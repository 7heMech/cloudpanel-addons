/**
 * Relays CloudPanel sites' mail through named profiles, one SMTP account each.
 *
 * Postfix does the enforcing. Every site's Unix login may only use its own
 * domains as the envelope sender, and the envelope sender picks the profile's
 * relay and credential, so a site can only ever send through its own profile.
 * Loopback SMTP carries no login, so its unauthenticated relay is closed while
 * any site is routed.
 *
 * PHP's `mail()` additionally runs through `clp-addons smtp-submit`, set as
 * `sendmail_path` in each PHP version's conf.d, which only rewrites the From
 * header. Postfix cannot fix a From on another domain without a milter.
 */
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ActionFailure, emitActionError, emitActionOk, failAction, nameSlug, oneLine, runCommand, withFileLock,
  type CommandResult,
} from "../../cli/action-common";
import { CLI_BIN, PANEL_DB, STATE_DIR } from "../../cli/paths";
import { log } from "../../cli/util";
import { writeFileAtomic } from "../../lib/atomic-write";
import {
  DEFAULT_SENDER, envelopeGrants, parseRelay, parseSenderTemplate, senderFor, siteName, smtpAddress, smtpDomain,
  submissionRule, type SmtpProfile, type SmtpRelay, type SmtpRewriteRule, type SmtpSubmissionRule,
} from "./config";
import { prepareSubmission, RULE_DIR, rulePathFor, SENDMAIL } from "./submit";

type SmtpVerb = "list" | "save-profile" | "delete-profile" | "assign" | "set-default" | "save-grants" | "test" |
  "reconcile" | "sync-sites" | "deactivate";
const VERBS: SmtpVerb[] = ["list", "save-profile", "delete-profile", "assign", "set-default", "save-grants", "test",
  "reconcile", "sync-sites", "deactivate"];
const BODY_VERBS: SmtpVerb[] = ["save-profile", "delete-profile", "assign", "set-default", "save-grants", "test"];

const POSTFIX_KEYS = [
  "smtp_sasl_auth_enable", "smtp_sender_dependent_authentication", "smtp_sasl_password_maps",
  "smtp_sasl_tls_security_options", "smtp_tls_policy_maps", "sender_dependent_default_transport_maps",
  "sender_canonical_maps", "local_login_sender_maps", "smtpd_relay_restrictions",
] as const;
type PostfixKey = (typeof POSTFIX_KEYS)[number];
const TRUSTED_LOGINS = ["root", "postfix", "clp"];
const PHP_INI_NAME = "99-clp-addons-smtp.ini";
const PHP_INI = `; Managed by clp-addons SMTP Relay\nsendmail_path = ${CLI_BIN} smtp-submit -t -i\n`;
const DONT_SEND: SmtpProfile = { id: "dont-send", name: "Don't send", relay: null, sender: DEFAULT_SENDER };
const MAX_PROFILES = 24;
const NAME_MAX = 40;
const MAX_GRANTS = 30;
const MAX_ASSIGN = 2_000;

export interface SmtpSiteRow {
  id: number;
  domain: string;
  user: string;
  uid: number;
  gid: number;
  type: string;
  /** Null for a site that does not run PHP. */
  phpVersion: string | null;
}

interface SmtpPolicy {
  version: 2;
  profiles: SmtpProfile[];
  defaultProfileId: string | null;
  /** Domain to profile id. A site that is absent is in no profile and its mail is not relayed. */
  assignments: Record<string, string>;
  /** Extra domains an administrator let a site send as. */
  grants: Record<string, string[]>;
  knownSiteIds: number[];
}

export interface SmtpProfileView {
  id: string;
  name: string;
  relay: Omit<SmtpRelay, "password"> | null;
  sender: string;
  sites: number;
}
export interface SmtpSiteView {
  domain: string;
  user: string;
  type: string;
  phpVersion: string | null;
  profileId: string | null;
  /** The From template with {site} filled in, or null when the site's mail is not relayed. */
  sender: string | null;
  /** Why the site is not relayed although it is in a profile, or may not use its own domains although it is in none. */
  blocked: string | null;
  grants: string[];
}
export interface SmtpState {
  profiles: SmtpProfileView[];
  defaultProfileId: string | null;
  sites: SmtpSiteView[];
  skipped: { domain: string; reason: string }[];
}
export interface SmtpTestResult {
  queued: true;
  discarded: boolean;
  requested: string;
  sender: string;
  replyTo: string | null;
  recipient: string;
}

export interface SmtpPaths {
  panelDb: string;
  passwd: string;
  phpRoot: string;
  fpmBinDir: string;
  stateFile: string;
  originalFile: string;
  lockFile: string;
  ruleDir: string;
  postfixDir: string;
  sendmailLink: string;
  runuser: string;
  rootUid: number;
}
export interface SmtpActionOptions {
  paths?: Partial<SmtpPaths>;
  input?: string;
  emitReply?: boolean;
  run?: (command: string, args: string[]) => CommandResult;
  processUid?: number;
  /** Test fixtures may provide sites without a CloudPanel database. */
  sites?: SmtpSiteRow[];
}
export const DEFAULT_SMTP_PATHS: SmtpPaths = {
  panelDb: PANEL_DB,
  passwd: "/etc/passwd",
  phpRoot: "/etc/php",
  fpmBinDir: "/usr/sbin",
  stateFile: `${STATE_DIR}/smtp/config.json`,
  originalFile: `${STATE_DIR}/smtp/postfix-original.json`,
  lockFile: "/run/lock/clp-addons/smtp.lock",
  ruleDir: RULE_DIR,
  postfixDir: "/etc/postfix",
  sendmailLink: "/usr/local/bin/sendmail",
  runuser: "/usr/sbin/runuser",
  rootUid: 0,
};

type Run = (command: string, args: string[]) => CommandResult;
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);
const commandError = (result: CommandResult): string => result.stderr.trim() || result.stdout.trim() || "command failed";
function runChecked(run: Run, command: string, args: string[]): string {
  const result = run(command, args);
  if (!result.ok) failAction(`${command}: ${commandError(result)}`);
  return result.stdout.trim();
}

function trustedStat(path: string, uid: number): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
    failAction(`refusing untrusted SMTP file: ${path}`);
  }
}

function trustedRead(path: string, uid: number): string | null {
  if (!existsSync(path)) return null;
  trustedStat(path, uid);
  return readFileSync(path, "utf8");
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** Produced on read, like PHP Resources' presets, so a read never writes and a deleted one stays deleted. */
function seededPolicy(): SmtpPolicy {
  return { version: 2, profiles: [{ ...DONT_SEND }], defaultProfileId: null, assignments: {}, grants: {}, knownSiteIds: [] };
}

function parseProfileId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) failAction("that is not a profile identifier");
  return value;
}

function parseGrants(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_GRANTS) failAction(`a site can send as at most ${MAX_GRANTS} extra domains`);
  return [...new Set(value.map(smtpDomain))].sort();
}

function stablePolicy(policy: SmtpPolicy): SmtpPolicy {
  const ids = new Set(policy.profiles.map((profile) => profile.id));
  return {
    version: 2,
    profiles: policy.profiles,
    defaultProfileId: policy.defaultProfileId && ids.has(policy.defaultProfileId) ? policy.defaultProfileId : null,
    assignments: Object.fromEntries(Object.entries(policy.assignments)
      .filter(([, id]) => ids.has(id)).sort(([a], [b]) => a.localeCompare(b))),
    grants: Object.fromEntries(Object.entries(policy.grants)
      .filter(([, domains]) => domains.length > 0).sort(([a], [b]) => a.localeCompare(b))),
    knownSiteIds: [...new Set(policy.knownSiteIds.filter((id) => Number.isInteger(id) && id > 0))].sort((a, b) => a - b),
  };
}

function readPolicy(paths: SmtpPaths): SmtpPolicy {
  const raw = trustedRead(paths.stateFile, paths.rootUid);
  if (raw === null) return seededPolicy();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { failAction("SMTP configuration is malformed"); }
  const source = value as Partial<SmtpPolicy> | null;
  if (!source || typeof source !== "object" || source.version !== 2 || !Array.isArray(source.profiles) ||
      !source.assignments || typeof source.assignments !== "object" || !source.grants || typeof source.grants !== "object" ||
      !Array.isArray(source.knownSiteIds)) {
    failAction("SMTP configuration is malformed");
  }
  try {
    return stablePolicy({
      version: 2,
      profiles: source.profiles.map((profile) => {
        const raw = profile as unknown as Record<string, unknown>;
        return {
          id: parseProfileId(raw.id),
          name: oneLine(raw.name, "a profile name", NAME_MAX, true),
          relay: raw.relay == null ? null : parseRelay(raw.relay),
          sender: parseSenderTemplate(raw.sender),
        };
      }),
      defaultProfileId: source.defaultProfileId == null ? null : parseProfileId(source.defaultProfileId),
      assignments: Object.fromEntries(Object.entries(source.assignments).map(([domain, id]) => [smtpDomain(domain), parseProfileId(id)])),
      grants: Object.fromEntries(Object.entries(source.grants).map(([domain, list]) => [smtpDomain(domain), parseGrants(list)])),
      knownSiteIds: source.knownSiteIds,
    });
  } catch (error) {
    if (error instanceof ActionFailure) throw error;
    failAction(`SMTP configuration is malformed: ${reason(error)}`);
  }
}

function writePolicy(paths: SmtpPaths, policy: SmtpPolicy): void {
  if (existsSync(paths.stateFile)) trustedStat(paths.stateFile, paths.rootUid);
  writeFileAtomic(paths.stateFile, JSON.stringify(stablePolicy(policy), null, 2) + "\n", { mode: 0o600, createParent: true });
}

function findProfile(policy: SmtpPolicy, id: string): SmtpProfile {
  const profile = policy.profiles.find((candidate) => candidate.id === id);
  if (!profile) failAction(`there is no profile called '${id}'`);
  return profile;
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

interface SiteSet {
  sites: SmtpSiteRow[];
  /** Sites SMTP cannot bind. Their logins keep only their bare names, and the other sites are still managed. */
  skipped: { id: number; domain: string; reason: string }[];
}

function checkedSites(rows: SmtpSiteRow[], skipped: SiteSet["skipped"] = []): SiteSet {
  const valid: SmtpSiteRow[] = [];
  for (const site of rows) {
    let domain: string | null = null;
    try { domain = smtpDomain(site.domain); } catch { /* reported as skipped */ }
    const reason = domain === null ? "its domain is not one mail can use"
      : !/^[a-z_][a-z0-9_-]{0,31}$/.test(site.user) || TRUSTED_LOGINS.includes(site.user) ? `its Unix user ${site.user} cannot be bound`
      : site.phpVersion !== null && !/^[0-9]+\.[0-9]+$/.test(site.phpVersion) ? "its PHP version is unreadable"
      : !Number.isInteger(site.uid) || site.uid < 1 || !Number.isInteger(site.gid) || site.gid < 0 ? "its Unix account is invalid"
      : null;
    if (reason) skipped.push({ id: site.id, domain: site.domain, reason });
    else valid.push({ ...site, domain: domain! });
  }
  const uids = new Map<number, number>();
  for (const site of valid) uids.set(site.uid, (uids.get(site.uid) ?? 0) + 1);
  for (const site of valid) {
    if (uids.get(site.uid)! > 1) skipped.push({ id: site.id, domain: site.domain, reason: `it shares Unix UID ${site.uid} with another site` });
  }
  return { sites: valid.filter((site) => uids.get(site.uid) === 1), skipped };
}

/** Every CloudPanel site, whatever it runs: anything can call sendmail as its site user. */
function panelSites(paths: SmtpPaths, fixture?: SmtpSiteRow[]): SiteSet {
  if (fixture) return checkedSites(fixture);
  const accounts = new Map<string, { uid: number; gid: number }>();
  for (const line of readFileSync(paths.passwd, "utf8").split("\n")) {
    const [name, , uid, gid] = line.split(":");
    if (name && uid && gid) accounts.set(name, { uid: Number(uid), gid: Number(gid) });
  }
  const db = new Database(paths.panelDb, { readonly: true });
  try {
    const rows = db.query<{ id: number; domain_name: string; user: string; type: string; php_version: string | null }, []>(
      `SELECT site.id, site.domain_name, site.user, site.type, php_settings.php_version
         FROM site LEFT JOIN php_settings ON php_settings.site_id = site.id
        ORDER BY site.domain_name`,
    ).all();
    const sites: SmtpSiteRow[] = [];
    const skipped: SiteSet["skipped"] = [];
    for (const row of rows) {
      const account = accounts.get(String(row.user));
      if (!account) {
        skipped.push({ id: Number(row.id), domain: String(row.domain_name), reason: "it has no Unix account" });
        continue;
      }
      sites.push({
        id: Number(row.id), domain: String(row.domain_name), user: String(row.user), uid: account.uid, gid: account.gid,
        type: String(row.type), phpVersion: row.php_version == null ? null : String(row.php_version),
      });
    }
    return checkedSites(sites, skipped);
  } finally {
    db.close();
  }
}

function requireSite(sites: SmtpSiteRow[], domain: string): SmtpSiteRow {
  const site = sites.find((candidate) => candidate.domain === domain);
  if (!site) failAction(`CloudPanel has no site ${domain}`);
  return site;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

interface Route {
  site: SmtpSiteRow;
  /** Null when the site is in no profile, or is blocked. */
  profile: SmtpProfile | null;
  rule: SmtpRewriteRule;
  /** Envelope senders this site's login may use, as `@domain` or an exact address. */
  envelopes: string[];
  /** Why the site's login may send only as its bare name: its senders reach another profile's account. */
  blocked: string | null;
}

const domainOf = (pattern: string): string => pattern.slice(pattern.lastIndexOf("@") + 1);

/**
 * Each site's rule and envelope senders. A site that could send through
 * another profile's account is blocked instead: it is not relayed and its
 * login keeps only its bare name. Sites in a profile claim first, so a site in
 * none never displaces one that is.
 */
function routesFor(policy: SmtpPolicy, sites: SmtpSiteRow[]): Route[] {
  const names = new Set(sites.map((site) => site.domain));
  const profiles = new Map(policy.profiles.map((profile) => [profile.id, profile]));
  const routes = sites.map((site): Route => {
    const profile = profiles.get(policy.assignments[site.domain] ?? "") ?? null;
    const rule = submissionRule(site.domain, siteName(site.domain, names), profile?.sender ?? DEFAULT_SENDER,
      policy.grants[site.domain] ?? []);
    return { site, profile, rule, envelopes: envelopeGrants(rule), blocked: null };
  });
  const claims = new Map<string, [string, Route][]>();
  for (const route of [...routes.filter((route) => route.profile), ...routes.filter((route) => !route.profile)]) {
    for (const pattern of route.envelopes) {
      const clash = (claims.get(domainOf(pattern)) ?? []).find(([claimed, owner]) => owner.profile!.id !== route.profile?.id &&
        (claimed === pattern || claimed.startsWith("@") || pattern.startsWith("@")));
      if (!clash) continue;
      route.blocked = `${route.site.domain} can send as ${pattern}, which ${clash[1].site.domain} sends through the ${clash[1].profile!.name} profile`;
      route.profile = null;
      route.envelopes = [];
      break;
    }
    for (const pattern of route.profile ? route.envelopes : []) {
      claims.set(domainOf(pattern), [...(claims.get(domainOf(pattern)) ?? []), [pattern, route]]);
    }
  }
  return routes;
}

/** The first site `next` blocks that `before` did not, keyed with its profile so a blocked site moved elsewhere counts. */
function newBlock(before: SmtpPolicy, next: SmtpPolicy, sites: SmtpSiteRow[]): string | null {
  const blocks = (policy: SmtpPolicy) => new Map(routesFor(policy, sites).filter((route) => route.blocked)
    .map((route) => [`${route.site.domain} ${policy.assignments[route.site.domain] ?? ""}`, route.blocked!]));
  const existing = blocks(before);
  return [...blocks(next)].find(([key]) => !existing.has(key))?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Postfix
// ---------------------------------------------------------------------------

interface OriginalPostfix { version: 1; values: Record<string, string | null> }

const regexEscape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
// Postfix regexp tables read $n in a result as a capture reference.
const regexpResult = (value: string): string => value.split("$").join("$$");
const relayDestination = (relay: SmtpRelay): string => `[${relay.host}]:${relay.port}`;
function senderPattern(entry: string): string {
  return entry.startsWith("@") ? `/@${regexEscape(entry.slice(1))}$/` : `/^${regexEscape(entry)}$/`;
}

function managedFiles(paths: SmtpPaths) {
  const file = (name: string) => join(paths.postfixDir, `clp-addons-${name}`);
  return {
    transports: file("transports"), credentials: file("sasl"), tls: file("tls-policy"),
    canonical: file("canonical"), senders: file("local-senders"), fallback: file("login-fallback"),
  };
}
type ManagedMap = keyof ReturnType<typeof managedFiles>;
const HASH_MAPS: ManagedMap[] = ["canonical", "senders"];

export function postfixMaps(routes: Route[], origin: string): Record<ManagedMap, string> {
  const claimed = new Map<string, SmtpProfile>();
  for (const route of routes) {
    if (route.profile) for (const pattern of route.envelopes) claimed.set(pattern, route.profile);
  }
  // A regexp table stops at its first match, so exact addresses come before whole domains.
  const ordered = [...claimed].sort(([a], [b]) =>
    a.startsWith("@") === b.startsWith("@") ? a.localeCompare(b) : a.startsWith("@") ? 1 : -1);
  const lines = (entries: string[]) => entries.map((entry) => `${entry}\n`).join("");
  const relays = ordered.filter(([, profile]) => profile.relay);
  return {
    transports: lines(ordered.map(([pattern, profile]) =>
      `${senderPattern(pattern)} ${profile.relay ? `smtp:${relayDestination(profile.relay)}` : "discard:"}`)),
    credentials: lines(relays.map(([pattern, profile]) =>
      `${senderPattern(pattern)} ${regexpResult(profile.relay!.username)}:${regexpResult(profile.relay!.password)}`)),
    tls: lines([...new Set(relays.map(([, profile]) => relayDestination(profile.relay!)))].sort()
      .map((destination) => `/^${regexEscape(destination)}$/ secure match=nexthop`)),
    canonical: lines(routes.filter((route) => route.profile)
      .map((route) => `${route.site.user}@${origin} ${senderFor(route.rule.sender, route.rule.site)}`)),
    senders: lines([...TRUSTED_LOGINS.map((login) => `${login} *`),
      ...routes.map((route) => `${route.site.user} ${[route.site.user, ...route.envelopes].join(" ")}`)]),
    fallback: lines(["/^(.+)$/ $1"]),
  };
}

function explicitPostfixValue(explicit: string, key: string): string | null {
  const match = explicit.match(new RegExp(`(?:^|\\n)${key}[ \\t]*=[ \\t]*([^\\n]*)`));
  return match ? match[1]!.trim() : null;
}

function postfixSettings(explicit: string): Record<PostfixKey, string | null> {
  return Object.fromEntries(POSTFIX_KEYS.map((key) => [key, explicitPostfixValue(explicit, key)])) as Record<PostfixKey, string | null>;
}

function applyPostfixSettings(values: Record<string, string | null>, run: Run): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === null) runChecked(run, "postconf", ["-X", key]);
    else runChecked(run, "postconf", ["-e", `${key}=${value}`]);
  }
}

/** The operator's values for every key this addon manages, recorded before it first changes one. */
function originalPostfix(paths: SmtpPaths, current: Record<PostfixKey, string | null>): Record<string, string | null> {
  const raw = trustedRead(paths.originalFile, paths.rootUid);
  const backup: OriginalPostfix = raw ? JSON.parse(raw) as OriginalPostfix : { version: 1, values: {} };
  if (backup.version !== 1 || !backup.values) failAction("Postfix backup is malformed");
  let changed = raw === null;
  for (const key of POSTFIX_KEYS) {
    if (key in backup.values) continue;
    backup.values[key] = current[key]?.includes("/clp-addons-") ? null : current[key];
    changed = true;
  }
  if (changed) writeFileAtomic(paths.originalFile, JSON.stringify(backup, null, 2) + "\n", { mode: 0o600, createParent: true });
  return backup.values;
}

/** Ours first, so a match in the operator's own table cannot take a routed sender. */
function chained(ours: string, theirs: string | null | undefined): string {
  return theirs ? `${ours}, ${theirs}` : ours;
}

/** The operator's relay restrictions without `permit_mynetworks`, which lets any local process relay as anyone. */
export function closedRelay(original: string | null | undefined): string {
  const rest = (original ?? "permit_mynetworks, permit_sasl_authenticated, defer_unauth_destination")
    .replace(/(^|[\s,])permit_mynetworks(?=$|[\s,])/g, "$1")
    .replace(/^[\s,]+|[\s,]+$/g, "").replace(/\s*,\s*,\s*/g, ", ");
  return rest || "permit_sasl_authenticated, defer_unauth_destination";
}

function mailOrigin(run: Run): string {
  let origin = runChecked(run, "postconf", ["-xh", "myorigin"]);
  if (origin.startsWith("/")) origin = (readFileSync(origin, "utf8").split("\n")[0] ?? "").trim();
  origin = origin.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(origin)) failAction(`Postfix myorigin is not a hostname: ${origin}`);
  return origin;
}

interface FileSnapshot { path: string; content: Buffer | null; mode: number }

function snapshotFiles(paths: SmtpPaths, files: string[]): FileSnapshot[] {
  return files.map((path) => {
    if (!existsSync(path)) return { path, content: null, mode: 0o644 };
    trustedStat(path, paths.rootUid);
    return { path, content: readFileSync(path), mode: lstatSync(path).mode & 0o777 };
  });
}

function restoreFiles(snapshot: FileSnapshot[]): void {
  for (const { path, content, mode } of snapshot) {
    if (content === null) rmSync(path, { force: true });
    else writeFileAtomic(path, content, { mode, createParent: true });
  }
}

function applyPostfix(paths: SmtpPaths, routes: Route[], run: Run): void {
  const explicit = runChecked(run, "postconf", ["-n"]);
  if (explicitPostfixValue(explicit, "transport_maps")) {
    failAction("Postfix transport_maps can route mail around the SMTP relay; remove it before routing sites");
  }
  const current = postfixSettings(explicit);
  const files = managedFiles(paths);
  const localSenders = `hash:${files.senders}, regexp:${files.fallback}`;
  // A Postfix already running our sender map has passed this before.
  if (current.local_login_sender_maps !== localSenders &&
      !/^local_login_sender_maps\s*=/.test(runChecked(run, "postconf", ["-d", "local_login_sender_maps"]))) {
    failAction("Postfix 3.6 or newer is required for local sender restrictions");
  }
  const maps = postfixMaps(routes, mailOrigin(run));
  const tracked = [...Object.values(files), ...HASH_MAPS.map((name) => `${files[name]}.db`)];
  const snapshot = snapshotFiles(paths, tracked);
  const before = new Map(snapshot.map((item) => [item.path, item]));
  const original = originalPostfix(paths, current);
  const settings: Record<PostfixKey, string> = {
    smtp_sasl_auth_enable: "yes",
    smtp_sender_dependent_authentication: "yes",
    smtp_sasl_password_maps: chained(`regexp:${files.credentials}`, original.smtp_sasl_password_maps),
    smtp_sasl_tls_security_options: "noanonymous",
    smtp_tls_policy_maps: chained(`regexp:${files.tls}`, original.smtp_tls_policy_maps),
    sender_dependent_default_transport_maps: chained(`regexp:${files.transports}`, original.sender_dependent_default_transport_maps),
    sender_canonical_maps: chained(`hash:${files.canonical}`, original.sender_canonical_maps),
    local_login_sender_maps: localSenders,
    smtpd_relay_restrictions: closedRelay(original.smtpd_relay_restrictions),
  };
  const changedMaps = (Object.keys(files) as ManagedMap[])
    .filter((name) => before.get(files[name])!.content?.toString("utf8") !== maps[name]);
  const staleHashes = HASH_MAPS.filter((name) => {
    const db = before.get(`${files[name]}.db`)!;
    return changedMaps.includes(name) || db.content === null || lstatSync(files[name]).mtimeMs > lstatSync(`${files[name]}.db`).mtimeMs;
  });
  const changedSettings = POSTFIX_KEYS.filter((key) => current[key] !== settings[key]);
  if (!changedMaps.length && !staleHashes.length && !changedSettings.length) return;
  try {
    for (const name of changedMaps) {
      writeFileAtomic(files[name], maps[name], { mode: name === "credentials" ? 0o600 : 0o644, createParent: true });
    }
    for (const name of staleHashes) {
      runChecked(run, "postmap", [`hash:${files[name]}`]);
      chmodSync(`${files[name]}.db`, 0o644);
    }
    for (const key of changedSettings) runChecked(run, "postconf", ["-e", `${key}=${settings[key]}`]);
    runChecked(run, "postfix", ["check"]);
    runChecked(run, "systemctl", ["reload", "postfix"]);
  } catch (error) {
    restoreFiles(snapshot);
    applyPostfixSettings(Object.fromEntries(changedSettings.map((key) => [key, current[key]])), run);
    runChecked(run, "postfix", ["check"]);
    runChecked(run, "systemctl", ["reload", "postfix"]);
    throw error;
  }
}

function withdrawPostfix(paths: SmtpPaths, run: Run): void {
  const raw = trustedRead(paths.originalFile, paths.rootUid);
  if (raw) {
    const backup = JSON.parse(raw) as OriginalPostfix;
    if (backup.version !== 1 || !backup.values) failAction("Postfix backup is malformed");
    applyPostfixSettings(backup.values, run);
    runChecked(run, "postfix", ["check"]);
    runChecked(run, "systemctl", ["reload", "postfix"]);
    rmSync(paths.originalFile);
  }
  const files = managedFiles(paths);
  for (const path of [...Object.values(files), ...HASH_MAPS.map((name) => `${files[name]}.db`)]) {
    if (existsSync(path)) trustedStat(path, paths.rootUid);
    rmSync(path, { force: true });
  }
}

// ---------------------------------------------------------------------------
// The PHP side: one conf.d file per PHP version, and one rule file per site
// ---------------------------------------------------------------------------

/** `present` is false for a PHP-FPM whose package was removed but whose conf.d was left behind. */
function phpIniTargets(paths: SmtpPaths): { version: string; sapi: string; path: string; present: boolean }[] {
  if (!existsSync(paths.phpRoot)) return [];
  return readdirSync(paths.phpRoot).filter((version) => /^[0-9]+\.[0-9]+$/.test(version)).sort()
    .flatMap((version) => ["fpm", "cli"]
      .filter((sapi) => existsSync(join(paths.phpRoot, version, sapi, "conf.d")))
      .map((sapi) => ({
        version, sapi, path: join(paths.phpRoot, version, sapi, "conf.d", PHP_INI_NAME),
        present: sapi !== "fpm" || existsSync(join(paths.fpmBinDir, `php-fpm${version}`)),
      })));
}

/** Installs or removes the conf.d file everywhere, testing and reloading each PHP-FPM it changed. */
function syncPhpIni(paths: SmtpPaths, install: boolean, run: Run): number {
  const changes = phpIniTargets(paths).flatMap((target) => {
    const before = existsSync(target.path) ? (trustedStat(target.path, paths.rootUid), readFileSync(target.path, "utf8")) : null;
    const after = install && target.present ? PHP_INI : null;
    return before === after ? [] : [{ ...target, before, after }];
  });
  const fpm = [...new Set(changes.filter((change) => change.sapi === "fpm" && change.present).map((change) => change.version))];
  const write = (path: string, content: string | null) => content === null
    ? rmSync(path, { force: true })
    : writeFileAtomic(path, content, { mode: 0o644 });
  try {
    for (const change of changes) write(change.path, change.after);
    for (const version of fpm) {
      runChecked(run, join(paths.fpmBinDir, `php-fpm${version}`), ["-t"]);
      runChecked(run, "systemctl", ["try-reload-or-restart", `php${version}-fpm`]);
    }
  } catch (error) {
    for (const change of changes) write(change.path, change.before);
    for (const version of fpm) run("systemctl", ["try-reload-or-restart", `php${version}-fpm`]);
    throw error;
  }
  return changes.length;
}

/** Every PHP site gets one: a site that is not relayed still needs an envelope sender Postfix accepts. */
function syncRuleFiles(paths: SmtpPaths, routes: Route[]): void {
  const wanted = new Map(routes.filter((route) => route.site.phpVersion !== null)
    .map((route) => [rulePathFor(route.site.uid, paths.ruleDir), route]));
  if (!existsSync(paths.ruleDir)) {
    if (!wanted.size) return;
    mkdirSync(paths.ruleDir, { recursive: true, mode: 0o755 });
  }
  for (const name of readdirSync(paths.ruleDir)) {
    const path = join(paths.ruleDir, name);
    if (/^[0-9]+\.json$/.test(name) && !wanted.has(path)) rmSync(path, { force: true });
  }
  for (const [path, route] of wanted) {
    const rule: SmtpSubmissionRule = route.profile ? route.rule
      : { ...route.rule, sender: null, allowed: route.blocked ? [] : route.rule.allowed };
    const content = JSON.stringify(rule) + "\n";
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (stat.isFile() && stat.uid === paths.rootUid && stat.gid === route.site.gid && (stat.mode & 0o777) === 0o640 &&
          readFileSync(path, "utf8") === content) continue;
    }
    writeFileAtomic(path, content, { mode: 0o640, owner: { uid: paths.rootUid, gid: route.site.gid } });
  }
}

/** The default PATH leaves out /usr/sbin, where apps that run `sendmail` by name, such as Nodemailer, would not find it. */
function syncSendmailLink(paths: SmtpPaths, install: boolean): number {
  let target: string | null = null;
  try {
    target = lstatSync(paths.sendmailLink).isSymbolicLink() ? readlinkSync(paths.sendmailLink) : "";
  } catch {}
  // Whatever else is already there is the operator's.
  if (install && target === null) symlinkSync(SENDMAIL, paths.sendmailLink);
  else if (!install && target === SENDMAIL) rmSync(paths.sendmailLink);
  else return 0;
  return 1;
}

// ---------------------------------------------------------------------------
// Applying a policy
// ---------------------------------------------------------------------------

function withdrawAll(paths: SmtpPaths, run: Run): void {
  syncPhpIni(paths, false, run);
  syncRuleFiles(paths, []);
  syncSendmailLink(paths, false);
  withdrawPostfix(paths, run);
}

/** Converges the box on a policy; returns how many of its mail settings it had to put back. */
function applyConfiguration(paths: SmtpPaths, policy: SmtpPolicy, sites: SmtpSiteRow[], run: Run): number {
  const routes = routesFor(policy, sites);
  if (!routes.some((route) => route.profile)) {
    withdrawAll(paths, run);
    return 0;
  }
  applyPostfix(paths, routes, run);
  syncRuleFiles(paths, routes);
  return syncPhpIni(paths, true, run) + syncSendmailLink(paths, true);
}

/** Saves a policy only once the box runs it, and puts the old one back if it could not. */
function commit(paths: SmtpPaths, before: SmtpPolicy, next: SmtpPolicy, sites: SmtpSiteRow[], run: Run): number {
  // A site blocked already, say by a site created after a grant, does not stop unrelated changes.
  const blocked = newBlock(before, next, sites);
  if (blocked) failAction(blocked);
  try {
    const written = applyConfiguration(paths, next, sites, run);
    writePolicy(paths, next);
    return written;
  } catch (error) {
    try {
      applyConfiguration(paths, before, sites, run);
    } catch (rollbackError) {
      failAction(`SMTP update failed (${reason(error)}); restoring the previous settings also failed: ${reason(rollbackError)}`);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

function stateOf(policy: SmtpPolicy, { sites, skipped }: SiteSet): SmtpState {
  const routes = new Map(routesFor(policy, sites).map((route) => [route.site, route]));
  const profiles = new Map(policy.profiles.map((profile) => [profile.id, profile]));
  const count = (id: string) => sites.filter((site) => policy.assignments[site.domain] === id).length;
  return {
    profiles: policy.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      relay: profile.relay ? { host: profile.relay.host, port: profile.relay.port, username: profile.relay.username } : null,
      sender: profile.sender,
      sites: count(profile.id),
    })),
    defaultProfileId: policy.defaultProfileId,
    sites: sites.map((site) => {
      const route = routes.get(site)!;
      return {
        domain: site.domain, user: site.user, type: site.type, phpVersion: site.phpVersion,
        profileId: profiles.get(policy.assignments[site.domain] ?? "")?.id ?? null,
        sender: route.profile ? route.profile.sender.replaceAll("{site}", route.rule.site) : null,
        blocked: route.blocked,
        grants: policy.grants[site.domain] ?? [],
      };
    }),
    skipped: skipped.map(({ domain, reason }) => ({ domain, reason })),
  };
}

interface ProfileRequest {
  id: string | null;
  name: string;
  relay: (Omit<SmtpRelay, "password"> & { password: string }) | null;
  sender: string;
}

function profileRequest(body: Record<string, unknown>): ProfileRequest {
  let relay: ProfileRequest["relay"] = null;
  if (body.relay != null) {
    const raw = body.relay as Record<string, unknown>;
    if (typeof raw !== "object" || Array.isArray(raw)) failAction("relay must be an object");
    const password = raw.password ?? "";
    if (typeof password !== "string") failAction("SMTP password is invalid");
    // Validated with a placeholder so a blank password can keep the saved one.
    const checked = parseRelay({ ...raw, password: password || "unchanged" });
    relay = { host: checked.host, port: checked.port, username: checked.username, password };
  }
  return {
    id: body.id == null ? null : parseProfileId(body.id),
    name: oneLine(body.name, "a profile name", NAME_MAX, true),
    relay,
    sender: parseSenderTemplate(body.sender ?? DEFAULT_SENDER),
  };
}

function saveProfile(policy: SmtpPolicy, request: ProfileRequest): SmtpPolicy {
  const next = structuredClone(policy);
  const clash = next.profiles.find((profile) => profile.id !== request.id && profile.name.toLowerCase() === request.name.toLowerCase());
  if (clash) failAction(`a profile called '${clash.name}' already exists`);
  let profile: SmtpProfile;
  if (request.id === null) {
    if (next.profiles.length >= MAX_PROFILES) failAction(`a server can hold at most ${MAX_PROFILES} profiles`);
    const id = nameSlug(request.name, "a profile name");
    if (next.profiles.some((candidate) => candidate.id === id)) failAction(`a profile called '${request.name}' already exists`);
    profile = { id, name: request.name, relay: null, sender: request.sender };
    next.profiles.push(profile);
  } else {
    profile = findProfile(next, request.id);
  }
  const saved = profile.relay?.password;
  profile.name = request.name;
  profile.sender = request.sender;
  profile.relay = request.relay
    ? parseRelay({ ...request.relay, password: request.relay.password || saved })
    : null;
  return next;
}

function assignRequest(body: Record<string, unknown>): { domains: string[]; profileId: string | null } {
  if (!Array.isArray(body.domains) || body.domains.length === 0) failAction("no sites were named");
  if (body.domains.length > MAX_ASSIGN) failAction("too many sites were named at once");
  return {
    domains: [...new Set(body.domains.map(smtpDomain))],
    profileId: body.profileId == null ? null : parseProfileId(body.profileId),
  };
}

function sendTest(paths: SmtpPaths, policy: SmtpPolicy, sites: SmtpSiteRow[], body: Record<string, unknown>): SmtpTestResult {
  const site = requireSite(sites, smtpDomain(body.domain));
  const route = routesFor(policy, sites).find((candidate) => candidate.site === site)!;
  if (route.blocked) failAction(`${site.domain} is not relayed: ${route.blocked}`);
  if (!route.profile) failAction(`${site.domain} is in no profile, so its mail is not relayed`);
  const recipient = smtpAddress(body.recipient);
  const php = site.phpVersion !== null;
  const requested = body.from ? smtpAddress(body.from)
    : php ? `wordpress@${route.rule.site}` : senderFor(route.rule.sender, route.rule.site);
  const path = php ? "PHP's mail path" : "sendmail";
  const message = Buffer.from(`To: ${recipient}\nFrom: ${requested}\nSubject: CloudPanel SMTP relay test for ${site.domain}\n\n` +
    `This message was sent as ${site.user} through ${path} and the ${route.profile.name} profile.\n`);
  // Plain sendmail keeps the From the app wrote; Postfix maps only the envelope.
  let sender = requested;
  let replyTo: string | null = null;
  if (php) {
    const prepared = prepareSubmission(message, route.rule);
    sender = prepared.sender;
    replyTo = Buffer.from(prepared.message).toString("utf8").match(/^Reply-To: (.+)$/m)?.[1] ?? null;
  }
  const command = php ? [CLI_BIN, "smtp-submit", "-t", "-i"] : [SENDMAIL, "-t", "-i"];
  const submit = Bun.spawnSync([paths.runuser, "-u", site.user, "--", ...command], {
    stdin: message, stdout: "pipe", stderr: "pipe", maxBuffer: 64 * 1024, timeout: 30_000,
  });
  if (!submit.success) {
    const detail = Buffer.from(submit.stderr).toString("utf8").trim().replace(/^\[smtp\] /, "");
    failAction(`${site.domain}'s ${path} did not queue the test: ${detail || "submission failed"}`);
  }
  return { queued: true, discarded: route.profile.relay === null, requested, sender, replyTo, recipient };
}

/**
 * New sites join the default profile, and sites CloudPanel no longer has drop
 * out. With `repair`, an unchanged policy is applied again to undo drift.
 */
function reconcile(paths: SmtpPaths, policy: SmtpPolicy, { sites, skipped }: SiteSet, run: Run, repair: boolean): { repaired: number; joined: number } {
  let next = structuredClone(policy);
  const live = new Set([...sites, ...skipped].map((site) => site.domain));
  for (const domain of Object.keys(next.assignments)) if (!live.has(domain)) delete next.assignments[domain];
  for (const domain of Object.keys(next.grants)) if (!live.has(domain)) delete next.grants[domain];
  const known = new Set(policy.knownSiteIds);
  let joined = 0;
  for (const site of sites) {
    if (known.has(site.id) || next.defaultProfileId === null || next.assignments[site.domain]) continue;
    const candidate = structuredClone(next);
    candidate.assignments[site.domain] = next.defaultProfileId;
    // A new site whose senders another profile already uses stays out, rather than blocking a site that works.
    if (newBlock(next, candidate, sites)) continue;
    next = candidate;
    joined++;
  }
  next.knownSiteIds = sites.map((site) => site.id);
  // Only drift on an unchanged policy counts as repaired; a new site joining is reported as such.
  if (JSON.stringify(stablePolicy(next)) !== JSON.stringify(stablePolicy(policy))) {
    commit(paths, policy, next, sites, run);
    return { repaired: 0, joined };
  }
  return { repaired: repair ? applyConfiguration(paths, next, sites, run) : 0, joined };
}

async function inputBody(options: SmtpActionOptions): Promise<Record<string, unknown>> {
  const raw = options.input ?? await Bun.stdin.text();
  if (Buffer.byteLength(raw) > 256 * 1024) failAction("SMTP request is too large");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { failAction("SMTP request must be JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) failAction("SMTP request must be an object");
  return value as Record<string, unknown>;
}

export async function executeSmtpAction(argv: string[], options: SmtpActionOptions = {}): Promise<unknown> {
  if ((options.processUid ?? process.getuid?.()) !== 0) failAction("SMTP actions must run as root");
  const verb = argv[0] as SmtpVerb | undefined;
  if (argv.length !== 1 || !verb || !VERBS.includes(verb)) failAction(`usage: clp-addons action smtp {${VERBS.join("|")}}`);
  const paths = { ...DEFAULT_SMTP_PATHS, ...options.paths };
  const run = options.run ?? runCommand;
  const body = BODY_VERBS.includes(verb) ? await inputBody(options) : {};
  // Request data is checked before the lock; anything that depends on the
  // current policy or sites is checked under it.
  const profile = verb === "save-profile" ? profileRequest(body) : null;
  const assignment = verb === "assign" ? assignRequest(body) : null;
  const grants = verb === "save-grants" ? { domain: smtpDomain(body.domain), domains: parseGrants(body.domains ?? []) } : null;
  const target = verb === "delete-profile" ? parseProfileId(body.id)
    : verb === "set-default" ? (body.profileId == null ? null : parseProfileId(body.profileId)) : null;
  if (verb === "test") { smtpDomain(body.domain); smtpAddress(body.recipient); if (body.from) smtpAddress(body.from); }
  mkdirSync(dirname(paths.lockFile), { recursive: true, mode: 0o700 });
  return withFileLock(paths.lockFile, 30, "SMTP configuration is busy", async () => {
    if (verb === "deactivate") {
      withdrawAll(paths, run);
      return { deactivated: true };
    }
    const policy = readPolicy(paths);
    const siteSet = panelSites(paths, options.sites);
    const { sites } = siteSet;
    if (verb === "list") return stateOf(policy, siteSet);
    if (verb === "test") return sendTest(paths, policy, sites, body);
    if (verb === "reconcile" || verb === "sync-sites") return reconcile(paths, policy, siteSet, run, verb === "reconcile");
    let next = structuredClone(policy);
    if (profile) next = saveProfile(policy, profile);
    if (verb === "delete-profile") {
      findProfile(next, target!);
      next.profiles = next.profiles.filter((candidate) => candidate.id !== target);
      for (const [domain, id] of Object.entries(next.assignments)) if (id === target) delete next.assignments[domain];
      if (next.defaultProfileId === target) next.defaultProfileId = null;
    }
    if (assignment) {
      const chosen = assignment.domains.map((domain) => requireSite(sites, domain));
      if (assignment.profileId) findProfile(next, assignment.profileId);
      for (const site of chosen) {
        if (assignment.profileId) next.assignments[site.domain] = assignment.profileId;
        else delete next.assignments[site.domain];
        // Choosing a site's profile, or none, is a decision the default for new sites must not undo.
        next.knownSiteIds.push(site.id);
      }
    }
    if (verb === "set-default") {
      if (target) findProfile(next, target);
      next.defaultProfileId = target;
      // The sites that exist now are not new sites, so a default never reaches back over them.
      if (target) next.knownSiteIds = sites.map((site) => site.id);
    }
    if (grants) {
      requireSite(sites, grants.domain);
      next.grants[grants.domain] = grants.domains;
    }
    commit(paths, policy, next, sites, run);
    return stateOf(stablePolicy(next), siteSet);
  });
}

export async function runSmtpAction(argv: string[], options: SmtpActionOptions = {}): Promise<number> {
  try {
    const result = await executeSmtpAction(argv, options);
    if (options.emitReply !== false) emitActionOk(result);
    return 0;
  } catch (error) {
    if (options.emitReply !== false) emitActionError(reason(error), error instanceof ActionFailure ? error.data : undefined, "smtp");
    return 1;
  }
}

/** Called by disable/uninstall after the addon is no longer available to the UI. */
export function deactivateSmtp(): void {
  const result = runCommand(CLI_BIN, ["action", "smtp", "deactivate"]);
  if (!result.ok) failAction(`SMTP could not be deactivated: ${commandError(result)}`);
}

/** Called by enable, since disable withdrew the policy it kept; the repair timer retries a failure. */
export function activateSmtp(): void {
  const result = runCommand(CLI_BIN, ["action", "smtp", "reconcile"]);
  if (!result.ok) log.warn(`SMTP Relay could not reapply its profiles yet: ${commandError(result)}`);
}
