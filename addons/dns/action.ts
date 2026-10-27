/**
 * DNS's privileged verbs. Only these read the Cloudflare tokens and the
 * Mailcow key, and nothing they return to the manager contains either.
 *
 * Changes that alter what DNS writes once it is Automatic -- turning that on
 * included -- are not saved straight away: they come back as a review of every
 * create, update and delete they would make, and only a confirmation of that
 * same plan saves and applies them.
 */
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  ActionFailure, emitActionError, emitActionOk, failAction, nameSlug, oneLine, withFileLock,
} from "../../cli/action-common";
import { queueAddonPass } from "../../cli/job-store";
import { CONFIG_DIR, PANEL_DB, STATE_DIR } from "../../cli/paths";
import { DEFAULT_SITE_VHOST_PATHS } from "../../cli/site-vhost";
import { PANEL_USER_NAME_RE, panelUserOwnsSite } from "../../lib/panel-users";
import { DEFAULT_SMTP_PATHS, smtpRelayAccounts, type SmtpRelayAccount } from "../smtp/action";
import { detectAddresses, type Addresses } from "./addresses";
import { DnsRun, readiness, type ConnectionReport, type LogEntry, type ManagedRecords, type PanelSite, type SitePlan, type StandIns } from "./engine";
import { type ApiFetch, redact } from "./http";
import { MailcowApi } from "./mailcow";
import {
  connectionId, hostname, parseAccountRef, parseMailcow, parsePolicy, parseProfile, parseRedirect, parseRedirects, parseSecrets, profileEffect,
  profileId, secretText, ipAddress, cloudflareId, EMPTY_MAILCOW, MAX_CONNECTIONS, type MailcowSettings, type Policy, type Profile, type Redirect,
  type Secrets,
} from "./model";
import { PRESETS, seededPolicy, type Preset } from "./presets";
import { describeRecord, renderProfile, sameRecord } from "./records";
import { foundRedirect, REDIRECT_PHASE, type FoundRedirect } from "./redirects";
import { clpctlStandIns, readStandIns, retryStandInCertificates, type StandInPaths } from "./stand-in";
import { clpctlIssue, NEW_SITE_WINDOW, requestSsl, retryCertificates, type Issue, type SslRequest } from "./ssl";
import { readState, writeState } from "./store";
import { tokenTemplate, type TokenTemplate } from "./token";

export type DnsVerb = "list" | "check" | "save-profile" | "delete-profile" | "set-automatic" | "zone-account" | "assign" | "set-default" | "confirm"
  | "save-connection" | "remove-connection" | "choose-zone" | "save-mailcow" | "remove-mailcow" | "save-server" | "remove-records" | "forget-records"
  | "save-redirect" | "delete-redirect" | "find-redirects" | "take-over" | "provision" | "site-status" | "reconcile" | "sync-sites";

const VERBS: DnsVerb[] = ["list", "check", "save-profile", "delete-profile", "set-automatic", "zone-account", "assign", "set-default", "confirm",
  "save-connection", "remove-connection", "choose-zone", "save-mailcow", "remove-mailcow", "save-server", "remove-records", "forget-records",
  "save-redirect", "delete-redirect", "find-redirects", "take-over", "provision", "site-status", "reconcile", "sync-sites"];
const NO_BODY: DnsVerb[] = ["list", "check", "find-redirects", "provision", "site-status", "reconcile", "sync-sites"];
const MAX_BODY = 256 * 1024;
const REVIEW_LIFETIME = 15 * 60_000;
/** How many writes the change log keeps, newest first; the page is sent the first PAGE_LOG of them. */
const MAX_LOG = 1000;
const PAGE_LOG = 200;
/** CloudPanel's Certificate::TYPE_SELF_SIGNED. */
const SELF_SIGNED = "1";

export interface DnsPaths {
  configFile: string;
  panelDb: string;
  stateDir: string;
  /** SMTP Relay's configuration, read only for the relay accounts the Mailcow form offers. */
  smtpConfig: string;
  lockFile: string;
  clpctl: string;
  sqlite3: string;
  nginxVhostDir: string;
  tempDir: string;
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
  /** Test fixtures may stand in for CloudPanel's stand-in sites. */
  standIns?: () => StandIns;
}

export const DEFAULT_DNS_PATHS: DnsPaths = {
  configFile: `${CONFIG_DIR}/dns.conf`,
  panelDb: PANEL_DB,
  stateDir: `${STATE_DIR}/dns`,
  smtpConfig: DEFAULT_SMTP_PATHS.stateFile,
  lockFile: "/run/lock/clp-addons/dns.lock",
  clpctl: "/usr/bin/clpctl",
  sqlite3: DEFAULT_SITE_VHOST_PATHS.sqlite3,
  nginxVhostDir: DEFAULT_SITE_VHOST_PATHS.nginxVhostDir,
  tempDir: DEFAULT_SITE_VHOST_PATHS.tempDir,
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
  /** A redirect domain, and whether a stand-in site on this server serves it now. */
  redirect?: Redirect & { standIn: boolean };
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

/** A write DNS made, and what made it. */
export type LogLine = LogEntry & { cause: string };

export interface DnsState {
  automatic: boolean;
  createIn: Policy["createIn"];
  profiles: (Profile & { sites: number })[];
  defaultProfileId: string | null;
  sites: SiteView[];
  connections: (ConnectionReport & { hasToken: boolean })[];
  accounts: { connectionId: string; accountId: string; label: string }[];
  mailcow: MailcowSettings & { hasKey: boolean };
  /** SMTP Relay's accounts, which the Mailcow form can be filled from. */
  smtpRelays: SmtpRelayAccount[];
  server: { ipv4: string; ipv6: string; detected: Addresses };
  orphans: { domain: string; zone: string; records: number }[];
  checkedAt: string | null;
  waitUntil: number;
  token: TokenTemplate;
  presets: Preset[];
  /** Newest first. */
  log: LogLine[];
}

/** Whole-host redirect rules in reachable zones that no redirect domain manages yet. */
export interface Found {
  redirects: FoundRedirect[];
  /** Zones that could not be read, and why. */
  notes: string[];
}

export type DnsReply = DnsState & { review?: Review; notice?: string; found?: Found };

/** What a site's own pages may show anyone who can open them: its zone, and the nameservers it waits for. */
export interface SiteDnsStatus {
  zone: string | null;
  status: string | null;
  /** Only while the zone waits for them; an active zone needs nothing set. */
  nameServers: string[];
  /**
   * What happens to the certificate once the zone is active: DNS requests it,
   * the site's own users have to, or it already has a real one.
   */
  certificate: "automatic" | "manual" | "installed";
}

export interface ProvisionReply {
  managed: boolean;
  ready: boolean;
  reason: string;
  /** Only while the site's zone waits for its nameservers, for the page to show them. */
  zone?: string;
  nameServers?: string[];
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

  log(): LogLine[] {
    return readState<LogLine[]>(this.path("log"), this.paths.rootUid, () => []);
  }

  appendLog(lines: LogLine[]): void {
    if (!lines.length) return;
    writeState(this.path("log"), [...lines.reverse(), ...this.log()].slice(0, MAX_LOG), this.paths.rootUid);
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
  private cachedStandIns: StandIns | null = null;
  private cachedAddresses: Addresses | null = null;
  private readonly runs: DnsRun[] = [];
  private mailcowTrial: MailcowApi | null = null;
  /** What the change log says made this invocation's writes. */
  cause = "Scheduled check";

  constructor(readonly paths: DnsPaths, readonly options: DnsActionOptions) {
    this.files = new Files(paths);
    this.now = options.now?.() ?? Date.now();
  }

  /** CloudPanel's sites as the panel lists them, stand-ins included. */
  panelSites(fresh = false): PanelSite[] {
    if (!this.cachedSites || fresh) this.cachedSites = this.options.sites?.() ?? panelSites(this.paths.panelDb);
    return this.cachedSites;
  }

  /** CloudPanel's sites, without the stand-ins that serve redirects. */
  sites(fresh = false): PanelSite[] {
    const standIns = new Set([...Object.keys(readStandIns(this.standInPaths())), ...Object.keys(this.standIns().current)]);
    return this.panelSites(fresh).filter((site) => !standIns.has(site.domain));
  }

  standInPaths(): StandInPaths {
    const { panelDb, sqlite3, nginxVhostDir, tempDir } = this.paths;
    return { file: `${this.paths.stateDir}/standins.json`, clpctl: this.paths.clpctl, vhost: { panelDb, sqlite3, nginxVhostDir, tempDir }, rootUid: this.paths.rootUid };
  }

  standIns(): StandIns {
    this.cachedStandIns ??= this.options.standIns?.()
      ?? clpctlStandIns(this.standInPaths(), (domain) => this.panelSites(true).some((site) => site.domain === domain), () => Date.now());
    return this.cachedStandIns;
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
      backoff: this.files.status().backoff, standIns: this.standIns(),
    });
    this.runs.push(run);
    return run;
  }

  /** Appends what every run wrote, so writes made before a failure are logged too. */
  writeLog(): void {
    this.files.appendLog(this.runs.flatMap((run) => run.log.splice(0).map((entry) => ({ ...entry, cause: this.cause }))));
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

  /**
   * Saves `next`, and forgets what was written for a current site it no longer
   * enforces: those records are the site's own again, as taking it out of a
   * profile promises, so they are never offered for removal once it is deleted.
   */
  private savePolicy(next: Policy): void {
    this.files.savePolicy(next);
    const managed = this.files.managed();
    let forgot = false;
    for (const site of this.sites()) {
      if (!managed[site.domain] || (next.automatic && next.assignments[site.domain])) continue;
      delete managed[site.domain];
      forgot = true;
    }
    // A deleted site that became a redirect domain keeps its records: they are the redirect's now.
    for (const redirect of next.redirects) {
      if (!managed[redirect.source]) continue;
      delete managed[redirect.source];
      forgot = true;
    }
    if (forgot) this.files.saveManaged(managed);
  }

  /** Writes what a run found for `domains`, keeping what it did not look at. */
  record(run: DnsRun, plans: SitePlan[], domains: string[] | "all"): void {
    const status = this.files.status();
    const current = new Set(run.entries.map((site) => site.domain));
    const plansByDomain = domains === "all" ? {} : Object.fromEntries(Object.entries(status.plans).filter(([domain]) => current.has(domain)));
    for (const plan of plans) {
      if (domains !== "all" && !domains.includes(plan.domain)) continue;
      if (plan.profileId || plan.redirect) plansByDomain[plan.domain] = plan;
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
    const domains = new Set([...sites.map((site) => site.domain), ...policy.redirects.map((redirect) => redirect.source)]);
    const standIns = this.standIns().current;
    const accounts = status.connections.flatMap((connection) => connection.accounts.map((account) => ({
      connectionId: connection.id, accountId: account.id, label: `${account.name || account.id} (${connection.label})`,
    })));
    const managed = this.files.managed();
    return {
      automatic: policy.automatic,
      createIn: policy.createIn,
      profiles: policy.profiles.map((profile) => ({
        ...profile,
        sites: Object.values(policy.assignments).filter((id) => id === profile.id).length
          + policy.redirects.filter((redirect) => redirect.profileId === profile.id).length,
      })),
      defaultProfileId: policy.defaultProfileId,
      sites: [
        ...sites.filter((site) => !policy.redirects.some((redirect) => redirect.source === site.domain)).map((site): SiteView => {
          const profileId = policy.assignments[site.domain] ?? null;
          const plan = status.plans[site.domain];
          const request = ssl[site.domain];
          return {
            domain: site.domain, type: site.type, profileId,
            plan: plan && !plan.redirect && plan.profileId === profileId ? plan : null,
            ssl: request && request.siteId === site.id ? request.state : null,
          };
        }),
        ...policy.redirects.map((redirect): SiteView => {
          const plan = status.plans[redirect.source];
          return {
            domain: redirect.source, type: "redirect", profileId: redirect.profileId,
            plan: plan?.redirect && plan.profileId === redirect.profileId ? plan : null, ssl: null,
            redirect: { ...redirect, standIn: Boolean(standIns[redirect.source]) },
          };
        }),
      ].sort((a, b) => a.domain.localeCompare(b.domain)),
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
      smtpRelays: smtpRelayAccounts(this.paths.smtpConfig, this.paths.rootUid),
      server: { ...policy.server, detected: this.addresses() },
      orphans: Object.entries(managed)
        .filter(([domain]) => !domains.has(domain))
        .map(([domain, entry]) => ({ domain, zone: entry.zoneName, records: entry.records.length })),
      checkedAt: status.checkedAt,
      waitUntil: Math.max(status.backoff.cloudflare, status.backoff.mailcow),
      token: tokenTemplate(policy.profiles),
      presets: PRESETS,
      log: this.files.log().slice(0, PAGE_LOG),
    };
  }

  reply(extra: { review?: Review; notice?: string; found?: Found } = {}): DnsReply {
    this.writeLog();
    return { ...this.state(), ...extra };
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  /** Reads and plans `domains` without writing anything. */
  async refresh(domains: string[] | "all"): Promise<void> {
    const policy = this.files.policy();
    const run = this.run(policy);
    const planned = run.plannedDomains();
    const chosen = domains === "all" ? planned : planned.filter((domain) => domains.includes(domain));
    if (!chosen.length && domains !== "all") return;
    await run.discover();
    await run.load(chosen);
    this.record(run, run.planAll(), domains === "all" ? "all" : chosen);
  }

  /** Every site: read, write what Automatic writes, and record the result. */
  async check(retrySsl: boolean): Promise<void> {
    const before = this.files.policy();
    const policy = this.adoptNewSites(before);
    const run = this.run(policy);
    await run.discover();
    const planned = run.plannedDomains();
    await run.load(planned);
    this.hold(run, policy, this.joined(before, policy).map((site) => site.domain));
    const released = run.releaseHeld();
    if (released.length) {
      policy.held = policy.held.filter((domain) => !released.includes(domain));
      this.savePolicy(policy);
    }
    await run.enforce(planned);
    const plans = run.planAll();
    this.record(run, plans, "all");
    if (retrySsl) {
      await this.retrySsl(plans);
      await this.retryStandInCertificates();
    }
  }

  /** Puts sites CloudPanel created since the last look into the default profile. */
  adoptNewSites(policy: Policy): Policy {
    const sites = this.sites();
    // An empty read is a panel database being restored, not every site deleted.
    if (!sites.length) return policy;
    const known = new Set(policy.knownSiteIds);
    const next = structuredClone(policy);
    for (const site of sites) {
      if (!known.has(site.id) && next.defaultProfileId && !next.assignments[site.domain]) next.assignments[site.domain] = next.defaultProfileId;
    }
    for (const domain of Object.keys(next.assignments)) {
      if (!sites.some((site) => site.domain === domain)) delete next.assignments[domain];
    }
    next.knownSiteIds = sites.map((site) => site.id);
    next.held = next.held.filter((domain) => next.assignments[domain] || next.redirects.some((redirect) => redirect.source === domain));
    if (JSON.stringify(next) !== JSON.stringify(policy)) this.savePolicy(next);
    return next;
  }

  /** The sites `adoptNewSites` put in a profile. */
  private joined(before: Policy, after: Policy): PanelSite[] {
    const known = new Set(before.knownSiteIds);
    return this.sites().filter((site) => !known.has(site.id) && after.assignments[site.domain] && !before.assignments[site.domain]);
  }

  /**
   * Creating a site points its names here, so a new site's own address records
   * are written straight away. Anything more its profile would change in the
   * zone waits until an administrator reviews the site.
   */
  private hold(run: DnsRun, policy: Policy, domains: string[]): void {
    const held = run.holdForReview(domains);
    if (!held.length) return;
    policy.held = [...policy.held, ...held];
    this.savePolicy(policy);
  }

  async syncSites(): Promise<string[]> {
    const before = this.files.policy();
    const known = new Set(before.knownSiteIds);
    const added = this.sites().filter((site) => !known.has(site.id));
    const removed = Object.keys(before.assignments).some((domain) => !this.sites().some((site) => site.domain === domain));
    if (!added.length && !removed) return [];
    const policy = this.adoptNewSites(before);
    const joined = this.joined(before, policy);
    if (!joined.length) return [];
    const run = this.run(policy);
    await run.discover();
    await run.load(joined.map((site) => site.domain));
    this.hold(run, policy, joined.map((site) => site.domain));
    await run.enforce(joined.map((site) => site.domain));
    this.record(run, run.planAll(), joined.map((site) => site.domain));
    return joined.map((site) => site.domain);
  }

  /** `asUser` names a non-administrator, who is told whether DNS is ready but not why. */
  async provision(domain: string, ssl: boolean, asUser = ""): Promise<ProvisionReply> {
    await this.syncSites();
    const site = this.site(domain);
    const policy = this.files.policy();
    const profile = policy.profiles.find((candidate) => candidate.id === policy.assignments[domain]);
    if (!profile || !policy.automatic) {
      return { managed: false, ready: false, reason: profile ? "DNS is set to Ask first" : "No DNS profile is assigned to this site", certificateNames: [] };
    }
    // A site owner's call reaches Cloudflare only for a site made in the last
    // few minutes, the moment it is for; for any other the last check answers.
    let plan: SitePlan | undefined;
    if (asUser && this.now - site.createdAt > NEW_SITE_WINDOW) {
      plan = this.files.status().plans[domain];
    } else {
      if (ssl) {
        const requests = this.files.ssl();
        if (requestSsl(requests, site, this.now)) this.files.saveSsl(requests);
      }
      const run = this.run(policy);
      await run.discover();
      await run.load([domain]);
      await run.enforce([domain]);
      const plans = run.planAll();
      this.record(run, plans, [domain]);
      plan = plans.find((candidate) => candidate.domain === domain);
    }
    const ready = readiness(plan);
    // A plan's problems can name other customers' sites and quote Cloudflare
    // or Mailcow errors, which are an administrator's to read. The rest, such
    // as the nameservers a pending zone needs, are the site owner's to act on.
    if (asUser && plan?.problems.length) ready.reason = "an administrator can see why on the DNS page";
    return { managed: true, ...ready, certificateNames: ready.ready ? plan!.certificateNames : [] };
  }

  /** From the last check alone, so opening a page never reaches Cloudflare. */
  siteStatus(domain: string): SiteDnsStatus {
    const site = this.site(domain);
    const policy = this.files.policy();
    const plan = this.files.status().plans[domain];
    const request = this.files.ssl()[domain];
    const certificate = !site.selfSigned ? "installed" : request && request.siteId === site.id && !request.done ? "automatic" : "manual";
    const zone = policy.assignments[domain] && plan?.profileId === policy.assignments[domain] ? plan.zone : null;
    if (!zone) return { zone: null, status: null, nameServers: [], certificate };
    return { zone: zone.name, status: zone.status, nameServers: zone.status === "active" ? [] : zone.nameServers, certificate };
  }

  /** Run in the periodic pass only: a certificate request can take minutes. */
  async retryStandInCertificates(): Promise<void> {
    if (this.options.standIns) return;
    const selfSigned = (domain: string) => this.panelSites(true).find((site) => site.domain === domain)?.selfSigned ?? null;
    await retryStandInCertificates(this.standInPaths(), selfSigned, this.options.issue ?? clpctlIssue(this.paths.clpctl), Date.now());
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

  /** The sites and redirect domains whose records would change if `after` replaced `before`, once DNS is Automatic. */
  affected(before: Policy, after: Policy): string[] {
    if (!after.automatic) return [];
    const mailcowBefore = JSON.stringify(before.mailcow);
    const mailcowAfter = JSON.stringify(after.mailcow);
    const createIn = JSON.stringify(before.createIn) !== JSON.stringify(after.createIn);
    const redirectOf = (policy: Policy, domain: string) => policy.redirects.find((redirect) => redirect.source === domain);
    const profileOf = (policy: Policy, domain: string) => {
      const redirect = redirectOf(policy, domain);
      return policy.profiles.find((profile) => profile.id === (redirect ? redirect.profileId : policy.assignments[domain]));
    };
    const domains = [...this.sites().map((site) => site.domain), ...after.redirects.map((redirect) => redirect.source)];
    return [...new Set(domains)].filter((domain) => {
      const redirect = redirectOf(after, domain);
      const next = profileOf(after, domain);
      if (!next && !redirect) return false;
      if (!before.automatic || createIn) return true;
      if (before.held.includes(domain) && !after.held.includes(domain)) return true;
      if (redirect && JSON.stringify(redirectOf(before, domain)) !== JSON.stringify(redirect)) return true;
      const previous = profileOf(before, domain);
      if (!next) return false;
      if (!previous || previous.id !== next.id) return true;
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
      this.savePolicy(next);
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
    const plans = run.planAll().filter((plan) => domains.includes(plan.domain));
    const blocked = plans.some((plan) => plan.problems.length > 0);
    const token = blocked ? "" : randomBytes(24).toString("hex");
    this.files.savePending(blocked ? null : {
      token, expiresAt: this.now + REVIEW_LIFETIME, base: hash(before), digest: this.digest(plans), domains, policy: next, mailcowKey,
    });
    const changes = plans.reduce((count, plan) => count + plan.changes.filter((change) => change.action !== "note").length, 0);
    const turningOn = !before.automatic;
    return this.reply({
      notice,
      review: {
        token,
        title: blocked ? "Resolve these first" : turningOn ? "Turn on Automatic" : `Apply to ${plans.length} site${plans.length === 1 ? "" : "s"}`,
        text: blocked
          ? "This cannot be applied while a site below has a problem. Fix it, or take the site out of its profile."
          : `${changes} change${changes === 1 ? "" : "s"} will be made now${turningOn
            ? ". From then on DNS keeps every site's records to its profile, and creates a missing zone, on its own"
            : ", and kept from then on"}. Records at names a profile does not write are left alone.`,
        sites: plans,
        blocked,
        confirmLabel: turningOn ? "Apply and turn on Automatic" : "Apply",
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
    const plans = run.planAll().filter((plan) => pending.domains.includes(plan.domain));
    if (this.digest(plans) !== pending.digest) {
      return this.review(current, next, pending.domains, "Cloudflare or Mailcow changed after the plan was shown. This is the plan now.", pending.mailcowKey);
    }
    this.savePolicy(next);
    if (pending.mailcowKey !== undefined) this.files.saveSecrets(this.secretsWith(pending.mailcowKey));
    this.files.savePending(null);
    this.cause = "Confirmed review";
    await run.enforce(pending.domains);
    this.record(run, run.planAll(), pending.domains);
    return this.reply({ notice: `Applied to ${pending.domains.length} site${pending.domains.length === 1 ? "" : "s"}.${current.automatic ? "" : " DNS is Automatic."}` });
  }

  /** The tracked records of a site CloudPanel no longer has, that are unchanged and no current site writes. */
  private async removable(domain: string): Promise<{ run: DnsRun; entry: ManagedRecords; ids: string[]; plans: SitePlan[] }> {
    const entry = this.files.managed()[domain];
    if (!entry) failAction(`DNS tracks no records for ${domain}`);
    if (this.sites().some((site) => site.domain === domain)) failAction(`${domain} is still a CloudPanel site`);
    const policy = this.files.policy();
    const run = this.run(policy);
    await run.discover();
    await run.load(run.plannedDomains());
    const currentPlans = run.planAll();
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
    this.cause = "Remove records";
    await run.deleteRecords(domain, entry, ids);
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
    // Before the token is saved, so a refused one is not left behind in the secrets.
    if (!existing && policy.connections.length >= MAX_CONNECTIONS) failAction(`At most ${MAX_CONNECTIONS} Cloudflare connections can be added`);
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
    // A redirect a stand-in serves moves to Cloudflare through its review, not on the next check.
    const standIns = Object.keys(this.standIns().current).filter((domain) => next.redirects.some((redirect) => redirect.source === domain));
    if (!existing && standIns.length) next.held = [...new Set([...next.held, ...standIns])];
    this.files.saveSecrets({ ...secrets, cloudflare: { ...secrets.cloudflare, [id]: token } });
    this.savePolicy(next);
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
    if (next.createIn?.connectionId === id) next.createIn = null;
    const secrets = this.files.secrets();
    delete secrets.cloudflare[id];
    this.files.saveSecrets(secrets);
    this.savePolicy(next);
    const status = this.files.status();
    this.files.saveStatus({ ...status, connections: status.connections.filter((connection) => connection.id !== id) });
    await this.tryRefresh("all");
    return this.reply({ notice: "Connection removed. Its token stays valid in Cloudflare until you delete it there." });
  }

  async saveMailcow(body: Record<string, unknown>): Promise<DnsReply> {
    const policy = this.files.policy();
    const secrets = this.files.secrets();
    const settings = parseMailcow(body);
    if (!settings.url) failAction("Enter Mailcow's hostname, such as mail.example.com");
    // Mailcow serves its API, webmail and mail on one hostname, so the address is also what {mailcow.host} is.
    settings.host = new URL(settings.url).hostname;
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
    return this.change(next, "Mailcow saved.", this.mailcowSites(next), key);
  }

  /** Like a Cloudflare connection, straight away: a site whose profile needs Mailcow stops being applied, and nothing is deleted. */
  async removeMailcow(): Promise<DnsReply> {
    const policy = this.files.policy();
    const secrets = this.files.secrets();
    if (!policy.mailcow.url && !secrets.mailcowKey) failAction("Mailcow is not set up");
    this.files.saveSecrets({ ...secrets, mailcowKey: "" });
    this.savePolicy({ ...structuredClone(policy), mailcow: { ...EMPTY_MAILCOW } });
    await this.tryRefresh(this.mailcowSites(policy));
    return this.reply({ notice: "Mailcow removed. Its API key stays valid in Mailcow until you delete it there." });
  }

  // -------------------------------------------------------------------------
  // Redirect domains
  // -------------------------------------------------------------------------

  private refuseSite(source: string): void {
    if (this.sites().some((site) => site.domain === source)) failAction(`${source} is a CloudPanel site; archive or delete the site first`);
  }

  async saveRedirect(body: Record<string, unknown>): Promise<DnsReply> {
    const policy = this.files.policy();
    const ids = new Set(policy.profiles.map((profile) => profile.id));
    const redirect = parseRedirect(body, ids);
    if (body.profileId && !redirect.profileId) failAction("That profile no longer exists");
    const existing = policy.redirects.some((candidate) => candidate.source === redirect.source);
    if (!existing) this.refuseSite(redirect.source);
    const next = structuredClone(policy);
    next.redirects = parseRedirects([...next.redirects.filter((candidate) => candidate.source !== redirect.source), redirect], ids);
    return this.change(next, existing ? `Saved ${redirect.source}.` : `Added ${redirect.source}.`, [redirect.source]);
  }

  /** At once: nothing in Cloudflare is deleted, and a stand-in site serves nothing else. */
  async deleteRedirect(source: string): Promise<DnsReply> {
    const policy = this.files.policy();
    if (!policy.redirects.some((redirect) => redirect.source === source)) failAction("That redirect no longer exists");
    const standIns = this.standIns();
    const standIn = standIns.current[source];
    if (standIn) {
      await standIns.remove(source);
      this.files.appendLog([{ at: new Date(this.now).toISOString(), sites: [source], zone: "", action: "delete", subject: "Stand-in site",
        detail: "The redirect domain was deleted", cause: "Redirect deleted" }]);
    }
    const next = structuredClone(policy);
    next.redirects = next.redirects.filter((redirect) => redirect.source !== source);
    next.held = next.held.filter((domain) => domain !== source);
    this.savePolicy(next);
    const status = this.files.status();
    delete status.plans[source];
    this.files.saveStatus(status);
    return this.reply({ notice: standIn ? `Deleted ${source} and its stand-in site.` : `${source} is no longer managed. Its rule and records stay in Cloudflare.` });
  }

  async findRedirects(): Promise<DnsReply> {
    const policy = this.files.policy();
    if (!policy.connections.length) failAction("Connect Cloudflare first");
    const run = this.run(policy);
    await run.discover();
    const found = await run.findRedirects();
    const taken = new Set([...policy.redirects.map((redirect) => redirect.source), ...this.sites().map((site) => site.domain)]);
    return this.reply({ found: { redirects: found.redirects.filter((redirect) => !taken.has(redirect.source)), notes: found.notes } });
  }

  /** Adds several redirect domains at once, such as the rules another tool left in Cloudflare. */
  async takeOver(body: Record<string, unknown>): Promise<DnsReply> {
    const policy = this.files.policy();
    if (!Array.isArray(body.redirects) || !body.redirects.length) failAction("Select at least one redirect");
    const profile = body.profileId == null || body.profileId === "" ? null : profileById(policy, body.profileId).id;
    const ids = new Set(policy.profiles.map((candidate) => candidate.id));
    const added = body.redirects.map((entry) => parseRedirect({ ...(entry as Record<string, unknown>), profileId: profile }, ids));
    for (const redirect of added) {
      if (policy.redirects.some((candidate) => candidate.source === redirect.source)) failAction(`${redirect.source} is already a redirect domain`);
      this.refuseSite(redirect.source);
    }
    const next = structuredClone(policy);
    next.redirects = parseRedirects([...next.redirects, ...added], ids);
    return this.change(next, `Added ${added.length} redirect domain${added.length === 1 ? "" : "s"}.`, added.map((redirect) => redirect.source));
  }

  private mailcowSites(policy: Policy): string[] {
    const uses = (id: string | null | undefined) => policy.profiles.find((profile) => profile.id === id)?.mailcow;
    return [
      ...this.sites().filter((site) => uses(policy.assignments[site.domain])).map((site) => site.domain),
      ...policy.redirects.filter((redirect) => uses(redirect.profileId)).map((redirect) => redirect.source),
    ];
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
    const profile = parseProfile({ ...body, id });
    action.checkProfile(profile);
    if (existing) next.profiles = next.profiles.map((candidate) => candidate.id === id ? profile : candidate);
    else next.profiles.push(profile);
    return action.change(next, existing ? `Saved ${profile.name}.` : `Created ${profile.name}.`, sitesOf(next, id));
  }
  if (verb === "delete-profile") {
    const profile = profileById(policy, body.id);
    next.profiles = next.profiles.filter((candidate) => candidate.id !== profile.id);
    for (const domain of sitesOf(next, profile.id)) delete next.assignments[domain];
    for (const redirect of next.redirects) if (redirect.profileId === profile.id) redirect.profileId = null;
    if (next.defaultProfileId === profile.id) next.defaultProfileId = null;
    return action.change(next, `Deleted ${profile.name}. Its sites' DNS is left as it is.`);
  }
  if (verb === "set-automatic") {
    if (typeof body.automatic !== "boolean") failAction("Say whether DNS is Automatic");
    next.automatic = body.automatic;
    return action.change(next, body.automatic ? "DNS is Automatic." : "DNS asks first. Nothing in Cloudflare or Mailcow was changed.");
  }
  if (verb === "zone-account") {
    const ref = parseAccountRef(body.createIn);
    if (ref && !policy.connections.some((connection) => connection.id === ref.connectionId)) failAction("That connection no longer exists");
    next.createIn = ref;
    return action.change(next, "New zones go to the chosen account.", "all");
  }
  if (verb === "assign") {
    if (!Array.isArray(body.domains) || !body.domains.length) failAction("Select at least one site");
    const id = body.profileId == null || body.profileId === "" ? null : profileById(policy, body.profileId).id;
    const domains = body.domains.map((domain) => hostname(domain, "a site"));
    const sites: string[] = [];
    for (const domain of domains) {
      const redirect = next.redirects.find((candidate) => candidate.source === domain);
      if (redirect) {
        redirect.profileId = id;
        continue;
      }
      sites.push(action.site(domain).domain);
      if (id) next.assignments[domain] = id;
      else delete next.assignments[domain];
    }
    // Placing a site by hand is its review.
    next.held = next.held.filter((domain) => !domains.includes(domain));
    // A site placed by hand is not a new site for the default to claim.
    next.knownSiteIds = [...new Set([...next.knownSiteIds, ...sites.map((domain) => action.site(domain).id)])];
    const name = id ? next.profiles.find((profile) => profile.id === id)!.name : "no profile";
    return action.change(next, `${domains.length} site${domains.length === 1 ? "" : "s"} now in ${name}.`, domains);
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
  if (!domain) failAction("this needs --domain");
  if (asUser && !PANEL_USER_NAME_RE.test(asUser)) failAction("that is not a valid panel user name");
  return { domain, asUser, ssl };
}

export async function executeDnsAction(argv: string[], options: DnsActionOptions = {}): Promise<unknown> {
  if ((options.processUid ?? process.getuid?.()) !== 0) failAction("DNS actions must run as root");
  const [rawVerb, ...args] = argv;
  const verb = VERBS.find((candidate) => candidate === rawVerb);
  if (!verb) failAction(`usage: clp-addons action dns {${VERBS.join("|")}}`);
  const forSite = verb === "provision" || verb === "site-status";
  if (!forSite && args.length) failAction(`'${verb}' takes no arguments`);
  const paths = { ...DEFAULT_DNS_PATHS, ...options.paths };
  const provision = forSite ? provisionArguments(args) : null;
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
  if (verb === "site-status") return action.siteStatus(provision!.domain);

  mkdirSync(dirname(paths.lockFile), { recursive: true, mode: 0o700 });
  // Long enough for a check of the whole fleet; a page action waits less and says so.
  const wait = verb === "reconcile" || verb === "sync-sites" || verb === "provision" ? 240 : 30;
  return withFileLock(paths.lockFile, wait, "DNS is busy checking Cloudflare; try again in a moment", async () => {
    if ((verb === "reconcile" || verb === "sync-sites") && !existsSync(paths.configFile)) return { checked: 0, joined: [] };
    let failed = false;
    try {
      return await perform(action, verb, body, provision);
    } catch (error) {
      failed = true;
      if (!(error instanceof Error)) throw error;
      // Redaction is best effort: state that cannot be read now must not
      // replace the failure the operator needs to see.
      let secrets;
      try { secrets = action.files.secrets(); } catch { throw error; }
      const message = redact(error.message, [...Object.values(secrets.cloudflare), secrets.mailcowKey]);
      if (message === error.message) throw error;
      failAction(message);
    } finally {
      try {
        action.writeLog();
        action.rememberBackoff();
      } catch (afterError) {
        if (!failed) throw afterError;
      }
    }
  });
}

async function perform(
  action: Action, verb: DnsVerb, body: Record<string, unknown>, provision: ReturnType<typeof provisionArguments> | null,
): Promise<unknown> {
  switch (verb) {
    case "check":
      action.cause = "Check now";
      await action.check(false);
      return action.reply({ notice: "Checked every site." });
    case "reconcile":
      await action.check(true);
      return { checked: action.sites().length };
    case "sync-sites":
      action.cause = "New site";
      return { joined: await action.syncSites() };
    case "provision":
      action.cause = "New site";
      return action.provision(provision!.domain, provision!.ssl, provision!.asUser);
    case "confirm":
      return action.confirm(body.token);
    case "save-connection":
      return action.saveConnection(body);
    case "remove-connection":
      return action.removeConnection(connectionId(body.id));
    case "save-mailcow":
      return action.saveMailcow(body);
    case "remove-mailcow":
      return action.removeMailcow();
    case "remove-records":
      return action.reviewRemoval(hostname(body.domain, "the site"));
    case "save-redirect":
      return action.saveRedirect(body);
    case "delete-redirect":
      action.cause = "Redirect deleted";
      return action.deleteRedirect(hostname(body.source, "the redirect's domain"));
    case "find-redirects":
      return action.findRedirects();
    case "take-over":
      return action.takeOver(body);
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
