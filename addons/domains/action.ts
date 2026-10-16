import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG_DIR, PANEL_DB, STATE_DIR } from "../../cli/paths";
import { emitActionError, emitActionOk, failAction, withFileLock, validateDomain as actionDomain } from "../../cli/action-common";
import { readBoundedText } from "../../lib/app-http";
import { AUTO_SSL_FILE, AUTO_SSL_LOCK, autoSslRequests, updateAutoSsl } from "../../lib/auto-ssl";
import { panelUserOwnsSite, PANEL_USER_NAME_RE } from "../../lib/panel-users";
import { detectedServerIps, provisioningSites } from "../../lib/panel-site-provisioning";
import { readRootJson, writeRootJson } from "../../lib/root-json";
import type { ApiFetch } from "../../lib/provider-http";
import { domain, emptyPolicy, object, parseProfile, text, type Connections, type Orphan, type PanelSite, type Policy, type Reply, type Review, type State } from "./model";
import { DomainsEngine, provisionReadiness, rememberRecords, type FleetPlan } from "./reconcile";
import { attachSsl, retryCertificates } from "./ssl";
import { claimed, desiredRecords, sameRecord } from "./records";

export type DomainsVerb = "list" | "save-connections" | "save-profile" | "delete-profile" | "assign" | "set-default" | "plan" | "apply" | "remove-records" | "provision" | "retry-ssl" | "reconcile" | "sync-sites";
const VERBS: DomainsVerb[] = ["list", "save-connections", "save-profile", "delete-profile", "assign", "set-default", "plan", "apply", "remove-records", "provision", "retry-ssl", "reconcile", "sync-sites"];
export interface DomainsPaths {
  panelDb: string; stateDir: string; lockFile: string; configFile: string;
  autoSslFile: string; autoSslLock: string; panelTweaksConfig: string; panelTweaksFile: string; clpctl: string; rootUid: number;
}
export interface DomainsActionOptions {
  paths?: Partial<DomainsPaths>; input?: string; emitReply?: boolean; processUid?: number;
  fetch?: ApiFetch; sites?: () => PanelSite[]; ips?: () => { ipv4: string; ipv6: string };
  domainValidator?: (value: string) => string; runCertificate?: (command: string, args: string[]) => Promise<boolean>;
  now?: () => number;
}
export const DEFAULT_DOMAINS_PATHS: DomainsPaths = {
  panelDb: PANEL_DB, stateDir: `${STATE_DIR}/domains`, lockFile: "/run/lock/clp-addons/domains.lock", configFile: `${CONFIG_DIR}/domains.conf`,
  autoSslFile: AUTO_SSL_FILE, autoSslLock: AUTO_SSL_LOCK, panelTweaksConfig: `${CONFIG_DIR}/panel-tweaks.conf`, panelTweaksFile: `${STATE_DIR}/panel-tweaks/tweaks.json`, clpctl: "/usr/bin/clpctl", rootUid: 0,
};
interface Cache { scannedAt: string | null; sites: State["sites"]; inventory: Orphan[]; errors: string[]; fleet?: string; retry: { cloudflare: number; mailcow: number } }
interface Pending { token: string; expiresAt: number; base: string; policy: Policy; digest: string; removal?: Orphan }
const emptyConnections = (): Connections => ({ accountId: "", cloudflareToken: "", mailcowUrl: "", mailcowKey: "" });
const emptyCache = (): Cache => ({ scannedAt: null, sites: [], inventory: [], errors: [], retry: { cloudflare: 0, mailcow: 0 } });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
const reason = (e: unknown) => e instanceof Error ? e.message : "DNS and mail operation failed";
function redact<T>(value: T, c: Connections): T {
  const secrets = [c.cloudflareToken, c.mailcowKey].filter(Boolean);
  const clean = (v: unknown): unknown => typeof v === "string" ? secrets.reduce((s, key) => s.split(key).join("[redacted]"), v)
    : Array.isArray(v) ? v.map(clean) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, val]) => [clean(k), clean(val)])) : v;
  return clean(value) as T;
}
function loadPolicy(path: string, uid: number): Policy {
  const p = readRootJson<Policy>(path, emptyPolicy, uid);
  if (p?.version !== 1 || !Array.isArray(p.profiles) || !p.assignments || typeof p.assignments !== "object" || Array.isArray(p.assignments) || !Array.isArray(p.knownSiteIds) || !p.knownSiteIds.every((id) => Number.isSafeInteger(id) && id > 0)) throw new Error("DNS and mail policy is malformed");
  p.profiles = p.profiles.map(parseProfile);
  if (new Set(p.profiles.map((p) => p.id)).size !== p.profiles.length || p.defaultProfileId !== null && !p.profiles.some((v) => v.id === p.defaultProfileId)) throw new Error("DNS and mail profiles are malformed");
  for (const [name, id] of Object.entries(p.assignments)) if (domain(name) !== name || !p.profiles.some((p) => p.id === id)) throw new Error("DNS and mail assignment is malformed");
  return p;
}
function connections(value: unknown): Connections {
  const c = object(value, "Connections");
  const result = { accountId: text(c.accountId, "Cloudflare account id", 32), cloudflareToken: text(c.cloudflareToken, "Cloudflare token", 4096), mailcowUrl: text(c.mailcowUrl, "Mailcow URL", 512).replace(/\/$/, ""), mailcowKey: text(c.mailcowKey, "Mailcow API key", 4096) };
  if (result.accountId && !/^[a-f0-9]{32}$/.test(result.accountId)) throw new Error("Cloudflare account id is invalid");
  if (result.mailcowUrl) {
    let url: URL;
    try { url = new URL(result.mailcowUrl); } catch { throw new Error("Mailcow URL must be an HTTPS origin"); }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Mailcow URL must be an HTTPS origin without a path, query or credentials");
    result.mailcowUrl = url.origin;
  }
  return result;
}
function discover(policy: Policy, sites: PanelSite[]): void {
  const known = new Set(policy.knownSiteIds);
  for (const s of sites) if (!known.has(s.id) && policy.defaultProfileId && !policy.assignments[s.domain]) policy.assignments[s.domain] = policy.defaultProfileId;
  policy.knownSiteIds = sites.map((s) => s.id);
  for (const name of Object.keys(policy.assignments)) if (!sites.some((s) => s.domain === name)) delete policy.assignments[name];
}
function changePolicy(policy: Policy, sites: PanelSite[], verb: DomainsVerb, body: Record<string, unknown>): Policy {
  const next = structuredClone(policy);
  const find = (id: unknown) => {
    const p = next.profiles.find((p) => p.id === id);
    if (!p) throw new Error("Profile does not exist"); return p;
  };
  if (verb === "save-profile") {
    const p = parseProfile(body);
    const at = next.profiles.findIndex((v) => v.id === p.id);
    if (at < 0) {
      if (p.mode !== "report") throw new Error("New profiles start in Report only; save first, then review Enforce");
      next.profiles.push(p);
    } else next.profiles[at] = p;
    const example: PanelSite = { id: 1, domain: "site.example.net", type: "php", certificateReady: false, certificateNames: [], placeholder: true, cloudflareOnly: false };
    desiredRecords(p, example, { id: "", name: example.domain, status: "active", nameServers: [] }, { ipv4: "192.0.2.1", ipv6: "2001:db8::1" }, { selector: p.dkimSelector, txt: "v=DKIM1;p=dGVzdA==" });
  }
  if (verb === "delete-profile") {
    const p = find(body.id);
    next.profiles = next.profiles.filter((v) => v.id !== p.id);
    for (const [name, id] of Object.entries(next.assignments)) if (id === p.id) delete next.assignments[name];
    if (next.defaultProfileId === p.id) next.defaultProfileId = null;
  }
  if (verb === "assign") {
    const id = body.profileId == null ? null : find(body.profileId).id;
    if (!Array.isArray(body.domains) || !body.domains.length) throw new Error("Select at least one site");
    for (const v of body.domains) {
      const name = domain(v), site = sites.find((s) => s.domain === name);
      if (!site) throw new Error("Assignment contains a site CloudPanel does not have");
      if (id) next.assignments[name] = id; else delete next.assignments[name];
      next.knownSiteIds.push(site.id);
    }
  }
  if (verb === "set-default") {
    next.defaultProfileId = body.profileId == null ? null : find(body.profileId).id;
    next.knownSiteIds = sites.map((s) => s.id);
  }
  next.knownSiteIds = [...new Set(next.knownSiteIds)];
  return next;
}
function needsReview(before: Policy, after: Policy, sites: PanelSite[]): boolean {
  return after.profiles.some((p) => p.mode === "enforce" && hash(before.profiles.find((v) => v.id === p.id)) !== hash(p))
    || sites.some((s) => before.assignments[s.domain] !== after.assignments[s.domain] && after.profiles.some((p) => p.id === after.assignments[s.domain] && p.mode === "enforce"));
}
function planDigest(plan: FleetPlan): string {
  return hash(plan.sites.map((s) => ({ domain: s.domain, profileId: s.profileId, mode: s.mode, zone: s.zone, changes: s.changes, errors: s.errors })).sort((a, b) => a.domain.localeCompare(b.domain)));
}

export async function executeDomainsAction(argv: string[], options: DomainsActionOptions = {}): Promise<unknown> {
  if ((options.processUid ?? process.getuid?.()) !== 0) failAction("DNS and mail actions must run as root");
  const verb = argv[0] as DomainsVerb;
  if (!VERBS.includes(verb)) failAction("Unknown DNS and mail action");
  const paths = { ...DEFAULT_DOMAINS_PATHS, ...options.paths };
  let target = "", asUser = "";
  for (const arg of argv.slice(1)) {
    if (verb !== "provision") failAction("This action takes no arguments");
    if (arg.startsWith("--domain=")) target = (options.domainValidator ?? actionDomain)(arg.slice(9));
    else if (arg.startsWith("--as-user=")) asUser = arg.slice(10);
    else failAction("Unexpected provision argument");
  }
  if (verb === "provision" && !target) failAction("provision requires --domain");
  if (asUser && !PANEL_USER_NAME_RE.test(asUser)) failAction("Invalid panel user name");
  const noBody = ["list", "reconcile", "sync-sites", "provision"].includes(verb);
  const raw = noBody ? "{}" : options.input ?? await readBoundedText(new Response(Bun.stdin.stream()), 256 * 1024);
  if (Buffer.byteLength(raw) > 256 * 1024) failAction("DNS and mail request is too large");
  let body: Record<string, unknown>;
  try { body = object(JSON.parse(raw), "Request"); } catch { failAction("Request must be a JSON object"); }
  mkdirSync(dirname(paths.lockFile), { recursive: true, mode: 0o700 });
  const execute = async () => {
    if (!existsSync(paths.configFile)) failAction("The Domains addon is disabled");
    const file = (name: string) => `${paths.stateDir}/${name}.json`;
    let policy = loadPolicy(file("policy"), paths.rootUid);
    let c = connections(readRootJson(file("credentials"), emptyConnections, paths.rootUid));
    let cache = readRootJson<Cache>(file("state"), emptyCache, paths.rootUid);
    if (!cache || !Array.isArray(cache.sites) || !Array.isArray(cache.inventory) || !Array.isArray(cache.errors) || !cache.retry) throw new Error("DNS and mail state is malformed");
    const getSites = () => options.sites?.() ?? provisioningSites(paths.panelDb);
    const sites = getSites();
    const ips = options.ips?.() ?? detectedServerIps();
    const enabled = () => existsSync(paths.configFile);
    const fleet = hash(sites.map((s) => [s.id, s.domain]));
    const savePolicy = () => writeRootJson(file("policy"), policy, paths.rootUid);
    const base = () => hash({ policy, c, sites: sites.map((s) => [s.id, s.domain]) });
    const state = (): Reply => {
      const plans = sites.map((site) => {
        const profile = policy.profiles.find((p) => p.id === policy.assignments[site.domain]);
        const previous = cache.sites.find((s) => s.domain === site.domain && s.profileId === profile?.id);
        return previous ? { ...previous, mode: profile!.mode, cloudflareOnly: site.cloudflareOnly, certificateReady: site.certificateReady, unproxiedWeb: previous.unproxiedWeb || !profile!.webProxied }
          : { domain: site.domain, type: site.type, profileId: profile?.id ?? null, mode: profile?.mode ?? "report", zone: null, certificateReady: site.certificateReady, waitingCertificate: false, unproxiedWeb: Boolean(profile && !profile.webProxied), changes: [], errors: profile ? ["Scan to build this site's current plan"] : [], cloudflareOnly: site.cloudflareOnly };
      });
      attachSsl(plans, sites, autoSslRequests(paths.autoSslFile, paths.rootUid));
      return redact({ profiles: policy.profiles, defaultProfileId: policy.defaultProfileId,
        connections: { accountId: c.accountId, mailcowUrl: c.mailcowUrl, hasCloudflareToken: Boolean(c.cloudflareToken), hasMailcowKey: Boolean(c.mailcowKey) },
        detectedIps: ips, sites: plans, orphans: cache.inventory.filter((v) => !sites.some((s) => s.domain === v.domain)), scannedAt: cache.scannedAt, errors: cache.errors, retryAt: Math.max(cache.retry.cloudflare, cache.retry.mailcow) }, c);
    };
    if (verb === "list") return state();
    const engine = new DomainsEngine({ connections: c, ips, retry: cache.retry, fetch: async (url, init) => {
      if (init.method !== "GET" && !enabled()) throw new Error("Domains was disabled");
      return (options.fetch ?? fetch)(url, init);
    } });
    const scanned = async (next = policy, selected?: Set<string>, enforce = false): Promise<FleetPlan> => {
      let plan = await engine.scan(next, sites);
      if (enforce) plan = await engine.enforce(next, sites, plan, selected);
      cache = { ...cache, fleet, scannedAt: new Date(options.now?.() ?? Date.now()).toISOString(), sites: plan.sites, inventory: rememberRecords(cache.inventory, plan), retry: engine.retry(), errors: [] };
      writeRootJson(file("state"), cache, paths.rootUid);
      return plan;
    };
    try {
      if (verb === "save-connections") {
        const endpoints = connections({ ...body, cloudflareToken: "", mailcowKey: "" });
        const next = connections({ ...endpoints, cloudflareToken: body.cloudflareToken || (endpoints.accountId === c.accountId ? c.cloudflareToken : ""), mailcowKey: body.mailcowKey || (endpoints.mailcowUrl === c.mailcowUrl ? c.mailcowKey : "") });
        c = next;
        writeRootJson(file("credentials"), c, paths.rootUid);
        for (const p of policy.profiles) p.mode = "report";
        savePolicy(); cache.sites = []; cache.retry = { cloudflare: 0, mailcow: 0 };
        rmSync(file("pending"), { force: true });
        return state();
      }
      if (verb === "provision" && asUser) {
        const db = new Database(paths.panelDb, { readonly: true });
        try { if (!panelUserOwnsSite(db, asUser, target)) failAction("That site is not yours to provision"); } finally { db.close(); }
      }
      if (verb === "reconcile" || verb === "sync-sites" || verb === "provision") {
        if (verb === "sync-sites" && cache.fleet === fleet && sites.every((s) => policy.knownSiteIds.includes(s.id))) return state();
        if (verb === "provision" && !sites.some((s) => s.domain === target)) failAction("CloudPanel has no such site");
        discover(policy, sites); savePolicy();
        const plan = await scanned(policy, verb === "provision" ? new Set([target]) : undefined, true);
        if (verb === "provision") {
          const readiness = provisionReadiness(plan.sites.find((s) => s.domain === target));
          const www = `www.${target}`;
          const hasWww = plan.work.get(target)?.desired.records.some((r) => r.name === www && ["A", "AAAA", "CNAME"].includes(r.type));
          return redact({ ...readiness, ...(readiness.ready ? { certificateDomains: [target, ...(hasWww ? [www] : [])] } : {}) }, c);
        }
        if (existsSync(paths.panelTweaksConfig)) {
          const tweaks = readRootJson<{ autoSsl?: boolean }>(paths.panelTweaksFile, () => ({}), paths.rootUid);
          if (tweaks.autoSsl) await retryCertificates(plan, { file: paths.autoSslFile, lock: paths.autoSslLock, uid: paths.rootUid, clpctl: paths.clpctl, sites: getSites, run: options.runCertificate, enabled, now: options.now });
        }
        return state();
      }
      if (verb === "retry-ssl") {
        const name = domain(body.domain), site = sites.find((s) => s.domain === name);
        if (!site?.placeholder) failAction("Only a site's self-signed placeholder can be retried");
        await updateAutoSsl((requests) => {
          const r = requests[name];
          if (!r || r.siteId !== site.id) failAction("This site did not request auto SSL at creation");
          r.attempts = 0; r.nextAttemptAt = 0; r.state = "Retry requested; waiting for reconciliation";
        }, paths.autoSslFile, paths.autoSslLock, paths.rootUid);
        return state();
      }
      if (verb === "plan") { await scanned(); return state(); }
      const removalPlan = async (orphan: Orphan, fleet: FleetPlan): Promise<Orphan> => {
        if (sites.some((s) => s.domain === orphan.domain)) throw new Error("Only an orphan's records can be removed");
        const current = await engine.cloudflare.records(orphan.zoneId), records = [];
        for (const old of orphan.records) {
          const r = current.find((r) => r.id === old.id);
          if (!r) continue;
          if (!sameRecord(old, r)) throw new Error("An orphan record changed in the dashboard; review it there before removal");
          if ([...fleet.work.values()].some((w) => claimed(r, w.desired))) throw new Error("A current site still manages an orphan's DNS name");
          records.push(r);
        }
        return { ...orphan, records };
      };
      if (verb === "apply") {
        const pending = readRootJson<Pending | null>(file("pending"), () => null, paths.rootUid);
        if (!pending || pending.token !== body.token || pending.expiresAt < (options.now?.() ?? Date.now()) || pending.base !== base()) throw new Error("The reviewed plan expired or the fleet/configuration changed; review a fresh plan");
        const fresh = await engine.scan(pending.policy, sites);
        const removal = pending.removal ? await removalPlan(pending.removal, fresh) : undefined;
        if ((removal ? hash(removal) : planDigest(fresh)) !== pending.digest) throw new Error("Provider state changed since this plan was reviewed; scan and confirm again");
        rmSync(file("pending"), { force: true });
        if (removal) {
          for (const r of removal.records) await engine.cloudflare.deleteRecord(removal.zoneId, r.id!);
          cache.inventory = cache.inventory.filter((v) => v.domain !== removal.domain || v.zoneId !== removal.zoneId);
          writeRootJson(file("state"), cache, paths.rootUid);
          return state();
        }
        policy = pending.policy; savePolicy();
        await scanned(policy, undefined, true);
        return state();
      }
      if (verb === "remove-records") {
        const orphan = cache.inventory.find((v) => v.domain === domain(body.domain) && v.zoneId === body.zoneId);
        if (!orphan) throw new Error("Orphan does not exist");
        const fleet = await engine.scan(policy, sites);
        const removal = await removalPlan(orphan, fleet);
        const pending: Pending = { token: randomBytes(32).toString("hex"), expiresAt: (options.now?.() ?? Date.now()) + 15 * 60_000, base: base(), policy, digest: hash(removal), removal };
        writeRootJson(file("pending"), pending, paths.rootUid);
        const review: Review = { token: pending.token, expiresAt: pending.expiresAt, title: `Remove ${removal.records.length} orphan records for ${removal.domain}`, sites: [], removal };
        return redact({ ...state(), review }, c);
      }
      const next = changePolicy(policy, sites, verb, body);
      if (needsReview(policy, next, sites)) {
        const plan = await engine.scan(next, sites);
        const affected = plan.sites.filter((s) => s.mode === "enforce");
        if (affected.some((s) => s.errors.length)) {
          cache.sites = plan.sites;
          rmSync(file("pending"), { force: true });
          return redact({ ...state(), review: { token: "", expiresAt: 0, title: "Resolve these plan errors before enabling Enforce", sites: plan.sites, blocked: true } }, c);
        }
        const pending: Pending = { token: randomBytes(32).toString("hex"), expiresAt: (options.now?.() ?? Date.now()) + 15 * 60_000, base: base(), policy: next, digest: planDigest(plan) };
        writeRootJson(file("pending"), pending, paths.rootUid);
        return redact({ ...state(), review: { token: pending.token, expiresAt: pending.expiresAt, title: "Review DNS and mail enforcement", sites: plan.sites } }, c);
      }
      policy = next; savePolicy(); cache.sites = [];
      return state();
    } catch (e) { throw new Error(redact(reason(e), c)); }
    finally {
      if (verb !== "save-connections") cache.retry = engine.retry();
      writeRootJson(file("state"), redact(cache, c), paths.rootUid);
    }
  };
  return verb === "list" ? execute() : withFileLock(paths.lockFile, 15, "DNS and mail reconciliation is running; try again shortly", execute);
}

export async function runDomainsAction(argv: string[], options: DomainsActionOptions = {}): Promise<number> {
  try {
    const result = await executeDomainsAction(argv, options);
    if (options.emitReply !== false) emitActionOk(result);
    return 0;
  } catch (e) {
    if (options.emitReply !== false) emitActionError(reason(e), undefined, "domains");
    return 1;
  }
}
