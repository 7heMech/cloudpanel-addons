import { describe, expect, test } from "bun:test";
import { mergeSpf } from "../addons/dns/spf";

describe("merging a profile's SPF into what a domain publishes", () => {
  test("with no SPF yet, the profile's record is used as written", () => {
    expect(mergeSpf("v=spf1 mx  ~all", [])).toEqual({ ok: true, value: "v=spf1 mx ~all", changed: true });
  });

  test("existing senders and the existing ending are kept, and missing senders are added before it", () => {
    const merged = mergeSpf("v=spf1 mx ~all", ["v=spf1 include:_spf.mlsend.com include:spf.mailjet.com -all"]);
    expect(merged).toEqual({ ok: true, value: "v=spf1 include:_spf.mlsend.com include:spf.mailjet.com mx -all", changed: true });
  });

  test("a record that already names every sender is unchanged, however it spells them", () => {
    expect(mergeSpf("v=spf1 ip4:192.0.2.25 ip6:2001:db8::25 ~all", ["v=spf1 +ip4:192.0.2.25/32 ip6:2001:0db8::25 ~all"]))
      .toMatchObject({ ok: true, changed: false });
    expect(mergeSpf("v=spf1 include:_SPF.Google.com. ~all", ["v=spf1 include:_spf.google.com -all"])).toMatchObject({ ok: true, changed: false });
  });

  test("redirect= and an implicit neutral ending are kept", () => {
    expect(mergeSpf("v=spf1 mx ~all", ["v=spf1 a redirect=_spf.example.net"]))
      .toEqual({ ok: true, value: "v=spf1 a mx redirect=_spf.example.net", changed: true });
    expect(mergeSpf("v=spf1 mx ~all", ["v=spf1 a"])).toEqual({ ok: true, value: "v=spf1 a mx", changed: true });
  });

  test("duplicate SPF records that end alike become one record with every sender", () => {
    expect(mergeSpf("v=spf1 mx ~all", ["v=spf1 include:a.example ~all", "v=spf1 include:b.example ~all"]))
      .toEqual({ ok: true, value: "v=spf1 include:a.example include:b.example mx ~all", changed: true });
  });

  test("duplicates that end differently are reported, not guessed", () => {
    const merged = mergeSpf("v=spf1 mx ~all", ["v=spf1 include:a.example ~all", "v=spf1 include:b.example -all"]);
    expect(merged.ok).toBe(false);
  });

  test("order-sensitive and unsupported syntax is left for a person", () => {
    for (const existing of ["v=spf1 -ip4:192.0.2.1 mx ~all", "v=spf1 exists:%{i}.spf.example ~all", "v=spf1 ~all mx", "v=spf1 bogus ~all"]) {
      const merged = mergeSpf("v=spf1 mx ~all", [existing]);
      expect(merged.ok).toBe(false);
    }
  });

  test("a merge that would pass SPF's ten-lookup limit is refused", () => {
    const includes = Array.from({ length: 10 }, (_, n) => `include:s${n}.example`).join(" ");
    expect(mergeSpf("v=spf1 mx ~all", [`v=spf1 ${includes} ~all`]).ok).toBe(false);
  });

  test("a malformed profile SPF is reported as the profile's", () => {
    const merged = mergeSpf("v=spf1 ip4:not-an-address ~all", ["v=spf1 mx ~all"]);
    expect(merged.ok).toBe(false);
    if (!merged.ok) expect(merged.problem).toContain("profile");
  });
});
