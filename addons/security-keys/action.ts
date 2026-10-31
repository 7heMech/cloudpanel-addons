import { SECURITY_KEYS_VERBS } from "./verbs";
import { createHmac, randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, constants as fs, existsSync, fchmodSync, fchownSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync,
  readdirSync, readFileSync, readSync, rmSync, writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  ActionFailure, emitActionError, emitActionOk, failAction, oneLine, withFileLockSync,
} from "../../cli/action-common";
import { openPanelDatabase, writeAtomicOwned } from "../../cli/nginx-transaction";
import { LOCK_DIR, PANEL_DB, PANEL_VAR_DIR, STATE_DIR } from "../../cli/paths";
import { PANEL_USER_NAME_RE } from "../../lib/panel-users";
import {
  ALGORITHMS, fromB64url, normalizeOrigin, verifyAssertion, verifyRegistration, type StoredPublicKey,
  WebAuthnError,
} from "./webauthn";

/**
 * `keys`, `register-options`, `register` and `remove` act on the caller's own
 * account: the gateway checks the CloudPanel session itself and passes
 * `--panel-user`. `login-options` and `sign-in` have no session yet; the key's
 * signature is their credential. `users`, `revoke` and `settings` are the
 * administrator's.
 */
export type SecurityKeysVerb = keyof typeof SECURITY_KEYS_VERBS;

const VERBS = Object.keys(SECURITY_KEYS_VERBS) as SecurityKeysVerb[];
const OWN_ACCOUNT_VERBS = new Set(VERBS.filter((verb) => SECURITY_KEYS_VERBS[verb].web === "own-account"));

const STORE_VERSION = 1;
const CHALLENGE_TTL_MS = 5 * 60_000;
/** How long CloudPanel will honour the sign-in token once it is written. */
const TOKEN_TTL_SECONDS = 60;
const TOKEN_FILE_RE = /^\.token_[0-9a-f]{64}$/;
/** `<expiry in ms>.<random>`: the challenge itself is root's HMAC of this. */
const CHALLENGE_ID_RE = /^(\d{13})\.[0-9a-f]{32}$/;
const MAX_TOKEN_FILE_BYTES = 4096;
const MAX_INPUT_BYTES = 64 * 1024;

export interface SecurityKeysPaths {
  stateDir: string;
  lockFile: string;
  panelDb: string;
  panelVarDir: string;
  /** Who owns the credential store: root, except under test. */
  stateUid: number;
}

export const DEFAULT_SECURITY_KEYS_PATHS: SecurityKeysPaths = {
  stateDir: `${STATE_DIR}/security-keys`,
  lockFile: `${LOCK_DIR}/security-keys.lock`,
  panelDb: PANEL_DB,
  panelVarDir: PANEL_VAR_DIR,
  stateUid: 0,
};

export interface SecurityKeysActionOptions {
  paths?: Partial<SecurityKeysPaths>;
  input?: string;
  emitReply?: boolean;
  now?: () => number;
}

interface StoredKey {
  id: string;
  name: string;
  publicKey: StoredPublicKey;
  origin: string;
  signCount: number;
  synced: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

interface StoredUser {
  /** CloudPanel's `user.id`, so a deleted and recreated name does not inherit the keys. */
  userId: number;
  /** The WebAuthn user handle the keys were created under. */
  handle: string;
  keys: StoredKey[];
}

interface Store {
  version: 1;
  users: Record<string, StoredUser>;
}

export const PANEL_ROLES = ["ROLE_ADMIN", "ROLE_SITE_MANAGER", "ROLE_USER"] as const;
export type PanelRole = (typeof PANEL_ROLES)[number];

/** What an administrator decides for the whole panel. */
export interface Settings {
  /** The CloudPanel roles that may add keys and sign in with them. */
  roles: PanelRole[];
  /** Whether keys a password manager or platform syncs between devices are accepted. */
  syncedPasskeys: boolean;
}

const DEFAULT_SETTINGS: Settings = { roles: [...PANEL_ROLES], syncedPasskeys: true };

export interface KeyView {
  id: string;
  name: string;
  origin: string;
  synced: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface UserKeysView {
  user: string;
  /** Whether the CloudPanel account the keys were made for still signs in. */
  active: boolean;
  /** That account's CloudPanel role, or null once it is not the same account. */
  role: string | null;
  keys: KeyView[];
}

interface Parsed {
  verb: SecurityKeysVerb;
  panelUser: string | null;
}

function parseArgs(argv: string[]): Parsed {
  const [verb, ...rest] = argv;
  if (!VERBS.includes(verb as SecurityKeysVerb)) failAction(`unknown security-keys verb '${verb ?? ""}'`);
  let panelUser: string | null = null;
  for (const argument of rest) {
    if (argument.startsWith("--panel-user=") && panelUser === null) panelUser = argument.slice("--panel-user=".length);
    else failAction(`unexpected argument '${argument}'`);
  }
  const ownAccount = OWN_ACCOUNT_VERBS.has(verb as SecurityKeysVerb);
  if (ownAccount && (panelUser === null || !PANEL_USER_NAME_RE.test(panelUser))) failAction("missing or invalid --panel-user");
  if (!ownAccount && panelUser !== null) failAction(`'${verb}' takes no --panel-user`);
  return { verb: verb as SecurityKeysVerb, panelUser };
}

function readInput(options: SecurityKeysActionOptions): Record<string, unknown> {
  const raw = options.input ?? readFileSync(0, "utf8");
  if (raw.length > MAX_INPUT_BYTES) failAction("input is too large");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { failAction("input must be JSON"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) failAction("input must be a JSON object");
  return value as Record<string, unknown>;
}

function storePath(paths: SecurityKeysPaths): string {
  return join(paths.stateDir, "credentials.json");
}

function trustedFile(path: string, uid: number): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    failAction(`${path} is not a trusted root-only file`);
  }
}

function validKey(value: unknown): value is StoredKey {
  const key = value as StoredKey;
  return typeof key === "object" && key !== null && typeof key.id === "string" && typeof key.name === "string"
    && typeof key.origin === "string" && Number.isInteger(key.signCount) && typeof key.synced === "boolean"
    && typeof key.createdAt === "string" && (key.lastUsedAt === null || typeof key.lastUsedAt === "string")
    && typeof key.publicKey === "object" && key.publicKey !== null
    && (ALGORITHMS as readonly number[]).includes(key.publicKey.alg) && typeof key.publicKey.jwk === "object";
}

function readStore(paths: SecurityKeysPaths): Store {
  const path = storePath(paths);
  if (!existsSync(path)) return { version: STORE_VERSION, users: {} };
  trustedFile(path, paths.stateUid);
  let raw: Store;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { failAction(`${path} is not valid JSON`); }
  if (raw?.version !== STORE_VERSION || typeof raw.users !== "object" || raw.users === null) failAction(`${path} is malformed`);
  const users: Record<string, StoredUser> = Object.create(null);
  for (const [name, user] of Object.entries(raw.users)) {
    if (!PANEL_USER_NAME_RE.test(name) || !Number.isInteger(user?.userId) || typeof user.handle !== "string"
      || !Array.isArray(user.keys) || !user.keys.every(validKey)) failAction(`${path} is malformed`);
    users[name] = user;
  }
  return { version: STORE_VERSION, users };
}

function writeStore(paths: SecurityKeysPaths, store: Store): void {
  const users = Object.fromEntries(Object.entries(store.users).filter(([, user]) => user.keys.length > 0).sort());
  writeAtomicOwned(storePath(paths), `${JSON.stringify({ version: STORE_VERSION, users }, null, 2)}\n`, 0o600, paths.stateUid, process.getgid?.() ?? 0);
}

function settingsPath(paths: SecurityKeysPaths): string {
  return join(paths.stateDir, "settings.json");
}

function parseSettings(value: unknown): Settings | null {
  const raw = value as Partial<Settings> | null;
  if (typeof raw !== "object" || raw === null || typeof raw.syncedPasskeys !== "boolean" || !Array.isArray(raw.roles)
    || !raw.roles.every((role) => (PANEL_ROLES as readonly unknown[]).includes(role))) return null;
  return { roles: PANEL_ROLES.filter((role) => raw.roles!.includes(role)), syncedPasskeys: raw.syncedPasskeys };
}

function readSettings(paths: SecurityKeysPaths): Settings {
  const path = settingsPath(paths);
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS, roles: [...DEFAULT_SETTINGS.roles] };
  trustedFile(path, paths.stateUid);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { failAction(`${path} is not valid JSON`); }
  return parseSettings(raw) ?? failAction(`${path} is malformed`);
}

function writeSettings(paths: SecurityKeysPaths, settings: Settings): void {
  writeAtomicOwned(settingsPath(paths), `${JSON.stringify(settings, null, 2)}\n`, 0o600, paths.stateUid, process.getgid?.() ?? 0);
}

function allowedRole(settings: Settings, account: PanelAccount): boolean {
  return (settings.roles as string[]).includes(account.role ?? "");
}

function withStoreLock<T>(paths: SecurityKeysPaths, body: () => T): T {
  mkdirSync(dirname(paths.lockFile), { recursive: true });
  chmodSync(dirname(paths.lockFile), 0o700);
  return withFileLockSync(paths.lockFile, 30, "another security key change is running", body);
}

interface PanelAccount {
  id: number;
  active: boolean;
  role: string | null;
}

function panelAccounts(paths: SecurityKeysPaths): Map<string, PanelAccount> {
  const db = openPanelDatabase(paths.panelDb, true);
  try {
    const rows = db.query<{ id: number; user_name: string; status: number | boolean | null; role: string | null }, []>(
      "SELECT id, user_name, status, role FROM user",
    ).all();
    return new Map(rows.map((row) => [row.user_name, { id: Number(row.id), active: Number(row.status) === 1, role: row.role }]));
  } finally {
    db.close();
  }
}

function activeAccount(paths: SecurityKeysPaths, user: string): PanelAccount {
  const account = panelAccounts(paths).get(user);
  if (!account?.active) failAction("that CloudPanel account is not active");
  return account;
}

/**
 * What the login page may show the person in front of it. Anything else a
 * sign-in fails with -- a path, a database error -- is the journal's, and the
 * page is told only that sign-in is unavailable.
 */
class SignInRefusal extends ActionFailure {}

function refuse(message: string): never {
  throw new SignInRefusal(message);
}

const SIGN_IN_UNAVAILABLE = "Security key sign-in is unavailable right now; sign in with your password";

/**
 * Root's own key for challenges and user handles, made on first use. A
 * challenge is an HMAC of its id, so issuing one writes nothing: the sign-in
 * route answers anyone who can reach the panel, and what it costs must not
 * grow with how often it is asked.
 */
function secret(paths: SecurityKeysPaths): Buffer {
  const path = join(paths.stateDir, "secret");
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  // Written in full beside it and linked into place, so no reader ever finds
  // it empty and a crash cannot leave it so; a link refuses an existing name.
  if (!existsSync(path)) {
    const temp = `${path}.${randomBytes(8).toString("hex")}`;
    const fd = openSync(temp, fs.O_WRONLY | fs.O_CREAT | fs.O_EXCL | fs.O_NOFOLLOW, 0o600);
    try {
      try { writeSync(fd, randomBytes(32)); } finally { closeSync(fd); }
      linkSync(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      rmSync(temp, { force: true });
    }
  }
  trustedFile(path, paths.stateUid);
  const key = readFileSync(path);
  if (key.length !== 32) failAction(`${path} is malformed`);
  return key;
}

function mac(paths: SecurityKeysPaths, ...parts: (string | number)[]): Buffer {
  return createHmac("sha256", secret(paths)).update(parts.join("\0")).digest();
}

/** The handle a new account's keys are made under: stable for that `user.id`, and nothing else. */
function handleFor(paths: SecurityKeysPaths, userId: number): string {
  return mac(paths, "handle", userId).subarray(0, 16).toString("base64url");
}

function issueChallenge(paths: SecurityKeysPaths, now: number, ...binding: (string | number)[]): { challengeId: string; challenge: string } {
  const challengeId = `${now + CHALLENGE_TTL_MS}.${randomBytes(16).toString("hex")}`;
  return { challengeId, challenge: mac(paths, ...binding, challengeId).toString("base64url") };
}

/** The challenge a key must have signed for this id and purpose, if the id is still current. */
function expectedChallenge(paths: SecurityKeysPaths, id: unknown, now: number, ...binding: (string | number)[]): string {
  const match = typeof id === "string" ? CHALLENGE_ID_RE.exec(id) : null;
  if (!match || !(Number(match[1]) > now)) refuse("the sign-in request has expired; try again");
  return mac(paths, ...binding, id as string).toString("base64url");
}

/**
 * Spend a challenge, under the store lock: refuse one already spent, then
 * record it only once `answered` has accepted the key's reply, so the list
 * grows with real sign-ins rather than with requests.
 */
function spendChallenge<T>(paths: SecurityKeysPaths, id: string, now: number, answered: () => T): T {
  const path = join(paths.stateDir, "spent.json");
  let spent: Record<string, number> = {};
  if (existsSync(path)) {
    trustedFile(path, paths.stateUid);
    try { spent = JSON.parse(readFileSync(path, "utf8")); } catch { spent = {}; }
  }
  const live = Object.fromEntries(Object.entries(spent).filter(([, expiresAt]) => typeof expiresAt === "number" && expiresAt > now));
  if (id in live) refuse("the sign-in request has expired; try again");
  const result = answered();
  live[id] = Number(id.split(".")[0]);
  writeAtomicOwned(path, JSON.stringify(live), 0o600, paths.stateUid, process.getgid?.() ?? 0);
  return result;
}

function keyView(key: StoredKey): KeyView {
  return {
    id: key.id, name: key.name, origin: key.origin, synced: key.synced, createdAt: key.createdAt, lastUsedAt: key.lastUsedAt,
  };
}

function ownKeys(store: Store, user: string, account: PanelAccount): KeyView[] {
  const entry = store.users[user];
  return entry && entry.userId === account.id ? entry.keys.map(keyView) : [];
}

/**
 * Write CloudPanel's own one-time sign-in token, the one its `/autologin`
 * route reads, deletes and exchanges for a session. The panel's `var` belongs
 * to its user, so the file is created exclusively and without following a
 * link, and handed to that user so the panel can delete it.
 */
function mintPanelToken(paths: SecurityKeysPaths, user: string, now: number): string {
  const dir = lstatSync(paths.panelVarDir);
  if (!dir.isDirectory() || dir.isSymbolicLink()) failAction("CloudPanel's var directory is not a directory");
  for (const name of readdirSync(paths.panelVarDir)) {
    if (!TOKEN_FILE_RE.test(name)) continue;
    const path = join(paths.panelVarDir, name);
    // The panel's user can put anything at this name, so root reads only a
    // small regular file of theirs, opened without following a link or
    // waiting on a pipe.
    let fd: number | null = null;
    try {
      fd = openSync(path, fs.O_RDONLY | fs.O_NOFOLLOW | fs.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== dir.uid || stat.size > MAX_TOKEN_FILE_BYTES) continue;
      const bytes = Buffer.alloc(stat.size);
      readSync(fd, bytes, 0, stat.size, 0);
      const expiration = Number((JSON.parse(bytes.toString("utf8")) as { expiration?: unknown }).expiration);
      if (expiration * 1000 < now) rmSync(path, { force: true });
    } catch {
      // Not ours to judge.
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
  const token = randomBytes(32).toString("hex");
  const fd = openSync(join(paths.panelVarDir, `.token_${token}`), fs.O_WRONLY | fs.O_CREAT | fs.O_EXCL | fs.O_NOFOLLOW, 0o600);
  try {
    fchownSync(fd, dir.uid, dir.gid);
    fchmodSync(fd, 0o600);
    writeSync(fd, JSON.stringify({ userName: user, expiration: Math.floor(now / 1000) + TOKEN_TTL_SECONDS }));
  } finally {
    closeSync(fd);
  }
  return token;
}

/** One line in the gateway's journal, where CloudPanel's own log has nothing for a key sign-in. */
function audit(line: string): void {
  process.stderr.write(`[security-keys] ${line.replace(/\s+/g, " ")}\n`);
}

function signIn(paths: SecurityKeysPaths, input: Record<string, unknown>, now: number): { token: string; user: string } {
  const challenge = expectedChallenge(paths, input.challengeId, now, "login");
  const credentialId = typeof input.id === "string" && input.id.length <= 1400 ? input.id : refuse("the key sent no credential id");
  const registered = (store: ReturnType<typeof readStore>) =>
    Object.entries(store.users).find(([, user]) => user.keys.some((key) => key.id === credentialId));
  // Looked up before the lock as well as under it, so a request naming no
  // registered key never waits in line with real sign-ins and registrations.
  if (!registered(readStore(paths))) refuse("this key is not registered on this panel");
  return withStoreLock(paths, () => {
    const store = readStore(paths);
    const owner = registered(store);
    if (!owner) refuse("this key is not registered on this panel");
    const [user, entry] = owner;
    // A discoverable key always says whose it is; it must say the same.
    if (input.userHandle !== entry.handle) refuse("this key is not registered on this panel");
    const account = activeAccount(paths, user);
    if (account.id !== entry.userId) refuse("this key belongs to a CloudPanel account that no longer exists");
    const key = entry.keys.find((candidate) => candidate.id === credentialId)!;
    // The signature first, so only the key's holder learns the settings that refuse it.
    const { signCount } = spendChallenge(paths, input.challengeId as string, now, () => verifyAssertion({
      clientDataJSON: fromB64url(input.clientDataJSON, "clientDataJSON"),
      authenticatorData: fromB64url(input.authenticatorData, "authenticatorData"),
      signature: fromB64url(input.signature, "signature"),
      challenge,
      origin: key.origin,
      publicKey: key.publicKey,
      signCount: key.signCount,
    }));
    const settings = readSettings(paths);
    if (!allowedRole(settings, account)) refuse("security keys are turned off for your account; sign in with your password");
    if (key.synced && !settings.syncedPasskeys) {
      refuse("this panel no longer accepts synced passkeys; use a hardware key or your password");
    }
    key.signCount = signCount;
    key.lastUsedAt = new Date(now).toISOString();
    writeStore(paths, store);
    const token = mintPanelToken(paths, user, now);
    audit(`${user} signed in with the key "${key.name}"`);
    return { token, user };
  });
}

function registerOptions(paths: SecurityKeysPaths, user: string, now: number) {
  const account = activeAccount(paths, user);
  const settings = readSettings(paths);
  if (!allowedRole(settings, account)) failAction("security keys are turned off for your account");
  const store = readStore(paths);
  const handle = currentHandle(paths, store, user, account);
  return {
    ...issueChallenge(paths, now, "register", user, account.id, handle),
    user: { id: handle, name: user },
    exclude: ownKeys(store, user, account).map((key) => key.id),
    syncedPasskeys: settings.syncedPasskeys,
  };
}

/** The handle this account's keys are, or would be, made under. */
function currentHandle(paths: SecurityKeysPaths, store: Store, user: string, account: PanelAccount): string {
  const entry = store.users[user];
  return entry && entry.userId === account.id ? entry.handle : handleFor(paths, account.id);
}

function register(paths: SecurityKeysPaths, user: string, input: Record<string, unknown>, now: number): void {
  const name = oneLine(input.name ?? "", "key name", 64, false) || "Security key";
  const origin = normalizeOrigin(input.origin);
  // Bound to the account and handle it was issued for, so a challenge from
  // another account, or from before this name was recreated, does not match.
  const started = activeAccount(paths, user);
  const handle = currentHandle(paths, readStore(paths), user, started);
  const registration = verifyRegistration({
    clientDataJSON: fromB64url(input.clientDataJSON, "clientDataJSON"),
    attestationObject: fromB64url(input.attestationObject, "attestationObject"),
    challenge: expectedChallenge(paths, input.challengeId, now, "register", user, started.id, handle),
  });
  if (registration.origin !== origin) failAction("the key was created for a different panel address");
  return withStoreLock(paths, () => {
    const account = activeAccount(paths, user);
    const settings = readSettings(paths);
    if (!allowedRole(settings, account)) failAction("security keys are turned off for your account");
    if (registration.backupEligible && !settings.syncedPasskeys) {
      failAction("this panel accepts only hardware keys, not passkeys synced by a password manager or your devices");
    }
    const store = readStore(paths);
    if (account.id !== started.id || currentHandle(paths, store, user, account) !== handle) {
      failAction("the registration is out of date; try again");
    }
    if (Object.values(store.users).some((entry) => entry.keys.some((key) => key.id === registration.credentialId))) {
      failAction("this key is already registered");
    }
    spendChallenge(paths, input.challengeId as string, now, () => {});
    let entry = store.users[user];
    if (!entry || entry.userId !== account.id) entry = store.users[user] = { userId: account.id, handle, keys: [] };
    entry.keys.push({
      id: registration.credentialId,
      name,
      publicKey: registration.publicKey,
      origin: registration.origin,
      signCount: registration.signCount,
      synced: registration.backupEligible,
      createdAt: new Date(now).toISOString(),
      lastUsedAt: null,
    });
    writeStore(paths, store);
    audit(`${user} added the key "${name}"`);
  });
}

function removeKey(paths: SecurityKeysPaths, user: string, id: unknown, by = user): boolean {
  if (typeof id !== "string") failAction("choose a key to remove");
  return withStoreLock(paths, () => {
    const store = readStore(paths);
    const entry = store.users[user];
    const removed = entry?.keys.find((key) => key.id === id);
    if (!entry || !removed) failAction("that key is not registered");
    entry.keys = entry.keys.filter((key) => key.id !== id);
    writeStore(paths, store);
    audit(by === user ? `${user} removed the key "${removed.name}"` : `${by} removed ${user}'s key "${removed.name}"`);
    return true;
  });
}

function ownView(paths: SecurityKeysPaths, user: string, account: PanelAccount) {
  const settings = readSettings(paths);
  return { keys: ownKeys(readStore(paths), user, account), canAdd: allowedRole(settings, account), syncedPasskeys: settings.syncedPasskeys };
}

function saveSettings(paths: SecurityKeysPaths, input: Record<string, unknown>): void {
  const settings = parseSettings(input);
  if (!settings) failAction("roles must be CloudPanel roles and syncedPasskeys true or false");
  withStoreLock(paths, () => writeSettings(paths, settings));
}

function allUsers(paths: SecurityKeysPaths): { users: UserKeysView[]; settings: Settings } {
  const store = readStore(paths);
  const accounts = panelAccounts(paths);
  return {
    settings: readSettings(paths),
    users: Object.entries(store.users).map(([user, entry]) => {
      const account = accounts.get(user);
      const same = account?.id === entry.userId;
      return { user, active: Boolean(same && account?.active), role: same ? account?.role ?? null : null, keys: entry.keys.map(keyView) };
    }),
  };
}

export async function runSecurityKeysAction(argv: string[], options: SecurityKeysActionOptions = {}): Promise<number> {
  const emit = options.emitReply !== false;
  try {
    if (process.getuid?.() !== 0 && options.paths === undefined) failAction("security key actions must run as root");
    const paths = { ...DEFAULT_SECURITY_KEYS_PATHS, ...options.paths };
    const now = (options.now ?? Date.now)();
    const { verb, panelUser } = parseArgs(argv);
    let data: unknown;
    if (verb === "login-options") data = issueChallenge(paths, now, "login");
    else if (verb === "sign-in") data = signIn(paths, readInput(options), now);
    else if (verb === "keys") data = ownView(paths, panelUser!, activeAccount(paths, panelUser!));
    else if (verb === "register-options") data = registerOptions(paths, panelUser!, now);
    else if (verb === "register") {
      register(paths, panelUser!, readInput(options), now);
      data = ownView(paths, panelUser!, activeAccount(paths, panelUser!));
    } else if (verb === "remove") {
      const account = activeAccount(paths, panelUser!);
      removeKey(paths, panelUser!, readInput(options).id);
      data = ownView(paths, panelUser!, account);
    } else if (verb === "users") data = allUsers(paths);
    else if (verb === "settings") {
      saveSettings(paths, readInput(options));
      data = allUsers(paths);
    } else if (verb === "revoke") {
      const input = readInput(options);
      if (typeof input.user !== "string" || !PANEL_USER_NAME_RE.test(input.user)) failAction("choose a user");
      removeKey(paths, input.user, input.id, "an administrator");
      data = allUsers(paths);
    } else {
      verb satisfies never;
      failAction(`unknown security-keys verb '${verb}'`);
    }
    if (emit) emitActionOk(data);
    return 0;
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    const data = error instanceof ActionFailure ? error.data : undefined;
    // The two verbs anyone who reaches the login page can call.
    const refused = error instanceof SignInRefusal || error instanceof WebAuthnError;
    if (argv[0] === "login-options" || argv[0] === "sign-in") {
      audit(`sign-in ${refused ? "refused" : "failed"}: ${message}`);
      if (!refused) message = SIGN_IN_UNAVAILABLE;
    }
    if (emit) emitActionError(message, data, "security-keys");
    else process.stderr.write(`[security-keys] ERROR: ${message}\n`);
    return 1;
  }
}
