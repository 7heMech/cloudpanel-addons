// Hand-written helpers replaced by what Bun and the language already provide:
// the behaviour callers depend on is pinned here.
import { expect, test } from "bun:test";
import { transformVhost } from "../addons/cloudflare-ips/action";
import { dateStamp } from "../addons/instatic/action";
import { foldServerName, hostnameBoundary } from "../addons/stager/action";
import { provenancePolicy } from "../cli/release";

test("a snapshot's stamp is the local time date(1) would print", () => {
  // bun test runs in UTC without setting TZ, so date(1) is handed the zone Bun resolved.
  const instant = 1_767_323_045;
  const env = { ...process.env, TZ: Intl.DateTimeFormat().resolvedOptions().timeZone };
  const printed = Bun.spawnSync(["date", "-d", `@${instant}`, "+%Y%m%d%H%M%S"], { env }).stdout.toString().trim();
  expect(dateStamp(false, new Date(instant * 1000))).toBe(printed);
  expect(dateStamp(false, new Date(2026, 0, 2, 3, 4, 5))).toBe("20260102030405");
});

test("a domain's dots match only dots", () => {
  const boundary = hostnameBoundary("a.example.com");
  expect("x a.example.com y".replace(boundary, "$1B$2")).toBe("x B y");
  expect("x aXexampleYcom y".replace(boundary, "$1B$2")).toBe("x aXexampleYcom y");
  expect("x sub.a.example.com y".replace(boundary, "$1B$2")).toBe("x sub.a.example.com y");

  const body = "  server_name a.example.com www1.a.example.com;\n  server_name aXexample.com;";
  expect(foldServerName(body, "a.example.com", "server_name staged.example.com;")).toBe(
    "  server_name staged.example.com;\n  server_name aXexample.com;",
  );
});

test("Cloudflare IP Access finds the access log of exactly that site user", () => {
  const vhost = "server {\n  access_log /home/site.user/logs/nginx/access.log main;\n}\n";
  expect(transformVhost(vhost, "site.user", true)).toContain("access.log cloudflare;");
  // A dot in the user is literal, so another user's log is not taken for it.
  expect(() => transformVhost(vhost.replace("site.user", "siteXuser"), "site.user", true)).toThrow();
});

test("release provenance names exactly this repository's workflow at this tag", () => {
  const { subjectAlternativeName } = provenancePolicy("v2.0.0-rc.5");
  const san = (tag: string) => `https://github.com/7heMech/cloudpanel-addons/.github/workflows/release.yml@refs/tags/${tag}`;
  expect(subjectAlternativeName.test(san("v2.0.0-rc.5"))).toBe(true);
  expect(subjectAlternativeName.test(san("v2.0.0-rcX5"))).toBe(false);
  expect(subjectAlternativeName.test(san("v2.0.0-rc.50"))).toBe(false);
});
