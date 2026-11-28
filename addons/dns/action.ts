/**
 * DNS's privileged verbs. Only these read the Cloudflare tokens and the
 * Mailcow key, and nothing they return to the manager contains either.
 *
 * Changes that alter what DNS writes once it is Automatic -- turning that on
 * included -- are not saved straight away: they come back as a review of every
 * create, update and delete they would make, and only a confirmation of that
 * same plan saves and applies them.
 */
import { LOCK_DIR, NGINX_CERTIFICATES_DIR, addonConfigFile, addonStateDir, CLOUDFLARE_STATE_DIR, PANEL_DB } from "../../lib/paths";
import { withPanelDb } from "../../lib/panel-db";
import { DNS_VERBS } from "./verbs";
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { getDomain } from "tldts";
import { ActionFailure, replyToAction, failAction, readJsonRequest } from "../../lib/action";
import { errorMessage } from "../../lib/errors";
import { nameSlug } from "../../lib/validate";
import { withFileLock } from "../../lib/file-lock";
import { DEFAULT_SITE_VHOST_PATHS } from "../../lib/site-vhost";
import { PANEL_USER_NAME_RE, panelUserOwnsSite } from "../../lib/panel-users";
import { DEFAULT_SMTP_PATHS, smtpRelayAccounts, type SmtpRelayAccount } from "../smtp/action";
import { DEFAULT_PANEL_TWEAKS_PATHS, readTweaks } from "../panel-tweaks/action";
import { detectAddresses, type Addresses } from "../../lib/addresses";
import {
  DnsRun, readiness, zoneMapKey, type ConnectionReport, type LogEntry, type ManagedRecords, type PanelSite, type SitePlan,
} from "./engine";
import { type ApiFetch, redact } from "../../lib/provider-http";
import { MailcowApi } from "./mailcow";
import {
  composeProfiles, connectionId, hostname, isMailcowLinked, legacyProfileZones, parseAccountRef, parseMailcow, parsePolicy, parsePowerDnsConnection, parseProfile,
  parseSecrets, profileEffect, profileId, providerId, secretText, ipAddress, EMPTY_MAILCOW, MAX_CONNECTIONS,
  MAX_DOMAINS, MAX_PROFILES, type HttpRole, type MailcowSettings, type Policy, type PowerDnsConnection, type Profile, type ProfileRole, type Secrets,
} from "./model";
import { parsePowerDnsApiKey, PowerDnsProvider } from "./powerdns";
import { PROVIDER_LABELS, type DnsRecord, type ProviderKind } from "./provider";
import { mailcowSeededProfile, presetsFor, seededPolicy, type Preset } from "./presets";
import { describeRecord, recordsOwnedBy, renderProfile, sameRecord } from "./records";
import { coveredHosts, readEdgeSources, readRedirectDomains, type RedirectDomain } from "../../lib/redirect-domains";
import { isStandInSite, readStandInMarks } from "../../lib/stand-ins";
import { clpctlIssue, NEW_SITE_WINDOW, requestSsl, retryCertificates, type Issue, type SslRequest } from "./ssl";
import { readState, writeState } from "../../lib/root-state";
import { accessView, type AccessView } from "../../lib/cloudflare/access";
import {
  cloudflareTokenHolds, hasSharedCloudflareStore, readCloudflareConnections, readCloudflareSecrets, readCloudflareStatus,
  readFirewallEdgeNeeds, recordCloudflareReports, removeCloudflareConnection, saveCloudflareConnection,
  type CloudflareStorePaths,
} from "../../lib/cloudflare/store";
import { tokenTemplate, tokenTemplates, type PermissionName, type TokenTemplate, type TokenTemplates } from "../../lib/cloudflare/tokens";
import { issuedForAll, panelCustomDomainCertificate } from "../../lib/panel-custom-domain";
import { trustedText } from "../../lib/trusted-file";
import { panelUserUid } from "../../lib/sso-auth";

type DnsVerb = keyof typeof DNS_VERBS;

const VERBS = Object.keys(DNS_VERBS) as DnsVerb[];
const NO_BODY: DnsVerb[] = ["list", "panel-host-helper", "check", "provision", "site-status", "reconcile", "sync-sites", "sync-panel-host"];
const MAX_BODY = 256 * 1024;
const REVIEW_LIFETIME = 15 * 60_000;
/** How many writes the change log keeps, newest first; the page is sent the first PAGE_LOG of them. */
const MAX_LOG = 1000;
const PAGE_LOG = 200;
/** CloudPanel's Certificate::TYPE_SELF_SIGNED. */
const SELF_SIGNED = "1";

interface DnsPaths {
  configFile: string;
  panelDb: string;
  stateDir: string;
  /** Shared Cloudflare connection store; defaults to CLOUDFLARE_STATE_DIR in production. */
  cloudflareDir?: string;
  cloudflareLockFile?: string;
  /** SMTP Relay's configuration, read only for the relay accounts the Mailcow form offers. */
  smtpConfig: string;
  /** Redirects' saved redirects, stand-ins and status, read for warnings and its stand-ins; default to Redirects' own files. */
  redirectsPolicyFile?: string;
  standInsFile?: string;
  redirectsStatusFile?: string;
  /** Panel Tweaks' enable flag and switches, read only to see whether automatic SSL is enabled. */
  panelTweaksConfig?: string;
  panelTweaksFile?: string;
  lockFile: string;
  clpctl: string;
  sqlite3: string;
  nginxVhostDir: string;
  sslCertDir?: string;
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
  /** Test fixtures may stand in for CloudPanel's custom domain and its certificate. */
  customDomain?: () => { name: string; issued: boolean } | undefined;
}

const DEFAULT_DNS_PATHS: DnsPaths = {
  configFile: addonConfigFile("dns"),
  panelDb: PANEL_DB,
  stateDir: addonStateDir("dns"),
  smtpConfig: DEFAULT_SMTP_PATHS.stateFile,
  lockFile: `${LOCK_DIR}/dns.lock`,
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
  httpRole: HttpRole;
  httpProfileId: string | null;
  mailProfileId: string | null;
  plan: SitePlan | null;
  ssl: string | null;
  /** True when this domain's Mail role uses Mailcow while Mailcow is not connected. */
  mailcowMissing?: true;
  /** The redirect in Redirects whose source or hosts include this domain. */
  redirectedBy?: { source: string; target: string };
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
type LogLine = LogEntry & { cause: string };

export type DnsConnectionView = Omit<ConnectionReport, "token" | "refused" | "zoneNames"> & {
  provider: ProviderKind;
  hasToken: boolean;
  access: AccessView | null;
  url?: string;
  serverId?: string;
  defaultTtl?: number;
  createZones?: boolean;
  nameservers?: string[];
};

export interface DnsState {
  automatic: boolean;
  createIn: Policy["createIn"];
  profiles: (Profile & { sites: number })[];
  defaultHttpProfileId: string | null;
  defaultMailProfileId: string | null;
  sites: SiteView[];
  connections: DnsConnectionView[];
  accounts: { connectionId: string; accountId: string; label: string }[];
  /** Active or pending zone names the connections reach, for picking a zone on the page. */
  zones: string[];
  mailcow: MailcowSettings & { hasKey: boolean; linked: boolean; affectedSites: string[] };
  /** SMTP Relay's accounts, which the Mailcow form can be filled from. */
  smtpRelays: SmtpRelayAccount[];
  server: { ipv4: string; ipv6: string; detected: Addresses };
  orphans: { domain: string; zone: string; records: number }[];
  checkedAt: string | null;
  waitUntil: number;
  token: TokenTemplate;
  tokens?: TokenTemplates;
  firewallEnabled?: boolean;
  redirectsEnabled?: boolean;
  presets: Preset[];
  /** Newest first. */
  log: LogLine[];
  /** CloudPanel's custom domain, even when DNS does not manage a panel hostname yet. */
  customDomain: { name: string; issued: boolean } | null;
  panelHost: PanelHostView | null;
}

export interface PanelHostView {
  name: string;
  /** What keeps DNS from managing it, such as a CloudPanel site of the same name. */
  problem: string | null;
  plan: SitePlan | null;
  /** CloudPanel's custom domain, if it has one. */
  customDomain: { name: string; issued: boolean } | null;
  /** Whether the next check proxies it: CloudPanel serves an issued certificate for it. */
  proxied: boolean;
}

export type DnsReply = DnsState & { review?: Review; notice?: string; error?: string; zoneCreated?: boolean };

/** Local-only state for CloudPanel's Admin → Settings Custom Domain helper. */
export interface PanelHostHelper {
  connected: boolean;
  automatic: boolean;
  hasCloudflare: boolean;
  hasPowerDns: boolean;
  zones: string[];
  zoneProviders: Record<string, ProviderKind>;
  panelHost: string | null;
  serverIps: { ipv4: string | null; ipv6: string | null };
}

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
  /** Which provider owns `zone`, when `zone` is returned. */
  provider?: ProviderKind;
  /** True when provisioning created a brand-new zone that still needs registrar delegation. */
  zoneCreated?: boolean;
  certificateNames: string[];
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

interface CreatedZoneRecord {
  at: number;
  nameServers: string[];
}

interface Status {
  checkedAt: string | null;
  connections: ConnectionReport[];
  plans: Record<string, SitePlan>;
  backoff: { cloudflare: number; mailcow: number; powerdns?: number };
  /** Whether the panel hostname was last planned proxied, so a certificate write that changes nothing is cheap. */
  panelProxied?: boolean;
  /** Cloudflare connection ids saved when DNS last looked; absent before it first did. */
  connectionIds?: string[];
  /** Zones recently created by DNS, keyed by `connectionId:zoneId`, so provision() after sync-sites knows the zone is new and its nameservers. */
  createdZones?: Record<string, CreatedZoneRecord>;
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
  /** Single-host unproxied panel hostname preparation (works in Ask first too without touching other sites). */
  panelOnly?: true;
}

const emptyStatus = (): Status => ({ checkedAt: null, connections: [], plans: {}, backoff: { cloudflare: 0, mailcow: 0, powerdns: 0 } });
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");

function cloudflarePathsOf(paths: DnsPaths): CloudflareStorePaths {
  const customState = paths.stateDir !== DEFAULT_DNS_PATHS.stateDir;
  return {
    stateDir: paths.cloudflareDir ?? (customState ? `${paths.stateDir}/cloudflare` : CLOUDFLARE_STATE_DIR),
    lockFile: paths.cloudflareLockFile ?? (customState ? `${paths.lockFile}.cloudflare` : `${LOCK_DIR}/cloudflare.lock`),
    rootUid: paths.rootUid,
  };
}

/** Whether Panel Tweaks is enabled and its automatic SSL switch is on; untrusted or missing files read as off. */
function panelTweaksAutoSsl(paths: DnsPaths): boolean {
  const customState = paths.stateDir !== DEFAULT_DNS_PATHS.stateDir;
  const configFile = paths.panelTweaksConfig ?? (customState ? `${paths.stateDir}/panel-tweaks.conf` : addonConfigFile("panel-tweaks"));
  const tweaksFile = paths.panelTweaksFile ?? (customState ? `${paths.stateDir}/panel-tweaks-tweaks.json` : DEFAULT_PANEL_TWEAKS_PATHS.tweaksFile);
  if (!existsSync(configFile)) return false;
  try {
    return readTweaks({ ...DEFAULT_PANEL_TWEAKS_PATHS, tweaksFile, rootUid: paths.rootUid }).autoSsl;
  } catch {
    return false;
  }
}

class Files {
  readonly cfPaths: CloudflareStorePaths;

  constructor(private readonly paths: DnsPaths) {
    this.cfPaths = cloudflarePathsOf(paths);
  }

  private path(name: string): string {
    return `${this.paths.stateDir}/${name}.json`;
  }

  policy(): Policy {
    const raw = readState<unknown>(this.path("policy"), this.paths.rootUid, () => null);
    const parsed = raw === null ? seededPolicy() : parsePolicy(raw);
    const connections = hasSharedCloudflareStore(this.cfPaths) ? readCloudflareConnections(this.cfPaths) : parsed.connections;
    const powerdns = parsed.powerdns ?? [];
    const allIds = new Set([...connections.map((c) => c.id), ...powerdns.map((c) => c.id)]);
    const createIn = parsed.createIn && allIds.has(parsed.createIn.connectionId) ? parsed.createIn : null;
    return { ...parsed, connections, powerdns, createIn };
  }

  savePolicy(policy: Policy): void {
    // Cloudflare connections live in the shared store and zone-wide edge defaults
    // live in Firewall; keep dns/policy.json's legacy connections and per-profile
    // `zone` blocks intact until their migrations finish and strip them.
    const clean = parsePolicy(policy);
    const onDisk = readState<unknown>(this.path("policy"), this.paths.rootUid, () => null);
    let legacy: Policy["connections"] = [];
    if (!hasSharedCloudflareStore(this.cfPaths) && onDisk !== null) {
      legacy = parsePolicy(onDisk).connections;
    }
    const legacyZones = legacyProfileZones(onDisk);
    const profiles = legacyZones.size > 0
      ? clean.profiles.map((profile) => legacyZones.has(profile.id) ? { ...profile, zone: legacyZones.get(profile.id) } : profile)
      : clean.profiles;
    // Redirects not yet moved to the Redirects addon stay for its migration, which reads them from here.
    // Their Mail roles are in `clean` now, so a later read never restores one an administrator removed.
    const raw = onDisk && typeof onDisk === "object" ? (onDisk as { redirects?: unknown }).redirects : undefined;
    const withoutMail = (entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const { mailProfileId: _imported, ...rest } = entry as Record<string, unknown>;
      return rest;
    };
    const redirects = Array.isArray(raw) && raw.length ? { redirects: raw.map(withoutMail) } : {};
    writeState(this.path("policy"), { ...clean, profiles, connections: legacy, ...redirects }, this.paths.rootUid);
  }

  secrets(): Secrets {
    const parsed = parseSecrets(readState(this.path("secrets"), this.paths.rootUid, () => ({})));
    const cloudflare = hasSharedCloudflareStore(this.cfPaths) ? readCloudflareSecrets(this.cfPaths) : parsed.cloudflare;
    return { cloudflare, powerdns: parsed.powerdns ?? {}, mailcowKey: parsed.mailcowKey };
  }

  saveSecrets(secrets: Secrets): void {
    // Cloudflare tokens live in the shared store; keep PowerDNS keys and Mailcow's key in dns/secrets.json,
    // without wiping unmigrated legacy Cloudflare tokens while the shared store does not exist yet.
    let legacy: Record<string, string> = {};
    if (!hasSharedCloudflareStore(this.cfPaths)) {
      legacy = parseSecrets(readState(this.path("secrets"), this.paths.rootUid, () => ({}))).cloudflare;
    }
    const powerdns = secrets.powerdns ?? {};
    writeState(this.path("secrets"), {
      cloudflare: legacy,
      ...(Object.keys(powerdns).length ? { powerdns } : {}),
      mailcowKey: secrets.mailcowKey,
    }, this.paths.rootUid);
  }

  status(): Status {
    const stored = { ...emptyStatus(), ...readState<Partial<Status>>(this.path("status"), this.paths.rootUid, emptyStatus) };
    const shared = hasSharedCloudflareStore(this.cfPaths);
    const { reports, backoffUntil } = readCloudflareStatus(this.cfPaths);
    const storedPdns = stored.connections
      .filter((entry) => entry.provider === "powerdns" || entry.id.startsWith("pdns-"))
      .map((entry) => ({ ...entry, provider: "powerdns" as const }));
    const storedCf = stored.connections
      .filter((entry) => entry.provider !== "powerdns" && !entry.id.startsWith("pdns-"))
      .map((entry) => ({ ...entry, provider: "cloudflare" as const }));
    const cfReports = shared ? reports.map((entry) => ({ ...entry, provider: "cloudflare" as const })) : storedCf;
    return {
      ...stored,
      connections: [...cfReports, ...storedPdns],
      backoff: {
        cloudflare: Math.max(stored.backoff.cloudflare, backoffUntil),
        mailcow: stored.backoff.mailcow,
        powerdns: stored.backoff.powerdns ?? 0,
      },
    };
  }

  saveStatus(status: Status): void {
    const connections = hasSharedCloudflareStore(this.cfPaths)
      ? status.connections.filter((entry) => entry.provider === "powerdns" || entry.id.startsWith("pdns-"))
      : status.connections;
    writeState(this.path("status"), { ...status, connections }, this.paths.rootUid);
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
  return withPanelDb(panelDb, (db) => {
    const site = columns(db, "site");
    const certCols = site.has("certificate_id") ? columns(db, "certificate") : new Set<string>();
    const certificate = certCols.has("type");
    const certPem = certificate && certCols.has("certificate");
    const rows = db.query<{
      id: number; domain_name: string; type: string; created_at: string | null; cf: number | null;
      cert: string | null; cert_pem: string | null; user: string | null;
    }, []>(
      `SELECT s.id, s.domain_name, s.type, ${site.has("user") ? "s.user" : "NULL"} AS user,
              ${site.has("created_at") ? "s.created_at" : "NULL"} AS created_at,
              ${site.has("allow_traffic_from_cloudflare_only") ? "s.allow_traffic_from_cloudflare_only" : "0"} AS cf,
              ${certificate ? "c.type" : "NULL"} AS cert,
              ${certPem ? "c.certificate" : "NULL"} AS cert_pem
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
        id: Number(row.id), domain, type: String(row.type), ...(row.user ? { user: row.user } : {}), createdAt: panelTime(row.created_at),
        selfSigned: String(row.cert) === SELF_SIGNED,
        ...(row.cert_pem ? { certificatePem: row.cert_pem } : {}),
        cloudflareOnly: Boolean(row.cf),
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
  private cachedSites: PanelSite[] | null = null;
  private cachedRedirects: RedirectDomain[] | null = null;
  private cachedEdge: { panel: PanelSite[]; hidden: Set<string> } | null = null;
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

  /** CloudPanel's sites, without the stand-ins `edgeStandIns` names. */
  sites(fresh = false): PanelSite[] {
    const hidden = this.edgeStandIns(fresh);
    return this.panelSites().filter((site) => !hidden.has(site.domain));
  }

  /**
   * Redirects' stand-in sites whose redirect it serves at Cloudflare's edge,
   * such as during a move there, so DNS never writes over its placeholders.
   * Redirects' state that cannot be trusted leaves out every stand-in, or
   * every site at a redirect's source when the stand-ins cannot be told.
   * Read once per panel read, so one invocation sees one snapshot.
   */
  edgeStandIns(fresh = false): Set<string> {
    const panel = this.panelSites(fresh);
    if (!fresh && this.cachedEdge?.panel === panel) return this.cachedEdge.hidden;
    const marks = readStandInMarks(this.paths.standInsFile, this.paths.rootUid);
    const edge = readEdgeSources({ statusFile: this.paths.redirectsStatusFile, rootUid: this.paths.rootUid });
    const sources = marks ? null : new Set(this.redirects().map((redirect) => redirect.source));
    const hidden = new Set(panel
      .filter((site) => (marks ? isStandInSite(marks[site.domain], site, this.now) : sources!.has(site.domain))
        && (edge === null || edge.has(site.domain)))
      .map((site) => site.domain));
    this.cachedEdge = { panel, hidden };
    return hidden;
  }

  /** The domains added with no CloudPanel site, as DNS plans them: a site at one is that site's. */
  dnsOnlyDomains(policy: Policy): string[] {
    const sites = new Set(this.sites().map((site) => site.domain));
    return policy.domains.filter((domain) => !sites.has(domain));
  }

  /** Every domain DNS plans roles for: the sites, then the DNS-only domains. */
  domainsOf(policy: Policy): string[] {
    return [...this.sites().map((site) => site.domain), ...this.dnsOnlyDomains(policy)];
  }

  /** Redirects' domains, read for the warning on DNS rows they cover. */
  redirects(): RedirectDomain[] {
    this.cachedRedirects ??= readRedirectDomains({
      policyFile: this.paths.redirectsPolicyFile, standInsFile: this.paths.standInsFile, rootUid: this.paths.rootUid,
    });
    return this.cachedRedirects;
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

  customDomain(): { name: string; issued: boolean } | undefined {
    if (this.options.customDomain) return this.options.customDomain();
    return panelCustomDomainCertificate([this.paths.rootUid, panelUserUid() ?? this.paths.rootUid]);
  }

  /** CloudPanel serves an issued certificate for the panel hostname, so Cloudflare may proxy it without breaking that certificate's first request. */
  panelProxied(policy: Policy): boolean {
    if (!policy.panelHost) return false;
    const custom = this.customDomain();
    return custom?.name === policy.panelHost && custom.issued;
  }

  run(policy: Policy, secrets = this.files.secrets(), overrides?: { panelProxied?: boolean; panelOnly?: boolean }): DnsRun {
    const status = this.files.status();
    const run = new DnsRun({
      policy, secrets, sites: this.sites(), addresses: this.addresses(), fetch: this.options.fetch,
      backoff: status.backoff,
      panelProxied: overrides?.panelProxied ?? this.panelProxied(policy),
      panelOnly: overrides?.panelOnly,
      tokens: Object.fromEntries(status.connections.filter((report) => report?.active).map((report) => [report.id, report.token])),
    });
    this.runs.push(run);
    return run;
  }

  /** Appends what every run wrote, so writes made before a failure are logged too. */
  writeLog(): void {
    this.files.appendLog(this.runs.flatMap((run) => run.log.splice(0).map((entry) => ({ ...entry, cause: this.cause }))));
  }

  async rememberBackoff(): Promise<void> {
    if (!this.runs.length && !this.mailcowTrial) return;
    const status = this.files.status();
    const backoff = { cloudflare: status.backoff.cloudflare, mailcow: status.backoff.mailcow, powerdns: status.backoff.powerdns ?? 0 };
    for (const run of this.runs) {
      const observed = run.backoff();
      backoff.cloudflare = Math.max(backoff.cloudflare, observed.cloudflare);
      backoff.mailcow = Math.max(backoff.mailcow, observed.mailcow);
      backoff.powerdns = Math.max(backoff.powerdns, observed.powerdns);
    }
    backoff.mailcow = Math.max(backoff.mailcow, this.mailcowTrial?.http.backoff.until ?? 0);
    if (JSON.stringify(backoff) !== JSON.stringify(status.backoff)) {
      this.files.saveStatus({ ...status, backoff });
      if (backoff.cloudflare > status.backoff.cloudflare) {
        await recordCloudflareReports([], backoff.cloudflare, false, {}, this.files.cfPaths);
      }
    }
  }

  /**
   * Saves `next`, and forgets what was written for a current site it no longer
   * enforces: those records are the site's own again, as taking it out of a
   * profile promises, so they are never offered for removal once it is deleted.
   * A site taken out of one role, or moved to another profile in it, keeps only
   * the records its profiles now write at.
   */
  private savePolicy(next: Policy): void {
    let before: Policy | undefined;
    try { before = this.files.policy(); } catch { /* nothing to compare with */ }
    this.files.savePolicy(next);
    this.cleanupManagedForPolicy(next, before);
  }

  private cleanupManagedForPolicy(next: Policy, before?: Policy): void {
    const managed = this.files.managed();
    const composed = (policy: Policy, domain: string) => {
      const assigned = policy.assignments[domain];
      const find = (id: string | null | undefined) => policy.profiles.find((profile) => profile.id === id) ?? null;
      return composeProfiles(find(assigned?.http), find(assigned?.mail));
    };
    let changed = false;
    for (const domain of this.domainsOf(next)) {
      const entry = managed[domain];
      if (!entry) continue;
      const assigned = next.assignments[domain];
      if (!next.automatic || !(assigned?.http || assigned?.mail)) {
        delete managed[domain];
        changed = true;
        continue;
      }
      const was = before?.assignments[domain];
      if (!was || (was.http === assigned.http && was.mail === assigned.mail)) continue;
      const profile = composed(next, domain);
      if (!profile) continue;
      const records = recordsOwnedBy(profile, domain, entry.zoneName, entry.records);
      if (records.length === entry.records.length) continue;
      if (records.length) managed[domain] = { ...entry, records };
      else delete managed[domain];
      changed = true;
    }
    if (changed) this.files.saveManaged(managed);
  }

  /**
   * A run that did not read a live token afresh, or could not reach
   * Cloudflare to, keeps the last read; a token that is no longer active keeps
   * none. A run over some sites adds its refusals to the ones the last full
   * check found, which only another full check clears: a call that succeeded
   * on one zone says nothing of the zones that refused it.
   */
  private withEarlier(run: DnsRun, earlier: ConnectionReport[], domains: string[] | "all"): ConnectionReport[] {
    return run.reports().map((report) => {
      const before = earlier.find((entry) => entry.id === report.id);
      const { token: fresh, refused: seen, ...rest } = report;
      const stale = !fresh || (!fresh.readable && fresh.transient);
      const token = !report.active ? undefined : stale && before?.token ? before.token : fresh;
      const refused = [...new Set([...domains === "all" ? [] : before?.refused ?? [], ...seen ?? []])];
      return { ...rest, ...(token ? { token } : {}), ...(refused.length ? { refused } : {}) };
    });
  }

  /** Writes what a run found for `domains`, keeping what it did not look at. */
  async record(run: DnsRun, plans: SitePlan[], domains: string[] | "all"): Promise<void> {
    const status = this.files.status();
    const current = new Set(run.entries.map((site) => site.domain));
    const plansByDomain = domains === "all" ? {} : Object.fromEntries(Object.entries(status.plans).filter(([domain]) => current.has(domain)));
    for (const plan of plans) {
      if (domains !== "all" && !domains.includes(plan.domain)) continue;
      if (plan.httpProfileId || plan.mailProfileId) plansByDomain[plan.domain] = plan;
      else delete plansByDomain[plan.domain];
    }
    const panelHost = run.entries.find((entry) => entry.panel)?.domain;
    // Only once Cloudflare holds it: a write that failed or waits for a review leaves the next certificate write to try again.
    const panelPlan = panelHost && (domains === "all" || domains.includes(panelHost)) ? plans.find((plan) => plan.domain === panelHost) : undefined;
    const panelSettled = panelPlan && !panelPlan.problems.length && !panelPlan.changes.some((change) => change.action !== "note");
    const shared = hasSharedCloudflareStore(this.files.cfPaths);
    const nextConnections = run.connections.length || domains === "all" ? this.withEarlier(run, status.connections, domains) : status.connections;
    const storedConnections = shared
      ? nextConnections.filter((entry) => entry.provider === "powerdns" || entry.id.startsWith("pdns-"))
      : nextConnections;
    const createdZones: Record<string, CreatedZoneRecord> = {};
    for (const [key, entry] of Object.entries(status.createdZones ?? {})) {
      if (entry && typeof entry.at === "number" && Array.isArray(entry.nameServers)
        && this.now - entry.at <= NEW_SITE_WINDOW && entry.at <= this.now + 60_000) {
        createdZones[key] = entry;
      }
    }
    const freshCreated = run.newlyCreatedZones();
    // A Cloudflare zone observed as active on a later run has already verified registrar delegation.
    for (const plan of plans) {
      if (!plan.zone || plan.zone.provider === "powerdns" || plan.zone.status !== "active") continue;
      const key = zoneMapKey(plan.zone.connectionId ?? "", plan.zone.id);
      if (!freshCreated.has(key)) delete createdZones[key];
    }
    for (const [key, nameServers] of freshCreated) {
      createdZones[key] = { at: this.now, nameServers };
    }
    const { createdZones: _previousCreated, redirectRules: _legacyRules, ...restStatus } = status as Status & { redirectRules?: unknown };
    this.files.saveStatus({
      ...restStatus,
      ...panelSettled && { panelProxied: run.panelProxied },
      checkedAt: domains === "all" ? new Date(this.now).toISOString() : status.checkedAt,
      connections: storedConnections,
      plans: plansByDomain,
      ...(Object.keys(createdZones).length ? { createdZones } : {}),
      backoff: run.backoff(),
    });
    const managed = this.files.managed();
    const checked = plans.filter((plan) => domains === "all" || domains.includes(plan.domain));
    const tracked = run.managed(checked);
    for (const plan of checked) {
      if (tracked[plan.domain]) managed[plan.domain] = tracked[plan.domain]!;
      // A settled enforcing entry handed off to a wildcard has no explicit records left to track.
      else if (plan.mode === "enforce" && plan.zone && !plan.problems.length && plan.wildcard
        && !plan.changes.some((change) => change.action !== "note")) {
        delete managed[plan.domain];
      }
    }
    for (const [domain, entry] of Object.entries(managed)) {
      if (current.has(domain) || !run.zoneGone(entry)) continue;
      run.logZoneGone(domain, entry);
      delete managed[domain];
    }
    this.files.saveManaged(managed);
    if (shared && (run.connections.length || domains === "all")) {
      const cfReports = run.reports().filter((report) => (report.provider ?? "cloudflare") === "cloudflare");
      await recordCloudflareReports(cfReports, run.backoff().cloudflare, domains === "all", run.tokens, this.files.cfPaths);
    }
  }

  state(): DnsState {
    const policy = this.files.policy();
    const secrets = this.files.secrets();
    const status = this.files.status();
    const ssl = this.files.ssl();
    const sites = this.sites();
    const dnsOnly = this.dnsOnlyDomains(policy);
    const hidden = this.edgeStandIns();
    const domains = new Set([...sites.map((site) => site.domain), ...dnsOnly, ...policy.panelHost ? [policy.panelHost] : []]);
    const accounts = status.connections.flatMap((connection) => connection.accounts.map((account) => ({
      connectionId: connection.id, accountId: account.id, label: `${account.name || account.id} (${connection.label})`,
    })));
    const managed = this.files.managed();
    const mailcowLinked = isMailcowLinked(policy.mailcow, secrets);
    const mailcowAffected = mailcowLinked ? [] : this.mailcowSites(policy).sort();
    const mailcowAffectedSet = new Set(mailcowAffected);
    const redirectedBy = new Map<string, { source: string; target: string }>();
    for (const redirect of this.redirects()) {
      for (const host of [redirect.source, ...coveredHosts(redirect)]) {
        if (!redirectedBy.has(host)) redirectedBy.set(host, { source: redirect.source, target: redirect.target });
      }
    }
    const view = (domain: string, type: string, siteId: number | null): SiteView => {
      const assigned = policy.assignments[domain];
      const httpProfileId = assigned?.http ?? null;
      const mailProfileId = assigned?.mail ?? null;
      const plan = status.plans[domain];
      const request = ssl[domain];
      const redirect = redirectedBy.get(domain);
      return {
        domain, type,
        httpRole: httpProfileId ? "site" : "dns-only",
        httpProfileId,
        mailProfileId,
        plan: plan && plan.httpProfileId === httpProfileId && plan.mailProfileId === mailProfileId ? plan : null,
        ssl: httpProfileId && siteId !== null && request && request.siteId === siteId ? request.state : null,
        ...(mailcowAffectedSet.has(domain) ? { mailcowMissing: true as const } : {}),
        ...(redirect ? { redirectedBy: redirect } : {}),
      };
    };
    return {
      automatic: policy.automatic,
      createIn: policy.createIn,
      profiles: policy.profiles.map((profile) => ({
        ...profile,
        sites: profile.role === "http"
          ? Object.entries(policy.assignments).filter(([domain, assigned]) => domains.has(domain) && assigned.http === profile.id).length
          : Object.entries(policy.assignments).filter(([domain, assigned]) => domains.has(domain) && assigned.mail === profile.id).length,
      })),
      defaultHttpProfileId: policy.defaultHttpProfileId,
      defaultMailProfileId: policy.defaultMailProfileId,
      sites: [
        ...sites.map((site) => view(site.domain, site.type, site.id)),
        ...dnsOnly.map((domain) => view(domain, "domain", null)),
      ].sort((a, b) => a.domain.localeCompare(b.domain)),
      connections: [
        ...policy.connections.map((connection): DnsConnectionView => {
          const stored = status.connections.find((entry) => entry.id === connection.id);
          const { token: _token, refused: _refused, zoneNames: _zoneNames, ...report } = stored ?? {
            id: connection.id, provider: "cloudflare" as const, active: false, status: "unchecked", accounts: [], zones: 0, error: null,
          };
          return {
            ...report,
            provider: "cloudflare",
            label: connection.label,
            hasToken: Boolean(secrets.cloudflare[connection.id]),
            access: stored?.active ? accessView(stored, readFirewallEdgeNeeds({ rootUid: this.paths.rootUid }), { includeDns: true, includeEdge: false, requirePanelGate: false }) : null,
          };
        }),
        ...(policy.powerdns ?? []).map((connection): DnsConnectionView => {
          const stored = status.connections.find((entry) => entry.id === connection.id);
          const { token: _token, refused: _refused, zoneNames: _zoneNames, ...report } = stored ?? {
            id: connection.id, provider: "powerdns" as const, active: false, status: "unchecked", accounts: [], zones: 0, error: null,
          };
          return {
            ...report,
            provider: "powerdns",
            label: connection.label,
            url: connection.url,
            serverId: connection.serverId,
            defaultTtl: connection.defaultTtl,
            createZones: connection.createZones,
            nameservers: connection.nameservers,
            hasToken: Boolean(secrets.powerdns?.[connection.id]),
            access: null,
          };
        }),
      ],
      accounts,
      zones: [...new Set(status.connections.flatMap((connection) => connection.zoneNames ?? []))].sort(),
      mailcow: { ...policy.mailcow, hasKey: Boolean(secrets.mailcowKey), linked: mailcowLinked, affectedSites: mailcowAffected },
      smtpRelays: smtpRelayAccounts(this.paths.smtpConfig, this.paths.rootUid),
      server: { ...policy.server, detected: this.addresses() },
      orphans: Object.entries(managed)
        .filter(([domain]) => !domains.has(domain) && !hidden.has(domain))
        .map(([domain, entry]) => ({ domain, zone: entry.zoneName, records: entry.records.length })),
      checkedAt: status.checkedAt,
      waitUntil: Math.max(status.backoff.cloudflare, status.backoff.mailcow, status.backoff.powerdns ?? 0),
      token: tokenTemplate(readFirewallEdgeNeeds({ rootUid: this.paths.rootUid }), { dns: true }),
      tokens: tokenTemplates(readFirewallEdgeNeeds({ rootUid: this.paths.rootUid })),
      firewallEnabled: existsSync(addonConfigFile("firewall")),
      redirectsEnabled: existsSync(addonConfigFile("redirects")),
      presets: presetsFor(mailcowLinked),
      log: this.files.log().slice(0, PAGE_LOG),
      customDomain: this.customDomain() ?? null,
      panelHost: this.panelHostView(policy, status.plans, sites, dnsOnly),
    };
  }

  private panelHostView(policy: Policy, plans: Record<string, SitePlan>, sites: PanelSite[], dnsOnly: string[]): PanelHostView | null {
    const name = policy.panelHost;
    if (!name) return null;
    const custom = this.customDomain() ?? null;
    const problem = sites.some((site) => site.domain === name) ? `CloudPanel has a site ${name}; remove the panel hostname or delete the site`
      : dnsOnly.includes(name) ? `${name} is a DNS-only domain; remove the panel hostname or the domain` : null;
    const plan = plans[name];
    const supportsProxy = plan?.zone ? plan.zone.provider !== "powerdns" : policy.connections.length > 0;
    return {
      name, problem, plan: !problem && plan?.panel ? plan : null, customDomain: custom,
      proxied: supportsProxy && custom?.name === name && custom.issued,
    };
  }

  /** From local state alone, so opening Admin → Settings never reaches any DNS provider or waits for the lock. */
  panelHostHelper(): PanelHostHelper {
    const policy = this.files.policy();
    const status = this.files.status();
    const detected = this.addresses();
    const hasCloudflare = policy.connections.length > 0;
    const hasPowerDns = (policy.powerdns?.length ?? 0) > 0;
    const zones = [...new Set(status.connections.flatMap((connection) => connection.zoneNames ?? []))].sort();
    const providerByConnection = new Map<string, ProviderKind>([
      ...policy.connections.map((connection): [string, ProviderKind] => [connection.id, "cloudflare"]),
      ...(policy.powerdns ?? []).map((connection): [string, ProviderKind] => [connection.id, "powerdns"]),
    ]);
    const zoneProviders: Record<string, ProviderKind> = {};
    for (const connection of status.connections) {
      const provider = connection.provider ?? providerByConnection.get(connection.id) ?? (connection.id.startsWith("pdns-") ? "powerdns" : "cloudflare");
      for (const zone of connection.zoneNames ?? []) {
        if (!zoneProviders[zone]) zoneProviders[zone] = provider;
      }
    }
    for (const [zone, choice] of Object.entries(policy.zoneChoices)) {
      const chosen = providerByConnection.get(choice.connectionId);
      if (chosen) zoneProviders[zone] = chosen;
    }
    return {
      connected: hasCloudflare || hasPowerDns,
      automatic: policy.automatic,
      hasCloudflare,
      hasPowerDns,
      zones,
      zoneProviders,
      panelHost: policy.panelHost,
      serverIps: {
        ipv4: policy.server.ipv4 || detected.ipv4 || null,
        ipv6: policy.server.ipv6 || detected.ipv6 || null,
      },
    };
  }

  reply(extra: { review?: Review; notice?: string; error?: string; zoneCreated?: boolean } = {}): DnsReply {
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
    await run.discover(domains === "all");
    await run.load(chosen);
    await this.record(run, run.planAll(domains === "all" ? undefined : chosen, true), domains === "all" ? "all" : chosen);
  }

  /** Every site: read, write what Automatic writes, and record the result. */
  async check(retrySsl: boolean): Promise<void> {
    const before = this.files.policy();
    const policy = this.adoptNewSites(before);
    this.enqueueNewSiteSsl(before, policy);
    const run = this.run(policy);
    await run.discover(true);
    const planned = run.plannedDomains();
    await run.load(planned);
    this.hold(run, policy, this.joined(before, policy).map((site) => site.domain));
    const released = run.releaseHeld();
    if (released.length) {
      policy.held = policy.held.filter((domain) => !released.includes(domain));
      this.savePolicy(policy);
    }
    await run.enforce(planned);
    const plans = run.planAll(undefined, true);
    await this.record(run, plans, "all");
    if (retrySsl) await this.retrySsl(plans);
  }

  /**
   * Puts sites CloudPanel created since the last look into the default
   * HTTP/Mail roles. A site at a DNS-only domain takes it over, keeping its
   * roles and taking the default HTTP role if it has none.
   */
  adoptNewSites(policy: Policy): Policy {
    const panel = this.panelSites();
    // An empty read is a panel database being restored, not every site deleted.
    if (!panel.length) return policy;
    const sites = this.sites();
    const domains = new Set(sites.map((site) => site.domain));
    const hidden = this.edgeStandIns();
    const marks = readStandInMarks(this.paths.standInsFile, this.paths.rootUid) ?? {};
    const known = new Set(policy.knownSiteIds);
    const next = structuredClone(policy);
    for (const site of sites) {
      const listed = next.domains.includes(site.domain);
      if (known.has(site.id) && !listed) continue;
      next.domains = next.domains.filter((domain) => domain !== site.domain);
      const existing = next.assignments[site.domain] ?? (listed ? { http: null, mail: null } : null);
      // A redirect's stand-in takes the default HTTP role only; mail for it is added in DNS by hand.
      const mail = isStandInSite(marks[site.domain], site, this.now) ? null : next.defaultMailProfileId;
      if (!existing && (next.defaultHttpProfileId || mail)) {
        next.assignments[site.domain] = { http: next.defaultHttpProfileId, mail };
      } else if (existing && !existing.http && next.defaultHttpProfileId) {
        next.assignments[site.domain] = { ...existing, http: next.defaultHttpProfileId };
      }
    }
    for (const domain of Object.keys(next.assignments)) {
      // A stand-in left out while Redirects serves it at the edge keeps its roles for when it is back.
      if (!domains.has(domain) && !next.domains.includes(domain) && !hidden.has(domain)) delete next.assignments[domain];
    }
    next.knownSiteIds = panel.map((site) => site.id);
    next.held = next.held.filter((domain) => next.assignments[domain]);
    if (JSON.stringify(next) !== JSON.stringify(policy)) this.savePolicy(next);
    return next;
  }

  /** The sites `adoptNewSites` put in a role. */
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

  /**
   * When Panel Tweaks automatic SSL is enabled and DNS is Automatic, records
   * brand-new self-signed sites within NEW_SITE_WINDOW in ssl.json so sites
   * created via clpctl or whose browser completion tab closed early still get
   * automatic Let's Encrypt retries once DNS is ready.
   */
  private enqueueNewSiteSsl(before: Policy, after: Policy): void {
    if (!after.automatic || !panelTweaksAutoSsl(this.paths)) return;
    const known = new Set(before.knownSiteIds);
    const candidates = this.sites().filter((site) => !known.has(site.id) && Boolean(after.assignments[site.domain]?.http));
    if (!candidates.length) return;
    const requests = this.files.ssl();
    let changed = false;
    for (const site of candidates) {
      const had = requests[site.domain]?.siteId === site.id;
      if (requestSsl(requests, site, this.now) && !had) changed = true;
    }
    if (changed) this.files.saveSsl(requests);
  }

  private recentCreatedZone(key: string): CreatedZoneRecord | null {
    const entry = this.files.status().createdZones?.[key];
    if (!entry || typeof entry.at !== "number" || !Array.isArray(entry.nameServers)) return null;
    if (this.now - entry.at > NEW_SITE_WINDOW || entry.at > this.now + 60_000) return null;
    return entry;
  }

  private async syncSitesRun(): Promise<{ joined: string[]; createdZones: Set<string> }> {
    const before = this.files.policy();
    const known = new Set(before.knownSiteIds);
    const added = this.sites().filter((site) => !known.has(site.id) || before.domains.includes(site.domain));
    const current = new Set([...this.domainsOf(before), ...this.edgeStandIns()]);
    const removed = Object.keys(before.assignments).some((domain) => !current.has(domain));
    if (!added.length && !removed) return { joined: [], createdZones: new Set() };
    const policy = this.adoptNewSites(before);
    this.enqueueNewSiteSsl(before, policy);
    const joined = this.joined(before, policy);
    if (!joined.length) return { joined: [], createdZones: new Set() };
    const joinedDomains = joined.map((site) => site.domain);
    const domains = this.wildcardAffected(policy, policy, joinedDomains);
    const run = this.run(policy);
    await run.discover();
    await run.load(domains);
    this.hold(run, policy, joinedDomains);
    await run.enforce(domains);
    await this.record(run, run.planAll(domains, true), domains);
    return { joined: joinedDomains, createdZones: new Set(run.newlyCreatedZones().keys()) };
  }

  async syncSites(): Promise<string[]> {
    return (await this.syncSitesRun()).joined;
  }

  /**
   * Run whenever CloudPanel writes a certificate: proxies the panel hostname
   * once its own certificate is issued, and stops proxying it if that changes.
   */
  panelHostDue(): boolean {
    const policy = this.files.policy();
    const host = policy.panelHost;
    if (!host || !policy.automatic || this.files.status().panelProxied === this.panelProxied(policy)) return false;
    // A site or DNS-only domain with the name keeps it out of every run, so there is nothing to wait for the lock over.
    return !policy.domains.includes(host) && !this.sites().some((site) => site.domain === host);
  }

  async syncPanelHost(): Promise<string | null> {
    if (!this.panelHostDue()) return null;
    const policy = this.files.policy();
    const host = policy.panelHost!;
    const run = this.run(policy);
    if (!run.entries.some((entry) => entry.panel)) return null;
    await run.discover();
    await run.load([host]);
    await run.enforce([host]);
    await this.record(run, run.planAll([host], true), [host]);
    const provider = run.resolvedProvider(host);
    if (!provider?.capabilities.proxy) return null;
    return run.panelProxied ? `${host} is proxied through Cloudflare` : `${host} is no longer proxied`;
  }

  /** `asUser` names a non-administrator, who is told whether DNS is ready but not why. */
  async provision(domain: string, ssl: boolean, asUser = ""): Promise<ProvisionReply> {
    const synced = await this.syncSitesRun();
    const policy = this.files.policy();
    // An administrator may apply a DNS-only domain's roles; anything else is a site's.
    const site = asUser || ssl || !this.dnsOnlyDomains(policy).includes(domain) ? this.site(domain) : null;
    const assigned = policy.assignments[domain];
    const hasAny = Boolean(assigned?.http || assigned?.mail);
    if (!hasAny || !policy.automatic) {
      return { managed: false, ready: false, reason: hasAny ? "DNS is set to Ask first" : "No DNS role is assigned to this site", certificateNames: [] };
    }
    if (ssl && !assigned?.http) {
      return { managed: false, ready: false, reason: "This site is DNS-only; DNS does not manage its HTTP records", certificateNames: [] };
    }
    // A site owner's call reaches the DNS provider only for a site made in the last
    // few minutes, the moment it is for; for any other the last check answers.
    let plan: SitePlan | undefined;
    const createdInCall = new Set(synced.createdZones);
    const checkedLive = !(asUser && site && this.now - site.createdAt > NEW_SITE_WINDOW);
    if (!checkedLive) {
      plan = this.files.status().plans[domain];
    } else {
      if (ssl) {
        const requests = this.files.ssl();
        if (site && requestSsl(requests, site, this.now)) this.files.saveSsl(requests);
      }
      const domains = this.wildcardAffected(policy, policy, [domain]);
      const run = this.run(policy);
      await run.discover();
      await run.load(domains);
      await run.enforce(domains);
      for (const key of run.newlyCreatedZones().keys()) createdInCall.add(key);
      const plans = run.planAll(domains, true);
      await this.record(run, plans, domains);
      plan = plans.find((candidate) => candidate.domain === domain);
    }
    const ready = readiness(plan);
    // A plan's problems can name other customers' sites and quote provider
    // or Mailcow errors, which are an administrator's to read. The rest, such
    // as the nameservers a pending zone needs, are the site owner's to act on.
    if (asUser && plan?.problems.length) ready.reason = "an administrator can see why on the DNS page";
    const zone = plan?.zone ?? null;
    const provider = zone?.provider;
    let zoneCreated = false;
    let nameServers = ready.nameServers;
    if (zone && !plan?.problems.length && checkedLive && (ready.ready || zone.status !== "active")) {
      const key = zoneMapKey(zone.connectionId ?? "", zone.id);
      const recent = this.recentCreatedZone(key);
      if (createdInCall.has(key) || (recent && (provider === "powerdns" || zone.status !== "active"))) {
        zoneCreated = true;
        if (!nameServers?.length) {
          const servers = zone.nameServers.length ? zone.nameServers : (recent?.nameServers ?? []);
          if (servers.length) nameServers = servers;
        }
      }
    }
    if (zoneCreated && ready.ready && zone) {
      const servers = nameServers?.length ? `: ${nameServers.join(", ")}` : "";
      return {
        managed: true,
        ready: false,
        reason: `Zone ${zone.name} was just created; set its nameservers at the registrar${servers}`,
        zone: zone.name,
        ...(nameServers?.length ? { nameServers } : {}),
        ...(provider ? { provider } : {}),
        zoneCreated: true,
        certificateNames: [],
      };
    }
    return {
      managed: true,
      ...ready,
      ...(nameServers?.length ? { nameServers } : {}),
      ...(ready.zone && provider ? { provider } : {}),
      ...(zoneCreated ? { zoneCreated: true } : {}),
      certificateNames: ready.ready ? plan!.certificateNames : [],
    };
  }

  /** From the last check alone, so opening a page never reaches Cloudflare. */
  siteStatus(domain: string): SiteDnsStatus {
    const site = this.site(domain);
    const policy = this.files.policy();
    const plan = this.files.status().plans[domain];
    const request = this.files.ssl()[domain];
    const assigned = policy.assignments[domain];
    const certificate = !site.selfSigned ? "installed"
      : policy.automatic && assigned?.http && request && request.siteId === site.id && !request.done ? "automatic"
      : "manual";
    const zone = assigned && plan && plan.httpProfileId === assigned.http && plan.mailProfileId === assigned.mail ? plan.zone : null;
    if (!zone) return { zone: null, status: null, nameServers: [], certificate };
    return { zone: zone.name, status: zone.status, nameServers: zone.status === "active" ? [] : zone.nameServers, certificate };
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

  /** The sites and DNS-only domains whose records would change if `after` replaced `before`, once DNS is Automatic. */
  affected(before: Policy, after: Policy): string[] {
    if (!after.automatic) return [];
    const mailcowBefore = JSON.stringify(before.mailcow);
    const mailcowAfter = JSON.stringify(after.mailcow);
    const createIn = JSON.stringify(before.createIn) !== JSON.stringify(after.createIn);
    const rolesOf = (policy: Policy, domain: string): { http: Profile | null; mail: Profile | null } => {
      const assigned = policy.assignments[domain];
      const planned = policy === after ? afterDomains : beforeDomains;
      if (!planned.has(domain)) return { http: null, mail: null };
      return {
        http: assigned?.http ? policy.profiles.find((profile) => profile.role === "http" && profile.id === assigned.http) ?? null : null,
        mail: assigned?.mail ? policy.profiles.find((profile) => profile.role === "mail" && profile.id === assigned.mail) ?? null : null,
      };
    };
    const beforeDomains = new Set(this.domainsOf(before));
    const afterDomains = new Set(this.domainsOf(after));
    const domains = [...new Set([...beforeDomains, ...afterDomains, ...after.panelHost ? [after.panelHost] : []])];
    const direct = domains.filter((domain) => {
      if (domain === after.panelHost && !afterDomains.has(domain)) {
        return !before.automatic || createIn || before.panelHost !== domain || JSON.stringify(before.server) !== JSON.stringify(after.server)
          || Object.keys({ ...before.zoneChoices, ...after.zoneChoices }).some((zone) =>
            (domain === zone || domain.endsWith(`.${zone}`)) && JSON.stringify(before.zoneChoices[zone]) !== JSON.stringify(after.zoneChoices[zone]));
      }
      const next = rolesOf(after, domain);
      if (!next.http && !next.mail) return false;
      if (!before.automatic || createIn) return true;
      if (before.held.includes(domain) && !after.held.includes(domain)) return true;
      const zoneChoiceChanged = Object.keys({ ...before.zoneChoices, ...after.zoneChoices }).some((zone) =>
        (domain === zone || domain.endsWith(`.${zone}`)) && JSON.stringify(before.zoneChoices[zone]) !== JSON.stringify(after.zoneChoices[zone]));
      if (zoneChoiceChanged) return true;
      if (JSON.stringify(before.server) !== JSON.stringify(after.server)) return true;
      const previous = rolesOf(before, domain);
      if ((previous.http?.id ?? null) !== (next.http?.id ?? null)) return true;
      if ((previous.mail?.id ?? null) !== (next.mail?.id ?? null)) return true;
      if (next.http && (!previous.http || profileEffect(previous.http) !== profileEffect(next.http))) return true;
      if (next.mail && (!previous.mail || profileEffect(previous.mail) !== profileEffect(next.mail))) return true;
      if (next.mail?.mailcow && mailcowBefore !== mailcowAfter) return true;
      return false;
    });
    return this.wildcardAffected(before, after, direct);
  }

  /**
   * Expands `direct` with managed subdomains whose wildcard coverage could
   * change: subdomains under a changed wildcard writer (including `*.{zone}`),
   * managed subdomain ancestors that a new descendant would turn into an ENT,
   * and subdomains sharing an intermediate ancestor above the registrable base.
   */
  private wildcardAffected(before: Policy, after: Policy, direct: string[]): string[] {
    if (!direct.length) return [];
    const profilesOf = (policy: Policy, domain: string): Profile[] => {
      const assigned = policy.assignments[domain];
      const http = assigned?.http ? policy.profiles.find((profile) => profile.role === "http" && profile.id === assigned.http) : undefined;
      const mail = assigned?.mail ? policy.profiles.find((profile) => profile.role === "mail" && profile.id === assigned.mail) : undefined;
      return [http, mail].filter((profile): profile is Profile => Boolean(profile));
    };
    const registrable = (domain: string) => getDomain(domain, { allowPrivateDomains: false }) ?? domain;
    const hasWildcard = (profile: Profile) => profile.records.some((row) => row.name.startsWith("*."));
    const wildcardBases = new Set<string>();
    const wildcardHosts: string[] = [];
    for (const domain of direct) {
      const profiles = [...profilesOf(before, domain), ...profilesOf(after, domain)];
      if (!profiles.some(hasWildcard)) continue;
      wildcardHosts.push(domain);
      if (profiles.some((profile) => profile.records.some((row) => row.name.startsWith("*.") && row.name.includes("{zone}")))) {
        wildcardBases.add(registrable(domain));
      }
    }
    const intermediateAncestors = (domain: string): string[] => {
      const base = registrable(domain);
      const list: string[] = [];
      let current = domain;
      while (current !== base) {
        const dot = current.indexOf(".");
        if (dot < 0) break;
        current = current.slice(dot + 1);
        if (current !== base) list.push(current);
      }
      return list;
    };
    const directSet = new Set(direct);
    const directIntermediates = new Set(direct.flatMap(intermediateAncestors));
    const domains = [...new Set([...this.domainsOf(after), ...after.panelHost ? [after.panelHost] : []])];
    const set = new Set(direct);
    for (const domain of domains) {
      if (set.has(domain)) continue;
      if (!profilesOf(after, domain).length && domain !== after.panelHost) continue;
      const base = registrable(domain);
      if (domain === base) continue;
      if (wildcardHosts.some((root) => domain.endsWith(`.${root}`)) || wildcardBases.has(base)) {
        set.add(domain);
        continue;
      }
      if (direct.some((changed) => changed.endsWith(`.${domain}`))
        || intermediateAncestors(domain).some((ancestor) => directIntermediates.has(ancestor) || directSet.has(ancestor))) {
        set.add(domain);
      }
    }
    return [...set];
  }

  private digest(plans: SitePlan[], run?: DnsRun): string {
    return hash(plans.map((plan) => [
      plan.domain,
      plan.zone ? [plan.zone.provider ?? "cloudflare", plan.zone.connectionId ?? "", plan.zone.id] : null,
      plan.zone ? null : (run?.creationTarget(plan.domain) ?? null),
      plan.changes,
      plan.problems,
    ]));
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
    const plans = run.planAll(domains).filter((plan) => domains.includes(plan.domain));
    const blocked = plans.some((plan) => plan.problems.length > 0);
    const token = blocked ? "" : randomBytes(24).toString("hex");
    this.files.savePending(blocked ? null : {
      token, expiresAt: this.now + REVIEW_LIFETIME, base: hash(before), digest: this.digest(plans, run), domains, policy: next, mailcowKey,
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

  /**
   * Plans the panel hostname alone and blocks preparation if writing its
   * records would remove wildcard coverage another managed site relies on.
   */
  private async planPanelHost(run: DnsRun, before: Policy, next: Policy, name: string): Promise<SitePlan[]> {
    const dependent = this.wildcardAffected(before, next, [name]).filter((domain) => domain !== name);
    await run.load([name, ...dependent]);
    const plans = run.planAll([name], true).filter((plan) => plan.domain === name);
    const plan = plans[0];
    if (plan && !plan.problems.length && dependent.length) {
      for (const domain of run.wildcardBlockedByPanel(name, dependent)) {
        plan.problems.push(
          `Writing records at ${name} would remove wildcard coverage for ${domain}; choose another panel hostname or apply DNS changes from the DNS page`,
        );
      }
    }
    return plans;
  }

  /**
   * Plans only the panel hostname's unproxied records for single-host
   * confirmation, in both Automatic and Ask first modes, without touching
   * other sites.
   */
  async preparePanelHost(before: Policy, next: Policy, name: string, notice?: string, error?: string): Promise<DnsReply> {
    const run = this.run(next, this.files.secrets(), { panelProxied: false, panelOnly: true });
    await run.discover();
    const plans = await this.planPanelHost(run, before, next, name);
    const plan = plans[0];
    const blocked = !plan || plans.some((candidate) => candidate.problems.length > 0);
    const token = blocked ? "" : randomBytes(24).toString("hex");
    this.files.savePending(blocked ? null : {
      token, expiresAt: this.now + REVIEW_LIFETIME, base: hash(before), digest: this.digest(plans, run),
      domains: [name], policy: next, panelOnly: true,
    });
    const changes = plans.reduce((count, candidate) => count + candidate.changes.filter((change) => change.action !== "note").length, 0);
    const provider = run.resolvedProvider(name);
    const supportsProxy = provider
      ? provider.capabilities.proxy
      : next.connections.length > 0 && !(next.powerdns?.length ?? 0);
    const text = blocked
      ? "DNS cannot prepare this hostname while the problem below remains."
      : changes === 0
        ? `${name} already matches${plan?.wildcard ? ` (covered by ${plan.wildcard})` : ""}. Save it as the panel hostname and continue.`
        : supportsProxy
          ? `${changes} change${changes === 1 ? "" : "s"} will be written for ${name} (DNS only) before CloudPanel requests the certificate.${before.automatic ? " Once CloudPanel has its certificate, DNS proxies it through Cloudflare." : " DNS stays in Ask first mode, and no other sites are changed."}`
          : `${changes} change${changes === 1 ? "" : "s"} will be written for ${name} before CloudPanel requests the certificate.${before.automatic ? "" : " DNS stays in Ask first mode, and no other sites are changed."}`;
    return this.reply({
      notice,
      ...(error ? { error } : {}),
      review: {
        token,
        title: blocked ? "Resolve these first" : `Prepare DNS for ${name}`,
        text,
        sites: plans,
        blocked,
        confirmLabel: changes === 0 ? "Continue" : "Write DNS and save",
        danger: plans.some((candidate) => candidate.changes.some((change) => change.action === "delete")),
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
    const panelOnly = pending.panelOnly === true;
    const run = this.run(next, this.secretsWith(pending.mailcowKey), panelOnly ? { panelProxied: false, panelOnly: true } : undefined);
    await run.discover();
    const plans = panelOnly
      ? await this.planPanelHost(run, current, next, pending.domains[0]!)
      : (await run.load(pending.domains), run.planAll(pending.domains, false).filter((plan) => pending.domains.includes(plan.domain)));
    if (this.digest(plans, run) !== pending.digest) {
      if (panelOnly) return this.preparePanelHost(current, next, pending.domains[0]!, `${providerLabelFor(next)} changed after the plan was shown. This is the plan now.`);
      return this.review(current, next, pending.domains, `${providerLabelFor(next)} or Mailcow changed after the plan was shown. This is the plan now.`, pending.mailcowKey);
    }
    this.savePolicy(next);
    if (pending.mailcowKey !== undefined) this.files.saveSecrets(this.secretsWith(pending.mailcowKey));
    this.files.savePending(null);
    this.cause = panelOnly ? "Panel hostname" : "Confirmed review";
    await run.enforce(pending.domains);
    const afterPlans = run.planAll(pending.domains, true);
    await this.record(run, afterPlans, pending.domains);
    if (panelOnly) {
      const host = pending.domains[0]!;
      const finalPlan = afterPlans.find((candidate) => candidate.domain === host);
      if (!finalPlan || finalPlan.problems.length || finalPlan.changes.some((change) => change.action !== "note")) {
        const errorText = finalPlan?.problems.length
          ? finalPlan.problems.join("; ")
          : `Some DNS changes for ${host} could not be applied yet.`;
        return this.preparePanelHost(next, next, host, `DNS could not prepare ${host}.`, errorText);
      }
    }
    const zoneCreated = panelOnly && run.zoneCreatedFor(pending.domains[0]!);
    return this.reply({
      ...(zoneCreated ? { zoneCreated: true } : {}),
      notice: panelOnly
        ? `DNS prepared ${pending.domains[0]}.`
        : `Applied to ${pending.domains.length} site${pending.domains.length === 1 ? "" : "s"}.${current.automatic ? "" : " DNS is Automatic."}`,
    });
  }

  /** The tracked records of a site CloudPanel no longer has, that are unchanged and no current site writes. */
  private async removable(domain: string): Promise<{ run: DnsRun; entry: ManagedRecords; ids: string[]; published: DnsRecord[]; plans: SitePlan[]; gone?: true }> {
    const entry = this.files.managed()[domain];
    if (!entry) failAction(`DNS tracks no records for ${domain}`);
    if (this.sites().some((site) => site.domain === domain)) failAction(`${domain} is still a CloudPanel site`);
    const policy = this.files.policy();
    if (policy.domains.includes(domain)) failAction(`${domain} is still a DNS-only domain`);
    const run = this.run(policy);
    await run.discover();
    if (run.zoneGone(entry)) return { run, entry, ids: [], published: [], plans: [], gone: true };
    await run.load(run.plannedDomains());
    const currentPlans = run.planAll(undefined, true);
    const isPowerDns = entry.connectionId.startsWith("pdns-");
    if (run.unread(entry.zoneId, entry.connectionId)) failAction(`${entry.zoneName} could not be read for the sites in it; check again before removing records`);
    const uncertain = currentPlans.some((plan) => (plan.httpProfileId || plan.mailProfileId) && plan.problems.length
      && (plan.zone
        ? plan.zone.id === entry.zoneId && (isPowerDns ? plan.zone.connectionId === entry.connectionId : plan.zone.provider !== "powerdns")
        : plan.domain === entry.zoneName || plan.domain.endsWith(`.${entry.zoneName}`)));
    if (uncertain) failAction(`${entry.zoneName} could not be planned for the sites in it; resolve their problems before removing records`);
    const published = await run.readZone(entry.connectionId, entry.zoneId, entry.zoneName);
    const supportsProxy = !entry.connectionId.startsWith("pdns-");
    const ids = entry.records
      .filter((tracked) => published.some((record) => record.id === tracked.id && sameRecord(record, tracked)
        && record.comment === tracked.comment))
      .filter((tracked) => !run.stillWanted(tracked))
      .map((tracked) => tracked.id);
    const plans: SitePlan[] = [{
      domain, httpProfileId: null, mailProfileId: null, mode: "enforce", zone: null, problems: [], zoneChoices: [], certificateNames: [],
      changes: entry.records.filter((tracked) => ids.includes(tracked.id)).map((tracked) => ({
        action: "delete", subject: `${tracked.type} ${tracked.name}`, detail: describeRecord(tracked, { proxy: supportsProxy }),
      })),
    }];
    return { run, entry, ids, published, plans };
  }

  /** A deleted zone took the records with it: there is nothing left to remove. */
  private forgetGone(run: DnsRun, domain: string, entry: ManagedRecords): DnsReply {
    this.cause = "Remove records";
    run.logZoneGone(domain, entry);
    const managed = this.files.managed();
    delete managed[domain];
    this.files.saveManaged(managed);
    const provider = entry.connectionId.startsWith("pdns-") ? PROVIDER_LABELS.powerdns : PROVIDER_LABELS.cloudflare;
    return this.reply({ notice: `${entry.zoneName} is no longer in ${provider}, so ${domain}'s records went with it.` });
  }

  async reviewRemoval(domain: string): Promise<DnsReply> {
    const { run, entry, ids, plans, gone } = await this.removable(domain);
    if (gone) return this.forgetGone(run, domain, entry);
    const skipped = entry.records.length - ids.length;
    const token = randomBytes(24).toString("hex");
    this.files.savePending({
      token, expiresAt: this.now + REVIEW_LIFETIME, base: hash(this.files.policy()), digest: this.digest(plans), domains: [], removal: { domain, ids },
    });
    const provider = entry.connectionId.startsWith("pdns-") ? PROVIDER_LABELS.powerdns : PROVIDER_LABELS.cloudflare;
    return this.reply({
      review: {
        token,
        title: `Remove ${domain}'s records`,
        text: `${ids.length} record${ids.length === 1 ? "" : "s"} in ${entry.zoneName} will be deleted.${skipped ? ` ${skipped} other${skipped === 1 ? " was" : "s were"} changed in ${provider} or ${skipped === 1 ? "is" : "are"} used by another site, and ${skipped === 1 ? "stays" : "stay"}.` : ""} The zone and Mailcow are not touched.`,
        sites: plans,
        blocked: ids.length === 0,
        confirmLabel: "Remove records",
        danger: true,
      },
    });
  }

  private async confirmRemoval(pending: Pending): Promise<DnsReply> {
    const { domain } = pending.removal!;
    const { run, entry, ids, published, plans, gone } = await this.removable(domain);
    if (gone) {
      this.files.savePending(null);
      return this.forgetGone(run, domain, entry);
    }
    if (this.digest(plans) !== pending.digest) return this.reviewRemoval(domain);
    this.files.savePending(null);
    this.cause = "Remove records";
    await run.deleteRecords(domain, entry, ids, published);
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

  /**
   * Forgets zone choices whose Cloudflare connection is gone, whichever addon
   * removed it, and remembers the connections DNS last saw.
   */
  noticeConnections(): void {
    const currentIds = readCloudflareConnections(this.files.cfPaths).map((connection) => connection.id);
    const status = this.files.status();
    const prevIds = status.connectionIds;
    if (prevIds !== undefined && prevIds.length === currentIds.length && prevIds.every((id, index) => id === currentIds[index])) {
      return;
    }
    const shared = hasSharedCloudflareStore(this.files.cfPaths);
    const activeIds = new Set(currentIds);
    const policy = this.files.policy();
    const nextChoices = { ...policy.zoneChoices };
    let choicesChanged = false;
    if (shared) {
      for (const [zone, choice] of Object.entries(nextChoices)) {
        if (!activeIds.has(choice.connectionId) && !choice.connectionId.startsWith("pdns-")) {
          delete nextChoices[zone];
          choicesChanged = true;
        }
      }
    }
    if (choicesChanged) this.savePolicy({ ...policy, zoneChoices: nextChoices });
    const latest = this.files.status();
    this.files.saveStatus({
      ...latest,
      connections: shared
        ? latest.connections.filter((entry) => entry.provider === "powerdns" || entry.id.startsWith("pdns-"))
        : latest.connections,
      connectionIds: currentIds,
    });
  }

  async saveConnection(body: Record<string, unknown>): Promise<DnsReply> {
    const isPowerDns = body.provider === "powerdns" || (typeof body.id === "string" && body.id.startsWith("pdns-"));
    if (isPowerDns) return this.savePowerDnsConnection(body);
    const saved = await saveCloudflareConnection(body, { paths: this.files.cfPaths, fetch: this.options.fetch });
    this.noticeConnections();
    await this.tryRefresh("all");
    return this.reply({ notice: saved.notice });
  }

  private async savePowerDnsConnection(body: Record<string, unknown>): Promise<DnsReply> {
    const policy = this.files.policy();
    const secrets = this.files.secrets();
    const list = policy.powerdns ?? [];
    const existing = body.id ? list.find((connection) => connection.id === connectionId(body.id)) : undefined;
    if (body.id && !existing) failAction("That connection no longer exists");
    if (!existing && list.length >= MAX_CONNECTIONS) {
      failAction(`At most ${MAX_CONNECTIONS} PowerDNS connections can be added`);
    }
    const candidateId = existing?.id ?? `pdns-${randomBytes(4).toString("hex")}`;
    const parsed: PowerDnsConnection = parsePowerDnsConnection({ ...body, id: candidateId });
    const serverChanged = Boolean(existing && (existing.url !== parsed.url || existing.serverId !== parsed.serverId));
    // Pointing an entry at a different PowerDNS server starts a fresh identity so orphan records from the old server never match it.
    const id = serverChanged ? `pdns-${randomBytes(4).toString("hex")}` : candidateId;
    const connection: PowerDnsConnection = serverChanged ? { ...parsed, id } : parsed;
    const rawKey = body.apiKey ?? body.token;
    // Keep a saved key only for the PowerDNS URL it was saved with.
    const apiKey = rawKey
      ? parsePowerDnsApiKey(rawKey)
      : existing && existing.url === connection.url
        ? secrets.powerdns?.[existing.id] ?? ""
        : "";
    if (!apiKey) failAction("Enter the PowerDNS API key");

    const status = this.files.status();
    const backoff = { until: status.backoff.powerdns ?? 0 };
    const provider = new PowerDnsProvider(connection, apiKey, this.options.fetch, backoff);
    const checked = await provider.discover();
    if (backoff.until > (status.backoff.powerdns ?? 0)) {
      this.files.saveStatus({ ...status, backoff: { ...status.backoff, powerdns: backoff.until } });
    }
    if (!checked.active) {
      failAction(redact(`PowerDNS did not accept this connection: ${(checked.error ?? checked.status).replace(/^PowerDNS: /, "")}`, [apiKey]));
    }

    const next = structuredClone(policy);
    next.powerdns = existing
      ? (next.powerdns ?? []).map((entry) => entry.id === existing.id ? connection : entry)
      : [...(next.powerdns ?? []), connection];
    if (serverChanged && existing) {
      for (const [zone, choice] of Object.entries(next.zoneChoices)) {
        if (choice.connectionId === existing.id) delete next.zoneChoices[zone];
      }
      if (next.createIn?.connectionId === existing.id) next.createIn = null;
    }
    const previousSecrets = secrets;
    const savedSecrets: Secrets = { ...secrets, powerdns: { ...(secrets.powerdns ?? {}), [id]: apiKey } };
    this.files.saveSecrets(savedSecrets);
    try {
      this.files.savePolicy(next);
    } catch (error) {
      try { this.files.saveSecrets(previousSecrets); } catch { /* best-effort rollback */ }
      throw error;
    }
    if (serverChanged && existing) {
      const cleaned = { ...(savedSecrets.powerdns ?? {}) };
      delete cleaned[existing.id];
      this.files.saveSecrets({ ...savedSecrets, powerdns: cleaned });
    }
    this.cleanupManagedForPolicy(next);

    const report: ConnectionReport = {
      id,
      label: connection.label,
      provider: "powerdns",
      active: true,
      status: checked.status,
      accounts: checked.accounts,
      zones: checked.zones.length,
      zoneNames: [...new Set(checked.zones.map((zone) => zone.name))].sort(),
      error: null,
    };
    const latestStatus = this.files.status();
    this.files.saveStatus({
      ...latestStatus,
      connections: [...latestStatus.connections.filter((entry) => entry.id !== id && entry.id !== existing?.id), report],
      backoff: { ...latestStatus.backoff, powerdns: Math.max(latestStatus.backoff.powerdns ?? 0, backoff.until) },
    });

    await this.tryRefresh("all");
    return this.reply({ notice: `${connection.label} reaches ${checked.zones.length} zone${checked.zones.length === 1 ? "" : "s"}.` });
  }

  async removeConnection(id: string): Promise<DnsReply> {
    const policy = this.files.policy();
    const pdnsExisting = (policy.powerdns ?? []).find((connection) => connection.id === id);
    if (pdnsExisting || id.startsWith("pdns-")) {
      if (!pdnsExisting) failAction("That connection no longer exists");
      const next = structuredClone(policy);
      next.powerdns = (next.powerdns ?? []).filter((connection) => connection.id !== id);
      const secrets = this.files.secrets();
      const nextPowerDnsSecrets = { ...(secrets.powerdns ?? {}) };
      delete nextPowerDnsSecrets[id];
      const status = this.files.status();
      for (const [zone, choice] of Object.entries(next.zoneChoices)) {
        if (choice.connectionId === id) delete next.zoneChoices[zone];
      }
      if (next.createIn?.connectionId === id) next.createIn = null;
      this.savePolicy(next);
      this.files.saveSecrets({ ...secrets, powerdns: nextPowerDnsSecrets });
      this.files.saveStatus({ ...status, connections: status.connections.filter((connection) => connection.id !== id) });
      await this.tryRefresh("all");
      return this.reply({ notice: "Connection removed. Its API key stays valid in PowerDNS until you change it there." });
    }
    const removed = await removeCloudflareConnection(id, { paths: this.files.cfPaths });
    const next = structuredClone(policy);
    next.connections = next.connections.filter((connection) => connection.id !== id);
    for (const [zone, choice] of Object.entries(next.zoneChoices)) {
      if (choice.connectionId === id) delete next.zoneChoices[zone];
    }
    if (next.createIn?.connectionId === id) next.createIn = null;
    this.savePolicy(next);
    const status = this.files.status();
    this.files.saveStatus({
      ...status,
      connections: hasSharedCloudflareStore(this.files.cfPaths)
        ? status.connections.filter((connection) => connection.provider === "powerdns" || connection.id.startsWith("pdns-"))
        : status.connections.filter((connection) => connection.id !== id),
    });
    this.noticeConnections();
    await this.tryRefresh("all");
    return this.reply({ notice: removed.notice });
  }

  async saveMailcow(body: Record<string, unknown>): Promise<DnsReply> {
    const policy = this.files.policy();
    const secrets = this.files.secrets();
    const wasLinked = isMailcowLinked(policy.mailcow, secrets);
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
      failAction(redact(errorMessage(error), [key]));
    }
    const next = { ...structuredClone(policy), mailcow: settings };
    let capacityNotice = "";
    if (!wasLinked && !next.profiles.some((profile) => profile.mailcow)) {
      if (next.profiles.length < MAX_PROFILES) {
        const taken = new Set(next.profiles.map((profile) => profile.id));
        let id = "mailcow";
        for (let n = 2; taken.has(id); n++) id = `mailcow-${n}`;
        next.profiles.push(mailcowSeededProfile(id));
      } else {
        capacityNotice = ` All ${MAX_PROFILES} profile slots are in use, so the default Mailcow Mail profile was not added; delete an unused profile and create a Mail profile under Profiles.`;
      }
    }
    const baseNotice = wasLinked ? "Mailcow saved." : "Mailcow connected.";
    return this.change(next, `${baseNotice}${capacityNotice}`, this.mailcowSites(next), key);
  }

  /** Like a Cloudflare connection, straight away: domains whose Mail role needs Mailcow stop being applied, and nothing is deleted. */
  async removeMailcow(): Promise<DnsReply> {
    const policy = this.files.policy();
    const secrets = this.files.secrets();
    if (!policy.mailcow.url && !secrets.mailcowKey) failAction("Mailcow is not set up");
    const affected = this.mailcowSites(policy);
    this.files.saveSecrets({ ...secrets, mailcowKey: "" });
    this.savePolicy({ ...structuredClone(policy), mailcow: { ...EMPTY_MAILCOW } });
    await this.tryRefresh(affected);
    const warning = affected.length
      ? ` ${affected.length} ${affected.length === 1 ? "domain still assigns" : "domains still assign"} Mailcow as ${affected.length === 1 ? "its" : "their"} Mail role and will stay paused until you reconnect Mailcow or switch ${affected.length === 1 ? "its" : "their"} Mail role.`
      : "";
    return this.reply({ notice: `Mailcow removed.${warning} Its API key stays valid in Mailcow until you delete it there.` });
  }

  /** Its records stay in the DNS provider, listed with the records of deleted sites. */
  removePanelHost(next: Policy): DnsReply {
    const previous = this.files.policy().panelHost;
    const status = this.files.status();
    const provider = previous && status.plans[previous]?.zone?.provider
      ? PROVIDER_LABELS[status.plans[previous]!.zone!.provider!]
      : providerLabelFor(next);
    this.savePolicy(next);
    this.files.savePending(null);
    if (previous) {
      delete status.plans[previous];
      this.files.saveStatus(status);
    }
    return this.reply({ notice: `DNS no longer manages the panel hostname. Its records are left in ${provider}.` });
  }

  /** Direct save + read-only refresh for profile deletion (never writes to providers). */
  async deleteProfileDirect(next: Policy, affected: string[], notice: string): Promise<DnsReply> {
    this.savePolicy(next);
    this.files.savePending(null);
    await this.tryRefresh(affected);
    return this.reply({ notice });
  }

  private mailcowSites(policy: Policy): string[] {
    const uses = (id: string | null | undefined) => policy.profiles.find((profile) => profile.role === "mail" && profile.id === id)?.mailcow;
    const domains = new Set(this.domainsOf(policy));
    return [...domains].filter((domain) => uses(policy.assignments[domain]?.mail));
  }
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

function providerLabelFor(policy: Policy): string {
  const cf = policy.connections.length > 0;
  const pdns = (policy.powerdns?.length ?? 0) > 0;
  if (cf && !pdns) return PROVIDER_LABELS.cloudflare;
  if (pdns && !cf) return PROVIDER_LABELS.powerdns;
  return "your DNS provider";
}

function profileById(policy: Policy, id: unknown, role?: ProfileRole): Profile {
  const profile = policy.profiles.find((candidate) => candidate.id === profileId(id));
  if (!profile) failAction("That profile no longer exists");
  if (role && profile.role !== role) failAction(`"${profile.name}" is a ${profile.role === "http" ? "HTTP" : "Mail"} profile, not a ${role === "http" ? "HTTP" : "Mail"} profile`);
  return profile;
}

function domainsUsing(policy: Policy, profile: Profile): string[] {
  return Object.entries(policy.assignments)
    .filter(([, assigned]) => profile.role === "http" ? assigned.http === profile.id : assigned.mail === profile.id)
    .map(([domain]) => domain);
}

async function changeVerb(action: Action, verb: DnsVerb, body: Record<string, unknown>): Promise<DnsReply> {
  const policy = action.files.policy();
  const next = structuredClone(policy);

  if (verb === "save-profile") {
    const existing = body.id ? profileById(policy, body.id) : null;
    if (existing && body.role !== undefined && body.role !== existing.role) {
      failAction("A profile's role cannot be changed after it is created");
    }
    const taken = new Set(policy.profiles.map((profile) => profile.id));
    let id = existing?.id ?? nameSlug(String(body.name ?? ""), "the profile name");
    for (let n = 2; !existing && taken.has(id); n++) id = `${nameSlug(String(body.name), "the profile name", 36)}-${n}`;
    const role = existing?.role ?? body.role;
    const profile = parseProfile({ ...body, id, ...(role !== undefined ? { role } : {}) });
    action.checkProfile(profile);
    if (existing) next.profiles = next.profiles.map((candidate) => candidate.id === id ? profile : candidate);
    else next.profiles.push(profile);
    return action.change(next, existing ? `Saved ${profile.name}.` : `Created ${profile.name}.`, domainsUsing(next, profile));
  }
  if (verb === "delete-profile") {
    const profile = profileById(policy, body.id);
    const affected = domainsUsing(policy, profile);
    next.profiles = next.profiles.filter((candidate) => candidate.id !== profile.id);
    for (const [domain, assigned] of Object.entries(next.assignments)) {
      if (profile.role === "http" && assigned.http === profile.id) assigned.http = null;
      if (profile.role === "mail" && assigned.mail === profile.id) assigned.mail = null;
      if (!assigned.http && !assigned.mail) delete next.assignments[domain];
    }
    if (profile.role === "mail") {
      if (next.defaultMailProfileId === profile.id) next.defaultMailProfileId = null;
    } else if (next.defaultHttpProfileId === profile.id) {
      next.defaultHttpProfileId = null;
    }
    return action.deleteProfileDirect(next, affected, `Deleted ${profile.name}. Its domains' DNS is left as it is.`);
  }
  if (verb === "set-automatic") {
    if (typeof body.automatic !== "boolean") failAction("Say whether DNS is Automatic");
    next.automatic = body.automatic;
    return action.change(next, body.automatic ? "DNS is Automatic." : `DNS asks first. Nothing in ${providerLabelFor(next)} or Mailcow was changed.`);
  }
  if (verb === "zone-account") {
    const ref = parseAccountRef(body.createIn);
    const known = new Set([...policy.connections.map((c) => c.id), ...(policy.powerdns ?? []).map((c) => c.id)]);
    if (ref && !known.has(ref.connectionId)) failAction("That connection no longer exists");
    next.createIn = ref;
    return action.change(next, "New zones go to the chosen account.", "all");
  }
  if (verb === "assign") {
    if (!Array.isArray(body.domains) || !body.domains.length) failAction("Select at least one site");
    let hasHttp = Object.prototype.hasOwnProperty.call(body, "httpProfileId");
    let hasMail = Object.prototype.hasOwnProperty.call(body, "mailProfileId");
    let httpId: string | null = null;
    let mailId: string | null = null;
    if (hasHttp) {
      httpId = body.httpProfileId == null || body.httpProfileId === "" ? null : profileById(policy, body.httpProfileId, "http").id;
    }
    if (hasMail) {
      mailId = body.mailProfileId == null || body.mailProfileId === "" ? null : profileById(policy, body.mailProfileId, "mail").id;
    }
    if (!hasHttp && !hasMail && Object.prototype.hasOwnProperty.call(body, "profileId")) {
      if (body.profileId == null || body.profileId === "") {
        hasHttp = true;
        hasMail = true;
        httpId = null;
        mailId = null;
      } else {
        const chosen = profileById(policy, body.profileId);
        if (chosen.role === "http") { hasHttp = true; httpId = chosen.id; }
        else { hasMail = true; mailId = chosen.id; }
      }
    }
    if (!hasHttp && !hasMail) failAction("Choose an HTTP or Mail role to assign");
    const domains = body.domains.map((domain) => hostname(domain, "a site"));
    const sites: string[] = [];
    const dnsOnly = action.dnsOnlyDomains(policy);
    for (const domain of domains) {
      if (!dnsOnly.includes(domain)) sites.push(action.site(domain).domain);
      const current = next.assignments[domain] ?? { http: null, mail: null };
      const updated = {
        http: hasHttp ? httpId : current.http,
        mail: hasMail ? mailId : current.mail,
      };
      if (updated.http || updated.mail) next.assignments[domain] = updated;
      else delete next.assignments[domain];
    }
    // Placing a site by hand is its review.
    next.held = next.held.filter((domain) => !domains.includes(domain));
    // A site placed by hand is not a new site for the default to claim.
    next.knownSiteIds = [...new Set([...next.knownSiteIds, ...sites.map((domain) => action.site(domain).id)])];
    const httpName = httpId ? next.profiles.find((profile) => profile.id === httpId)!.name : "DNS-only";
    const mailName = mailId ? next.profiles.find((profile) => profile.id === mailId)!.name : "None";
    const summary = hasHttp && hasMail
      ? (!httpId && !mailId ? "not managed" : `HTTP ${httpName}, Mail ${mailName}`)
      : hasHttp ? `HTTP ${httpName}` : `Mail ${mailName}`;
    return action.change(next, `Updated ${domains.length} ${domains.length === 1 ? "domain" : "domains"} (${summary}).`, domains);
  }
  if (verb === "set-default") {
    let hasHttp = Object.prototype.hasOwnProperty.call(body, "httpProfileId");
    let hasMail = Object.prototype.hasOwnProperty.call(body, "mailProfileId");
    if (hasHttp) {
      next.defaultHttpProfileId = body.httpProfileId == null || body.httpProfileId === "" ? null : profileById(policy, body.httpProfileId, "http").id;
    }
    if (hasMail) {
      next.defaultMailProfileId = body.mailProfileId == null || body.mailProfileId === "" ? null : profileById(policy, body.mailProfileId, "mail").id;
    }
    if (!hasHttp && !hasMail && Object.prototype.hasOwnProperty.call(body, "profileId")) {
      if (body.profileId == null || body.profileId === "") {
        next.defaultHttpProfileId = null;
        next.defaultMailProfileId = null;
      } else {
        const chosen = profileById(policy, body.profileId);
        if (chosen.role === "http") next.defaultHttpProfileId = chosen.id;
        else next.defaultMailProfileId = chosen.id;
      }
    }
    // The sites that exist now are not new sites, so a default never reaches back over them.
    next.knownSiteIds = action.sites().map((site) => site.id);
    const hasDefault = Boolean(next.defaultHttpProfileId || next.defaultMailProfileId);
    return action.change(next, hasDefault ? "Updated defaults for new sites." : "New sites will not join any HTTP or Mail role.");
  }
  if (verb === "choose-zone") {
    const zone = hostname(body.zone, "the zone");
    next.zoneChoices[zone] = { connectionId: connectionId(body.connectionId), zoneId: providerId(body.zoneId, "the zone") };
    const inZone = [...action.domainsOf(next), ...(next.panelHost ? [next.panelHost] : [])]
      .filter((domain) => domain === zone || domain.endsWith(`.${zone}`));
    return action.change(next, `${zone} is managed through the chosen connection.`, inZone);
  }
  if (verb === "set-panel-host") {
    const prepareOnly = body.prepareOnly === true;
    const name = body.name == null || body.name === "" ? null : hostname(body.name, "The panel hostname");
    if (prepareOnly && !name) failAction("Enter the panel hostname");
    if (name && !policy.connections.length && !(policy.powerdns?.length ?? 0)) failAction("Add a DNS connection first");
    if (name && action.sites().some((site) => site.domain === name)) failAction(`${name} is a CloudPanel site; choose another name for the panel`);
    if (name && policy.domains.includes(name)) failAction(`${name} is a DNS-only domain; choose another name for the panel`);
    next.panelHost = name;
    if (!name) return action.removePanelHost(next);
    if (prepareOnly) return action.preparePanelHost(policy, next, name);
    const notice = next.automatic
      ? `DNS points ${name} at this server.`
      : `Saved ${name}. Turn on Automatic when you are ready for DNS to write the record.`;
    return action.change(next, notice, [name]);
  }
  if (verb === "add-domain") {
    const domain = hostname(body.domain, "The domain");
    if (action.panelSites().some((site) => site.domain === domain)) failAction(`${domain} is a CloudPanel site; it is already listed`);
    if (policy.domains.includes(domain)) failAction(`${domain} is already listed`);
    if (domain === policy.panelHost) failAction(`${domain} is the panel hostname`);
    if (policy.domains.length >= MAX_DOMAINS) failAction(`At most ${MAX_DOMAINS} DNS-only domains can be added`);
    const http = body.httpProfileId == null || body.httpProfileId === "" ? null : profileById(policy, body.httpProfileId, "http").id;
    const mail = body.mailProfileId == null || body.mailProfileId === "" ? null : profileById(policy, body.mailProfileId, "mail").id;
    next.domains.push(domain);
    if (http || mail) next.assignments[domain] = { http, mail };
    else delete next.assignments[domain];
    next.held = next.held.filter((held) => held !== domain);
    return action.change(next, `Added ${domain}.`, [domain]);
  }
  if (verb === "remove-domain") {
    const domain = hostname(body.domain, "The domain");
    if (!policy.domains.includes(domain)) failAction(`${domain} is not a DNS-only domain`);
    if (action.panelSites(true).some((site) => site.domain === domain)) failAction(`${domain} is a CloudPanel site now and keeps its roles as one`);
    next.domains = next.domains.filter((listed) => listed !== domain);
    delete next.assignments[domain];
    next.held = next.held.filter((held) => held !== domain);
    return action.change(next, `Removed ${domain}. Its records are left in ${providerLabelFor(next)}.`);
  }
  if (verb === "save-server") {
    next.server = { ipv4: ipAddress(body.ipv4, 4, "The IPv4 address"), ipv6: ipAddress(body.ipv6, 6, "The IPv6 address") };
    return action.change(next, "Server addresses saved.", "all");
  }
  failAction(`unknown DNS change '${verb}'`);
}

function bodyOf(options: DnsActionOptions): Promise<Record<string, unknown>> {
  return readJsonRequest(options.input, MAX_BODY);
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
  if (verb === "panel-host-helper") return action.panelHostHelper();

  if (provision?.asUser) {
    const owns = withPanelDb(paths.panelDb, (db) => panelUserOwnsSite(db, provision.asUser!, provision.domain));
    if (!owns) failAction("That site is not one of yours");
  }
  if (verb === "site-status") return action.siteStatus(provision!.domain);
  // Every certificate CloudPanel writes wakes this, renewals included, so nothing waits for the lock unless there is work.
  if (verb === "sync-panel-host" && (!existsSync(paths.configFile) || !action.panelHostDue())) return { line: null };

  // Long enough for a check of the whole fleet; a page action waits less and says so.
  const wait = verb === "reconcile" || verb === "sync-sites" || verb === "sync-panel-host" || verb === "provision" ? 240 : 30;
  return withFileLock(paths.lockFile, wait, "DNS is busy checking your DNS provider; try again in a moment", async () => {
    if ((verb === "reconcile" || verb === "sync-sites" || verb === "sync-panel-host") && !existsSync(paths.configFile)) return { checked: 0, joined: [], line: null };
    let failed = false;
    try {
      action.noticeConnections();
      return await perform(action, verb, body, provision);
    } catch (error) {
      failed = true;
      if (!(error instanceof Error)) throw error;
      // Redaction is best effort: state that cannot be read now must not
      // replace the failure the operator needs to see.
      let secrets;
      try { secrets = action.files.secrets(); } catch { throw error; }
      const message = redact(error.message, [...Object.values(secrets.cloudflare), ...Object.values(secrets.powerdns ?? {}), secrets.mailcowKey]);
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
    case "sync-panel-host":
      action.cause = "Panel certificate";
      return { line: await action.syncPanelHost() };
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
    case "forget-records": {
      const domain = hostname(body.domain, "the site");
      const managed = action.files.managed();
      if (action.sites().some((site) => site.domain === domain)) failAction(`${domain} is still a CloudPanel site`);
      if (action.files.policy().domains.includes(domain)) failAction(`${domain} is still a DNS-only domain`);
      const entry = managed[domain];
      const provider = entry
        ? (entry.connectionId.startsWith("pdns-") ? PROVIDER_LABELS.powerdns : PROVIDER_LABELS.cloudflare)
        : providerLabelFor(action.files.policy());
      delete managed[domain];
      action.files.saveManaged(managed);
      return action.reply({ notice: `${domain}'s records are kept in ${provider} and no longer listed here.` });
    }
    default:
      return changeVerb(action, verb, body);
  }
}

export async function runDnsAction(argv: string[], options: DnsActionOptions = {}): Promise<number> {
  return replyToAction("dns", options.emitReply !== false, () => executeDnsAction(argv, options));
}

/**
 * Whether a DNS connection's token holds a permission on a zone, from the last
 * check's read of it, without calling Cloudflare. Null when that is not known:
 * no such connection, not checked yet, a token no longer active or that cannot
 * read itself, or a policy not understood that could change the answer.
 */
export function dnsTokenHolds(connectionId: string, permission: PermissionName, zone: { id: string; accountId: string }, paths: Partial<DnsPaths> = {}): boolean | null {
  return cloudflareTokenHolds(connectionId, permission, zone, cloudflarePathsOf({ ...DEFAULT_DNS_PATHS, ...paths }));
}

export type { AccessView };
