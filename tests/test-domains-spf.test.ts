import { expect, test } from "bun:test";
import { mergeSpf } from "../addons/domains/spf";

const required = ["include:_spf.mail.example.net", "ip4:192.0.2.25", "ip6:2001:db8::25"];
const merge = (...existing: string[]) => mergeSpf(required, existing, "example.net");

test("new SPF uses the profile includes and mail IPs with softfail", () => {
  expect(merge()).toBe(`v=spf1 ${required.join(" ")} ~all`);
});

test("SPF retains existing senders, address mechanisms, networks, modifiers and hardfail", () => {
  const existing = "v=spf1 include:newsletter.example.org a mx:mx.example.org/24//64 ip4:198.51.100.0/24 ip6:2001:db8:1::/48 -all exp=explain.example.org";
  const result = merge(existing);
  expect(result).toBe(`v=spf1 include:newsletter.example.org a mx:mx.example.org/24//64 ip4:198.51.100.0/24 ip6:2001:db8:1::/48 ${required.join(" ")} -all exp=explain.example.org`);
  expect(merge(result)).toBe(result);
});

test("SPF preserves redirected and implicit fallback instead of adding an overriding all", () => {
  expect(merge("v=spf1 include:external.example.org redirect=_spf.policy.example.org")).toBe(`v=spf1 include:external.example.org ${required.join(" ")} redirect=_spf.policy.example.org`);
  expect(merge("v=spf1 a")).toBe(`v=spf1 a ${required.join(" ")}`);
  expect(merge("v=spf1")).toBe(`v=spf1 ${required.join(" ")}`);
});

test("SPF deduplicates explicit pass, DNS capitalization and trailing dots, and equivalent IP literals", () => {
  const result = merge("V=SPF1 +INCLUDE:_SPF.MAIL.EXAMPLE.NET. ip4:192.0.2.25/32 +IP6:2001:0db8:0:0:0:0:0:25/128 ?ALL");
  expect(result).toBe("v=spf1 +INCLUDE:_SPF.MAIL.EXAMPLE.NET. ip4:192.0.2.25/32 +IP6:2001:0db8:0:0:0:0:0:25/128 ?ALL");
  expect(merge(result)).toBe(result);
});

test("compatible duplicate SPF becomes one deterministic union without losing providers or modifiers", () => {
  const first = "v=spf1 include:news.example.org ~all exp=explain.example.org x-operator=keep";
  const second = "v=spf1 ip4:198.51.100.4 include:transactional.example.org ~all x-operator=keep exp=explain.example.org";
  const result = merge(first, second, first);
  expect(result).toContain("include:news.example.org");
  expect(result).toContain("include:transactional.example.org");
  expect(result).toContain("ip4:198.51.100.4");
  expect(result.match(/v=spf1/g)).toHaveLength(1);
  expect(result.match(/~all/g)).toHaveLength(1);
  expect(merge(second, first)).toBe(result);
  expect(merge(result)).toBe(result);
});

test.each([
  ["v=spf1 include:first.example.org -all", "v=spf1 include:second.example.org ~all"],
  ["v=spf1 redirect=first.example.org", "v=spf1 redirect=second.example.org"],
  ["v=spf1 a", "v=spf1 a ?all"],
  ["v=spf1 a -all exp=first.example.org", "v=spf1 a -all exp=second.example.org"],
])("conflicting SPF policies require a review: %s / %s", (first, second) => {
  expect(() => merge(first, second)).toThrow("conflicting ending policies or modifiers");
});

test.each([
  "v=spf1 -include:blocked.example.org ~all",
  "v=spf1 ?a ~all",
  "v=spf1 ip4:999.0.2.1 -all",
  "v=spf1 ip4:192.0.2.25/33 -all",
  "v=spf1 ip6:2001:db8::25/129 -all",
  "v=spf1 mx/33//64 -all",
  "v=spf1 exists: -all",
  "v=spf1 unknown:example.org -all",
  "v=spf1 include:%{d} ~all",
  "v=spf1 ~all include:ignored.example.org",
  "v=spf1 ~all -all",
  "v=spf1 redirect=first.example.org redirect=second.example.org",
  "v=spf1 include:external.example.org\n~all",
])("unsafe or malformed SPF is reported without guessing: %s", (existing) => {
  expect(() => merge(existing)).toThrow("SPF at example.net:");
});
