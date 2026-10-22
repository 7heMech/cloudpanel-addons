import { randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, constants as fs, existsSync, fchmodSync, fchownSync, lstatSync, mkdirSync, openSync, readdirSync,
  readFileSync, rmSync, unlinkSync, writeSync,
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
} from "./webauthn";

/**
 * `keys`, `register-options`, `register` and `remove` act on the caller's own
 * account: the gateway checks the CloudPanel session itself and passes
 * `--panel-user`. `login-options` and `sign-in` have no session yet; the key's
 * signature is their credential. `users` and `revoke` are the administrator's.
 */
export type SecurityKeysVerb =
  | "login-options" | "sign-in" | "keys" | "register-options" | "register" | "remove" | "users" | "revoke";

const VERBS: SecurityKeysVerb[] = ["login-options", "sign-in", "keys", "register-options", "register", "remove", "users", "revoke"];
const OWN_ACCOUNT_VERBS = new Set<SecurityKeysVerb>(["keys", "register-options", "register", "remove"]);

const STORE_VERSION = 1;
const CHALLENGE_TTL_MS = 5 * 60_000;
/** How long CloudPanel will honour the sign-in token once it is written. */
const TOKEN_TTL_SECONDS = 60;
const TOKEN_FILE_RE = /^\.token_[0-9a-f]{64}$/;
const CHALLENGE_ID_RE = /^[0-9a-f]{32}$/;
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

interface Challenge {
  challenge: string;
  purpose: "login" | "register";
  expiresAt: number;
  user?: string;
  userId?: number;
  handle?: string;
}

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

function withStoreLock<T>(paths: SecurityKeysPaths, body: () => T): T {
  mkdirSync(dirname(paths.lockFile), { recursive: true });
  chmodSync(dirname(paths.lockFile), 0o700);
  return withFileLockSync(paths.lockFile, 30, "another security key change is running", body);
}

interface PanelAccount {
  id: number;
  active: boolean;
}

function panelAccounts(paths: SecurityKeysPaths): Map<string, PanelAccount> {
  const db = openPanelDatabase(paths.panelDb, true);
  try {
    const rows = db.query<{ id: number; user_name: string; status: number | boolean | null }, []>(
      "SELECT id, user_name, status FROM user",
    ).all();
    return new Map(rows.map((row) => [row.user_name, { id: Number(row.id), active: Number(row.status) === 1 }]));
  } finally {
    db.close();
  }
}

function activeAccount(paths: SecurityKeysPaths, user: string): PanelAccount {
  const account = panelAccounts(paths).get(user);
  if (!account?.active) failAction("that CloudPanel account is not active");
  return account;
}

function challengeDir(paths: SecurityKeysPaths): string {
  return join(paths.stateDir, "challenges");
}

function issueChallenge(paths: SecurityKeysPaths, now: number, record: Omit<Challenge, "challenge" | "expiresAt">): { challengeId: string; challenge: string } {
  const dir = challengeDir(paths);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  // Every expired challenge goes here, so the directory holds only the last
  // few minutes' worth however many were asked for.
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      const old = JSON.parse(readFileSync(path, "utf8")) as Challenge;
      if (!(old.expiresAt > now)) rmSync(path, { force: true });
    } catch {
      rmSync(path, { force: true });
    }
  }
  const challengeId = randomBytes(16).toString("hex");
  const challenge = randomBytes(32).toString("base64url");
  const fd = openSync(join(dir, challengeId), fs.O_WRONLY | fs.O_CREAT | fs.O_EXCL | fs.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, JSON.stringify({ ...record, challenge, expiresAt: now + CHALLENGE_TTL_MS }));
  } finally {
    closeSync(fd);
  }
  return { challengeId, challenge };
}

/** The challenge, removed so it can be answered once; whoever removes it wins. */
function consumeChallenge(paths: SecurityKeysPaths, id: unknown, purpose: Challenge["purpose"], now: number): Challenge {
  if (typeof id !== "string" || !CHALLENGE_ID_RE.test(id)) failAction("the sign-in request has expired; try again");
  const path = join(challengeDir(paths), id);
  let record: Challenge;
  try {
    record = JSON.parse(readFileSync(path, "utf8"));
    unlinkSync(path);
  } catch {
    failAction("the sign-in request has expired; try again");
  }
  if (record.purpose !== purpose || !(record.expiresAt > now)) failAction("the sign-in request has expired; try again");
  return record;
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
    try {
      const stat = lstatSync(path);
      const expiration = Number((JSON.parse(readFileSync(path, "utf8")) as { expiration?: unknown }).expiration);
      if (stat.isFile() && stat.uid === dir.uid && expiration * 1000 < now) rmSync(path, { force: true });
    } catch {
      // Not ours to judge.
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

function signIn(paths: SecurityKeysPaths, input: Record<string, unknown>, now: number): { token: string; user: string } {
  const challenge = consumeChallenge(paths, input.challengeId, "login", now);
  const credentialId = typeof input.id === "string" && input.id.length <= 1400 ? input.id : failAction("the key sent no credential id");
  return withStoreLock(paths, () => {
    const store = readStore(paths);
    const owner = Object.entries(store.users).find(([, user]) => user.keys.some((key) => key.id === credentialId));
    if (!owner) failAction("this key is not registered on this panel");
    const [user, entry] = owner;
    // A discoverable key always says whose it is; it must say the same.
    if (input.userHandle !== entry.handle) failAction("this key is not registered on this panel");
    const account = activeAccount(paths, user);
    if (account.id !== entry.userId) failAction("this key belongs to a CloudPanel account that no longer exists");
    const key = entry.keys.find((candidate) => candidate.id === credentialId)!;
    const { signCount } = verifyAssertion({
      clientDataJSON: fromB64url(input.clientDataJSON, "clientDataJSON"),
      authenticatorData: fromB64url(input.authenticatorData, "authenticatorData"),
      signature: fromB64url(input.signature, "signature"),
      challenge: challenge.challenge,
      origin: key.origin,
      publicKey: key.publicKey,
      signCount: key.signCount,
    });
    key.signCount = signCount;
    key.lastUsedAt = new Date(now).toISOString();
    writeStore(paths, store);
    return { token: mintPanelToken(paths, user, now), user };
  });
}

function registerOptions(paths: SecurityKeysPaths, user: string, now: number) {
  const account = activeAccount(paths, user);
  const store = readStore(paths);
  const entry = store.users[user];
  const current = entry && entry.userId === account.id ? entry : null;
  const handle = current?.handle ?? randomBytes(16).toString("base64url");
  const issued = issueChallenge(paths, now, { purpose: "register", user, userId: account.id, handle });
  return { ...issued, user: { id: handle, name: user }, exclude: current?.keys.map((key) => key.id) ?? [] };
}

function register(paths: SecurityKeysPaths, user: string, input: Record<string, unknown>, now: number): { keys: KeyView[] } {
  const challenge = consumeChallenge(paths, input.challengeId, "register", now);
  if (challenge.user !== user) failAction("the registration was started by a different account");
  const name = oneLine(input.name ?? "", "key name", 64, false) || "Security key";
  const origin = normalizeOrigin(input.origin);
  const registration = verifyRegistration({
    clientDataJSON: fromB64url(input.clientDataJSON, "clientDataJSON"),
    attestationObject: fromB64url(input.attestationObject, "attestationObject"),
    challenge: challenge.challenge,
  });
  if (registration.origin !== origin) failAction("the key was created for a different panel address");
  return withStoreLock(paths, () => {
    const account = activeAccount(paths, user);
    if (account.id !== challenge.userId) failAction("the registration was started by a different account");
    const store = readStore(paths);
    if (Object.values(store.users).some((entry) => entry.keys.some((key) => key.id === registration.credentialId))) {
      failAction("this key is already registered");
    }
    let entry = store.users[user];
    if (!entry || entry.userId !== account.id) entry = store.users[user] = { userId: account.id, handle: challenge.handle!, keys: [] };
    if (entry.handle !== challenge.handle) failAction("the registration is out of date; try again");
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
    return { keys: entry.keys.map(keyView) };
  });
}

function removeKey(paths: SecurityKeysPaths, user: string, id: unknown): boolean {
  if (typeof id !== "string") failAction("choose a key to remove");
  return withStoreLock(paths, () => {
    const store = readStore(paths);
    const entry = store.users[user];
    const before = entry?.keys.length ?? 0;
    if (entry) entry.keys = entry.keys.filter((key) => key.id !== id);
    if ((entry?.keys.length ?? 0) === before) failAction("that key is not registered");
    writeStore(paths, store);
    return true;
  });
}

function allUsers(paths: SecurityKeysPaths): { users: UserKeysView[] } {
  const store = readStore(paths);
  const accounts = panelAccounts(paths);
  return {
    users: Object.entries(store.users).map(([user, entry]) => {
      const account = accounts.get(user);
      return { user, active: Boolean(account?.active && account.id === entry.userId), keys: entry.keys.map(keyView) };
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
    if (verb === "login-options") data = issueChallenge(paths, now, { purpose: "login" });
    else if (verb === "sign-in") data = signIn(paths, readInput(options), now);
    else if (verb === "keys") data = { keys: ownKeys(readStore(paths), panelUser!, activeAccount(paths, panelUser!)) };
    else if (verb === "register-options") data = registerOptions(paths, panelUser!, now);
    else if (verb === "register") data = register(paths, panelUser!, readInput(options), now);
    else if (verb === "remove") {
      const account = activeAccount(paths, panelUser!);
      removeKey(paths, panelUser!, readInput(options).id);
      data = { keys: ownKeys(readStore(paths), panelUser!, account) };
    } else if (verb === "users") data = allUsers(paths);
    else {
      const input = readInput(options);
      if (typeof input.user !== "string" || !PANEL_USER_NAME_RE.test(input.user)) failAction("choose a user");
      removeKey(paths, input.user, input.id);
      data = allUsers(paths);
    }
    if (emit) emitActionOk(data);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const data = error instanceof ActionFailure ? error.data : undefined;
    if (emit) emitActionError(message, data, "security-keys");
    else process.stderr.write(`[security-keys] ERROR: ${message}\n`);
    return 1;
  }
}
