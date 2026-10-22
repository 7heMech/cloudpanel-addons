/**
 * DNS's privileged verbs. Only these read the Cloudflare tokens and the
 * Mailcow key, and nothing they return to the manager contains either.
 *
 * Changes that alter what an enforcing profile writes are not saved straight
 * away: they come back as a review of every create, update and delete they
 * would make, and only a confirmation of that same plan saves and applies
 * them.
 */
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  ActionFailure, emitActionError, emitActionOk, failAction, nameSlug, oneLine, withFileLock,
} from "../../cli/action-common";
import { CONFIG_DIR, PANEL_DB, STATE_DIR } from "../../cli/paths";
import { PANEL_USER_NAME_RE, panelUserOwnsSite } from "../../lib/panel-users";
import { detectAddresses, type Addresses } from "./addresses";
import { DnsRun, readiness, type ConnectionReport, type ManagedRecords, type PanelSite, type SitePlan } from "./engine";
import { type ApiFetch, redact } from "./http";
import { MailcowApi } from "./mailcow";
import {
  connectionId, hostname, parseMailcow, parsePolicy, parseProfile, parseSecrets, profileEffect, profileId, secretText,
  ipAddress, cloudflareId, type MailcowSettings, type Policy, type Profile, type Secrets,
} from "./model";
import { PRESETS, seededPolicy, type Preset } from "./presets";
import { describeRecord, renderProfile, sameRecord } from "./records";
import { clpctlIssue, requestSsl, retryCertificates, type Issue, type SslRequest } from "./ssl";
import { readState, writeState } from "./store";
import { tokenTemplate, type TokenTemplate } from "./token";

export type DnsVerb = "list" | "check" | "save-profile" | "delete-profile" | "set-mode" | "assign" | "set-default" | "confirm"
  | "save-connection" | "remove-connection" | "choose-zone" | "save-mailcow" | "save-server" | "remove-records" | "forget-records"
  | "provision" | "reconcile" | "sync-sites";

const VERBS: DnsVerb[] = ["list", "check", "save-profile", "delete-profile", "set-mode", "assign", "set-default", "confirm",
  "save-connection", "remove-connection", "choose-zone", "save-mailcow", "save-server", "remove-records", "forget-records",
  "provision", "reconcile", "sync-sites"];
const NO_BODY: DnsVerb[] = ["list", "check", "provision", "reconcile", "sync-sites"];
const MAX_BODY = 256 * 1024;
const REVIEW_LIFETIME = 15 * 60_000;
/** CloudPanel's Certificate::TYPE_SELF_SIGNED. */
const SELF_SIGNED = "1";

export interface DnsPaths {
  configFile: string;
  panelDb: string;
  stateDir: string;
  lockFile: string;
  clpctl: string;
  rootUid: number;
}

export interface DnsActionOptions {
  paths?: Partial<DnsPaths>;
  input?: string;
  emitReply?: boolean;
  processUid?: number;
  fetch?: ApiFetch;
  /** Test fixtures may provide sites without a CloudPanel database. */
  sites?: () => PanelSite[];
  addresses?: () => Addresses;
  issue?: Issue;
  now?: () => number;
}

export const DEFAULT_DNS_PATHS: DnsPaths = {
  configFile: `${CONFIG_DIR}/dns.conf`,
  panelDb: PANEL_DB,
  stateDir: `${STATE_DIR}/dns`,
  lockFile: "/run/lock/clp-addons/dns.lock",
  clpctl: "/usr/bin/clpctl",
  rootUid: 0,
};

// ---------------------------------------------------------------------------
// What the page is sent
// ---------------------------------------------------------------------------

export interface SiteView {
  domain: string;
  type: string;
  profileId: string | null;
  plan: SitePlan | null;
  ssl: string | null;
}

export interface Review {
  token: string;
  title: string;
  text: string;
  sites: SitePlan[];
  /** Planning found problems, so there is nothing that can be confirmed yet. */
  blocked: boolean;
  confirmLabel: string;
  danger: boolean;
}

export interface DnsState {
  profiles: (Profile & { sites: number })[];
  defaultProfileId: string | null;
  sites: SiteView[];
  connections: (ConnectionReport & { hasToken: boolean })[];
  accounts: { connectionId: string; accountId: string; label: string }[];
  mailcow: MailcowSettings & { hasKey: boolean };
  server: { ipv4: string; ipv6: string; detected: Addresses };
  orphans: { domain: string; zone: string; records: number }[];
  checkedAt: string | null;
  waitUntil: number;
  token: TokenTemplate;
  presets: Preset[];
}

export type DnsReply = DnsState & { review?: Review; notice?: string };

export interface ProvisionReply {
  managed: boolean;
  ready: boolean;
  reason: string;
  certificateNames: string[];
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

interface Status {
  checkedAt: string | null;
  connections: ConnectionReport[];
  plans: Record<string, SitePlan>;
  backoff: { cloudflare: number; mailcow: number };
}

interface Pending {
  token: string;
  expiresAt: number;
  /** The policy the review was made against; a different one means the review no longer describes the change. */
  base: string;
  digest: string;
  domains: string[];
  policy?: Policy;
  /** A Mailcow key saved with `policy`, so it is not used before that policy is. */
  mailcowKey?: string;
  removal?: { domain: string; ids: string[] };
}

const emptyStatus = (): Status => ({ checkedAt: null, connections: [], plans: {}, backoff: { cloudflare: 0, mailcow: 0 } });
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);

class Files {
  constructor(private readonly paths: DnsPaths) {}

  private path(name: string): string {
    return `${this.paths.stateDir}/${name}.json`;
  }

  policy(): Policy {
    const raw = readState<unknown>(this.path("policy"), this.paths.rootUid, () => null);
    return raw === null ? seededPolicy() : parsePolicy(raw);
  }

  savePolicy(policy: Policy): void {
    writeState(this.path("policy"), parsePolicy(policy), this.paths.rootUid);
  }

  secrets(): Secrets {
    return parseSecrets(readState(this.path("secrets"), this.paths.rootUid, () => ({})));
  }

  saveSecrets(secrets: Secrets): void {
    writeState(this.path("secrets"), secrets, this.paths.rootUid);
  }

  status(): Status {
    return { ...emptyStatus(), ...readState<Partial<Status>>(this.path("status"), this.paths.rootUid, emptyStatus) };
  }

  saveStatus(status: Status): void {
    writeState(this.path("status"), status, this.paths.rootUid);
  }

  managed(): Record<string, ManagedRecords> {
    return readState(this.path("managed"), this.paths.rootUid, () => ({}));
  }

  saveManaged(managed: Record<string, ManagedRecords>): void {
    writeState(this.path("managed"), managed, this.paths.rootUid);
  }

  pending(): Pending | null {
    return readState<Pending | null>(this.path("pending"), this.paths.rootUid, () => null);
  }

  savePending(pending: Pending | null): void {
    writeState(this.path("pending"), pending, this.paths.rootUid);
  }

  ssl(): Record<string, SslRequest> {
    return readState(this.path("ssl"), this.paths.rootUid, () => ({}));
  }

  saveSsl(requests: Record<string, SslRequest>): void {
    writeState(this.path("ssl"), requests, this.paths.rootUid);
  }
}

// ---------------------------------------------------------------------------
// CloudPanel's sites
// ---------------------------------------------------------------------------

function columns(db: Database, table: string): Set<string> {
  return new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${table});`).all().map((row) => row.name));
}

/** CloudPanel stores UTC without saying so. */
function panelTime(value: unknown): number {
  const text = String(value ?? "").replace(" ", "T");
  const time = Date.parse(/Z$|[+-]\d\d:\d\d$/.test(text) ? text : `${text}Z`);
  return Number.isFinite(time) ? time : 0;
}

export function panelSites(panelDb: string): PanelSite[] {
  const db = new Database(panelDb, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const site = columns(db, "site");
    const certificate = site.has("certificate_id") && columns(db, "certificate").has("type");
    const rows = db.query<{ id: number; domain_name: string; type: string; created_at: string | null; cf: number | null; cert: string | null }, []>(
      `SELECT s.id, s.domain_name, s.type,
              ${site.has("created_at") ? "s.created_at" : "NULL"} AS created_at,
              ${site.has("allow_traffic_from_cloudflare_only") ? "s.allow_traffic_from_cloudflare_only" : "0"} AS cf,
              ${certificate ? "c.type" : "NULL"} AS cert
         FROM site s ${certificate ? "LEFT JOIN certificate c ON c.id = s.certificate_id" : ""}
        ORDER BY s.domain_name`,
    ).all();
    const sites: PanelSite[] = [];
    for (const row of rows) {
      let domain: string;
      try {
        domain = hostname(row.domain_name, "a site");
      } catch {
        continue;
      }
      sites.push({
        id: Number(row.id), domain, type: String(row.type), createdAt: panelTime(row.created_at),
        selfSigned: String(row.cert) === SELF_SIGNED, cloudflareOnly: Boolean(row.cf),
      });
    }
    return sites;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// One action invocation
// ---------------------------------------------------------------------------

class Action {
  readonly files: Files;
  readonly now: number;
  private cachedSites: PanelSite[] | null = null;
  private cachedAddresses: Addresses | null = null;
  private readonly runs: DnsRun[] = [];
  private mailcowTrial: MailcowApi | null = null;

  constructor(readonly paths: DnsPaths, readonly options: DnsActionOptions) {
    this.files = new Files(paths);
    this.now = options.now?.() ?? Date.now();
  }

  sites(fresh = false): PanelSite[] {
    if (!this.cachedSites || fresh) this.cachedSites = this.options.sites?.() ?? panelSites(this.paths.panelDb);
    return this.cachedSites;
  }

  addresses(): Addresses {
    this.cachedAddresses ??= this.options.addresses?.() ?? detectAddresses();
    return this.cachedAddresses;
  }

  site(domain: string): PanelSite {
    const site = this.sites().find((candidate) => candidate.domain === domain);
    if (!site) failAction(`CloudPanel has no site ${domain}`);
    return site;
  }

  private secretsWith(mailcowKey?: string): Secrets {
    const secrets = this.files.secrets();
    return mailcowKey === undefined ? secrets : { ...secrets, mailcowKey };
  }

  run(policy: Policy, secrets = this.files.secrets()): DnsRun {
    const run = new DnsRun({
      policy, secrets, sites: this.sites(), addresses: this.addresses(), fetch: this.options.fetch,
      backoff: this.files.status().backoff,
    });
    this.runs.push(run);
    return run;
  }

  rememberBackoff(): void {
    if (!this.runs.length && !this.mailcowTrial) return;
    const status = this.files.status();
    const backoff = { ...status.backoff };
    for (const run of this.runs) {
      const observed = run.backoff();
      backoff.cloudflare = Math.max(backoff.cloudflare, observed.cloudflare);
      backoff.mailcow = Math.max(backoff.mailcow, observed.mailcow);
    }
    backoff.mailcow = Math.max(backoff.mailcow, this.mailcowTrial?.http.backoff.until ?? 0);
    if (JSON.stringify(backoff) !== JSON.stringify(status.backoff)) this.files.saveStatus({ ...status, backoff });
  }

  /** Writes what a run found for `domains`, keeping what it did not look at. */
  record(run: DnsRun, plans: SitePlan[], domains: string[] | "all"): void {
    const status = this.files.status();
    const current = new Set(this.sites().map((site) => site.domain));
    const plansByDomain = domains === "all" ? {} : Object.fromEntries(Object.entries(status.plans).filter(([domain]) => current.has(domain)));
    for (const plan of plans) {
      if (domains !== "all" && !domains.includes(plan.domain)) continue;
      if (plan.profileId) plansByDomain[plan.domain] = plan;
      else delete plansByDomain[plan.domain];
    }
    this.files.saveStatus({
      ...status,
      checkedAt: domains === "all" ? new Date(this.now).toISOString() : status.checkedAt,
      connections: run.connections.length || domains === "all" ? run.connections : status.connections,
      plans: plansByDomain,
      backoff: run.backoff(),
    });
    const managed = this.files.managed();
    for (const [domain, entry] of Object.entries(run.managed(plans.filter((plan) => domains === "all" || domains.includes(plan.domain))))) {
      managed[domain] = entry;
    }
    this.files.saveManaged(managed);
  }

  state(): DnsState {
    const policy = this.files.policy();
    const secrets = this.files.secrets();
    const status = this.files.status();
    const ssl = this.files.ssl();
    const sites = this.sites();
    const domains = new Set(sites.map((site) => site.domain));
    const accounts = status.connections.flatMap((connection) => connection.accounts.map((account) => ({
      connectionId: connection.id, accountId: account.id, label: `${account.name || account.id} (${connection.label})`,
    })));
    const managed = this.files.managed();
    return {
      profiles: policy.profiles.map((profile) => ({
        ...profile, sites: Object.values(policy.assignments).filter((id) => id === profile.id).length,
      })),
      defaultProfileId: policy.defaultProfileId,
      sites: sites.map((site) => {
        const profileId = policy.assignments[site.domain] ?? null;
        const plan = status.plans[site.domain];
        const request = ssl[site.domain];
        return {
          domain: site.domain, type: site.type, profileId,
          plan: plan && plan.profileId === profileId ? plan : null,
          ssl: request && request.siteId === site.id ? request.state : null,
        };
      }),
      connections: policy.connections.map((connection) => {
        const report = status.connections.find((entry) => entry.id === connection.id);
        return {
          ...(report ?? { id: connection.id, active: false, status: "unchecked", accounts: [], zones: 0, error: null }),
          label: connection.label,
          hasToken: Boolean(secrets.cloudflare[connection.id]),
        };
      }),
      accounts,
      mailcow: { ...policy.mailcow, hasKey: Boolean(secrets.mailcowKey) },
      server: { ...policy.server, detected: this.addresses() },
      orphans: Object.entries(managed)
        .filter(([domain]) => !domains.has(domain))
        .map(([domain, entry]) => ({ domain, zone: entry.zoneName, records: entry.records.length })),
      checkedAt: status.checkedAt,
      waitUntil: Math.max(status.backoff.cloudflare, status.backoff.mailcow),
      token: tokenTemplate(policy.profiles),
      presets: PRESETS,
    };
  }

  reply(extra: { review?: Review; notice?: string } = {}): DnsReply {
    return { ...this.state(), ...extra };
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  /** Reads and plans `domains` without writing anything. */
  async refresh(domains: string[] | "all"): Promise<void> {
    const policy = this.files.policy();
    const assigned = this.sites().filter((site) => policy.assignments[site.domain]);
    const chosen = domains === "all" ? assigned : assigned.filter((site) => domains.includes(site.domain));
    if (!chosen.length && domains !== "all") return;
    const run = this.run(policy);
    await run.discover();
    await run.load(chosen.map((site) => site.domain));
    this.record(run, run.planAll(this.sites()), domains === "all" ? "all" : chosen.map((site) => site.domain));
  }

  /** Every site: read, enforce what enforces, and record the result. */
  async check(retrySsl: boolean): Promise<void> {
    const policy = this.adoptNewSites(this.files.policy());
    const run = this.run(policy);
    await run.discover();
    const assigned = this.sites().filter((site) => policy.assignments[site.domain]);
    await run.load(assigned.map((site) => site.domain));
    await run.enforce(assigned);
    const plans = run.planAll(this.sites());
    this.record(run, plans, "all");
    if (retrySsl) await this.retrySsl(plans);
  }

  /** Puts sites CloudPanel created since the last look into the default profile. */
  adoptNewSites(policy: Policy): Policy {
    const sites = this.sites();
    const known = new Set(policy.knownSiteIds);
    const next = structuredClone(policy);
    for (const site of sites) {
      if (!known.has(site.id) && next.defaultProfileId && !next.assignments[site.domain]) next.assignments[site.domain] = next.defaultProfileId;
    }
    for (const domain of Object.keys(next.assignments)) {
      if (!sites.some((site) => site.domain === domain)) delete next.assignments[domain];
    }
    next.knownSiteIds = sites.map((site) => site.id);
    if (JSON.stringify(next) !== JSON.stringify(policy)) this.files.savePolicy(next);
    return next;
  }

  async syncSites(): Promise<string[]> {
    const before = this.files.policy();
    const known = new Set(before.knownSiteIds);
    const added = this.sites().filter((site) => !known.has(site.id));
    const removed = Object.keys(before.assignments).some((domain) => !this.sites().some((site) => site.domain === domain));
    if (!added.length && !removed) return [];
    const policy = this.adoptNewSites(before);
    const joined = added.filter((site) => policy.assignments[site.domain]);
    if (!joined.length) return [];
    const run = this.run(policy);
    await run.discover();
    await run.load(joined.map((site) => site.domain));
    await run.enforce(joined);
    this.record(run, run.planAll(this.sites()), joined.map((site) => site.domain));
    return joined.map((site) => site.domain);
  }

  async provision(domain: string, ssl: boolean): Promise<ProvisionReply> {
    await this.syncSites();
    const site = this.site(domain);
    const policy = this.files.policy();
    const profile = policy.profiles.find((candidate) => candidate.id === policy.assignments[domain]);
    if (!profile || profile.mode !== "enforce") {
      return { managed: false, ready: false, reason: profile ? "Its DNS profile is Report only" : "No DNS profile is assigned to this site", certificateNames: [] };
    }
    if (ssl) {
      const requests = this.files.ssl();
      if (requestSsl(requests, site, this.now)) this.files.saveSsl(requests);
    }
    const run = this.run(policy);
    await run.discover();
    await run.load([domain]);
    await run.enforce([site]);
    const plans = run.planAll(this.sites());
    this.record(run, plans, [domain]);
    const plan = plans.find((candidate) => candidate.domain === domain);
    const ready = readiness(plan);
    return { managed: true, ...ready, certificateNames: ready.ready ? plan!.certificateNames : [] };
  }

  async retrySsl(plans: SitePlan[]): Promise<void> {
    const requests = this.files.ssl();
    if (!Object.keys(requests).length) return;
    await retryCertificates(
      requests, plans, () => this.sites(true), this.options.issue ?? clpctlIssue(this.paths.clpctl), this.now,
      () => this.files.saveSsl(requests),
    );
    this.files.saveSsl(requests);
  }

  // -------------------------------------------------------------------------
  // Reviews
  // -------------------------------------------------------------------------

  /** The enforcing sites whose records would change if `after` replaced `before`. */
  affected(before: Policy, after: Policy): string[] {
    const mailcowBefore = JSON.stringify(before.mailcow);
    const mailcowAfter = JSON.stringify(after.mailcow);
    return this.sites().map((site) => site.domain).filter((domain) => {
      const next = after.profiles.find((profile) => profile.id === after.assignments[domain]);
      if (!next || next.mode !== "enforce") return false;
      const previous = before.profiles.find((profile) => profile.id === before.assignments[domain]);
      if (!previous || previous.mode !== "enforce" || previous.id !== next.id) return true;
      if (profileEffect(previous) !== profileEffect(next)) return true;
      if (JSON.stringify(before.server) !== JSON.stringify(after.server)) return true;
      if (next.mailcow && mailcowBefore !== mailcowAfter) return true;
      return Object.keys({ ...before.zoneChoices, ...after.zoneChoices }).some((zone) =>
        (domain === zone || domain.endsWith(`.${zone}`)) && JSON.stringify(before.zoneChoices[zone]) !== JSON.stringify(after.zoneChoices[zone]));
    });
  }

  private digest(plans: SitePlan[]): string {
    return hash(plans.map((plan) => [plan.domain, plan.changes, plan.problems]));
  }

  /** Saves `next`, and a new Mailcow key with it, straight away, or answers with the review it needs first. */
  async change(next: Policy, notice: string, refresh: string[] | "all" = [], mailcowKey?: string): Promise<DnsReply> {
    const before = this.files.policy();
    const domains = this.affected(before, next);
    if (!domains.length) {
      this.files.savePolicy(next);
      if (mailcowKey !== undefined) this.files.saveSecrets(this.secretsWith(mailcowKey));
      this.files.savePending(null);
      await this.tryRefresh(refresh);
      return this.reply({ notice });
    }
    return this.review(before, next, domains, undefined, mailcowKey);
  }

  private async tryRefresh(domains: string[] | "all"): Promise<void> {
    try {
      await this.refresh(domains);
    } catch (error) {
      if (!(error instanceof ActionFailure)) throw error;
    }
  }

  private async review(before: Policy, next: Policy, domains: string[], notice?: string, mailcowKey?: string): Promise<DnsReply> {
    const run = this.run(next, this.secretsWith(mailcowKey));
    await run.discover();
    await run.load(domains);
    const plans = run.planAll(this.sites()).filter((plan) => domains.includes(plan.domain));
    const blocked = plans.some((plan) => plan.problems.length > 0);
    const token = blocked ? "" : randomBytes(24).toString("hex");
    this.files.savePending(blocked ? null : {
      token, expiresAt: this.now + REVIEW_LIFETIME, base: hash(before), digest: this.digest(plans), domains, policy: next, mailcowKey,
    });
    const changes = plans.reduce((count, plan) => count + plan.changes.filter((change) => change.action !== "note").length, 0);
    return this.reply({
      notice,
      review: {
        token,
        title: blocked ? "Resolve these first" : `Enforce on ${plans.length} site${plans.length === 1 ? "" : "s"}`,
        text: blocked
          ? "Enforcing cannot start while a site below has a problem. Fix it, or take the site out of this profile."
          : `${changes} change${changes === 1 ? "" : "s"} will be made now, and the profile will keep these records as they are from then on. Records at names the profile does not write are left alone.`,
        sites: plans,
        blocked,
        confirmLabel: "Confirm and enforce",
        danger: plans.some((plan) => plan.changes.some((change) => change.action === "delete")),
      },
    });
  }

  async confirm(token: unknown): Promise<DnsReply> {
    const pending = this.files.pending();
    const current = this.files.policy();
    if (!pending || typeof token !== "string" || !token || pending.token !== token || pending.expiresAt < this.now) {
      failAction("This review has expired; make the change again to see a fresh plan");
    }
    if (pending.base !== hash(current)) failAction("The settings changed after this review; make the change again to see a fresh plan");
    if (pending.removal) return this.confirmRemoval(pending);
    const next = parsePolicy(pending.policy);
    const run = this.run(next, this.secretsWith(pending.mailcowKey));
    await run.discover();
    await run.load(pending.domains);
    const plans = run.planAll(this.sites()).filter((plan) => pending.domains.includes(plan.domain));
    if (this.digest(plans) !== pending.digest) {
      return this.review(current, next, pending.domains, "Cloudflare or Mailcow changed after the plan was shown. This is the plan now.", pending.mailcowKey);
    }
    this.files.savePolicy(next);
    if (pending.mailcowKey !== undefined) this.files.saveSecrets(this.secretsWith(pending.mailcowKey));
    this.files.savePending(null);
    await run.enforce(this.sites().filter((site) => pending.domains.includes(site.domain)));
    this.record(run, run.planAll(this.sites()), pending.domains);
    return this.reply({ notice: `Enforcing on ${pending.domains.length} site${pending.domains.length === 1 ? "" : "s"}.` });
  }

  /** The tracked records of a site CloudPanel no longer has, that are unchanged and no current site writes. */
  private async removable(domain: string): Promise<{ run: DnsRun; entry: ManagedRecords; ids: string[]; plans: SitePlan[] }> {
    const entry = this.files.managed()[domain];
    if (!entry) failAction(`DNS tracks no records for ${domain}`);
    if (this.sites().some((site) => site.domain === domain)) failAction(`${domain} is still a CloudPanel site`);
    const policy = this.files.policy();
    const run = this.run(policy);
    await run.discover();
    const assigned = this.sites().filter((site) => policy.assignments[site.domain]).map((site) => site.domain);
    await run.load(assigned);
    const currentPlans = run.planAll(this.sites());
    if (run.unread(entry.zoneId)) failAction(`${entry.zoneName} could not be read for the sites in it; check again before removing records`);
    const uncertain = currentPlans.some((plan) => plan.profileId && plan.problems.length
      && (plan.zone ? plan.zone.id === entry.zoneId : plan.domain === entry.zoneName || plan.domain.endsWith(`.${entry.zoneName}`)));
    if (uncertain) failAction(`${entry.zoneName} could not be planned for the sites in it; resolve their problems before removing records`);
    const published = await run.readZone(entry.connectionId, entry.zoneId);
    const ids = entry.records
      .filter((tracked) => published.some((record) => record.id === tracked.id && sameRecord(record, tracked)
        && record.comment === tracked.comment))
      .filter((tracked) => !run.stillWanted(tracked))
      .map((tracked) => tracked.id);
    const plans: SitePlan[] = [{
      domain, profileId: null, mode: "enforce", zone: null, problems: [], zoneChoices: [], certificateNames: [],
      changes: entry.records.filter((tracked) => ids.includes(tracked.id)).map((tracked) => ({
        action: "delete", subject: `${tracked.type} ${tracked.name}`, detail: describeRecord(tracked),
      })),
    }];
    return { run, entry, ids, plans };
  }

  async reviewRemoval(domain: string): Promise<DnsReply> {
    const { entry, ids, plans } = await this.removable(domain);
    const skipped = entry.records.length - ids.length;
    const token = randomBytes(24).toString("hex");
    this.files.savePending({
      token, expiresAt: this.now + REVIEW_LIFETIME, base: hash(this.files.policy()), digest: this.digest(plans), domains: [], removal: { domain, ids },
    });
    return this.reply({
      review: {
        token,
        title: `Remove ${domain}'s records`,
        text: `${ids.length} record${ids.length === 1 ? "" : "s"} in ${entry.zoneName} will be deleted.${skipped ? ` ${skipped} other${skipped === 1 ? " was" : "s were"} changed in Cloudflare or ${skipped === 1 ? "is" : "are"} written by another site, and ${skipped === 1 ? "stays" : "stay"}.` : ""} The zone and Mailcow are not touched.`,
        sites: plans,
        blocked: ids.length === 0,
        confirmLabel: "Remove records",
        danger: true,
      },
    });
  }

  private async confirmRemoval(pending: Pending): Promise<DnsReply> {
    const { domain } = pending.removal!;
    const { run, entry, ids, plans } = await this.removable(domain);
    if (this.digest(plans) !== pending.digest) return this.reviewRemoval(domain);
    this.files.savePending(null);
    await run.deleteRecords(entry.connectionId, entry.zoneId, ids);
    const managed = this.files.managed();
    delete managed[domain];
    this.files.saveManaged(managed);
    return this.reply({ notice: `Removed ${ids.length} record${ids.length === 1 ? "" : "s"} of ${domain}.` });
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  /** Checks rows the way a real site would use them, at an apex and in a subdomain. */
  checkProfile(profile: Profile): void {
    for (const domain of ["example.com", "shop.example.com"]) {
      const rendered = renderProfile(profile, {
        domain, zone: "example.com", ipv4: "192.0.2.10", ipv6: "2001:db8::10", mailcowHost: "mail.example.net",
        mailcowSelector: "dkim", mailcowDkim: "v=DKIM1;k=rsa;p=TUlJQklq",
      });
      if (rendered.problems.length) failAction(rendered.problems[0]!.replace(/example\.com/g, "the site's domain"));
    }
  }

  async saveConnection(body: Record<string, unknown>): Promise<DnsReply> {
    const policy = this.files.policy();
    const secrets = this.files.secrets();
    const existing = body.id ? policy.connections.find((connection) => connection.id === connectionId(body.id)) : undefined;
    if (body.id && !existing) failAction("That connection no longer exists");
    const token = body.token ? secretText(body.token, "The API token") : existing ? secrets.cloudflare[existing.id] : undefined;
    if (!token) failAction("Paste the API token Cloudflare showed you");
    if (Object.entries(secrets.cloudflare).some(([id, saved]) => saved === token && id !== existing?.id)) failAction("That token is already saved as another connection");

    const id = existing?.id ?? `cf-${randomBytes(4).toString("hex")}`;
    const trial: Policy = { ...structuredClone(policy), connections: [{ id, label: "Checking" }] };
    const run = this.run(trial, { cloudflare: { [id]: token }, mailcowKey: "" });
    await run.discover();
    const report = run.connections[0]!;
    if (!report.active) failAction(redact(`Cloudflare did not accept this token: ${(report.error ?? report.status).replace(/^Cloudflare: /, "")}`, [token]));
    const named = oneLine(body.label, "the connection name", 40, false);
    const label = named || report.accounts.map((account) => account.name).filter(Boolean).join(", ").slice(0, 40) || "Cloudflare";

    const next = structuredClone(policy);
    if (existing) next.connections = next.connections.map((connection) => connection.id === id ? { id, label } : connection);
    else next.connections.push({ id, label });
    this.files.saveSecrets({ ...secrets, cloudflare: { ...secrets.cloudflare, [id]: token } });
    this.files.savePolicy(next);
    await this.tryRefresh("all");
    const zones = `${report.zones} zone${report.zones === 1 ? "" : "s"}`;
    return this.reply({ notice: `${label} reaches ${report.accounts.length} account${report.accounts.length === 1 ? "" : "s"} and ${zones}.` });
  }

  async removeConnection(id: string): Promise<DnsReply> {
    const policy = this.files.policy();
    if (!policy.connections.some((connection) => connection.id === id)) failAction("That connection no longer exists");
    const next = structuredClone(policy);
    next.connections = next.connections.filter((connection) => connection.id !== id);
    for (const [zone, choice] of Object.entries(next.zoneChoices)) if (choice.connectionId === id) delete next.zoneChoices[zone];
    for (const profile of next.profiles) if (profile.zone.createIn?.connectionId === id) profile.zone.createIn = null;
    const secrets = this.files.secrets();
    delete secrets.cloudflare[id];
    this.files.saveSecrets(secrets);
    this.files.savePolicy(next);
    const status = this.files.status();
    this.files.saveStatus({ ...status, connections: status.connections.filter((connection) => connection.id !== id) });
    await this.tryRefresh("all");
    return this.reply({ notice: "Connection removed. Its token stays valid in Cloudflare until you delete it there." });
  }

  async saveMailcow(body: Record<string, unknown>): Promise<DnsReply> {
    const policy = this.files.policy();
    const secrets = this.files.secrets();
    const settings = parseMailcow(body);
    if (!settings.url) failAction("Enter Mailcow's address, such as https://mail.example.com");
    if (!settings.host) settings.host = new URL(settings.url).hostname;
    // A saved key is kept only for the Mailcow it was saved for.
    const key = body.key ? secretText(body.key, "The Mailcow API key") : settings.url === policy.mailcow.url ? secrets.mailcowKey : "";
    if (!key) failAction("Enter Mailcow's API key");
    const api = new MailcowApi(settings.url, key, this.options.fetch, { until: this.files.status().backoff.mailcow });
    this.mailcowTrial = api;
    try {
      if (settings.sharedMailbox) await api.senderAcl(settings.sharedMailbox);
      else await api.hasDomain(settings.host);
    } catch (error) {
      failAction(redact(reason(error), [key]));
    }
    const next = { ...structuredClone(policy), mailcow: settings };
    const mailcowSites = this.sites().filter((site) => next.profiles.find((profile) => profile.id === next.assignments[site.domain])?.mailcow);
    return this.change(next, "Mailcow saved.", mailcowSites.map((site) => site.domain), key);
  }
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

function profileById(policy: Policy, id: unknown): Profile {
  const profile = policy.profiles.find((candidate) => candidate.id === profileId(id));
  if (!profile) failAction("That profile no longer exists");
  return profile;
}

function sitesOf(policy: Policy, id: string): string[] {
  return Object.entries(policy.assignments).filter(([, assigned]) => assigned === id).map(([domain]) => domain);
}

async function changeVerb(action: Action, verb: DnsVerb, body: Record<string, unknown>): Promise<DnsReply> {
  const policy = action.files.policy();
  const next = structuredClone(policy);

  if (verb === "save-profile") {
    const existing = body.id ? profileById(policy, body.id) : null;
    const taken = new Set(policy.profiles.map((profile) => profile.id));
    let id = existing?.id ?? nameSlug(String(body.name ?? ""), "the profile name");
    for (let n = 2; !existing && taken.has(id); n++) id = `${nameSlug(String(body.name), "the profile name", 36)}-${n}`;
    const profile = parseProfile({ ...body, id, mode: existing?.mode ?? "report" });
    action.checkProfile(profile);
    if (existing) next.profiles = next.profiles.map((candidate) => candidate.id === id ? profile : candidate);
    else next.profiles.push(profile);
    return action.change(next, existing ? `Saved ${profile.name}.` : `Created ${profile.name}. It starts in Report only.`, sitesOf(next, id));
  }
  if (verb === "delete-profile") {
    const profile = profileById(policy, body.id);
    next.profiles = next.profiles.filter((candidate) => candidate.id !== profile.id);
    for (const domain of sitesOf(next, profile.id)) delete next.assignments[domain];
    if (next.defaultProfileId === profile.id) next.defaultProfileId = null;
    return action.change(next, `Deleted ${profile.name}. Its sites' DNS is left as it is.`);
  }
  if (verb === "set-mode") {
    const profile = next.profiles.find((candidate) => candidate.id === profileById(policy, body.id).id)!;
    if (body.mode !== "report" && body.mode !== "enforce") failAction("The mode must be Report only or Enforce");
    profile.mode = body.mode;
    return action.change(next, body.mode === "enforce" ? `${profile.name} enforces.` : `${profile.name} is Report only. Nothing in Cloudflare or Mailcow was changed.`);
  }
  if (verb === "assign") {
    if (!Array.isArray(body.domains) || !body.domains.length) failAction("Select at least one site");
    const id = body.profileId == null || body.profileId === "" ? null : profileById(policy, body.profileId).id;
    const domains = body.domains.map((domain) => action.site(hostname(domain, "a site")).domain);
    for (const domain of domains) {
      if (id) next.assignments[domain] = id;
      else delete next.assignments[domain];
    }
    // A site placed by hand is not a new site for the default to claim.
    next.knownSiteIds = [...new Set([...next.knownSiteIds, ...domains.map((domain) => action.site(domain).id)])];
    const name = id ? next.profiles.find((profile) => profile.id === id)!.name : "no profile";
    return action.change(next, `${domains.length} site${domains.length === 1 ? "" : "s"} now in ${name}.`, id ? domains : []);
  }
  if (verb === "set-default") {
    next.defaultProfileId = body.profileId == null || body.profileId === "" ? null : profileById(policy, body.profileId).id;
    // The sites that exist now are not new sites, so a default never reaches back over them.
    next.knownSiteIds = action.sites().map((site) => site.id);
    return action.change(next, next.defaultProfileId ? "New sites will join this profile." : "New sites will not join a profile.");
  }
  if (verb === "choose-zone") {
    const zone = hostname(body.zone, "the zone");
    next.zoneChoices[zone] = { connectionId: connectionId(body.connectionId), zoneId: cloudflareId(body.zoneId, "the zone") };
    const inZone = action.sites().map((site) => site.domain).filter((domain) => domain === zone || domain.endsWith(`.${zone}`));
    return action.change(next, `${zone} is managed through the chosen connection.`, inZone);
  }
  if (verb === "save-server") {
    next.server = { ipv4: ipAddress(body.ipv4, 4, "The IPv4 address"), ipv6: ipAddress(body.ipv6, 6, "The IPv6 address") };
    return action.change(next, "Server addresses saved.", "all");
  }
  failAction(`unknown DNS change '${verb}'`);
}

async function bodyOf(options: DnsActionOptions): Promise<Record<string, unknown>> {
  const raw = options.input ?? await Bun.stdin.text();
  if (Buffer.byteLength(raw) > MAX_BODY) failAction("DNS request is too large");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    failAction("DNS request must be JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) failAction("DNS request must be an object");
  return value as Record<string, unknown>;
}

function provisionArguments(args: string[]): { domain: string; asUser: string; ssl: boolean } {
  let domain = "";
  let asUser = "";
  let ssl = false;
  for (const arg of args) {
    if (arg.startsWith("--domain=")) domain = hostname(arg.slice("--domain=".length), "the site");
    else if (arg.startsWith("--as-user=")) asUser = arg.slice("--as-user=".length);
    else if (arg === "--ssl") ssl = true;
    else failAction(`unexpected argument '${arg}'`);
  }
  if (!domain) failAction("provision needs --domain");
  if (asUser && !PANEL_USER_NAME_RE.test(asUser)) failAction("that is not a valid panel user name");
  return { domain, asUser, ssl };
}

export async function executeDnsAction(argv: string[], options: DnsActionOptions = {}): Promise<unknown> {
  if ((options.processUid ?? process.getuid?.()) !== 0) failAction("DNS actions must run as root");
  const [rawVerb, ...args] = argv;
  const verb = VERBS.find((candidate) => candidate === rawVerb);
  if (!verb) failAction(`usage: clp-addons action dns {${VERBS.join("|")}}`);
  if (verb !== "provision" && args.length) failAction(`'${verb}' takes no arguments`);
  const paths = { ...DEFAULT_DNS_PATHS, ...options.paths };
  const provision = verb === "provision" ? provisionArguments(args) : null;
  const body = NO_BODY.includes(verb) ? {} : await bodyOf(options);
  const action = new Action(paths, options);
  if (verb === "list") return action.state();

  if (provision?.asUser) {
    const db = new Database(paths.panelDb, { readonly: true });
    try {
      if (!panelUserOwnsSite(db, provision.asUser, provision.domain)) failAction("That site is not one of yours");
    } finally {
      db.close();
    }
  }

  mkdirSync(dirname(paths.lockFile), { recursive: true, mode: 0o700 });
  // Long enough for a check of the whole fleet; a page action waits less and says so.
  const wait = verb === "reconcile" || verb === "sync-sites" || verb === "provision" ? 240 : 30;
  return withFileLock(paths.lockFile, wait, "DNS is busy checking Cloudflare; try again in a moment", async () => {
    if ((verb === "reconcile" || verb === "sync-sites") && !existsSync(paths.configFile)) return { checked: 0, joined: [] };
    try {
      return await perform(action, verb, body, provision);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const secrets = action.files.secrets();
      const message = redact(error.message, [...Object.values(secrets.cloudflare), secrets.mailcowKey]);
      if (message === error.message) throw error;
      failAction(message);
    } finally {
      action.rememberBackoff();
    }
  });
}

async function perform(
  action: Action, verb: DnsVerb, body: Record<string, unknown>, provision: ReturnType<typeof provisionArguments> | null,
): Promise<unknown> {
  switch (verb) {
    case "check":
      await action.check(false);
      return action.reply({ notice: "Checked every site." });
    case "reconcile":
      await action.check(true);
      return { checked: action.sites().length };
    case "sync-sites":
      return { joined: await action.syncSites() };
    case "provision":
      return action.provision(provision!.domain, provision!.ssl);
    case "confirm":
      return action.confirm(body.token);
    case "save-connection":
      return action.saveConnection(body);
    case "remove-connection":
      return action.removeConnection(connectionId(body.id));
    case "save-mailcow":
      return action.saveMailcow(body);
    case "remove-records":
      return action.reviewRemoval(hostname(body.domain, "the site"));
    case "forget-records": {
      const domain = hostname(body.domain, "the site");
      const managed = action.files.managed();
      if (action.sites().some((site) => site.domain === domain)) failAction(`${domain} is still a CloudPanel site`);
      delete managed[domain];
      action.files.saveManaged(managed);
      return action.reply({ notice: `${domain}'s records are kept in Cloudflare and no longer listed here.` });
    }
    default:
      return changeVerb(action, verb, body);
  }
}

export async function runDnsAction(argv: string[], options: DnsActionOptions = {}): Promise<number> {
  try {
    const result = await executeDnsAction(argv, options);
    if (options.emitReply !== false) emitActionOk(result);
    return 0;
  } catch (error) {
    if (options.emitReply !== false) emitActionError(reason(error), error instanceof ActionFailure ? error.data : undefined, "dns");
    return 1;
  }
}
