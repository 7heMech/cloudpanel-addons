import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ActionFailure, emitActionError, emitActionOk, failAction, runCommand, withFileLock,
  type CommandResult,
} from "../../cli/action-common";
import { CLI_BIN, PANEL_DB, STATE_DIR } from "../../cli/paths";
import { writeFileAtomic } from "../../lib/atomic-write";
import {
  emptySmtpPolicy, parseRelay, parseRule, senderFor, smtpAddress, smtpDomain,
  type SmtpPolicy, type SmtpRelay, type SmtpSiteRule, type SmtpSubmissionPolicy,
} from "./config";
import { SUBMISSION_POLICY_PATH } from "./submit";

const MANAGED_POOL_LINE = `php_admin_value[sendmail_path] = ${CLI_BIN} smtp-submit -t -i`;
const MANAGED_POOL_MARKER = "; clp-addons smtp relay";
type SmtpVerb = "list" | "save-relay" | "save-default" | "save-site" | "clear-site" |
  "save-domain-relay" | "clear-domain-relay" | "test" | "reconcile" | "deactivate";
const POSTFIX_KEYS = [
  "relayhost", "smtp_sasl_auth_enable", "smtp_sender_dependent_authentication",
  "smtp_sasl_password_maps", "sender_dependent_relayhost_maps", "smtp_tls_security_level",
  "smtp_sasl_security_options", "smtp_sasl_tls_security_options", "local_login_sender_maps",
] as const;

interface SiteRow { domain: string; user: string; phpVersion: string; uid: number }
interface OriginalPostfix { version: 1; values: Record<string, string | null> }
export interface SmtpSiteView {
  domain: string;
  user: string;
  phpVersion: string;
  rule: SmtpSiteRule;
  overridden: boolean;
  senderPreview: string;
}
export interface SmtpState {
  configured: boolean;
  relay: Omit<SmtpRelay, "password"> & { hasPassword: boolean } | null;
  relayOverrides: Record<string, Omit<SmtpRelay, "password"> & { hasPassword: boolean }>;
  defaultRule: SmtpSiteRule;
  sites: SmtpSiteView[];
}

export interface SmtpPaths {
  panelDb: string;
  phpRoot: string;
  stateFile: string;
  originalFile: string;
  lockFile: string;
  submissionFile: string;
  postfixDir: string;
  sendmail: string;
  rootUid: number;
}
export interface SmtpActionOptions {
  paths?: Partial<SmtpPaths>;
  input?: string;
  emitReply?: boolean;
  run?: (command: string, args: string[]) => CommandResult;
  processUid?: number;
  /** Test fixtures may provide sites without a CloudPanel database. */
  sites?: SiteRow[];
}
export const DEFAULT_SMTP_PATHS: SmtpPaths = {
  panelDb: PANEL_DB,
  phpRoot: "/etc/php",
  stateFile: `${STATE_DIR}/smtp/config.json`,
  originalFile: `${STATE_DIR}/smtp/postfix-original.json`,
  lockFile: "/run/lock/clp-addons/smtp.lock",
  submissionFile: SUBMISSION_POLICY_PATH,
  postfixDir: "/etc/postfix",
  sendmail: "/usr/sbin/sendmail",
  rootUid: 0,
};

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);
const commandError = (result: CommandResult): string => result.stderr.trim() || result.stdout.trim() || "command failed";
function runChecked(run: (command: string, args: string[]) => CommandResult, command: string, args: string[]): string {
  const result = run(command, args);
  if (!result.ok) failAction(`${command}: ${commandError(result)}`);
  return result.stdout.trim();
}

function trustedRead(path: string, uid: number): string | null {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
    failAction(`refusing untrusted SMTP file: ${path}`);
  }
  return readFileSync(path, "utf8");
}

function parseStoredPolicy(raw: string | null): SmtpPolicy {
  if (raw === null) return emptySmtpPolicy();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { failAction("SMTP configuration is malformed"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) failAction("SMTP configuration is malformed");
  const source = value as Record<string, unknown>;
  if (source.version !== 1 || !source.defaultRule || !source.siteRules || !source.relayOverrides) {
    failAction("SMTP configuration is malformed");
  }
  const siteRules: Record<string, SmtpSiteRule> = {};
  const relayOverrides: Record<string, SmtpRelay> = {};
  for (const [domain, rule] of Object.entries(source.siteRules as Record<string, unknown>)) {
    siteRules[smtpDomain(domain)] = parseRule(rule);
  }
  for (const [domain, relay] of Object.entries(source.relayOverrides as Record<string, unknown>)) {
    relayOverrides[smtpDomain(domain)] = parseRelay(relay);
  }
  return {
    version: 1,
    relay: source.relay == null ? null : parseRelay(source.relay),
    relayOverrides,
    defaultRule: parseRule(source.defaultRule),
    siteRules,
  };
}

function readPolicy(paths: SmtpPaths): SmtpPolicy {
  return parseStoredPolicy(trustedRead(paths.stateFile, paths.rootUid));
}

function writePolicy(paths: SmtpPaths, policy: SmtpPolicy): void {
  trustedRead(paths.stateFile, paths.rootUid);
  writeFileAtomic(paths.stateFile, JSON.stringify(policy, null, 2) + "\n", { mode: 0o600, createParent: true });
}

function panelSites(paths: SmtpPaths, fixture?: SiteRow[]): SiteRow[] {
  if (fixture) return fixture;
  const db = new Database(paths.panelDb, { readonly: true });
  try {
    const passwd = readFileSync("/etc/passwd", "utf8").split("\n");
    const rows = db.query<{ domain_name: string; user: string; php_version: string }, []>(
      `SELECT site.domain_name, site.user, php_settings.php_version
         FROM site JOIN php_settings ON php_settings.site_id = site.id
        ORDER BY site.domain_name`,
    ).all();
    return rows.map((row) => {
      const domain = smtpDomain(row.domain_name);
      const user = String(row.user);
      if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) failAction(`invalid site user for ${domain}`);
      const entry = passwd.find((line) => line.startsWith(`${user}:`));
      if (!entry) failAction(`site user ${user} is missing`);
      const uid = Number(entry.split(":")[2]);
      if (!Number.isInteger(uid) || uid < 1) failAction(`invalid site UID for ${domain}`);
      return { domain, user, phpVersion: String(row.php_version), uid };
    });
  } finally { db.close(); }
}

function validatedSites(sites: SiteRow[]): SiteRow[] {
  const uids = new Set<number>();
  for (const site of sites) {
    smtpDomain(site.domain);
    if (!/^[0-9]+\.[0-9]+$/.test(site.phpVersion)) failAction(`invalid PHP version for ${site.domain}`);
    if (uids.has(site.uid)) failAction(`multiple sites share Unix UID ${site.uid}; SMTP cannot identify their sender safely`);
    uids.add(site.uid);
  }
  return sites;
}

function effectiveRule(policy: SmtpPolicy, domain: string): SmtpSiteRule {
  return policy.siteRules[domain] ?? policy.defaultRule;
}

function stateOf(policy: SmtpPolicy, sites: SiteRow[]): SmtpState {
  const publicRelay = (relay: SmtpRelay) => ({ host: relay.host, port: relay.port, username: relay.username, hasPassword: true });
  return {
    configured: policy.relay !== null,
    relay: policy.relay ? publicRelay(policy.relay) : null,
    relayOverrides: Object.fromEntries(Object.entries(policy.relayOverrides).map(([domain, relay]) => [domain, publicRelay(relay)])),
    defaultRule: policy.defaultRule,
    sites: sites.map((site) => {
      const rule = effectiveRule(policy, site.domain);
      return {
        domain: site.domain, user: site.user, phpVersion: site.phpVersion, rule,
        overridden: Boolean(policy.siteRules[site.domain]),
        senderPreview: senderFor(rule.sender, site.domain),
      };
    }),
  };
}

function relayFromRequest(value: unknown, old: SmtpRelay | null): SmtpRelay {
  if (!value || typeof value !== "object" || Array.isArray(value)) failAction("relay must be an object");
  const raw = value as Record<string, unknown>;
  return parseRelay({ ...raw, password: raw.password === "" ? old?.password : raw.password });
}

function replacePolicy(policy: SmtpPolicy, verb: string, body: Record<string, unknown>, sites: SiteRow[]): SmtpPolicy {
  const next: SmtpPolicy = {
    ...policy, siteRules: { ...policy.siteRules }, relayOverrides: { ...policy.relayOverrides },
  };
  if (verb === "save-relay") {
    next.relay = relayFromRequest(body.relay, policy.relay);
  } else if (verb === "save-default") {
    next.defaultRule = parseRule(body.rule);
  } else if (verb === "save-site" || verb === "clear-site") {
    const domain = smtpDomain(body.domain);
    if (!sites.some((site) => site.domain === domain)) failAction(`CloudPanel has no PHP site ${domain}`);
    if (verb === "clear-site") delete next.siteRules[domain];
    else next.siteRules[domain] = parseRule(body.rule);
  } else if (verb === "save-domain-relay" || verb === "clear-domain-relay") {
    const domain = smtpDomain(body.domain);
    if (verb === "clear-domain-relay") delete next.relayOverrides[domain];
    else next.relayOverrides[domain] = relayFromRequest(body.relay, policy.relayOverrides[domain] ?? null);
  }
  return next;
}

function relayDestination(relay: SmtpRelay): string {
  return `[${relay.host}]:${relay.port}`;
}
function regexDomain(domain: string): string {
  return domain.replaceAll(".", "\\.");
}
function regexpResult(value: string): string {
  // Postfix regexp tables interpret $n in lookup results as a capture reference.
  // A literal dollar sign in a provider username or password must be doubled.
  return value.split("$").join("$$");
}
export function postfixMaps(policy: SmtpPolicy): { credentials: string; routes: string } {
  if (!policy.relay) throw new Error("global relay is not configured");
  const credentials: string[] = [];
  const routes: string[] = [];
  for (const [domain, relay] of Object.entries(policy.relayOverrides).sort(([a], [b]) => a.localeCompare(b))) {
    const pattern = `/@${regexDomain(domain)}$/`;
    credentials.push(`${pattern} ${regexpResult(relay.username)}:${regexpResult(relay.password)}`);
    routes.push(`${pattern} ${relayDestination(relay)}`);
  }
  credentials.push(`/.*/ ${regexpResult(policy.relay.username)}:${regexpResult(policy.relay.password)}`);
  return { credentials: credentials.join("\n") + "\n", routes: routes.join("\n") + "\n" };
}

function localSenderMap(policy: SmtpPolicy, sites: SiteRow[]): string {
  const entries = ["root *", "postfix *"];
  for (const site of sites) {
    const rule = effectiveRule(policy, site.domain);
    const patterns = rule.mode === "force"
      ? [senderFor(rule.sender, site.domain)]
      : [senderFor(rule.sender, site.domain), `@${site.domain}`, ...rule.domains.map((d) => `@${d}`), ...rule.addresses];
    entries.push(`${site.user} ${[...new Set(patterns)].join(" ")}`);
  }
  return entries.join("\n") + "\n";
}

function managedPaths(paths: SmtpPaths): { credentials: string; routes: string; senders: string } {
  return {
    credentials: join(paths.postfixDir, "clp-addons-sasl"),
    routes: join(paths.postfixDir, "clp-addons-relays"),
    senders: join(paths.postfixDir, "clp-addons-local-senders"),
  };
}

function capturePostfix(paths: SmtpPaths, run: (command: string, args: string[]) => CommandResult): void {
  if (trustedRead(paths.originalFile, paths.rootUid) !== null) return;
  const values = currentPostfixSettings(run);
  writeFileAtomic(paths.originalFile, JSON.stringify({ version: 1, values }, null, 2) + "\n", { mode: 0o600, createParent: true });
}

function currentPostfixSettings(run: (command: string, args: string[]) => CommandResult): Record<string, string | null> {
  const explicit = runChecked(run, "postconf", ["-n"]);
  const values: Record<string, string | null> = {};
  for (const key of POSTFIX_KEYS) {
    const match = explicit.match(new RegExp(`(?:^|\\n)${key}\\s*=\\s*([^\\n]*)`));
    values[key] = match ? match[1]!.trim() : null;
  }
  return values;
}

function applyPostfixSettings(values: Record<string, string | null>, run: (command: string, args: string[]) => CommandResult): void {
  for (const key of POSTFIX_KEYS) {
    const value = values[key];
    if (value === null || value === undefined) runChecked(run, "postconf", ["-X", key]);
    else runChecked(run, "postconf", ["-e", `${key}=${value}`]);
  }
}

function restorePostfix(paths: SmtpPaths, run: (command: string, args: string[]) => CommandResult): void {
  const raw = trustedRead(paths.originalFile, paths.rootUid);
  if (!raw) return;
  const backup = JSON.parse(raw) as OriginalPostfix;
  if (backup.version !== 1 || !backup.values) failAction("Postfix backup is malformed");
  applyPostfixSettings(backup.values, run);
  runChecked(run, "postfix", ["check"]);
  runChecked(run, "systemctl", ["reload", "postfix"]);
  rmSync(paths.originalFile);
}

function updatePostfix(paths: SmtpPaths, policy: SmtpPolicy, sites: SiteRow[], run: (command: string, args: string[]) => CommandResult): void {
  if (!policy.relay) return;
  const managed = managedPaths(paths);
  const maps = postfixMaps(policy);
  const mapContents: Record<string, string> = {
    [managed.credentials]: maps.credentials,
    [managed.routes]: maps.routes,
    [managed.senders]: localSenderMap(policy, sites),
  };
  const before = Object.fromEntries(Object.keys(mapContents).map((path) => [path, trustedRead(path, paths.rootUid)]));
  const oldDbPath = `${managed.senders}.db`;
  const oldDbStat = existsSync(oldDbPath) ? lstatSync(oldDbPath) : null;
  if (oldDbStat && (!oldDbStat.isFile() || oldDbStat.isSymbolicLink() || oldDbStat.uid !== paths.rootUid || (oldDbStat.mode & 0o022) !== 0)) {
    failAction(`refusing untrusted SMTP file: ${oldDbPath}`);
  }
  const oldDb = oldDbStat ? readFileSync(oldDbPath) : null;
  const settings: Record<string, string> = {
    relayhost: relayDestination(policy.relay),
    smtp_sasl_auth_enable: "yes",
    smtp_sender_dependent_authentication: "yes",
    smtp_sasl_password_maps: `regexp:${managed.credentials}`,
    sender_dependent_relayhost_maps: `regexp:${managed.routes}`,
    smtp_tls_security_level: "secure",
    smtp_sasl_security_options: "noanonymous",
    smtp_sasl_tls_security_options: "noanonymous",
    local_login_sender_maps: `hash:${managed.senders}`,
  };
  const current = currentPostfixSettings(run);
  const mapsChanged = Object.entries(mapContents).some(([path, content]) => before[path] !== content);
  const configChanged = Object.entries(settings).some(([key, value]) => current[key] !== value);
  const dbStale = oldDb === null || (existsSync(managed.senders) && statSync(managed.senders).mtimeMs > oldDbStat!.mtimeMs);
  if (!mapsChanged && !configChanged && !dbStale) return;
  // Older Postfix cannot enforce local Unix login sender maps. Refuse the
  // configuration instead of silently offering a sender policy it cannot keep.
  if (!/^local_login_sender_maps\s*=/.test(runChecked(run, "postconf", ["-d", "local_login_sender_maps"]))) {
    failAction("Postfix 3.6 or newer is required for local sender restrictions");
  }
  capturePostfix(paths, run);
  try {
    for (const [path, content] of Object.entries(mapContents)) {
      if (before[path] !== content) writeFileAtomic(path, content, { mode: path === managed.senders ? 0o644 : 0o600, createParent: true });
    }
    if (before[managed.senders] !== mapContents[managed.senders] || dbStale) {
      runChecked(run, "postmap", [`hash:${managed.senders}`]);
      chmodSync(`${managed.senders}.db`, 0o644);
    }
    for (const [key, value] of Object.entries(settings)) {
      if (current[key] !== value) runChecked(run, "postconf", ["-e", `${key}=${value}`]);
    }
    runChecked(run, "postfix", ["check"]);
    runChecked(run, "systemctl", ["reload", "postfix"]);
  } catch (error) {
    for (const [path, content] of Object.entries(before)) {
      if (content === null) rmSync(path, { force: true });
      else writeFileAtomic(path, content, { mode: path === managed.senders ? 0o644 : 0o600 });
    }
    if (oldDb === null) rmSync(oldDbPath, { force: true });
    else writeFileAtomic(oldDbPath, oldDb, { mode: oldDbStat!.mode & 0o777 });
    applyPostfixSettings(current, run);
    runChecked(run, "postfix", ["check"]);
    runChecked(run, "systemctl", ["reload", "postfix"]);
    throw error;
  }
}

function poolPath(paths: SmtpPaths, site: SiteRow): string {
  return join(paths.phpRoot, site.phpVersion, "fpm/pool.d", `${site.domain}.conf`);
}
function updatePools(paths: SmtpPaths, sites: SiteRow[], enabled: boolean, run: (command: string, args: string[]) => CommandResult): number {
  const changedVersions = new Set<string>();
  const changes: { path: string; before: string; after: string; mode: number; uid: number; gid: number }[] = [];
  for (const site of sites) {
    const path = poolPath(paths, site);
    if (!existsSync(path)) {
      if (!enabled) continue;
      failAction(`PHP-FPM pool is missing for ${site.domain}`);
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== paths.rootUid || (stat.mode & 0o022) !== 0) {
      failAction(`untrusted PHP-FPM pool for ${site.domain}`);
    }
    const original = readFileSync(path, "utf8");
    const lines = original.split("\n").filter((line) => line !== MANAGED_POOL_LINE && line !== MANAGED_POOL_MARKER);
    if (enabled && lines.some((line) => /^\s*php_(?:admin_)?value\[sendmail_path\]/i.test(line))) {
      failAction(`${site.domain} already configures sendmail_path; resolve that conflict first`);
    }
    const next = lines.join("\n").replace(/\n*$/, "\n") + (enabled ? `${MANAGED_POOL_MARKER}\n${MANAGED_POOL_LINE}\n` : "");
    if (next === original) continue;
    changes.push({ path, before: original, after: next, mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid });
    changedVersions.add(site.phpVersion);
  }
  try {
    for (const change of changes) writeFileAtomic(change.path, change.after, { mode: change.mode, owner: { uid: change.uid, gid: change.gid } });
    for (const version of changedVersions) {
      runChecked(run, `/usr/sbin/php-fpm${version}`, ["-t"]);
      runChecked(run, "systemctl", ["reload", `php${version}-fpm`]);
    }
  } catch (error) {
    for (const change of changes) writeFileAtomic(change.path, change.before, { mode: change.mode, owner: { uid: change.uid, gid: change.gid } });
    for (const version of changedVersions) run("systemctl", ["reload", `php${version}-fpm`]);
    throw error;
  }
  return changes.length;
}

function writeSubmissionPolicy(paths: SmtpPaths, policy: SmtpPolicy, sites: SiteRow[]): void {
  const submission: SmtpSubmissionPolicy = {
    version: 1,
    sites: sites.map((site) => ({ domain: site.domain, uid: site.uid, user: site.user, rule: effectiveRule(policy, site.domain) })),
  };
  trustedRead(paths.submissionFile, paths.rootUid);
  writeFileAtomic(paths.submissionFile, JSON.stringify(submission, null, 2) + "\n", { mode: 0o644, createParent: true });
}

function applyConfiguration(paths: SmtpPaths, policy: SmtpPolicy, sites: SiteRow[], run: (command: string, args: string[]) => CommandResult): number {
  if (!policy.relay) return 0;
  updatePostfix(paths, policy, sites, run);
  writeSubmissionPolicy(paths, policy, sites);
  return updatePools(paths, sites, true, run);
}

async function inputBody(options: SmtpActionOptions): Promise<Record<string, unknown>> {
  const raw = options.input ?? await Bun.stdin.text();
  if (Buffer.byteLength(raw) > 128 * 1024) failAction("SMTP request is too large");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { failAction("SMTP request must be JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) failAction("SMTP request must be an object");
  return value as Record<string, unknown>;
}

function sendTest(paths: SmtpPaths, policy: SmtpPolicy, sites: SiteRow[], body: Record<string, unknown>): { queued: true; sender: string; recipient: string } {
  if (!policy.relay) failAction("configure the global SMTP relay first");
  const domain = smtpDomain(body.domain);
  const site = sites.find((item) => item.domain === domain);
  if (!site) failAction(`CloudPanel has no PHP site ${domain}`);
  const recipient = smtpAddress(body.recipient);
  const sender = senderFor(effectiveRule(policy, domain).sender, domain);
  const message = `To: ${recipient}\nFrom: ${sender}\nSubject: CloudPanel SMTP relay test for ${domain}\n\nThis message was submitted through the CloudPanel Addons Postfix relay.\n`;
  const result = Bun.spawnSync([paths.sendmail, "-t", "-i", "-f", sender], {
    stdin: Buffer.from(message), stdout: "pipe", stderr: "pipe", maxBuffer: 64 * 1024,
  });
  if (!result.success) failAction(`Postfix did not queue the test: ${Buffer.from(result.stderr).toString("utf8").trim() || "sendmail failed"}`);
  return { queued: true, sender, recipient };
}

export async function executeSmtpAction(argv: string[], options: SmtpActionOptions = {}): Promise<unknown> {
  if ((options.processUid ?? process.getuid?.()) !== 0) failAction("SMTP actions must run as root");
  const paths = { ...DEFAULT_SMTP_PATHS, ...options.paths };
  const run = options.run ?? runCommand;
  const verb = argv[0] as SmtpVerb | undefined;
  if (argv.length !== 1 || !["list", "save-relay", "save-default", "save-site", "clear-site", "save-domain-relay", "clear-domain-relay", "test", "reconcile", "deactivate"].includes(verb ?? "")) {
    failAction("usage: clp-addons action smtp {list|save-relay|save-default|save-site|clear-site|save-domain-relay|clear-domain-relay|test|reconcile|deactivate}");
  }
  return withFileLock(paths.lockFile, 30, "SMTP configuration is busy", async () => {
    const policy = readPolicy(paths);
    const sites = validatedSites(panelSites(paths, options.sites));
    if (verb === "list") return stateOf(policy, sites);
    if (verb === "deactivate") {
      updatePools(paths, sites, false, run);
      rmSync(paths.submissionFile, { force: true });
      restorePostfix(paths, run);
      const managed = managedPaths(paths);
      for (const path of [managed.credentials, managed.routes, managed.senders, `${managed.senders}.db`]) {
        trustedRead(path, paths.rootUid);
        rmSync(path, { force: true });
      }
      return { deactivated: true };
    }
    if (verb === "reconcile") {
      const repaired = applyConfiguration(paths, policy, sites, run);
      return { repaired };
    }
    const body = await inputBody(options);
    if (verb === "test") return sendTest(paths, policy, sites, body);
    const next = replacePolicy(policy, verb!, body, sites);
    try {
      if (next.relay) applyConfiguration(paths, next, sites, run);
      writePolicy(paths, next);
    } catch (error) {
      // The saved policy still describes the old state. Restore its maps and
      // submission rules if a later pool validation or file write failed.
      try {
        if (policy.relay) {
          // updatePools rolls back its own files on failure. A pre-existing
          // sendmail_path conflict would still exist, so restoring the old
          // Postfix/submission state must not rerun pool validation.
          updatePostfix(paths, policy, sites, run);
          writeSubmissionPolicy(paths, policy, sites);
        }
        else {
          updatePools(paths, sites, false, run);
          rmSync(paths.submissionFile, { force: true });
          restorePostfix(paths, run);
        }
      } catch (rollbackError) {
        failAction(`SMTP update failed (${reason(error)}); rollback also failed: ${reason(rollbackError)}`);
      }
      throw error;
    }
    return stateOf(next, sites);
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
