import { dlopen, FFIType } from "bun:ffi";
import { createHash } from "node:crypto";
import {
  accessSync, closeSync, ftruncateSync, lstatSync, openSync, readFileSync, writeSync, constants as fsConstants,
} from "node:fs";
import { PANEL_IDENTITY_PATH } from "./paths";

const HOSTNAME_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME_RE = new RegExp(`^(?:${HOSTNAME_LABEL})(?:\\.${HOSTNAME_LABEL})+$`);
const WILDCARD_HOSTNAME_RE = new RegExp(`^\\*\\.(?:${HOSTNAME_LABEL})(?:\\.${HOSTNAME_LABEL})+$`);

function matchesEntire(pattern: RegExp, value: string): boolean {
  const match = value.match(pattern);
  return match?.[0] === value;
}

export interface PanelIdentity {
  primary: string;
  aliases: string[];
}

export class ActionFailure extends Error {
  readonly data?: unknown;

  constructor(message: string, data?: unknown) {
    super(message);
    this.name = "ActionFailure";
    this.data = data;
  }
}

export class ActionCommandFailure extends Error {
  constructor(readonly command: string, readonly output = "") {
    super(`command failed: ${command}`);
    this.name = "ActionCommandFailure";
  }
}

export function failAction(message: string, data?: unknown): never {
  throw new ActionFailure(message, data);
}

function stripJsonControls(value: string): string {
  // Strips ESC and other non-printing control characters while retaining
  // newline/tab/CR for JSON.stringify to escape; this is the canonical
  // encoding every action reply's JSON string values follow (originally
  // duplicated per wrapper script's json_str, now implemented once here).
  return value
    .replaceAll("\u001b", "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === "string") return stripJsonControls(value);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = jsonSafe(item);
    return result;
  }
  return value;
}

export function emitActionOk(data: unknown): void {
  process.stdout.write(`${JSON.stringify(jsonSafe({ ok: true, data }))}\n`);
}

export function actionErrorJson(message: string, data?: unknown): string {
  const reply: Record<string, unknown> = { ok: false, error: stripJsonControls(message) };
  if (data !== undefined) reply.data = jsonSafe(data);
  return JSON.stringify(reply);
}

export function emitActionError(message: string, data?: unknown, addon = "instatic"): void {
  process.stderr.write(`[${addon}] ERROR: ${message}\n`);
  process.stdout.write(`${actionErrorJson(message, data)}\n`);
}

export function normalizeIdentityHostname(value: string): string | null {
  let host = value.toLowerCase();
  if (host.includes("..")) return null;
  if (host.endsWith(".")) host = host.slice(0, -1);
  return matchesEntire(HOSTNAME_RE, host) || matchesEntire(WILDCARD_HOSTNAME_RE, host) ? host : null;
}

export function parsePanelIdentity(content: string): PanelIdentity | null {
  let primary = "";
  const aliases: string[] = [];
  let seenPrimary = false;
  let seenAliases = false;

  for (const line of content.split("\n")) {
    if (line.replace(/[\s]/g, "") === "" || /^\s*#/.test(line)) continue;
    const separator = line.indexOf("=");
    if (separator === -1) return null;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key === "PRIMARY") {
      if (seenPrimary) return null;
      // An empty PRIMARY is the catch-all panel: CloudPanel ships the vhost as
      // `server_name _;` and only gains a hostname when an operator sets one.
      // There is then no panel domain for a site to collide with, which is a
      // real state to record rather than a parse failure.
      if (value.trim() === "") {
        primary = "";
        seenPrimary = true;
        continue;
      }
      const host = normalizeIdentityHostname(value);
      if (!host || !matchesEntire(HOSTNAME_RE, host)) return null;
      primary = host;
      seenPrimary = true;
    } else if (key === "ALIASES") {
      if (seenAliases) return null;
      const rawAliases = value.trim() ? value.trim().split(/\s+/) : [];
      for (const raw of rawAliases) {
        const host = normalizeIdentityHostname(raw);
        if (!host) return null;
        aliases.push(host);
      }
      seenAliases = true;
    } else {
      return null;
    }
  }

  return seenPrimary && seenAliases ? { primary, aliases } : null;
}

export function readPanelIdentity(path = PANEL_IDENTITY_PATH): PanelIdentity | null {
  let stat;
  try {
    stat = lstatSync(path);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) return null;
  } catch {
    return null;
  }

  try {
    return parsePanelIdentity(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function panelIdentityMatches(candidate: string, identity: PanelIdentity): boolean {
  if (identity.primary !== "" && candidate === identity.primary) return true;
  for (const alias of identity.aliases) {
    if (alias.startsWith("*.")) {
      const suffix = alias.slice(2);
      if (candidate === suffix || candidate.endsWith(`.${suffix}`)) return true;
    } else if (candidate === alias) {
      return true;
    }
  }
  return false;
}

export function panelIdentityGuardForIdentity(domain: string, identity: PanelIdentity): void {
  const normalized = normalizeIdentityHostname(domain);
  if (!normalized) failAction(`invalid domain: '${domain}'`);
  if (panelIdentityMatches(normalized, identity)) {
    failAction(`refusing to act on the CloudPanel panel site or alias: '${domain}'`);
  }
}

export function panelIdentityGuard(domain: string, identityPath = PANEL_IDENTITY_PATH): void {
  const identity = readPanelIdentity(identityPath);
  if (!identity) failAction("the CloudPanel panel identity is missing or malformed");
  panelIdentityGuardForIdentity(domain, identity);
}

export function validateDomain(value: string, identityPath = PANEL_IDENTITY_PATH, what?: string): string {
  const option = what ? `--${what}` : "--domain";
  if (!value) failAction(`missing ${option}`);
  if (value.length > 253) failAction(what ? `the ${option} domain is too long` : "domain too long");
  let normalized = value.toLowerCase();
  const invalid = () => failAction(what ? `invalid domain for ${option}: '${value}'` : `invalid domain: '${value}'`);
  if (normalized.includes("..")) invalid();
  if (normalized.endsWith(".")) normalized = normalized.slice(0, -1);
  if (!matchesEntire(HOSTNAME_RE, normalized)) invalid();
  panelIdentityGuard(normalized, identityPath);
  return normalized;
}

export function validatePort(value: string): number {
  if (!value) failAction("missing --port");
  if (!matchesEntire(/^[0-9]{1,5}$/, value)) failAction(`port must be an integer: '${value}'`);
  const port = Number(value);
  if (port < 39000 || port > 39999) {
    failAction(`port ${value} outside reserved range 39000-39999`);
  }
  return port;
}

export function validateTag(value: string): string {
  if (!value) failAction("missing --tag");
  if (!matchesEntire(/^\d+\.\d+\.\d+$/, value)) {
    failAction(`tag must be an exact version like 0.0.18, got: '${value}'`);
  }
  return value;
}

export function validateFlag(value: string, what: string): string {
  if (value !== "yes" && value !== "no") failAction(`--${what} takes yes or no, got: '${value}'`);
  return value;
}

export function validateJob(value: string): string {
  if (!value) failAction("missing --job");
  if (!matchesEntire(/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$/, value)) {
    failAction(`invalid job id: '${value}'`);
  }
  return value;
}

export function validateEmail(value: string): string {
  if (!value) failAction("missing --email");
  if (value.length > 254) failAction("--email is too long");
  if (!matchesEntire(/^[A-Za-z0-9._%+-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/, value)) {
    failAction(`invalid email address: '${value}'`);
  }
  return value;
}

export function validateMfa(value: string): string {
  if (!matchesEntire(/^[A-Za-z0-9-]{6,32}$/, value)) failAction("the authentication code has an unexpected shape");
  return value;
}

function domainStem(domain: string): string {
  return domain.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
}

function domainHash(domain: string): string {
  return createHash("sha256").update(domain.toLowerCase()).digest("hex").slice(0, 6);
}

export function siteUserFor(domain: string): string {
  return `addon-${domainStem(domain)}-${domainHash(domain)}`;
}

// The panel resolves the registrable domain with the public suffix list, so a
// name ending in one of these before a two-letter country code is part of the
// suffix and never the registrable label: example.co.uk is example, not co.
const SECOND_LEVEL_SUFFIXES = new Set([
  "ac", "ad", "co", "com", "ed", "edu", "go", "gov", "gr", "id", "in", "lg", "ltd",
  "me", "mil", "ne", "net", "nhs", "nom", "or", "org", "plc", "sch", "web",
]);

/**
 * The site user CloudPanel's own New Site page would suggest: the registrable
 * label, then any subdomain labels in the order they appear, hyphen-joined.
 * `the.staging.renaissancechurch.com` becomes `renaissancechurch-the-staging`,
 * which is what the panel wrote for that site on this project's staging box.
 *
 * Matching the panel matters because an operator reads these in the panel's own
 * site list beside sites it named itself, and `addon-stagingr-852487` announced
 * which tool made the site rather than which site it is.
 *
 * The name is not unique on its own -- two domains differing only in their TLD
 * produce the same one, and CloudPanel refuses a duplicate with "siteUser: This
 * value already exists" -- so a caller creating a site picks through
 * `availableSiteUser`.
 */
export function panelSiteUserFor(domain: string): string {
  const labels = domain.toLowerCase().replace(/\.+$/, "").split(".")
    .map((label) => label.replace(/[^a-z0-9]/g, ""))
    .filter((label) => label.length > 0);
  const suffix = labels.length > 2 && labels[labels.length - 1]!.length === 2
    && SECOND_LEVEL_SUFFIXES.has(labels[labels.length - 2]!) ? 2 : 1;
  // Anything with a TLD keeps every label except it; a bare hostname is itself.
  const named = labels.length > suffix ? labels.slice(0, -suffix) : labels;
  const registrable = named[named.length - 1] ?? "";
  // The panel treats a bare www as noise rather than as a subdomain worth naming.
  const subdomains = named.slice(0, -1);
  const parts = subdomains.length === 1 && subdomains[0] === "www" ? [] : subdomains;
  return clampSiteUser([registrable, ...parts].join("-"));
}

/** A Linux account name: starts with a letter, at most 32 characters. */
function clampSiteUser(name: string): string {
  const prefixed = /^[a-z]/.test(name) ? name : `s${name}`;
  return prefixed.slice(0, 32).replace(/-+$/, "");
}

/**
 * The panel-style name, or the first free variation of it. CloudPanel enforces
 * one site per site user, so the caller supplies the question "is this account
 * taken" and this answers with one that is not.
 */
export function availableSiteUser(domain: string, taken: (user: string) => boolean): string {
  const base = panelSiteUserFor(domain);
  if (!taken(base)) return base;
  // The digits a person would add in the panel, with room kept for them.
  for (let n = 2; n <= 99; n++) {
    const suffix = `-${n}`;
    const candidate = clampSiteUser(base.slice(0, 32 - suffix.length)) + suffix;
    if (!taken(candidate)) return candidate;
  }
  failAction(`could not find a free site user for ${domain}; ${base} and 98 variations of it are taken`);
}

export function dbNameFor(domain: string): string {
  return `stg${domainStem(domain)}${domainHash(domain)}`;
}

export function dbUserFor(domain: string): string {
  return `u${domainStem(domain)}${domainHash(domain)}`;
}

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number | null;
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return value == null ? "" : String(value);
}

export function runCommand(command: string, args: string[]): CommandResult {
  try {
    const result = Bun.spawnSync([command, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    return {
      ok: result.success,
      stdout: outputText(result.stdout),
      stderr: outputText(result.stderr),
      exitCode: result.exitCode,
    };
  } catch (error) {
    const e = error as { stdout?: unknown; stderr?: unknown };
    return { ok: false, stdout: outputText(e.stdout), stderr: outputText(e.stderr), exitCode: null };
  }
}

export function forwardCommandOutput(result: CommandResult): void {
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

export function commandFailure(command: string, result: CommandResult): ActionCommandFailure {
  return new ActionCommandFailure(command, result.stderr || result.stdout);
}

const libc = process.platform === "linux"
  ? dlopen("libc.so.6", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    })
  : null;

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface FileLockHandle {
  release(): void;
}

/**
 * The refusal a waiter gets when the lock does not come free.
 *
 * A function is handed whatever the holder wrote into the lock file, so a
 * refusal can name the operation it waited for rather than only say "busy".
 */
export type LockTimeoutMessage = string | ((holder: string | null) => string);

export interface FileLockOptions {
  /** Kept in the lock file while the lock is held, for a waiter to read. */
  note?: string;
}

// O_RDWR|O_CREAT rather than "w": truncating on open would erase the note the
// holder wrote. The file is created with mode 0666 under the service umask,
// the same mode the original wrapper's `exec 200>...` used; the lock directory
// itself, not the file mode, is the access boundary.
function openLockFile(path: string): number {
  return openSync(path, fsConstants.O_RDWR | fsConstants.O_CREAT, 0o666);
}

function lockHolder(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function lockTimeout(message: LockTimeoutMessage, path: string): never {
  failAction(typeof message === "string" ? message : message(lockHolder(path)));
}

function lockHandle(fd: number, state: { locked: boolean }): FileLockHandle {
  return {
    release: () => {
      if (!state.locked) return;
      ftruncateSync(fd, 0);
      libc!.symbols.flock(fd, LOCK_UN);
      state.locked = false;
      closeSync(fd);
    },
  };
}

function takeLock(fd: number, options: FileLockOptions): void {
  ftruncateSync(fd, 0);
  if (options.note) writeSync(fd, options.note, 0);
}

export async function acquireFileLock(
  path: string,
  timeoutSeconds: number,
  onTimeout: LockTimeoutMessage,
  options: FileLockOptions = {},
): Promise<FileLockHandle> {
  if (!libc) failAction("flock is unavailable; refusing to run a privileged action");
  const fd = openLockFile(path);
  const state = { locked: false };
  let handedOff = false;
  try {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (true) {
      if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) === 0) break;
      if (Date.now() >= deadline) lockTimeout(onTimeout, path);
      await sleep(100);
    }
    state.locked = true;
    takeLock(fd, options);
    handedOff = true;
    return lockHandle(fd, state);
  } finally {
    // A timeout or another failure before the handle is returned owns the fd.
    if (!handedOff) {
      if (state.locked) libc.symbols.flock(fd, LOCK_UN);
      closeSync(fd);
    }
  }
}

/**
 * The same lock for callers that cannot await: disable, uninstall and the
 * template reconcile are synchronous from end to end.
 */
export function acquireFileLockSync(
  path: string,
  timeoutSeconds: number,
  onTimeout: LockTimeoutMessage,
  options: FileLockOptions = {},
): FileLockHandle {
  if (!libc) failAction("flock is unavailable; refusing to run a privileged action");
  const fd = openLockFile(path);
  const state = { locked: false };
  let handedOff = false;
  try {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (true) {
      if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) === 0) break;
      if (Date.now() >= deadline) lockTimeout(onTimeout, path);
      Bun.sleepSync(100);
    }
    state.locked = true;
    takeLock(fd, options);
    handedOff = true;
    return lockHandle(fd, state);
  } finally {
    if (!handedOff) {
      if (state.locked) libc.symbols.flock(fd, LOCK_UN);
      closeSync(fd);
    }
  }
}

export async function withFileLock<T>(
  path: string,
  timeoutSeconds: number,
  onTimeout: LockTimeoutMessage,
  body: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const lock = await acquireFileLock(path, timeoutSeconds, onTimeout, options);
  try {
    return await body();
  } finally {
    lock.release();
  }
}

export function withFileLockSync<T>(
  path: string,
  timeoutSeconds: number,
  onTimeout: LockTimeoutMessage,
  body: () => T,
  options: FileLockOptions = {},
): T {
  const lock = acquireFileLockSync(path, timeoutSeconds, onTimeout, options);
  try {
    return body();
  } finally {
    lock.release();
  }
}

export function readable(path: string): boolean {
  try {
    accessSync(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}
