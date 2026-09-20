/**
 * Who issued a certificate, read from the certificate itself.
 *
 * CloudPanel records a certificate's type as a number -- self-signed, Let's
 * Encrypt, imported -- so every uploaded certificate is alike to the panel,
 * whether it came from a public authority or from Cloudflare's origin CA. The
 * issuer is in the certificate the panel stored, so it is read from there.
 *
 * Only the issuer's name is wanted, so this walks the few DER fields in front
 * of it rather than decoding a whole X.509. Anything it does not recognise
 * gives no issuer, and the caller falls back to the panel's own wording.
 */

interface Field {
  tag: number;
  start: number;
  end: number;
  next: number;
}

/** The common name and organisation an issuer gave, as far as either is there. */
export interface CertificateIssuer {
  commonName: string;
  organization: string;
}

const COMMON_NAME = "2.5.4.3";
const ORGANIZATION = "2.5.4.10";

const SEQUENCE = 0x30;
const SET = 0x31;
const INTEGER = 0x02;
const OBJECT_IDENTIFIER = 0x06;
const VERSION = 0xa0;
// The string types an authority's name is written in. A BMPString is UTF-16 and
// would decode to nonsense here, so a name in one is left unread rather than
// reported wrongly.
const TEXT_TAGS = new Set([0x0c, 0x13, 0x14, 0x16, 0x1a]);

function field(bytes: Uint8Array, at: number): Field | null {
  if (at + 1 >= bytes.length) return null;
  const tag = bytes[at]!;
  const first = bytes[at + 1]!;
  if (first < 0x80) return { tag, start: at + 2, end: at + 2 + first, next: at + 2 + first };
  const count = first & 0x7f;
  // An indefinite length, and a length too long to be a certificate's, are both
  // outside what DER allows here.
  if (count === 0 || count > 4 || at + 2 + count > bytes.length) return null;
  let length = 0;
  for (let i = 0; i < count; i++) length = length * 256 + bytes[at + 2 + i]!;
  const start = at + 2 + count;
  if (start + length > bytes.length) return null;
  return { tag, start, end: start + length, next: start + length };
}

function objectIdentifier(bytes: Uint8Array, from: Field): string {
  const first = bytes[from.start];
  if (first === undefined) return "";
  const parts = [String(Math.floor(first / 40)), String(first % 40)];
  let value = 0;
  for (let i = from.start + 1; i < from.end; i++) {
    const byte = bytes[i]!;
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      parts.push(String(value));
      value = 0;
    }
  }
  return parts.join(".");
}

/**
 * The issuer of the first certificate in a PEM.
 *
 * A stored certificate is the leaf, and a chain below it is the authority's own
 * certificate, which is not what named the site's.
 */
export function certificateIssuer(pem: string): CertificateIssuer | null {
  const base64 = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(pem)?.[1];
  if (!base64) return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(base64.replace(/\s+/g, "")), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }

  // Certificate ::= SEQUENCE { tbsCertificate SEQUENCE { [0] version, serial,
  // signature, issuer Name, ... } }. The version is optional, so the issuer is
  // the second field after the serial rather than a fixed offset. Every tag on
  // the way is checked: a field that is not what the structure says it is means
  // this is not a certificate, and a name read out of it would be a guess.
  const certificate = field(bytes, 0);
  const tbs = certificate?.tag === SEQUENCE ? field(bytes, certificate.start) : null;
  if (tbs?.tag !== SEQUENCE) return null;
  let at = tbs.start;
  const version = field(bytes, at);
  if (version?.tag === VERSION) at = version.next;
  const serial = field(bytes, at);
  if (serial?.tag !== INTEGER) return null;
  const algorithm = field(bytes, serial.next);
  if (algorithm?.tag !== SEQUENCE) return null;
  const issuer = field(bytes, algorithm.next);
  if (issuer?.tag !== SEQUENCE || issuer.end > tbs.end) return null;

  const found: CertificateIssuer = { commonName: "", organization: "" };
  // Name ::= SEQUENCE OF SET OF SEQUENCE { type OID, value }. A set usually
  // holds one attribute, but it may hold several, in any order, so every one of
  // them is read and the two an operator would recognise are kept.
  for (let set = field(bytes, issuer.start); set && set.end <= issuer.end; set = field(bytes, set.next)) {
    if (set.tag !== SET) return null;
    for (let pair = field(bytes, set.start); pair && pair.end <= set.end; pair = field(bytes, pair.next)) {
      if (pair.tag !== SEQUENCE) return null;
      const type = field(bytes, pair.start);
      if (type?.tag !== OBJECT_IDENTIFIER) return null;
      const value = field(bytes, type.next);
      if (!value) return null;
      const name = objectIdentifier(bytes, type);
      if ((name === COMMON_NAME || name === ORGANIZATION) && TEXT_TAGS.has(value.tag)) {
        const text = new TextDecoder().decode(bytes.subarray(value.start, value.end)).trim();
        if (name === COMMON_NAME && !found.commonName) found.commonName = text;
        if (name === ORGANIZATION && !found.organization) found.organization = text;
      }
      if (pair.next >= set.end) break;
    }
    if (set.next >= issuer.end) break;
  }
  return found.commonName || found.organization ? found : null;
}

/** Cloudflare's origin CA, which spells its own name both ways. */
const CLOUDFLARE_ORIGIN = /cloudflare origin/i;

/**
 * Cloudflare's origin certificate is the one worth naming outright: a browser
 * reaching the origin directly rejects it, exactly as it rejects the panel's
 * self-signed placeholder, and it is a certificate at all only for traffic
 * arriving through Cloudflare.
 */
function fromCloudflare(issuer: CertificateIssuer): boolean {
  return CLOUDFLARE_ORIGIN.test(issuer.commonName) || CLOUDFLARE_ORIGIN.test(issuer.organization);
}

/**
 * What to call the issuer in a column an operator scans.
 *
 * An authority names itself after its product in the common name -- "ZeroSSL
 * RSA Domain Secure Site CA", "R11" -- and after itself in the organisation,
 * which is both shorter and the name an operator recognises. The common name
 * is the fallback for an issuer that gave no organisation.
 */
export function issuerLabel(issuer: CertificateIssuer | null): string {
  if (!issuer) return "";
  if (fromCloudflare(issuer)) return "CF Origin";
  return issuer.organization || issuer.commonName;
}
