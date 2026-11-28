/**
 * Redirects' privileged verbs. Only these read the shared Cloudflare API tokens
 * or touch CloudPanel's stand-in sites, and nothing they return to the manager
 * contains a token.
 *
 * Changes that alter what Redirects writes once it is Automatic -- turning that
 * on, editing redirects, releasing holds, and deleting a redirect whose rule may
 * be in Cloudflare -- are reviewed first and applied only on confirmation of
 * that exact plan digest. A CloudPanel site at a redirect's host replaces it
 * without a review once Redirects is Automatic.
 */
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { ActionFailure, failAction, readJsonRequest, replyToAction } from "../../lib/action";
import { detectAddresses, type Addresses } from "../../lib/addresses";
import {
  cloudflareConnectionViews, readCloudflareConnections, readCloudflareSecrets, readCloudflareStatus,
  readFirewallEdgeDefaults, recordCloudflareReports, removeCloudflareConnection, saveCloudflareConnection,
  type CloudflareConnectionView, type CloudflareStorePaths,
} from "../../lib/cloudflare/store";
import { tokenTemplates, type TokenTemplates } from "../../lib/cloudflare/tokens";
import { withFileLock } from "../../lib/file-lock";
import { issuedForAll } from "../../lib/panel-custom-domain";
import { withPanelDb } from "../../lib/panel-db";
import {
  addonConfigFile, addonStateDir, CLOUDFLARE_STATE_DIR, LOCK_DIR, NGINX_CERTIFICATES_DIR, PANEL_DB,
} from "../../lib/paths";
import { type ApiFetch, redact } from "../../lib/provider-http";
import { readState, writeState } from "../../lib/root-state";
import { DEFAULT_SITE_VHOST_PATHS } from "../../lib/site-vhost";
import { panelUserUid } from "../../lib/sso-auth";
import { isStandInSite } from "../../lib/stand-ins";
import { trustedText } from "../../lib/trusted-file";
import {
  RedirectsRun, type LogEntry, type RedirectPlan, type Removal, type TrackedRedirectRule,
} from "./engine";
import {
  cloudflareId, connectionId, emptyPolicy, hostname, parsePolicy, parseRedirect, parseRedirects,
  type Policy, type Redirect, type RedirectStatus,
} from "./model";
import { redirectHosts, standInHosts, type FoundRedirect } from "./rules";
import {
  clpctlIssue, clpctlStandIns, readStandIns, retryStandInCertificates,
  type CertificateIssue, type StandInPaths, type StandIns,
} from "./stand-in";
import { REDIRECTS_VERBS } from "./verbs";

type RedirectsVerb = keyof typeof REDIRECTS_VERBS;

const VERBS = Object.keys(REDIRECTS_VERBS) as RedirectsVerb[];
const NO_BODY: RedirectsVerb[] = ["list", "check", "find-redirects", "create-site-helper", "reconcile", "sync-sites"];
const MAX_BODY = 256 * 1024;
const REVIEW_LIFETIME = 15 * 60_000;
const MAX_LOG = 1000;
const PAGE_LOG = 200;
const SELF_SIGNED = "1";

export interface PanelSiteInfo {
  id: number;
  domain: string;
  user?: string;
  selfSigned: boolean;
  certificatePem?: string | null;
}

export interface RedirectsPaths {
  configFile: string;
  panelDb: string;
  stateDir: string;
  cloudflareDir?: string;
  cloudflareLockFile?: string;
  dnsStateDir?: string;
  lockFile: string;
  clpctl: string;
  sqlite3: string;
  nginxVhostDir: string;
  sslCertDir?: string;
  tempDir: string;
  rootUid: number;
}

export interface RedirectsActionOptions {
  paths?: Partial<RedirectsPaths>;
  input?: string;
  emitReply?: boolean;
  processUid?: number;
  fetch?: ApiFetch;
  sites?: () => PanelSiteInfo[];
  addresses?: () => Addresses;
  issue?: CertificateIssue;
  now?: () => number;
  standIns?: () => StandIns;
}

export const DEFAULT_REDIRECTS_PATHS: RedirectsPaths = {
  configFile: addonConfigFile("redirects"),
  panelDb: PANEL_DB,
  stateDir: addonStateDir("redirects"),
  lockFile: `${LOCK_DIR}/redirects.lock`,
  clpctl: "/usr/bin/clpctl",
  sqlite3: DEFAULT_SITE_VHOST_PATHS.sqlite3,
  nginxVhostDir: DEFAULT_SITE_VHOST_PATHS.nginxVhostDir,
  tempDir: DEFAULT_SITE_VHOST_PATHS.tempDir,
  rootUid: 0,
};

// ---------------------------------------------------------------------------
// Page state & API replies
// ---------------------------------------------------------------------------

export interface RedirectView extends Redirect {
  standIn: boolean;
  plan: RedirectPlan | null;
}

export interface Review {
  token: string;
  title: string;
  text: string;
  sites: RedirectPlan[];
  blocked: boolean;
  confirmLabel: string;
  danger: boolean;
}

export type LogLine = LogEntry & { cause: string };

export interface Found {
  redirects: FoundRedirect[];
  notes: string[];
}

export interface RedirectsState {
  automatic: boolean;
  redirects: RedirectView[];
  connections: CloudflareConnectionView[];
  zones: string[];
  checkedAt: string | null;
  waitUntil: number;
  tokens: TokenTemplates;
  serverIps: string[];
  dnsEnabled: boolean;
  firewallEnabled: boolean;
  log: LogLine[];
}

export type RedirectsReply = RedirectsState & {
  review?: Review;
  notice?: string;
  error?: string;
  found?: Found;
};

export interface CreateSiteRedirectEntry {
  source: string;
  target: string;
  status: RedirectStatus;
  keepPath: boolean;
  keepQuery: boolean;
  standIn: boolean;
  hosts: string[];
  servedBy: "cloudflare" | "stand-in" | "pending";
  zone: string | null;
}

export interface CreateSiteHelper {
  redirects: CreateSiteRedirectEntry[];
  automatic: boolean;
}

// ---------------------------------------------------------------------------
// Stored state
// ---------------------------------------------------------------------------

interface Status {
  checkedAt: string | null;
  plans: Record<string, RedirectPlan>;
  /** Cloudflare connection ids saved when Redirects last looked; absent before its first look. */
  connectionIds?: string[];
  /** Last known Cloudflare zone holding a redirect's edge rule, kept across provider switches until deleted. */
  redirectRules?: Record<string, TrackedRedirectRule>;
}

interface Pending {
  token: string;
  expiresAt: number;
  base: string;
  digest: string;
  domains: string[];
  policy?: Policy;
  /** Deleting a redirect from the Redirects page. */
  deleteSource?: string;
}

const emptyStatus = (): Status => ({ checkedAt: null, plans: {} });
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");

function cloudflarePathsOf(paths: RedirectsPaths): CloudflareStorePaths {
  const customState = paths.stateDir !== DEFAULT_REDIRECTS_PATHS.stateDir;
  return {
    stateDir: paths.cloudflareDir ?? (customState ? `${paths.stateDir}/cloudflare` : CLOUDFLARE_STATE_DIR),
    lockFile: paths.cloudflareLockFile ?? (customState ? `${paths.lockFile}.cloudflare` : `${LOCK_DIR}/cloudflare.lock`),
    rootUid: paths.rootUid,
  };
}

class Files {
  readonly cfPaths: CloudflareStorePaths;

  constructor(private readonly paths: RedirectsPaths) {
    this.cfPaths = cloudflarePathsOf(paths);
  }

  private path(name: string): string {
    return `${this.paths.stateDir}/${name}.json`;
  }

  policy(): Policy {
    const raw = readState<unknown>(this.path("policy"), this.paths.rootUid, () => null);
    return raw === null ? emptyPolicy() : parsePolicy(raw);
  }

  savePolicy(policy: Policy): void {
    writeState(this.path("policy"), parsePolicy(policy), this.paths.rootUid);
  }

  status(): Status {
    return { ...emptyStatus(), ...readState<Partial<Status>>(this.path("status"), this.paths.rootUid, emptyStatus) };
  }

  saveStatus(status: Status): void {
    writeState(this.path("status"), status, this.paths.rootUid);
  }

  pending(): Pending | null {
    return readState<Pending | null>(this.path("pending"), this.paths.rootUid, () => null);
  }

  savePending(pending: Pending | null): void {
    writeState(this.path("pending"), pending, this.paths.rootUid);
  }

  log(): LogLine[] {
    return readState<LogLine[]>(this.path("log"), this.paths.rootUid, () => []);
  }

  appendLog(lines: LogLine[]): void {
    if (!lines.length) return;
    writeState(this.path("log"), [...lines.reverse(), ...this.log()].slice(0, MAX_LOG), this.paths.rootUid);
  }
}

// ---------------------------------------------------------------------------
// CloudPanel's sites
// ---------------------------------------------------------------------------

function columns(db: Database, table: string): Set<string> {
  return new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${table});`).all().map((row) => row.name));
}

export function panelSites(panelDb: string): PanelSiteInfo[] {
  return withPanelDb(panelDb, (db) => {
    const site = columns(db, "site");
    const certCols = site.has("certificate_id") ? columns(db, "certificate") : new Set<string>();
    const certificate = certCols.has("type");
    const certPem = certificate && certCols.has("certificate");
    const rows = db.query<{
      id: number; domain_name: string; user: string | null; cert: string | null; cert_pem: string | null;
    }, []>(
      `SELECT s.id, s.domain_name, ${site.has("user") ? "s.user" : "NULL"} AS user,
              ${certificate ? "c.type" : "NULL"} AS cert,
              ${certPem ? "c.certificate" : "NULL"} AS cert_pem
         FROM site s ${certificate ? "LEFT JOIN certificate c ON c.id = s.certificate_id" : ""}
        ORDER BY s.domain_name`,
    ).all();
    const sites: PanelSiteInfo[] = [];
    for (const row of rows) {
      let domain: string;
      try {
        domain = hostname(row.domain_name, "a site");
      } catch {
        continue;
      }
      sites.push({
        id: Number(row.id),
        domain,
        ...(row.user ? { user: row.user } : {}),
        selfSigned: String(row.cert) === SELF_SIGNED,
        ...(row.cert_pem ? { certificatePem: row.cert_pem } : {}),
      });
    }
    return sites;
  });
}

// ---------------------------------------------------------------------------
// One action invocation
// ---------------------------------------------------------------------------

class Action {
  readonly files: Files;
  readonly now: number;
  private cachedSites: PanelSiteInfo[] | null = null;
  private cachedStandIns: StandIns | null = null;
  private cachedAddresses: Addresses | null = null;
  private readonly runs: RedirectsRun[] = [];
  cause = "Scheduled check";

  constructor(readonly paths: RedirectsPaths, readonly options: RedirectsActionOptions) {
    this.files = new Files(paths);
    this.now = options.now?.() ?? Date.now();
  }

  panelSites(fresh = false): PanelSiteInfo[] {
    if (!this.cachedSites || fresh) this.cachedSites = this.options.sites?.() ?? panelSites(this.paths.panelDb);
    return this.cachedSites;
  }

  standInPaths(): StandInPaths {
    const { panelDb, sqlite3, nginxVhostDir, tempDir } = this.paths;
    return {
      file: `${this.paths.stateDir}/standins.json`,
      clpctl: this.paths.clpctl,
      vhost: { panelDb, sqlite3, nginxVhostDir, tempDir },
      rootUid: this.paths.rootUid,
    };
  }

  standIns(): StandIns {
    this.cachedStandIns ??= this.options.standIns?.()
      ?? clpctlStandIns(this.standInPaths(), (domain) => this.panelSites(true).find((site) => site.domain === domain), () => this.now);
    return this.cachedStandIns;
  }

  /** Real CloudPanel sites, excluding Redirects' own stand-ins. */
  sites(fresh = false): PanelSiteInfo[] {
    const records = readStandIns(this.standInPaths());
    const current = this.standIns().current;
    return this.panelSites(fresh).filter((site) => !current[site.domain] && !isStandInSite(records[site.domain], site, this.now));
  }

  addresses(): Addresses {
    this.cachedAddresses ??= this.options.addresses?.() ?? detectAddresses();
    return this.cachedAddresses;
  }

  run(policy: Policy): RedirectsRun {
    const connections = readCloudflareConnections(this.files.cfPaths);
    const tokens = readCloudflareSecrets(this.files.cfPaths);
    const { reports, backoffUntil } = readCloudflareStatus(this.files.cfPaths);
    const run = new RedirectsRun({
      policy,
      connections,
      tokens,
      siteDomains: new Set(this.sites().map((site) => site.domain)),
      fetch: this.options.fetch,
      backoff: backoffUntil,
      standIns: this.standIns(),
      storedTokens: Object.fromEntries(reports.filter((report) => report.active).map((report) => [report.id, report.token])),
      tracked: this.files.status().redirectRules,
    });
    this.runs.push(run);
    return run;
  }

  writeLog(): void {
    this.files.appendLog(this.runs.flatMap((run) => run.log.splice(0).map((entry) => ({ ...entry, cause: this.cause }))));
  }

  async rememberBackoff(): Promise<void> {
    if (!this.runs.length) return;
    const { backoffUntil } = readCloudflareStatus(this.files.cfPaths);
    let maxUntil = backoffUntil;
    for (const run of this.runs) maxUntil = Math.max(maxUntil, run.backoff());
    if (maxUntil > backoffUntil) {
      await recordCloudflareReports([], maxUntil, false, {}, this.files.cfPaths);
    }
  }

  async record(run: RedirectsRun, plans: RedirectPlan[], domains: string[] | "all"): Promise<void> {
    const status = this.files.status();
    const policy = this.files.policy();
    const currentSources = new Set(policy.redirects.map((redirect) => redirect.source));
    const plansByDomain = domains === "all"
      ? {}
      : Object.fromEntries(Object.entries(status.plans).filter(([domain]) => currentSources.has(domain)));
    const redirectRules: Record<string, TrackedRedirectRule> = { ...(status.redirectRules ?? {}) };
    for (const domain of Object.keys(redirectRules)) {
      if (!currentSources.has(domain)) delete redirectRules[domain];
    }
    for (const plan of plans) {
      if (domains !== "all" && !domains.includes(plan.domain)) continue;
      plansByDomain[plan.domain] = plan;
      const tracked = run.trackedRule(plan.domain);
      if (tracked) redirectRules[plan.domain] = tracked;
      else delete redirectRules[plan.domain];
    }
    this.files.saveStatus({
      ...status,
      checkedAt: domains === "all" ? new Date(this.now).toISOString() : status.checkedAt,
      plans: plansByDomain,
      redirectRules,
    });
    if (run.connections.length || domains === "all") {
      await recordCloudflareReports(run.reports(), run.backoff(), domains === "all", run.tokens, this.files.cfPaths);
    }
  }

  state(): RedirectsState {
    const policy = this.files.policy();
    const status = this.files.status();
    const standIns = this.standIns().current;
    const edge = readFirewallEdgeDefaults({ rootUid: this.paths.rootUid });
    const cf = cloudflareConnectionViews(edge, { includeDns: false, requireRedirects: true }, this.files.cfPaths);
    const detected = this.addresses();
    const serverIps = [detected.ipv4, detected.ipv6].filter((ip): ip is string => Boolean(ip));
    return {
      automatic: policy.automatic,
      redirects: policy.redirects.map((redirect): RedirectView => ({
        ...redirect,
        standIn: Boolean(standIns[redirect.source]),
        plan: status.plans[redirect.source] ?? null,
      })),
      connections: cf.connections,
      zones: cf.zones,
      checkedAt: status.checkedAt,
      waitUntil: cf.backoffUntil,
      tokens: tokenTemplates(edge),
      serverIps,
      dnsEnabled: existsSync(addonConfigFile("dns")),
      firewallEnabled: existsSync(addonConfigFile("firewall")),
      log: this.files.log().slice(0, PAGE_LOG),
    };
  }

  /** Local-only state for CloudPanel's Create Site form notice; never calls Cloudflare or waits for the lock. */
  createSiteHelper(): CreateSiteHelper {
    const policy = this.files.policy();
    const status = this.files.status();
    const standIns = this.standIns().current;
    const redirects: CreateSiteRedirectEntry[] = policy.redirects.map((redirect) => {
      const plan = status.plans[redirect.source];
      const standIn = standIns[redirect.source];
      const tracked = status.redirectRules?.[redirect.source];
      const zoneName = plan?.zone?.name ?? tracked?.zoneName ?? null;
      const hosts = standIn?.hosts?.length
        ? standIn.hosts
        : redirect.hosts?.length
          ? redirect.hosts
          : zoneName && redirect.mode !== "local"
            ? redirectHosts(redirect.source, zoneName)
            : standInHosts(redirect.source);
      const servedBy: CreateSiteRedirectEntry["servedBy"] = standIn
        ? "stand-in"
        : (plan?.zone || tracked) && redirect.mode !== "local"
          ? "cloudflare"
          : "pending";
      return {
        source: redirect.source,
        target: redirect.target,
        status: redirect.status,
        keepPath: redirect.keepPath,
        keepQuery: redirect.keepQuery,
        standIn: Boolean(standIn),
        hosts,
        servedBy,
        zone: zoneName,
      };
    });
    return { redirects, automatic: policy.automatic };
  }

  reply(extra: { review?: Review; notice?: string; error?: string; found?: Found } = {}): RedirectsReply {
    this.writeLog();
    return { ...this.state(), ...extra };
  }

  // -------------------------------------------------------------------------
  // Provider transition holds
  // -------------------------------------------------------------------------

  private standInRedirects(policy: Policy, includeLocal = false): string[] {
    const current = this.standIns().current;
    return Object.keys(current).filter((domain) => {
      const redirect = policy.redirects.find((candidate) => candidate.source === domain);
      return Boolean(redirect && (includeLocal || redirect.mode !== "local"));
    });
  }

  /**
   * Holds redirects for review whenever a shared Cloudflare connection arrives
   * or goes (whether Redirects, DNS, or Firewall changed it), so moving a
   * redirect between Cloudflare and a local stand-in site is always reviewed.
   */
  noticeConnections(): void {
    const currentIds = readCloudflareConnections(this.files.cfPaths).map((connection) => connection.id);
    const status = this.files.status();
    const prevIds = status.connectionIds;
    if (prevIds !== undefined && prevIds.length === currentIds.length && prevIds.every((id, index) => id === currentIds[index])) {
      return;
    }
    const activeIds = new Set(currentIds);
    const policy = this.files.policy();
    const nextChoices = { ...policy.zoneChoices };
    const clearedZones: string[] = [];
    for (const [zone, choice] of Object.entries(nextChoices)) {
      if (!activeIds.has(choice.connectionId)) {
        clearedZones.push(zone);
        delete nextChoices[zone];
      }
    }
    let held: string[] = [];
    if (prevIds !== undefined) {
      const added = currentIds.some((id) => !prevIds.includes(id));
      const removedIds = prevIds.filter((id) => !currentIds.includes(id));
      const emptied = prevIds.length > 0 && currentIds.length === 0;
      const partialRemoved = removedIds.length > 0 && currentIds.length > 0
        ? policy.redirects
          .filter((redirect) => redirect.mode !== "local")
          .map((redirect) => redirect.source)
          .filter((source) => {
            const planConn = status.plans[source]?.zone?.connectionId;
            const trackedConn = status.redirectRules?.[source]?.connectionId;
            if (!planConn || removedIds.includes(planConn) || (trackedConn && removedIds.includes(trackedConn))) return true;
            return clearedZones.some((zone) => source === zone || source.endsWith(`.${zone}`));
          })
        : [];
      held = [
        ...(added ? this.standInRedirects(policy) : []),
        ...(emptied ? policy.redirects.filter((redirect) => redirect.mode !== "local").map((redirect) => redirect.source) : []),
        ...partialRemoved,
      ];
    } else if (currentIds.length > 0) {
      held = this.standInRedirects(policy);
    }
    if (clearedZones.length || held.some((domain) => !policy.held.includes(domain))) {
      this.files.savePolicy({
        ...policy,
        zoneChoices: nextChoices,
        held: [...new Set([...policy.held, ...held])],
      });
    }
    const latest = this.files.status();
    this.files.saveStatus({ ...latest, connectionIds: currentIds });
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  async refresh(domains: string[] | "all"): Promise<void> {
    const policy = this.files.policy();
    const run = this.run(policy);
    const allSources = policy.redirects.map((redirect) => redirect.source);
    const chosen = domains === "all" ? allSources : allSources.filter((source) => domains.includes(source));
    if (!chosen.length && domains !== "all") return;
    await run.discover(domains === "all");
    await run.load(chosen);
    this.holdTransitions(run, policy, chosen);
    await this.record(run, run.planAll(domains === "all" ? undefined : chosen), domains === "all" ? "all" : chosen);
  }

  private async tryRefresh(domains: string[] | "all"): Promise<void> {
    try {
      await this.refresh(domains);
    } catch (error) {
      if (!(error instanceof ActionFailure)) throw error;
    }
  }

  async check(retryCerts: boolean): Promise<void> {
    const policy = this.files.policy();
    const run = this.run(policy);
    const allSources = policy.redirects.map((redirect) => redirect.source);
    await run.discover(true);
    await run.load(allSources);
    this.holdTransitions(run, policy, allSources);

    const released = run.releaseHeld();
    if (released.length) {
      policy.held = policy.held.filter((domain) => !released.includes(domain));
      this.files.savePolicy(policy);
    }
    await run.enforce(allSources);
    this.forget([...run.replaced.keys()]);
    const plans = run.planAll();
    await this.record(run, plans, "all");
    if (retryCerts) await this.retryStandInCertificates();
  }

  /**
   * Holds for review a redirect whose stand-in now matches a Cloudflare zone, or
   * whose Cloudflare destination is gone so it would fall back to a new stand-in,
   * judged against the last recorded plan, whichever run records the change first.
   */
  private holdTransitions(run: RedirectsRun, policy: Policy, sources: string[]): void {
    const status = this.files.status();
    const standIns = this.standIns().current;
    const moving = policy.redirects.filter((redirect) => {
      if (!sources.includes(redirect.source) || redirect.mode === "local" || policy.held.includes(redirect.source)) return false;
      if (run.replacingSite(redirect)) return false;
      const before = status.plans[redirect.source];
      if (standIns[redirect.source]) return !before?.zone && Boolean(run.planRedirect(redirect).zone);
      const wasCloudflare = before?.zone
        ? true
        : (!before || before.problems.length > 0) && Boolean(status.redirectRules?.[redirect.source]);
      return wasCloudflare && run.resolvesLocally(redirect);
    }).map((redirect) => redirect.source);
    if (!moving.length) return;
    run.hold(moving);
    policy.held = [...new Set([...policy.held, ...moving])];
    this.files.savePolicy(policy);
  }

  /** Run in the periodic reconcile pass only: a certificate request can take minutes. */
  async retryStandInCertificates(): Promise<void> {
    if (this.options.standIns) return;
    const current = this.standIns().current;
    const owners = [this.paths.rootUid, panelUserUid() ?? this.paths.rootUid];
    const certDir = this.paths.sslCertDir ?? NGINX_CERTIFICATES_DIR;
    const now = this.options.now ? this.options.now() : Date.now();
    const covered = (domain: string, hosts: string[]): boolean | null => {
      if (!current[domain]) return null;
      const site = this.panelSites(true).find((candidate) => candidate.domain === domain);
      if (!site) return null;
      if (site.selfSigned) return false;
      const pem = site.certificatePem
        || owners.map((uid) => trustedText(`${certDir}/${domain}.crt`, uid)).find((text) => text !== null)
        || null;
      return issuedForAll(pem, hosts, now);
    };
    await retryStandInCertificates(this.standInPaths(), covered, this.options.issue ?? clpctlIssue(this.paths.clpctl), now);
  }

  // -------------------------------------------------------------------------
  // Reviews & confirmations
  // -------------------------------------------------------------------------

  private affected(before: Policy, after: Policy): string[] {
    if (!after.automatic) return [];
    const redirectOf = (policy: Policy, source: string) => policy.redirects.find((redirect) => redirect.source === source);
    return after.redirects
      .map((redirect) => redirect.source)
      .filter((source) => {
        if (!before.automatic) return true;
        if (before.held.includes(source) && !after.held.includes(source)) return true;
        if (JSON.stringify(redirectOf(before, source)) !== JSON.stringify(redirectOf(after, source))) return true;
        return Object.keys({ ...before.zoneChoices, ...after.zoneChoices }).some((zone) =>
          (source === zone || source.endsWith(`.${zone}`))
          && JSON.stringify(before.zoneChoices[zone]) !== JSON.stringify(after.zoneChoices[zone]));
      });
  }

  private digest(plans: RedirectPlan[]): string {
    return hash(plans.map((plan) => [
      plan.domain,
      plan.zone ? [plan.zone.connectionId, plan.zone.id] : null,
      plan.changes,
      plan.problems,
    ]));
  }

  async change(next: Policy, notice: string, refresh: string[] | "all" = []): Promise<RedirectsReply> {
    const before = this.files.policy();
    const domains = this.affected(before, next);
    if (!domains.length) {
      this.files.savePolicy(next);
      this.files.savePending(null);
      await this.tryRefresh(refresh);
      return this.reply({ notice });
    }
    return this.review(before, next, domains);
  }

  private async review(before: Policy, next: Policy, domains: string[], notice?: string): Promise<RedirectsReply> {
    const run = this.run(next);
    await run.discover();
    await run.load(domains);
    const plans = run.planAll(domains);
    for (const plan of plans) {
      if (plan.replacedBy && !before.redirects.some((redirect) => redirect.source === plan.domain)) {
        plan.problems.push(`CloudPanel has a site ${plan.replacedBy}; delete the site or this redirect`);
      }
    }
    const blocked = plans.some((plan) => plan.problems.length > 0);
    const token = blocked ? "" : randomBytes(24).toString("hex");
    this.files.savePending(blocked ? null : {
      token,
      expiresAt: this.now + REVIEW_LIFETIME,
      base: hash(before),
      digest: this.digest(plans),
      domains,
      policy: next,
    });
    const changes = plans.reduce((count, plan) => count + plan.changes.filter((change) => change.action !== "note").length, 0);
    const turningOn = !before.automatic;
    return this.reply({
      notice,
      review: {
        token,
        title: blocked
          ? "Resolve these first"
          : turningOn
            ? "Turn on Automatic"
            : `Apply to ${plans.length} redirect${plans.length === 1 ? "" : "s"}`,
        text: blocked
          ? "This cannot be applied while a redirect below has a problem. Fix the problem or remove the redirect first."
          : `${changes} change${changes === 1 ? "" : "s"} will be made now${turningOn
            ? ". From then on Redirects keeps every redirect domain in sync on its own"
            : ", and kept from then on"}. Non-web DNS records such as mail and verification are left alone.`,
        sites: plans,
        blocked,
        confirmLabel: turningOn ? "Apply and turn on Automatic" : "Apply",
        danger: plans.some((plan) => plan.changes.some((change) => change.action === "delete")),
      },
    });
  }

  /** Reads live Cloudflare state and owned stand-in state for deleting `source`. */
  private async deletionPlan(source: string): Promise<{ run: RedirectsRun; removal: Removal; replacedBy: string | null; plans: RedirectPlan[]; digest: string }> {
    const policy = this.files.policy();
    const redirect = policy.redirects.find((candidate) => candidate.source === source)!;
    const tracked = this.files.status().redirectRules?.[source];
    const run = this.run(policy);
    if (readCloudflareConnections(this.files.cfPaths).length || tracked) {
      await run.discover();
      await run.loadRedirectDeletion(source, tracked);
    }
    const replacedBy = run.replacingSite(redirect);
    const removal = run.removal(source, replacedBy !== null);
    const plans: RedirectPlan[] = [{
      domain: source,
      mode: "enforce",
      zone: removal.rule?.zone ?? null,
      problems: removal.problems,
      zoneChoices: [],
      changes: removal.changes,
      ...replacedBy && { replacedBy },
    }];
    const rule = removal.rule && {
      id: removal.rule.rule.id,
      ref: removal.rule.rule.ref,
      expression: removal.rule.rule.expression,
      action_parameters: removal.rule.rule.action_parameters,
      description: removal.rule.rule.description,
      enabled: removal.rule.rule.enabled,
    };
    const digest = hash([this.digest(plans), rule, removal.records.map(({ record }) => record.id)]);
    return { run, removal, replacedBy, plans, digest };
  }

  /**
   * With Cloudflare connected, or a rule seen before, deleting always shows a
   * review of what it removes there, whether or not Redirects is Automatic, and
   * blocks while the rule cannot be read.
   */
  async deleteRedirect(source: string, notice?: string): Promise<RedirectsReply> {
    const policy = this.files.policy();
    if (!policy.redirects.some((redirect) => redirect.source === source)) failAction("That redirect no longer exists");
    const tracked = this.files.status().redirectRules?.[source];
    const hasCf = readCloudflareConnections(this.files.cfPaths).length > 0;
    const { run, removal, replacedBy, plans, digest } = await this.deletionPlan(source);
    if (!hasCf && !tracked) {
      await run.remove(source, removal, replacedBy ? `Replaced by the site ${replacedBy}` : "The redirect domain was deleted");
      this.forget([source]);
      return this.reply({ notice: removal.standIn ? `Deleted ${source} and its stand-in site.` : `${source} is no longer managed.` });
    }
    const blocked = removal.problems.length > 0;
    const token = blocked ? "" : randomBytes(24).toString("hex");
    this.files.savePending(blocked ? null : {
      token,
      expiresAt: this.now + REVIEW_LIFETIME,
      base: hash(policy),
      digest,
      domains: [],
      deleteSource: source,
    });
    const parts = [
      removal.rule ? `Its rule is deleted from Cloudflare, so ${source} stops redirecting.` : "No Cloudflare rule was found for it.",
      removal.records.length ? "Its placeholder records are deleted." : "",
      removal.standIn ? "Its stand-in site is deleted." : "",
      "Other DNS records stay untouched.",
    ];
    return this.reply({
      notice,
      review: {
        token,
        title: `Delete the redirect for ${source}`,
        text: blocked
          ? "This cannot be deleted while its rule cannot be read. Fix the problem, or delete the rule in Cloudflare."
          : parts.filter(Boolean).join(" "),
        sites: plans,
        blocked,
        confirmLabel: "Delete redirect",
        danger: true,
      },
    });
  }

  /** Forgets redirects that are gone, in policy and status. */
  private forget(sources: string[]): void {
    if (!sources.length) return;
    const gone = new Set(sources);
    const policy = this.files.policy();
    policy.redirects = policy.redirects.filter((redirect) => !gone.has(redirect.source));
    policy.held = policy.held.filter((domain) => !gone.has(domain));
    this.files.savePolicy(policy);
    const status = this.files.status();
    for (const source of gone) {
      delete status.plans[source];
      if (status.redirectRules) delete status.redirectRules[source];
    }
    this.files.saveStatus(status);
  }

  private async confirmDeletion(pending: Pending): Promise<RedirectsReply> {
    const source = pending.deleteSource!;
    const { run, removal, replacedBy, digest } = await this.deletionPlan(source);
    if (digest !== pending.digest) {
      return this.deleteRedirect(source, "Cloudflare or this server changed after the plan was shown. This is the plan now.");
    }
    this.files.savePending(null);
    this.cause = "Redirect deleted";
    await run.remove(source, removal, replacedBy ? `Replaced by the site ${replacedBy}` : "The redirect domain was deleted");
    this.forget([source]);
    return this.reply({ notice: `Deleted the redirect for ${source}.` });
  }

  /** Redirects whose source, `www`, or stand-in hosts a real site now uses; a superset of those a site replaces. */
  siteCandidates(policy = this.files.policy()): string[] {
    const sites = new Set(this.sites(true).map((site) => site.domain));
    return policy.redirects
      .filter((redirect) => [redirect.source, `www.${redirect.source}`, ...redirect.hosts ?? []].some((host) => sites.has(host)))
      .map((redirect) => redirect.source);
  }

  /**
   * Run when CloudPanel creates a site: a redirect the site replaces is removed
   * now once Redirects is Automatic, and shown as waiting otherwise. Makes no
   * Cloudflare call when no new site touches a redirect.
   */
  async syncSites(): Promise<{ replaced: string[]; waiting: string[] }> {
    const policy = this.files.policy();
    const candidates = this.siteCandidates(policy);
    if (!candidates.length) return { replaced: [], waiting: [] };
    this.cause = "New site";
    const run = this.run(policy);
    await run.discover();
    await run.load(candidates);
    const replacing = run.planAll(candidates).filter((plan) => plan.replacedBy).map((plan) => plan.domain);
    if (policy.automatic) await run.enforce(replacing);
    const replaced = [...run.replaced.keys()];
    this.forget(replaced);
    await this.record(run, run.planAll(candidates), candidates);
    return { replaced, waiting: replacing.filter((source) => !run.replaced.has(source)) };
  }

  async confirm(token: unknown): Promise<RedirectsReply> {
    const pending = this.files.pending();
    const current = this.files.policy();
    if (!pending || typeof token !== "string" || !token || pending.token !== token || pending.expiresAt < this.now) {
      failAction("This review has expired; make the change again to see a fresh plan");
    }
    if (pending.base !== hash(current)) {
      failAction("The settings changed after this review; make the change again to see a fresh plan");
    }
    if (pending.deleteSource) return this.confirmDeletion(pending);

    const next = parsePolicy(pending.policy);
    const run = this.run(next);
    await run.discover();
    await run.load(pending.domains);
    const plans = run.planAll(pending.domains);
    if (this.digest(plans) !== pending.digest) {
      return this.review(current, next, pending.domains, "Cloudflare changed after the plan was shown. This is the plan now.");
    }
    this.files.savePolicy(next);
    this.files.savePending(null);
    this.cause = "Confirmed review";
    await run.enforce(pending.domains);
    this.forget([...run.replaced.keys()]);
    const afterPlans = run.planAll(pending.domains);
    await this.record(run, afterPlans, pending.domains);
    return this.reply({
      notice: `Applied to ${pending.domains.length} redirect${pending.domains.length === 1 ? "" : "s"}.${current.automatic ? "" : " Redirects is Automatic."}`,
    });
  }

  // -------------------------------------------------------------------------
  // Redirect management & shared Cloudflare connections
  // -------------------------------------------------------------------------

  private refuseSite(redirect: Redirect): void {
    const hosts = new Set([redirect.source, ...standInHosts(redirect.source), ...redirect.hosts ?? []]);
    const site = this.sites().find((candidate) => hosts.has(candidate.domain));
    if (site) failAction(`${site.domain} is a CloudPanel site; delete the site first`);
  }

  async saveRedirect(body: Record<string, unknown>): Promise<RedirectsReply> {
    const policy = this.files.policy();
    const redirect = parseRedirect(body);
    const existing = policy.redirects.find((candidate) => candidate.source === redirect.source);
    this.refuseSite(redirect);
    // Preserve custom stand-in hosts across edits unless explicitly provided or switching away from local.
    if (!body.hosts && existing?.hosts && redirect.mode === "local") redirect.hosts = existing.hosts;
    const next = structuredClone(policy);
    next.redirects = parseRedirects([...next.redirects.filter((candidate) => candidate.source !== redirect.source), redirect]);
    next.held = next.held.filter((domain) => domain !== redirect.source);
    return this.change(next, existing ? `Saved ${redirect.source}.` : `Added ${redirect.source}.`, [redirect.source]);
  }

  async reviewRedirect(source: string): Promise<RedirectsReply> {
    const policy = this.files.policy();
    if (!policy.redirects.some((redirect) => redirect.source === source)) failAction("That redirect no longer exists");
    const next = structuredClone(policy);
    next.held = next.held.filter((domain) => domain !== source);
    return this.change(next, `${source} is ready.`, [source]);
  }

  async findRedirects(): Promise<RedirectsReply> {
    if (!readCloudflareConnections(this.files.cfPaths).length) failAction("Connect Cloudflare first");
    const policy = this.files.policy();
    const run = this.run(policy);
    await run.discover();
    const found = await run.findRedirects();
    const taken = new Set([...policy.redirects.map((redirect) => redirect.source), ...this.sites().map((site) => site.domain)]);
    return this.reply({
      found: { redirects: found.redirects.filter((redirect) => !taken.has(redirect.source)), notes: found.notes },
    });
  }

  async takeOver(body: Record<string, unknown>): Promise<RedirectsReply> {
    const policy = this.files.policy();
    if (!Array.isArray(body.redirects) || !body.redirects.length) failAction("Select at least one redirect");
    const added = body.redirects.map((entry) => parseRedirect(entry));
    for (const redirect of added) {
      if (policy.redirects.some((candidate) => candidate.source === redirect.source)) {
        failAction(`${redirect.source} is already a redirect domain`);
      }
      this.refuseSite(redirect);
    }
    const next = structuredClone(policy);
    next.redirects = parseRedirects([...next.redirects, ...added]);
    return this.change(next, `Added ${added.length} redirect domain${added.length === 1 ? "" : "s"}.`, added.map((redirect) => redirect.source));
  }

  async saveConnection(body: Record<string, unknown>): Promise<RedirectsReply> {
    const saved = await saveCloudflareConnection(body, { paths: this.files.cfPaths, fetch: this.options.fetch });
    this.noticeConnections();
    await this.tryRefresh("all");
    return this.reply({ notice: saved.notice });
  }

  async removeConnection(id: string): Promise<RedirectsReply> {
    const removed = await removeCloudflareConnection(id, { paths: this.files.cfPaths });
    this.noticeConnections();
    await this.tryRefresh("all");
    return this.reply({ notice: removed.notice });
  }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

async function perform(action: Action, verb: RedirectsVerb, body: Record<string, unknown>): Promise<unknown> {
  switch (verb) {
    case "check":
      action.cause = "Check now";
      await action.check(false);
      return action.reply({ notice: "Checked every redirect." });
    case "reconcile":
      await action.check(true);
      return { checked: action.files.policy().redirects.length };
    case "sync-sites":
      return action.syncSites();
    case "set-automatic": {
      if (typeof body.automatic !== "boolean") failAction("Say whether Redirects is Automatic");
      const next = structuredClone(action.files.policy());
      next.automatic = body.automatic;
      return action.change(next, body.automatic ? "Redirects is Automatic." : "Redirects asks first. Nothing in Cloudflare or on this server was changed.");
    }
    case "save-redirect":
      return action.saveRedirect(body);
    case "delete-redirect":
      action.cause = "Redirect deleted";
      return action.deleteRedirect(hostname(body.source, "the redirect's domain"));
    case "review-redirect":
      return action.reviewRedirect(hostname(body.source, "the redirect's domain"));
    case "confirm":
      return action.confirm(body.token);
    case "find-redirects":
      return action.findRedirects();
    case "take-over":
      return action.takeOver(body);
    case "choose-zone": {
      const zone = hostname(body.zone, "the zone");
      const next = structuredClone(action.files.policy());
      next.zoneChoices[zone] = { connectionId: connectionId(body.connectionId), zoneId: cloudflareId(body.zoneId, "the zone") };
      const inZone = next.redirects
        .map((redirect) => redirect.source)
        .filter((source) => source === zone || source.endsWith(`.${zone}`));
      return action.change(next, `${zone} is managed through the chosen connection.`, inZone);
    }
    case "save-connection":
      return action.saveConnection(body);
    case "remove-connection":
      return action.removeConnection(connectionId(body.id));
    default:
      failAction(`unknown Redirects verb '${verb}'`);
  }
}

export async function executeRedirectsAction(argv: string[], options: RedirectsActionOptions = {}): Promise<unknown> {
  if ((options.processUid ?? process.getuid?.()) !== 0) failAction("Redirects actions must run as root");
  const [rawVerb, ...args] = argv;
  const verb = VERBS.find((candidate) => candidate === rawVerb);
  if (!verb) failAction(`usage: clp-addons action redirects {${VERBS.join("|")}}`);
  if (args.length) failAction(`'${verb}' takes no arguments`);
  const paths = { ...DEFAULT_REDIRECTS_PATHS, ...options.paths };
  const body = NO_BODY.includes(verb) ? {} : await readJsonRequest(options.input, MAX_BODY);
  const action = new Action(paths, options);
  if (verb === "list") return action.state();
  if (verb === "create-site-helper") return action.createSiteHelper();
  if (verb === "sync-sites" && (!existsSync(paths.configFile) || !action.siteCandidates().length)) return { replaced: [], waiting: [] };

  const wait = verb === "reconcile" ? 240 : 30;
  return withFileLock(paths.lockFile, wait, "Redirects is busy checking Cloudflare; try again in a moment", async () => {
    if (verb === "reconcile" && !existsSync(paths.configFile)) return { checked: 0 };
    let failed = false;
    try {
      action.noticeConnections();
      return await perform(action, verb, body);
    } catch (error) {
      failed = true;
      if (!(error instanceof Error)) throw error;
      let tokens: Record<string, string>;
      try { tokens = readCloudflareSecrets(action.files.cfPaths); } catch { throw error; }
      const message = redact(error.message, Object.values(tokens));
      if (message === error.message) throw error;
      failAction(message);
    } finally {
      try {
        action.writeLog();
        await action.rememberBackoff();
      } catch (afterError) {
        if (!failed) throw afterError;
      }
    }
  });
}

export async function runRedirectsAction(argv: string[], options: RedirectsActionOptions = {}): Promise<number> {
  return replyToAction("redirects", options.emitReply !== false, () => executeRedirectsAction(argv, options));
}
