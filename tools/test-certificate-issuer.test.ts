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
  const body = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/
    .exec(ZEROSSL)![1]!.replace(/\s+/g, "");
  for (const length of [8, 40, 120, body.length - 200]) {
    const cut = `-----BEGIN CERTIFICATE-----\n${body.slice(0, length)}\n-----END CERTIFICATE-----`;
    expect(() => certificateIssuer(cut)).not.toThrow();
  }
});
