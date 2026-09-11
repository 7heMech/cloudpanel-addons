import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } from "node:constants";
import { dirname } from "node:path";
import { AUTH_SOCKET_PATH, PANEL_USER } from "../cli/paths";

const SESSION_COOKIE = "cloudpanel";
const SESSION_ID_RE = /^[a-zA-Z0-9,-]+$/;
const USER_RE = /^[a-zA-Z0-9_.@-]{1,128}$/;
const ROLE_RE = /^ROLE_[A-Z0-9_]{1,120}$/;
const TOKEN_CLASS = "Symfony\\Component\\Security\\Http\\Authenticator\\Token\\PostAuthenticationToken";
const USER_CLASS = "App\\Entity\\User";
export const MAX_SESSION_BYTES = 256 * 1024;
export const MAX_SESSION_ID_LENGTH = 128;
const AUTH_HELPER_TIMEOUT_MS = 2_000;
const AUTH_HELPER_MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_AUTH_HELPERS = 8;
const MAX_AUTH_WAITERS = 16;
const AUTH_WAIT_TIMEOUT_MS = 500;
const MAX_SERIALIZATION_DEPTH = 64;
const MAX_SERIALIZATION_NODES = 20_000;
const MAX_ARRAY_ITEMS = 20_000;

export interface AuthenticatedRequest {
  user: string;
  roles: string[];
}

function readCookie(req: Request, name: string): string | null {
  return new Bun.CookieMap(req.headers.get("cookie") ?? "").get(name) || null;
}

function redirectToLogin(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/login",
      "Cache-Control": "no-store",
    },
  });
}

type AuthHelperReply = { kind: "valid"; session: PanelSession } | { kind: "invalid" } | { kind: "unavailable" };

function parseAuthHelperReply(stdout: string): AuthHelperReply {
  try {
    const value: unknown = JSON.parse(stdout.trim());
    if (value === null || typeof value !== "object" || Array.isArray(value)) return { kind: "unavailable" };
    const reply = value as Record<string, unknown>;
    if (reply.valid === false && Object.keys(reply).length === 1) return { kind: "invalid" };
    if (reply.valid !== true || Object.keys(reply).length !== 4) return { kind: "unavailable" };
    if (typeof reply.user !== "string" || !USER_RE.test(reply.user)) return { kind: "unavailable" };
    if (!Array.isArray(reply.roles) || reply.roles.length > 128) return { kind: "unavailable" };
    const roles: string[] = [];
    const seen = new Set<string>();
    for (const role of reply.roles) {
      if (typeof role !== "string" || !ROLE_RE.test(role) || seen.has(role)) return { kind: "unavailable" };
      seen.add(role);
      roles.push(role);
    }
    if (typeof reply.expiresAt !== "number" || !Number.isSafeInteger(reply.expiresAt)) return { kind: "unavailable" };
    if (Math.floor(Date.now() / 1000) >= reply.expiresAt) return { kind: "invalid" };
    return { kind: "valid", session: { user: reply.user, roles, expiresAt: reply.expiresAt } };
  } catch {
    return { kind: "unavailable" };
  }
}

let activeAuthHelpers = 0;
const authWaiters: Array<() => void> = [];

function releaseAuthSlot(): void {
  activeAuthHelpers--;
  const next = authWaiters.shift();
  if (next) next();
}

async function acquireAuthSlot(): Promise<(() => void) | null> {
  if (activeAuthHelpers < MAX_AUTH_HELPERS) {
    activeAuthHelpers++;
    return releaseAuthSlot;
  }
  if (authWaiters.length >= MAX_AUTH_WAITERS) return null;

  return new Promise((resolve) => {
    let waiting = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grant = () => {
      if (!waiting) return;
      waiting = false;
      if (timer !== undefined) clearTimeout(timer);
      activeAuthHelpers++;
      resolve(releaseAuthSlot);
    };
    authWaiters.push(grant);
    timer = setTimeout(() => {
      if (!waiting) return;
      waiting = false;
      const index = authWaiters.indexOf(grant);
      if (index >= 0) authWaiters.splice(index, 1);
      resolve(null);
    }, AUTH_WAIT_TIMEOUT_MS);
  });
}

/**
 * Ask the root helper about one session over its socket.
 *
 * The transport is systemd socket activation rather than sudo: the manager's
 * own unit implies NoNewPrivileges=yes, under which sudo cannot escalate at
 * all. systemd accepts the connection, runs `clp-addons action auth` as root
 * with the connection as its stdin/stdout, and this writes one bounded request
 * and reads one bounded reply. Every failure is "unavailable", which the
 * caller turns into 503 -- never into an authenticated request.
 */
async function callAuthHelper(sessionId: string, socketPath = AUTH_SOCKET_PATH): Promise<AuthHelperReply> {
  const release = await acquireAuthSlot();
  if (!release) return { kind: "unavailable" };
  try {
    return await new Promise<AuthHelperReply>((resolve) => {
      const chunks: Uint8Array[] = [];
      let total = 0;
      let settled = false;
      let socket: { end: () => void } | null = null;
      const finish = (reply: AuthHelperReply) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket?.end(); } catch { /* already closed */ }
        resolve(reply);
      };
      const timer = setTimeout(() => finish({ kind: "unavailable" }), AUTH_HELPER_TIMEOUT_MS);

      Bun.connect({
        unix: socketPath,
        socket: {
          open(connection) {
            socket = connection;
            connection.write(`${sessionId}\n`);
          },
          data(_connection, chunk) {
            if (total + chunk.byteLength > AUTH_HELPER_MAX_OUTPUT_BYTES) {
              finish({ kind: "unavailable" });
              return;
            }
            chunks.push(chunk);
            total += chunk.byteLength;
          },
          close() {
            const bytes = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            finish(parseAuthHelperReply(new TextDecoder().decode(bytes)));
          },
          error() {
            finish({ kind: "unavailable" });
          },
          connectError() {
            finish({ kind: "unavailable" });
          },
        },
      }).catch(() => finish({ kind: "unavailable" }));
    });
  } catch {
    return { kind: "unavailable" };
  } finally {
    release();
  }
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function panelUserUid(): number | null {
  try {
    const line = readFileSync("/etc/passwd", "utf8")
      .split("\n")
      .find((entry) => entry.startsWith(`${PANEL_USER}:`));
    const uid = Number.parseInt(line?.split(":")[2] ?? "", 10);
    return Number.isInteger(uid) && uid >= 0 ? uid : null;
  } catch {
    return null;
  }
}

export interface SessionFileOptions {
  ownerUid?: number | null;
  maxBytes?: number;
  warn?: (message: string) => void;
}

export async function readPanelSessionFile(
  path: string,
  options: SessionFileOptions = {},
): Promise<Uint8Array | null> {
  const maxBytes = options.maxBytes === undefined
    ? MAX_SESSION_BYTES
    : Math.min(MAX_SESSION_BYTES, Math.max(0, options.maxBytes));
  let parentStat: ReturnType<typeof lstatSync>;
  try {
    parentStat = lstatSync(dirname(path));
  } catch {
    return null;
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) return null;
  if ((parentStat.mode & 0o022) !== 0) {
    (options.warn ?? ((message: string) => console.warn(message)))(
      `CloudPanel session directory is writable by group/other; file ownership remains the trust boundary: ${dirname(path)}`,
    );
  }
  const ownerUid = options.ownerUid === undefined ? panelUserUid() : options.ownerUid;
  if (ownerUid === null) return null;
  let fd: number | undefined;
  try {
    // O_NOFOLLOW and fstat on the opened descriptor keep the privileged read
    // bound to the object whose owner/type/size were checked. Read one extra
    // byte so growth after the stat is rejected without an unbounded read.
    fd = openSync(path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW);
    const fileStat = fstatSync(fd);
    if (!fileStat.isFile() || fileStat.uid !== ownerUid
      || !Number.isSafeInteger(fileStat.size) || fileStat.size < 0 || fileStat.size > maxBytes) return null;
    const bytes = new Uint8Array(maxBytes + 1);
    let total = 0;
    while (total < bytes.byteLength) {
      const count = readSync(fd, bytes, total, bytes.byteLength - total, total);
      if (count === 0) break;
      total += count;
    }
    return total <= maxBytes ? bytes.slice(0, total) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

type PhpKey =
  | { type: "integer"; value: number }
  | { type: "string"; value: Uint8Array };

type PhpNode =
  | { type: "null" }
  | { type: "boolean"; value: boolean }
  | { type: "integer"; value: number }
  | { type: "string"; value: Uint8Array }
  | { type: "array"; entries: Array<{ key: PhpKey; value: PhpNode }> }
  | { type: "object"; className: string; properties: Array<{ key: PhpKey; value: PhpNode }> };

class SerializationError extends Error {}

class PhpScanner {
  private offset = 0;
  private nodes = 0;

  constructor(private readonly bytes: Uint8Array) {
    if (bytes.byteLength > MAX_SESSION_BYTES) throw new SerializationError("session is too large");
  }

  get position(): number {
    return this.offset;
  }

  get length(): number {
    return this.bytes.byteLength;
  }

  parseValue(depth = 0): PhpNode {
    if (depth > MAX_SERIALIZATION_DEPTH) throw new SerializationError("serialization is too deep");
    if (++this.nodes > MAX_SERIALIZATION_NODES) throw new SerializationError("serialization has too many nodes");
    const tag = this.readByte();
    switch (tag) {
      case 78: // N
        this.expectByte(59);
        return { type: "null" };
      case 98: // b
        this.expectByte(58);
        const boolean = this.readByte();
        if (boolean !== 48 && boolean !== 49) throw new SerializationError("invalid boolean");
        this.expectByte(59);
        return { type: "boolean", value: boolean === 49 };
      case 105: // i
        this.expectByte(58);
        const integer = this.readInteger();
        this.expectByte(59);
        return { type: "integer", value: integer };
      case 115: // s
        return { type: "string", value: this.readStringPayload() };
      case 97: // a
        return { type: "array", entries: this.readEntries(depth) };
      case 79: // O
        return this.readObject(depth);
      default:
        throw new SerializationError("unknown serialization tag");
    }
  }

  readSessionKey(): string {
    const start = this.offset;
    while (this.offset < this.bytes.byteLength && this.bytes[this.offset] !== 124) this.offset++;
    if (this.offset === start || this.offset >= this.bytes.byteLength) throw new SerializationError("invalid session key");
    const value = decodeUtf8(this.bytes.slice(start, this.offset));
    if (value === null) throw new SerializationError("session key is not UTF-8");
    this.offset++;
    return value;
  }

  private readEntries(depth: number): Array<{ key: PhpKey; value: PhpNode }> {
    this.expectByte(58);
    const count = this.readInteger();
    if (count < 0 || count > MAX_ARRAY_ITEMS) throw new SerializationError("invalid array size");
    this.expectByte(58);
    this.expectByte(123);
    const entries: Array<{ key: PhpKey; value: PhpNode }> = [];
    const seen = new Set<string>();
    for (let index = 0; index < count; index++) {
      const key = this.parseKey(depth + 1);
      const identity = key.type === "integer" ? `i:${key.value}` : `s:${Buffer.from(key.value).toString("base64")}`;
      if (seen.has(identity)) throw new SerializationError("duplicate array key");
      seen.add(identity);
      entries.push({ key, value: this.parseValue(depth + 1) });
    }
    this.expectByte(125);
    return entries;
  }

  private readObject(depth: number): PhpNode {
    this.expectByte(58);
    const classLength = this.readInteger();
    if (classLength < 1 || classLength > this.bytes.byteLength) throw new SerializationError("invalid object class length");
    this.expectByte(58);
    this.expectByte(34);
    const classEnd = this.offset + classLength;
    if (classEnd > this.bytes.byteLength) throw new SerializationError("truncated object class");
    const className = decodeUtf8(this.bytes.slice(this.offset, classEnd));
    this.offset = classEnd;
    this.expectByte(34);
    if (className === null || !className) throw new SerializationError("invalid object class");
    this.expectByte(58);
    const count = this.readInteger();
    if (count < 0 || count > MAX_ARRAY_ITEMS) throw new SerializationError("invalid object property count");
    this.expectByte(58);
    this.expectByte(123);
    const properties: Array<{ key: PhpKey; value: PhpNode }> = [];
    const seen = new Set<string>();
    for (let index = 0; index < count; index++) {
      const key = this.parseKey(depth + 1);
      const identity = key.type === "integer" ? `i:${key.value}` : `s:${Buffer.from(key.value).toString("base64")}`;
      if (seen.has(identity)) throw new SerializationError("duplicate object property");
      seen.add(identity);
      properties.push({ key, value: this.parseValue(depth + 1) });
    }
    this.expectByte(125);
    return { type: "object", className, properties };
  }

  private parseKey(depth: number): PhpKey {
    const value = this.parseValue(depth);
    if (value.type === "integer") return value;
    if (value.type === "string") return value;
    throw new SerializationError("array key is not scalar");
  }

  private readStringPayload(): Uint8Array {
    this.expectByte(58);
    const length = this.readInteger();
    if (length < 0 || length > this.bytes.byteLength) throw new SerializationError("invalid string length");
    this.expectByte(58);
    this.expectByte(34);
    const end = this.offset + length;
    if (end > this.bytes.byteLength) throw new SerializationError("truncated string");
    const value = this.bytes.slice(this.offset, end);
    this.offset = end;
    this.expectByte(34);
    this.expectByte(59);
    return value;
  }

  private readInteger(): number {
    const start = this.offset;
    if (this.bytes[this.offset] === 45) this.offset++;
    const digits = this.offset;
    while (this.offset < this.bytes.byteLength && this.bytes[this.offset]! >= 48 && this.bytes[this.offset]! <= 57) {
      this.offset++;
    }
    if (this.offset === digits) throw new SerializationError("invalid integer");
    const text = new TextDecoder().decode(this.bytes.slice(start, this.offset));
    const value = Number(text);
    if (!Number.isSafeInteger(value)) throw new SerializationError("integer is out of range");
    return value;
  }

  private readByte(): number {
    if (this.offset >= this.bytes.byteLength) throw new SerializationError("truncated serialization");
    return this.bytes[this.offset++]!;
  }

  private expectByte(expected: number): void {
    if (this.readByte() !== expected) throw new SerializationError("malformed serialization");
  }
}

function keyText(key: PhpKey): string | null {
  return key.type === "string" ? decodeUtf8(key.value) : null;
}

function uniqueStringEntry(
  entries: Array<{ key: PhpKey; value: PhpNode }>,
  expected: string,
): PhpNode | null {
  const matches = entries.filter((entry) => keyText(entry.key) === expected);
  return matches.length === 1 ? matches[0]!.value : null;
}

function uniqueIntegerEntry(
  entries: Array<{ key: PhpKey; value: PhpNode }>,
  expected: number,
): PhpNode | null {
  const matches = entries.filter((entry) => entry.key.type === "integer" && entry.key.value === expected);
  return matches.length === 1 ? matches[0]!.value : null;
}

function uniqueUserProperty(user: PhpNode, name: string): PhpNode | null {
  if (user.type !== "object" || user.className !== USER_CLASS) return null;
  const nativeKey = `\u0000${USER_CLASS}\u0000${name}`;
  const matches = user.properties.filter((entry) => {
    const key = keyText(entry.key);
    // Any public or differently scoped property with this name is ambiguous,
    // even when the native private property is also present. Only the exact
    // private key CloudPanel serializes is trusted. The structured private-key
    // check is used only to detect collisions; it never authorizes a value.
    if (key === nativeKey || key === name) return true;
    if (!key || key.charCodeAt(0) !== 0) return false;
    const separator = key.indexOf("\u0000", 1);
    return separator > 1 && key.slice(separator + 1) === name;
  });
  return matches.length === 1 && keyText(matches[0]!.key) === nativeKey ? matches[0]!.value : null;
}

function roleNamesFromTokenState(value: PhpNode): string[] | null {
  if (value.type !== "array" || value.entries.length > 128) return null;
  const roles: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.entries.length; index++) {
    const entry = value.entries[index]!;
    if (entry.key.type !== "integer" || entry.key.value !== index || entry.value.type !== "string") return null;
    const role = decodeUtf8(entry.value.value);
    if (role === null || !ROLE_RE.test(role) || seen.has(role)) return null;
    seen.add(role);
    roles.push(role);
  }
  return roles;
}

interface TokenIdentity {
  user: string;
  roles: string[];
  mfa: boolean;
}

function identityFromToken(token: PhpNode): TokenIdentity | null {
  if (token.type !== "object" || token.className !== TOKEN_CLASS) return null;
  if (token.properties.length !== 2) return null;
  const firewall = uniqueIntegerEntry(token.properties, 0);
  const tokenAttributes = uniqueIntegerEntry(token.properties, 1);
  if (firewall?.type !== "string" || decodeUtf8(firewall.value) !== "main") return null;
  if (tokenAttributes?.type !== "array") return null;
  if (tokenAttributes.entries.length !== 5) return null;
  const user = uniqueIntegerEntry(tokenAttributes.entries, 0);
  const authenticated = uniqueIntegerEntry(tokenAttributes.entries, 1);
  const provider = uniqueIntegerEntry(tokenAttributes.entries, 2);
  const tokenAttributesMap = uniqueIntegerEntry(tokenAttributes.entries, 3);
  const roleNames = uniqueIntegerEntry(tokenAttributes.entries, 4);
  if (authenticated?.type !== "boolean" || authenticated.value !== true) return null;
  if (provider?.type !== "null") return null;
  if (tokenAttributesMap?.type !== "array") return null;
  const roles = roleNamesFromTokenState(roleNames ?? { type: "null" });
  if (roles === null) return null;
  if (user?.type !== "object" || user.className !== USER_CLASS) return null;

  const usernameNode = uniqueUserProperty(user, "userName");
  const mfaNode = uniqueUserProperty(user, "mfa");
  const statusNode = uniqueUserProperty(user, "status");
  if (usernameNode?.type !== "string" || mfaNode?.type !== "boolean" || statusNode?.type !== "boolean" || !statusNode.value) return null;
  const username = decodeUtf8(usernameNode.value);
  return username !== null && USER_RE.test(username)
    ? { user: username, roles, mfa: mfaNode.value }
    : null;
}

function parseSerializedValue(bytes: Uint8Array): PhpNode | null {
  try {
    const scanner = new PhpScanner(bytes);
    const value = scanner.parseValue();
    if (scanner.position !== scanner.length) throw new SerializationError("trailing serialization data");
    return value;
  } catch {
    return null;
  }
}

export interface PanelSession {
  user: string;
  roles: string[];
  expiresAt: number;
}

function serviceUnavailableResponse(): Response {
  return Response.json(
    { ok: false, error: "authentication service unavailable" },
    { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "1" } },
  );
}

export function parsePanelSession(data: Uint8Array | string): PanelSession | null {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SESSION_BYTES) return null;
  try {
    const scanner = new PhpScanner(bytes);
    const top = new Map<string, PhpNode>();
    while (scanner.position < scanner.length) {
      const key = scanner.readSessionKey();
      if (top.has(key)) throw new SerializationError("duplicate session key");
      top.set(key, scanner.parseValue());
    }

    const meta = top.get("_sf2_meta");
    const attributes = top.get("_sf2_attributes");
    if (meta?.type !== "array" || attributes?.type !== "array") return null;
    const updated = uniqueStringEntry(meta.entries, "u");
    const lifetime = uniqueStringEntry(meta.entries, "l");
    if (updated?.type !== "integer" || lifetime?.type !== "integer") return null;
    const seconds = lifetime.value === 0 ? 1440 : lifetime.value;
    if (seconds < 0 || updated.value < 0 || updated.value > Number.MAX_SAFE_INTEGER - seconds) return null;
    const expiresAt = updated.value + seconds;
    if (Math.floor(Date.now() / 1000) >= expiresAt) return null;

    const security = uniqueStringEntry(attributes.entries, "_security_main");
    if (security?.type !== "string") return null;
    const token = parseSerializedValue(security.value);
    const identity = identityFromToken(token ?? { type: "null" });
    if (!identity) return null;

    // LoginListener writes `true` only after successful MFA, writes `false`
    // while an MFA challenge is pending, and removes the marker for users who
    // do not have MFA enabled. AutoLoginAuthenticator can skip that listener,
    // so an absent marker is accepted only when the serialized native user
    // explicitly says MFA is disabled. Every present marker is required to be
    // the exact boolean true. It may remain true when the trusted native MFA
    // value is either boolean.
    const mfaEntries = attributes.entries.filter((entry) => keyText(entry.key) === "mfaAuthenticated");
    if (mfaEntries.length > 1) return null;
    if (mfaEntries.length === 1) {
      const marker = mfaEntries[0]!.value;
      if (marker.type !== "boolean" || marker.value !== true) return null;
    } else if (identity.mfa) {
      return null;
    }

    return { user: identity.user, roles: identity.roles, expiresAt };
  } catch {
    return null;
  }
}

export async function authenticateRequest(req: Request): Promise<{
  auth: AuthenticatedRequest | null;
  response?: Response;
}> {
  const sessionId = readCookie(req, SESSION_COOKIE);
  if (!sessionId || sessionId.length > MAX_SESSION_ID_LENGTH || !SESSION_ID_RE.test(sessionId)) {
    return { auth: null, response: redirectToLogin() };
  }
  const result = await callAuthHelper(sessionId);
  if (result.kind === "valid") {
    return { auth: { user: result.session.user, roles: result.session.roles } };
  }
  return {
    auth: null,
    response: result.kind === "unavailable" ? serviceUnavailableResponse() : redirectToLogin(),
  };
}
