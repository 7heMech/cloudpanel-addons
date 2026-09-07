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
import { BASE_CLIENT_JS } from "../lib/app-ui";
import { CLIENT_JS as STAGER_CLIENT_JS } from "../addons/stager/app/views";
import { expandTarget } from "../addons/stager/app/service";
import { isNewerThan } from "../addons/instatic/app/tags";
import type { InstanceView } from "../addons/instatic/app/service";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { describeAuthState, releaseArtifacts, siteUserFor, type SiteAuthState } from "../cli/provision";
import { ADDONS, ADDON_NAMES } from "../cli/paths";
import { getNextAvailablePort } from "../lib/snapshot-reader";
import type { PanelSnapshot } from "../lib/snapshot-reader";

let failed = 0;
let passed = 0;

function check(label: string, cond: boolean, detail = ""): void {
  if (cond) { console.log(`  ok    ${label}`); passed++; }
  else { console.log(`  FAIL  ${label}${detail ? `: ${detail}` : ""}`); failed++; }
}

// Checked as the browser receives it: the shared helpers and the addon's own
// script are concatenated into one <script>, so a stray escape in either one
// takes down every button on the page. Each addon is listed here; checking only
// the addon half would leave lib/app-ui.ts unverified.
const SCRIPTS: { name: string; source: string }[] = [
  { name: "instatic", source: BASE_CLIENT_JS + CLIENT_JS },
  { name: "stager", source: BASE_CLIENT_JS + STAGER_CLIENT_JS },
];

for (const { name, source } of SCRIPTS) {
  try {
    new Function(source);
    check(`the ${name} inline script parses`, true);
  } catch (err) {
    check(`the ${name} inline script parses`, false,
      err instanceof Error ? err.message : String(err));
  }

  // A bare newline inside a quoted string is the specific way this breaks, and
  // pointing at it is more useful than "unexpected token" on a 4KB blob.
  for (const [i, line] of source.split("\n").entries()) {
    const quotes = (line.match(/'/g) ?? []).length;
    if (quotes % 2 === 1) {
      check(`${name} client script line ${i + 1} closes its strings`, false, line.trim());
    }
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
function bashFunction(file: string, name: string): string {
  const src = readFileSync(file, "utf-8");
  const from = src.indexOf(`${name}() {`);
  if (from === -1) throw new Error(`${file} has no ${name}()`);
  return src.slice(from, src.indexOf("\n}", from) + 2);
}

// Every wrapper carries its own copy, because each is a standalone script that
// the operator is expected to read in one sitting. Checking only one of them
// would let the second drift, which is the same failure this test exists for.
const WRAPPERS = [
  "addons/instatic/wrapper/clp-action-instatic",
  "addons/stager/wrapper/clp-action-stager",
];

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

for (const file of WRAPPERS) {
  const fn = bashFunction(file, "site_user_for");
  const short = file.split("/").pop();
  const seen = new Map<string, string>();
  for (const d of DOMAINS) {
    const ts = siteUserFor(d);
    const sh = execFileSync("bash", ["-c", `${fn}\nsite_user_for "$1"`, "_", d], { encoding: "utf-8" });
    check(`${short}: ${d} names the same account as the TypeScript`, ts === sh, `ts=${ts} bash=${sh}`);
    check(`${short}: ${d} is a valid Linux account name`, /^[a-z][a-z0-9-]{0,31}$/.test(ts), ts);
    const clash = seen.get(ts);
    if (clash && clash !== d) check(`${short}: ${d} does not collide with ${clash}`, false, ts);
    seen.set(ts, d);
  }
}

// The staging database and its user are named from the target domain too, and
// they land in MySQL rather than /etc/passwd: 64 characters for a schema, 32
// for a user, and no dots or hyphens, which a domain has plenty of.
{
  const nameFn = bashFunction("addons/stager/wrapper/clp-action-stager", "db_name_for");
  const userFn = bashFunction("addons/stager/wrapper/clp-action-stager", "db_user_for");
  const names = new Map<string, string>();
  for (const d of DOMAINS) {
    const dbName = execFileSync("bash", ["-c", `${nameFn}\ndb_name_for "$1"`, "_", d], { encoding: "utf-8" });
    const dbUser = execFileSync("bash", ["-c", `${userFn}\ndb_user_for "$1"`, "_", d], { encoding: "utf-8" });
    check(`${d} yields a legal MySQL schema name`, /^[a-z][a-z0-9]{0,63}$/.test(dbName), dbName);
    check(`${d} yields a legal MySQL user name`, /^[a-z][a-z0-9]{0,31}$/.test(dbUser), dbUser);
    const clash = names.get(dbName);
    if (clash && clash !== d.toLowerCase()) check(`${d} does not collide with ${clash}`, false, dbName);
    names.set(dbName, d.toLowerCase());
  }
}

// The bare-label shorthand the original script accepted. It is expanded in the
// app rather than in the wrapper, which must reject its input rather than
// rewrite it, so this is the only place the rule is implemented.
check("a bare label becomes a subdomain of the source",
  expandTarget("stg", "example.com") === "stg.example.com");
check("a full hostname is left alone",
  expandTarget("staging.other.test", "example.com") === "staging.other.test");
check("case and surrounding space are normalised",
  expandTarget("  STG ", "example.com") === "stg.example.com");
check("a trailing dot is dropped rather than making an empty label",
  expandTarget("stg.example.com.", "example.com") === "stg.example.com");
check("an empty label expands to nothing rather than to the source",
  expandTarget("   ", "example.com") === "");

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

// How the manager's own site reports as protected.
//
// The README's first instruction is to put authentication in front of the
// manager, because it can create and delete CloudPanel sites -- and until now
// `status` said nothing about whether that was done. CloudPanel already has the
// feature, so this reads the panel's record rather than inventing a mechanism;
// these pin the four states apart, including the one a real box was found in.
console.log("== site protection ==");

const auth = (o: Partial<SiteAuthState>): SiteAuthState =>
  ({ panelManaged: false, active: false, ipAllowlist: false, vhostOnly: false, ...o });

check("panel-managed and on reads as protected",
  describeAuthState(auth({ panelManaged: true, active: true })).startsWith("yes, CloudPanel Basic Auth"));
check("an IP allowlist is mentioned when present",
  describeAuthState(auth({ panelManaged: true, active: true, ipAllowlist: true })).includes("IP allowlist"));
check("configured but switched off is NOT protected",
  describeAuthState(auth({ panelManaged: true, active: false })).startsWith("NO"));
check("a vhost-only edit counts as protected but is called out",
  /^yes, but via a vhost edit/.test(describeAuthState(auth({ vhostOnly: true, active: true }))));
check("nothing at all is NOT protected",
  describeAuthState(auth({})).startsWith("NO"));


console.log("\n== a release tree serves every installed addon ==");

// Installing a second addon used to fetch only that addon's artifacts, write
// them into a new release directory and move `current` onto it -- which took the
// first addon's app binary out from under its own unit. The service had been
// running for weeks and the only symptom was status=203/EXEC.
{
  const CLI = "clp-addons-linux-x64";
  const all = ADDON_NAMES.map((n) => ADDONS[n]!);
  const names = releaseArtifacts(all, CLI);

  check("the CLI is always in the set", names.includes(CLI));
  for (const spec of all) {
    check(`${spec.name}'s app binary is in the set`, names.includes(spec.appArtifact));
    check(`${spec.name}'s wrapper is in the set`, names.includes(spec.wrapperArtifact));
  }
  check("nothing is listed twice", names.length === new Set(names).size, names.join(", "));

  // The shape of the bug: one addon's set omits the other's binary, which is
  // why the caller has to pass every installed addon rather than just its own.
  const one = releaseArtifacts([all[0]!], CLI);
  const others = all.slice(1);
  if (others.length > 0) {
    check("one addon's set does not cover another's",
      others.every((o) => !one.includes(o.appArtifact)));
  }
}


console.log("\n== the vhost comparison ignores what CloudPanel generates ==");

// site.vhost_template keeps CloudPanel's placeholders and only the hostnames are
// concrete, so two things in it are generated rather than chosen: the
// http->https redirect block, which is prepended only for an apex or www
// hostname, and the shape of the server_name line, which differs between the
// two. Cloning example.com into stg.example.com therefore differs in both, and
// reporting that as a hand edit would fire the note on every ordinary clone.
{
  const W = "addons/stager/wrapper/clp-action-stager";
  const shapeFn = ["strip_redirect_block", "fold_server_name", "vhost_shape"]
    .map((n) => bashFunction(W, n))
    .join("\n");
  const shape = (body: string, domain: string) =>
    execFileSync("bash", ["-c", `${shapeFn}\nvhost_shape "$1" "$2"`, "_", body, domain],
      { encoding: "utf-8" });

  const REDIRECT = [
    "server {",
    "  listen 443 ssl;",
    "  {{ssl_certificate}}",
    "  server_name www.example.com;",
    "  return 301 https://example.com$request_uri;",
    "}",
    "",
  ].join("\n");
  const MAIN = (nameLine: string, extra = "") => [
    "server {",
    "  listen 443 ssl;",
    `  ${nameLine}`,
    "  {{root}}",
    ...(extra ? [`  ${extra}`] : []),
    "  location / {",
    "    {{php_fpm_port}}",
    "  }",
    "}",
  ].join("\n");

  const apex = shape(REDIRECT + MAIN("server_name example.com www1.example.com;"), "example.com");
  const sub = shape(MAIN("server_name stg.example.com;"), "stg.example.com");
  check("an apex site and a subdomain clone have the same shape",
    apex === sub, `apex=${JSON.stringify(apex)} sub=${JSON.stringify(sub)}`);

  const edited = shape(
    REDIRECT + MAIN("server_name example.com www1.example.com;", 'add_header X-Frame-Options "SAMEORIGIN";'),
    "example.com");
  check("an added directive still reads as an edit", edited !== apex);

  const widened = shape(MAIN("server_name stg.example.com *.stg.example.com;"), "stg.example.com");
  check("a hand-widened server_name still reads as an edit", widened !== sub);

  check("the redirect block is dropped, not the whole first block",
    apex.includes("{{root}}") && apex.includes("{{php_fpm_port}}"), apex);
  check("a redirect target does not survive into the shape",
    !apex.includes("return 301"), apex);
}

console.log("\n== a carried-over vhost may never name the source site ==");

// The dangerous outcome is a clone that answers for the site it was cloned
// from: two nginx server blocks claiming one server_name, where the other one
// is production. CloudPanel's own validator refuses a template with no
// {{server_name}}, which covers part of it; these are the checks it does not
// make, run before it is asked.
{
  const W = "addons/stager/wrapper/clp-action-stager";
  const gateFn = [bashFunction(W, "hostname_boundary"), bashFunction(W, "vhost_template_ok")].join("\n");
  const gate = (body: string) => {
    const f = `/tmp/clp-stager-gate-test-${process.pid}.tpl`;
    writeFileSync(f, body);
    try {
      const out = execFileSync("bash", ["-c",
        `${gateFn}\nif vhost_template_ok "$1" "$2" "$3"; then echo PASS; else echo "REJECT: $VHOST_REJECT"; fi`,
        "_", f, "example.com", "stg.example.com"], { encoding: "utf-8" });
      return out.trim();
    } finally {
      rmSync(f, { force: true });
    }
  };

  const ok = ["server {", "  {{server_name}}", "  {{root}}", "}"].join("\n");
  check("a template naming only the placeholder is accepted", gate(ok) === "PASS", gate(ok));

  const leaked = ["server {", "  {{server_name}}", "  # see https://example.com/docs", "}"].join("\n");
  check("the source hostname surviving anywhere is refused",
    gate(leaked).startsWith("REJECT"), gate(leaked));

  const noPlaceholder = ["server {", "  server_name stg.example.com *.stg.example.com;", "}"].join("\n");
  check("a template with no {{server_name}} is refused before the panel sees it",
    gate(noPlaceholder).startsWith("REJECT"), gate(noPlaceholder));

  // The maksimasenov.com shape: the hand edit is the server_name line itself.
  const foreign = ["server {", "  {{server_name}}", "  server_name other.test;", "}"].join("\n");
  check("a server_name outside the target is refused",
    gate(foreign).startsWith("REJECT"), gate(foreign));

  const wildcard = ["server {", "  {{server_name}}", "  server_name *.stg.example.com;", "}"].join("\n");
  check("a wildcard under the target is allowed", gate(wildcard) === "PASS", gate(wildcard));

  const sub = ["server {", "  {{server_name}}", "  server_name a.stg.example.com;", "}"].join("\n");
  check("a subdomain of the target is allowed", gate(sub) === "PASS", gate(sub));

  // stg.example.com is a subdomain of example.com, so a naive "endsWith the
  // source" test would pass this. It must be judged against the target.
  const parent = ["server {", "  {{server_name}}", "  server_name evil.example.com;", "}"].join("\n");
  check("a sibling under the source's domain is refused",
    gate(parent).startsWith("REJECT"), gate(parent));
}

console.log("\n== building the carried-over template ==");

{
  const W = "addons/stager/wrapper/clp-action-stager";
  const fns = ["hostname_boundary", "strip_redirect_block", "fold_server_name", "vhost_template_body"]
    .map((n) => bashFunction(W, n))
    .join("\n");
  // vhost_template_body rather than build_vhost_template: the latter stages the
  // result as root:clp, so a test that drove it needed both root and a clp
  // group. That passed on the CloudPanel box and failed in CI, which is the
  // whole reason the text transform is now its own function.
  const build = (body: string, source: string, target: string) => {
    const bodyFile = `/tmp/clp-stager-body-${process.pid}`;
    writeFileSync(bodyFile, body);
    try {
      return execFileSync("bash", ["-c",
        `vhost_of() { cat "${bodyFile}"; }\n${fns}\nvhost_template_body "$1" "$2"`,
        "_", source, target], { encoding: "utf-8" });
    } finally {
      rmSync(bodyFile, { force: true });
    }
  };

  const SOURCE = [
    "server {",
    "  listen 443 ssl;",
    "  server_name example.com www1.example.com;",
    "  {{root}}",
    '  add_header Link "<https://example.com/api>; rel=preconnect";',
    '  add_header X-Unrelated "https://notexample.com/keep";',
    "}",
  ].join("\n");

  const out = build(SOURCE, "example.com", "stg.example.com");

  // First, because the two checks phrased as absences are both satisfied by an
  // empty string. When this function broke, one of them still reported ok.
  check("the builder produced a template at all", out.trim().length > 0, JSON.stringify(out));
  check("the generated server_name becomes the placeholder again",
    out.includes("{{server_name}}") && !out.includes("server_name example.com"), out);
  check("a hand edit naming the source is rewritten to the target",
    out.includes("<https://stg.example.com/api>"), out);
  check("a hostname that merely ends in the source is left alone",
    out.includes("https://notexample.com/keep"), out);
  check("the clone's own name is not mangled into a double prefix",
    !out.includes("stg.stg.example.com"), out);
  check("CloudPanel's other placeholders survive untouched", out.includes("{{root}}"), out);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
