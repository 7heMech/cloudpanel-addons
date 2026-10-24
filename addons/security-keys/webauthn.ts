// Just enough WebAuthn for passkey sign-in: "none" attestation, discoverable
// credentials, user verification required, and the three algorithms browsers
// and authenticators actually offer (ES256, EdDSA, RS256).
//
// Attestation statements are not read. They say which make of authenticator
// produced a key, and nothing here restricts makes; what matters is that the
// key signed this challenge for this origin with the user verified.

import { createHash, createPublicKey, verify } from "node:crypto";
import { isIP } from "node:net";

export const ALGORITHMS = [-7, -8, -257] as const;
export type Algorithm = (typeof ALGORITHMS)[number];

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_AT = 0x40;
const MAX_CREDENTIAL_ID_BYTES = 1023;
const MAX_CBOR_DEPTH = 8;

export class WebAuthnError extends Error {}

function fail(message: string): never {
  throw new WebAuthnError(message);
}

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromB64url(value: unknown, what: string, maxBytes = 64 * 1024): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value) || value.length > Math.ceil(maxBytes * 4 / 3)) {
    fail(`${what} is not base64url`);
  }
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function sha256(bytes: Uint8Array | string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

export type Cbor = number | string | Uint8Array | boolean | null | undefined | Cbor[] | Map<Cbor, Cbor>;

/** One CBOR item from `bytes` at `offset`, and where it ends. */
export function decodeCbor(bytes: Uint8Array, offset = 0, depth = 0): { value: Cbor; end: number } {
  if (depth > MAX_CBOR_DEPTH) fail("CBOR nests too deeply");
  if (offset >= bytes.length) fail("CBOR ends early");
  const initial = bytes[offset]!;
  const major = initial >> 5;
  const info = initial & 0x1f;
  let at = offset + 1;
  const take = (count: number): number => {
    if (at + count > bytes.length) fail("CBOR ends early");
    let value = 0;
    for (let i = 0; i < count; i++) value = value * 256 + bytes[at + i]!;
    at += count;
    return value;
  };
  let argument: number;
  if (info < 24) argument = info;
  else if (info === 24) argument = take(1);
  else if (info === 25) argument = take(2);
  else if (info === 26) argument = take(4);
  else if (info === 27) {
    argument = take(8);
    if (!Number.isSafeInteger(argument)) fail("CBOR integer is too large");
  } else fail("indefinite-length CBOR is not supported");

  switch (major) {
    case 0: return { value: argument, end: at };
    case 1: return { value: -1 - argument, end: at };
    case 2:
    case 3: {
      if (at + argument > bytes.length) fail("CBOR ends early");
      const slice = bytes.subarray(at, at + argument);
      at += argument;
      return { value: major === 2 ? new Uint8Array(slice) : new TextDecoder("utf-8", { fatal: true }).decode(slice), end: at };
    }
    case 4: {
      if (argument > bytes.length - at) fail("CBOR ends early");
      const items: Cbor[] = [];
      for (let i = 0; i < argument; i++) {
        const item = decodeCbor(bytes, at, depth + 1);
        items.push(item.value);
        at = item.end;
      }
      return { value: items, end: at };
    }
    case 5: {
      if (argument > bytes.length - at) fail("CBOR ends early");
      const map = new Map<Cbor, Cbor>();
      for (let i = 0; i < argument; i++) {
        const key = decodeCbor(bytes, at, depth + 1);
        const value = decodeCbor(bytes, key.end, depth + 1);
        if (typeof key.value !== "number" && typeof key.value !== "string") fail("CBOR map key is not a number or string");
        if (map.has(key.value)) fail("CBOR map repeats a key");
        map.set(key.value, value.value);
        at = value.end;
      }
      return { value: map, end: at };
    }
    case 7:
      if (info === 20) return { value: false, end: at };
      if (info === 21) return { value: true, end: at };
      if (info === 22) return { value: null, end: at };
      if (info === 23) return { value: undefined, end: at };
      return fail("CBOR floats are not supported");
    default:
      return fail("CBOR tags are not supported");
  }
}

export interface PublicJwk {
  kty: "EC" | "OKP" | "RSA";
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
}

export interface StoredPublicKey {
  alg: Algorithm;
  jwk: PublicJwk;
}

function coseBytes(key: Map<Cbor, Cbor>, label: number, length?: number): string {
  const value = key.get(label);
  if (!(value instanceof Uint8Array) || (length !== undefined && value.length !== length)) fail("public key is malformed");
  return b64url(value);
}

/** A COSE public key as a JWK node:crypto can load, for the algorithms allowed. */
export function coseToJwk(key: Cbor): StoredPublicKey {
  if (!(key instanceof Map)) fail("public key is not a COSE map");
  const kty = key.get(1);
  const alg = key.get(3);
  let jwk: PublicJwk;
  if (alg === -7 && kty === 2 && key.get(-1) === 1) {
    jwk = { kty: "EC", crv: "P-256", x: coseBytes(key, -2, 32), y: coseBytes(key, -3, 32) };
  } else if (alg === -8 && kty === 1 && key.get(-1) === 6) {
    jwk = { kty: "OKP", crv: "Ed25519", x: coseBytes(key, -2, 32) };
  } else if (alg === -257 && kty === 3) {
    jwk = { kty: "RSA", n: coseBytes(key, -1), e: coseBytes(key, -2) };
  } else {
    fail("this key uses an algorithm that is not supported");
  }
  try {
    createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    fail("public key is malformed");
  }
  return { alg, jwk };
}

interface AuthenticatorData {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  credentialId?: Uint8Array;
  publicKey?: Cbor;
}

export function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData {
  if (bytes.length < 37) fail("authenticator data is too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parsed: AuthenticatorData = {
    rpIdHash: bytes.subarray(0, 32),
    flags: bytes[32]!,
    signCount: view.getUint32(33),
  };
  if (parsed.flags & FLAG_AT) {
    if (bytes.length < 55) fail("authenticator data is too short");
    const idLength = view.getUint16(53);
    if (idLength === 0 || idLength > MAX_CREDENTIAL_ID_BYTES || 55 + idLength > bytes.length) fail("credential id is malformed");
    parsed.credentialId = bytes.subarray(55, 55 + idLength);
    parsed.publicKey = decodeCbor(bytes, 55 + idLength).value;
  }
  return parsed;
}

/**
 * An `https:` origin with a hostname, as the browser reported it. WebAuthn
 * refuses IP addresses and pages with certificate errors itself; this only
 * makes sure nothing else is stored.
 */
export function normalizeOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 300) fail("origin is malformed");
  let url: URL;
  try { url = new URL(value); } catch { fail("origin is malformed"); }
  if (url.protocol !== "https:" || url.origin !== value || isIP(url.hostname.replace(/^\[|\]$/g, ""))) {
    fail("security keys need the panel on an https:// hostname");
  }
  return url.origin;
}

function clientData(bytes: Uint8Array, type: string, challenge: string): { origin: string } {
  let data: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail("client data is not JSON"); }
  if (typeof data !== "object" || data === null) fail("client data is not JSON");
  if (data.type !== type) fail("client data is for a different ceremony");
  if (data.challenge !== challenge) fail("the challenge does not match");
  if (data.crossOrigin === true) fail("the request came from a frame on another site");
  return { origin: normalizeOrigin(data.origin) };
}

function requireFlags(flags: number): void {
  if (!(flags & FLAG_UP)) fail("the key did not register a touch");
  if (!(flags & FLAG_UV)) fail("the key did not verify its user; set a PIN or use a biometric key");
}

export interface Registration {
  credentialId: string;
  publicKey: StoredPublicKey;
  signCount: number;
  origin: string;
  backupEligible: boolean;
}

export function verifyRegistration(input: {
  clientDataJSON: Uint8Array;
  attestationObject: Uint8Array;
  challenge: string;
}): Registration {
  const { origin } = clientData(input.clientDataJSON, "webauthn.create", input.challenge);
  const attestation = decodeCbor(input.attestationObject).value;
  if (!(attestation instanceof Map)) fail("attestation is malformed");
  const authData = attestation.get("authData");
  if (!(authData instanceof Uint8Array)) fail("attestation is malformed");
  const parsed = parseAuthenticatorData(authData);
  if (!sameBytes(parsed.rpIdHash, sha256(new URL(origin).hostname))) fail("the key was created for a different site");
  requireFlags(parsed.flags);
  if (!parsed.credentialId || parsed.publicKey === undefined) fail("the key returned no credential");
  return {
    credentialId: b64url(parsed.credentialId),
    publicKey: coseToJwk(parsed.publicKey),
    signCount: parsed.signCount,
    origin,
    backupEligible: Boolean(parsed.flags & FLAG_BE),
  };
}

export function verifyAssertion(input: {
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
  signature: Uint8Array;
  challenge: string;
  origin: string;
  publicKey: StoredPublicKey;
  signCount: number;
}): { signCount: number } {
  const { origin } = clientData(input.clientDataJSON, "webauthn.get", input.challenge);
  if (origin !== input.origin) fail("the key was registered on a different panel address");
  const parsed = parseAuthenticatorData(input.authenticatorData);
  if (!sameBytes(parsed.rpIdHash, sha256(new URL(origin).hostname))) fail("the key signed for a different site");
  requireFlags(parsed.flags);
  const signed = Buffer.concat([input.authenticatorData, sha256(input.clientDataJSON)]);
  const key = createPublicKey({ key: input.publicKey.jwk, format: "jwk" });
  const ok = verify(input.publicKey.alg === -8 ? null : "sha256", signed, key, input.signature);
  if (!ok) fail("the signature does not verify");
  // Synced passkeys always report 0. A key that counts and has gone backwards
  // has been cloned.
  if ((parsed.signCount !== 0 || input.signCount !== 0) && parsed.signCount <= input.signCount) {
    fail("the key's signature counter went backwards");
  }
  return { signCount: parsed.signCount };
}
