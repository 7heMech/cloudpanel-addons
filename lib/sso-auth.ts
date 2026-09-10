import { lstatSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { SESSION_DIR } from "../cli/paths";

const SESSION_COOKIE = "PHPSESSID";
const SESSION_FILE_PREFIX = "sess_";
const SESSION_ID_RE = /^[a-zA-Z0-9,-]+$/;
const USER_RE = /^[a-zA-Z0-9_.@-]{1,128}$/;
const TOKEN_CLASS = "Symfony\\Component\\Security\\Http\\Authenticator\\Token\\PostAuthenticationToken";
const USER_CLASS = "App\\Entity\\User";
const PANEL_USER = "clp";
export const MAX_SESSION_BYTES = 256 * 1024;
const MAX_SERIALIZATION_DEPTH = 64;
const MAX_SERIALIZATION_NODES = 20_000;
const MAX_ARRAY_ITEMS = 20_000;

export interface AuthenticatedRequest {
  user: string;
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

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function panelUserUid(): number | null {
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
  let fileStat: ReturnType<typeof lstatSync>;
  try {
    fileStat = lstatSync(path);
  } catch {
    return null;
  }

  if (fileStat.isSymbolicLink() || !fileStat.isFile()) return null;
  const ownerUid = options.ownerUid === undefined ? panelUserUid() : options.ownerUid;
  if (ownerUid === null || fileStat.uid !== ownerUid) return null;

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
  if (!Number.isSafeInteger(fileStat.size) || fileStat.size < 0 || fileStat.size > maxBytes) return null;

  try {
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    return bytes.byteLength <= maxBytes ? bytes : null;
  } catch {
    return null;
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

function usernameFromToken(token: PhpNode): string | null {
  if (token.type !== "object" || token.className !== TOKEN_CLASS) return null;
  const firewall = uniqueIntegerEntry(token.properties, 0);
  const tokenAttributes = uniqueIntegerEntry(token.properties, 1);
  if (firewall?.type !== "string" || decodeUtf8(firewall.value) !== "main") return null;
  if (tokenAttributes?.type !== "array") return null;
  const user = uniqueIntegerEntry(tokenAttributes.entries, 0);
  if (user?.type !== "object" || user.className !== USER_CLASS) return null;
  const usernames = user.properties.filter((entry) => {
    const name = keyText(entry.key);
    return name === "userName" || name?.endsWith("\u0000userName") === true;
  });
  if (usernames.length !== 1 || usernames[0]!.value.type !== "string") return null;
  const username = decodeUtf8(usernames[0]!.value.value);
  return username !== null && USER_RE.test(username) ? username : null;
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
  expiresAt: number;
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

    const mfa = uniqueStringEntry(attributes.entries, "mfaAuthenticated");
    const security = uniqueStringEntry(attributes.entries, "_security_main");
    if (mfa?.type !== "boolean" || mfa.value !== true) return null;
    if (security?.type !== "string") return null;
    const token = parseSerializedValue(security.value);
    const user = usernameFromToken(token ?? { type: "null" });
    return user ? { user, expiresAt } : null;
  } catch {
    return null;
  }
}

export async function authenticateRequest(req: Request): Promise<{
  auth: AuthenticatedRequest | null;
  response?: Response;
}> {
  const sessionId = readCookie(req, SESSION_COOKIE);
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return { auth: null, response: redirectToLogin() };
  const sessionPath = `${SESSION_DIR}/${SESSION_FILE_PREFIX}${sessionId}`;
  const bytes = await readPanelSessionFile(sessionPath);
  const session = bytes ? parsePanelSession(bytes) : null;
  return session
    ? { auth: { user: session.user } }
    : { auth: null, response: redirectToLogin() };
}
