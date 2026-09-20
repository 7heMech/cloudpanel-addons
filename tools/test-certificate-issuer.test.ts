import { expect, test } from "bun:test";
import { certificateIssuer, issuerLabel } from "../lib/certificate-issuer";
import {
  CLOUDFLARE_ORIGIN, CLOUDFLARE_ORIGIN_CA, CLOUDFLARE_ORIGIN_ECC, SELF_SIGNED, ZEROSSL,
} from "./fixtures/certificates";

test("an origin certificate is recognised whichever way Cloudflare spelled itself", () => {
  expect(certificateIssuer(CLOUDFLARE_ORIGIN)).toEqual({
    commonName: "CloudFlare Origin SSL Certificate Authority",
    organization: "CloudFlare, Inc.",
  });
  expect(issuerLabel(certificateIssuer(CLOUDFLARE_ORIGIN))).toBe("CF Origin");
  expect(issuerLabel(certificateIssuer(CLOUDFLARE_ORIGIN_ECC))).toBe("CF Origin");
});

test("another authority is named as it named itself, by its organisation", () => {
  expect(certificateIssuer(ZEROSSL)).toEqual({
    commonName: "ZeroSSL RSA Domain Secure Site CA",
    organization: "ZeroSSL",
  });
  expect(issuerLabel(certificateIssuer(ZEROSSL))).toBe("ZeroSSL");
});

test("an issuer with no organisation keeps its common name", () => {
  expect(issuerLabel(certificateIssuer(SELF_SIGNED))).toBe("shop.example.com");
});

test("the leaf's issuer is read, not the authority's own certificate below it", () => {
  const chain = `${CLOUDFLARE_ORIGIN}\n${CLOUDFLARE_ORIGIN_CA}`;
  expect(issuerLabel(certificateIssuer(chain))).toBe("CF Origin");
});

test("anything that is not a certificate gives no issuer rather than a wrong one", () => {
  for (const text of [
    "",
    "-----BEGIN CERTIFICATE-----\nnot base64 !!\n-----END CERTIFICATE-----",
    "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----",
    "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----",
    ZEROSSL.replace(/-----END CERTIFICATE-----/, ""),
  ]) {
    expect(certificateIssuer(text)).toBeNull();
    expect(issuerLabel(certificateIssuer(text))).toBe("");
  }
});

// A truncated certificate must not walk past the bytes it has, whatever it
// claims its lengths are.
test("a certificate cut short is refused rather than read out of bounds", () => {
  for (const length of [8, 40, 120, body(ZEROSSL).length - 200]) {
    expect(certificateIssuer(pemOf(body(ZEROSSL).slice(0, length)))).toBeNull();
  }
});

function body(pem: string): string {
  return /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(pem)![1]!.replace(/\s+/g, "");
}

function pemOf(base64: string): string {
  return `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----`;
}

function der(pem: string): Uint8Array {
  return Uint8Array.from(atob(body(pem)), (character) => character.charCodeAt(0));
}

function reencoded(bytes: Uint8Array): string {
  return pemOf(btoa(String.fromCharCode(...bytes)));
}

// Bytes that say what the structure is, rather than what is in it. A name read
// out of something shaped like this would be a guess, and a guess would replace
// the panel's own "Imported" with an authority that never signed anything.
test("a structure that is not a certificate's gives no issuer", () => {
  const bytes = der(ZEROSSL);
  const positions = [
    0, // the outer Certificate sequence
    4, // the tbsCertificate sequence inside it
    bytes.indexOf(0x31, 20), // the first name attribute's set
  ];
  for (const at of positions) {
    expect(at).toBeGreaterThan(-1);
    const changed = Uint8Array.from(bytes);
    changed[at] = changed[at] === 0x31 ? 0x30 : 0x31;
    expect(certificateIssuer(reencoded(changed))).toBeNull();
  }
  // Untouched, the same bytes still read.
  expect(issuerLabel(certificateIssuer(reencoded(bytes)))).toBe("ZeroSSL");
});
