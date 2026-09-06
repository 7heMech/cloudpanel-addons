// The dashboard's inline script is written inside a TypeScript template
// literal, so TypeScript consumes one level of backslash before the browser
// sees anything. A `\n` written for the browser arrives as a real newline, and
// inside a single-quoted JS string that is a SyntaxError -- which takes down
// the entire <script> element, not just the line that contains it.
//
// Nothing catches that: the page still renders, the server still answers, and
// only a browser console shows the error. This shipped, and every button on
// the dashboard was dead for four releases.
//
// The Function constructor compiles without executing, which is exactly the
// check that was missing.

import { CLIENT_JS, dashboardView } from "../addons/instatic/app/views";
import { isNewerThan } from "../addons/instatic/app/tags";
import type { InstanceView } from "../addons/instatic/app/service";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { siteUserFor } from "../cli/provision";
import { getNextAvailablePort } from "../lib/snapshot-reader";
import type { PanelSnapshot } from "../lib/snapshot-reader";

let failed = 0;
let passed = 0;

function check(label: string, cond: boolean, detail = ""): void {
  if (cond) { console.log(`  ok    ${label}`); passed++; }
  else { console.log(`  FAIL  ${label}${detail ? `: ${detail}` : ""}`); failed++; }
}

try {
  new Function(CLIENT_JS);
  check("the dashboard's inline script parses", true);
} catch (err) {
  check("the dashboard's inline script parses", false,
    err instanceof Error ? err.message : String(err));
}

// A bare newline inside a quoted string is the specific way this breaks, and
// pointing at it is more useful than "unexpected token" on a 4KB blob.
for (const [i, line] of CLIENT_JS.split("\n").entries()) {
  const quotes = (line.match(/'/g) ?? []).length;
  if (quotes % 2 === 1) {
    check(`line ${i + 1} of the client script closes its strings`, false, line.trim());
  }
}

// Port allocation reads a snapshot the root CLI rewrites on install and
// repair, so between reconciliation runs it does not know about instances
// created since. Without the caller's own ports, two creates in one window are
// handed the same number and the second dies on docker failing to bind it.
const snap = (allocated: number[]): PanelSnapshot => ({
  updatedAt: new Date().toISOString(),
  portRange: { min: 39000, max: 39999 },
  allocatedPorts: allocated,
  sites: [],
});

check("first port comes from the bottom of the range",
  getNextAvailablePort(snap([]), []) === 39000);
check("a port in the snapshot is skipped",
  getNextAvailablePort(snap([39000]), []) === 39001);
check("a port handed out since the snapshot is skipped",
  getNextAvailablePort(snap([39000]), [39001]) === 39002,
  `got ${getNextAvailablePort(snap([39000]), [39001])}`);
check("back-to-back creates do not collide",
  getNextAvailablePort(snap([39000, 39001]), [39002, 39003]) === 39004);

let exhausted = false;
try {
  getNextAvailablePort({ ...snap([]), portRange: { min: 39000, max: 39001 } }, [39000, 39001]);
} catch {
  exhausted = true;
}
check("an exhausted range throws rather than returning a used port", exhausted);

// The site-user scheme exists twice: once here in TypeScript and once in the
// wrapper, which is bash and cannot import it. Two implementations of one rule
// drift silently -- the manager would create a site under one name and the
// wrapper would look for another -- so the rule is pinned by running both.
const wrapper = readFileSync("addons/instatic/wrapper/clp-action-instatic", "utf-8");
const fn = wrapper.slice(
  wrapper.indexOf("site_user_for() {"),
  wrapper.indexOf("\n}", wrapper.indexOf("site_user_for() {")) + 2
);

const DOMAINS = [
  "demo.clp-stg.local",
  "addons.clp-stg.local",
  // Same first ten characters once punctuation is stripped. Under the schemes
  // this replaces, these two produced identical account names.
  "demo.clp-stg.local",
  "demo.clp-stg.example.com",
  "a.io",
  "UPPER.Example.COM",
];

const seen = new Map<string, string>();
for (const d of DOMAINS) {
  const ts = siteUserFor(d);
  const sh = execFileSync("bash", ["-c", `${fn}\nsite_user_for "$1"`, "_", d], { encoding: "utf-8" });
  check(`${d} names the same account in both implementations`, ts === sh, `ts=${ts} bash=${sh}`);
  check(`${d} is a valid Linux account name`, /^[a-z][a-z0-9-]{0,31}$/.test(ts), ts);
  const clash = seen.get(ts);
  if (clash && clash !== d) check(`${d} does not collide with ${clash}`, false, ts);
  seen.set(ts, d);
}

// Version comparison and the "this instance is behind" rendering.
//
// Auto-update is off by default because Instatic is pre-1.0, and that is only a
// defensible policy if the dashboard says when a release happened. It did not:
// the registry listing was fetched for the New Site page only, and the update
// dialog was a free-text box, so learning about 0.0.19 meant going to look at
// ghcr.io. These assert the comparison is by number rather than by string, and
// that a stale instance actually renders as stale.
console.log("== version awareness ==");

check("0.0.19 is newer than 0.0.18", isNewerThan("0.0.19", "0.0.18"));
check("0.0.18 is not newer than itself", !isNewerThan("0.0.18", "0.0.18"));
check("0.0.9 is not newer than 0.0.18", !isNewerThan("0.0.9", "0.0.18"));
check("0.0.18 is newer than 0.0.9 (numeric, not lexicographic)", isNewerThan("0.0.18", "0.0.9"));
check("1.0.0 is newer than 0.9.9", isNewerThan("1.0.0", "0.9.9"));
check("a non-version is never newer", !isNewerThan("latest", "0.0.18"));

const instance = (tag: string): InstanceView => ({
  domain: "demo.example.com", port: 39000, tag, container: `instatic-demo.example.com`,
  siteUser: "addon-demoexam-abc123", createdAt: "2026-01-01T00:00:00Z", state: "running",
});
const emptySnap: PanelSnapshot = {
  updatedAt: new Date().toISOString(), portRange: { min: 39000, max: 39999 },
  allocatedPorts: [], sites: [],
};

const live = (latest: string) => ({ tags: [latest], source: "registry" as const, latest });

const behindHtml = dashboardView([instance("0.0.17")], 39001, 0, emptySnap.sites, live("0.0.18"));
check("an out-of-date instance is badged", behindHtml.includes("0.0.18 available"));
check("and counted in the updates tile", /Updates available<\/div>\s*<div class="value"[^>]*>1</.test(behindHtml));

const currentHtml = dashboardView([instance("0.0.18")], 39001, 0, emptySnap.sites, live("0.0.18"));
check("a current instance is not badged", !currentHtml.includes("available</span>"));
check("and the tile reads zero", /Updates available<\/div>\s*<div class="value"[^>]*>0</.test(currentHtml));

// The offline list is one hardcoded version. Badging against it would invent
// updates that do not exist, and claim an instance is behind a version that may
// long since have been superseded.
const offlineHtml = dashboardView(
  [instance("0.0.17")], 39001, 0, emptySnap.sites,
  { tags: ["0.0.18"], source: "fallback", latest: null }
);
check("the offline fallback never claims an update", !offlineHtml.includes("0.0.18 available"));
check("and says the registry was unreachable", offlineHtml.includes("Could not reach ghcr.io"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
