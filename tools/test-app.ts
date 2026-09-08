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
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { cachedArtifact } from "../cli/release";
import { describeAuthState, releaseArtifacts, siteUserFor, type SiteAuthState } from "../cli/provision";
import { ADDONS, ADDON_NAMES, CLI_ARTIFACT } from "../cli/paths";
import { mountPath, splitMount } from "../lib/mount";
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
// first addon's binary out from under its own unit. The service had been running
// for weeks and the only symptom was status=203/EXEC. The app binaries have
// since merged into the one CLI artifact, but each addon still has a wrapper of
// its own in the release tree, so the same obligation applies to those.
{
  const all = ADDON_NAMES.map((n) => ADDONS[n]!);
  const names = releaseArtifacts(all);

  check("the one binary is always in the set", names.includes(CLI_ARTIFACT));
  for (const spec of all) {
    check(`${spec.name}'s wrapper is in the set`, names.includes(spec.wrapperArtifact));
  }
  check("nothing is listed twice", names.length === new Set(names).size, names.join(", "));

  // One binary rather than one per addon, which is the whole point of the merge:
  // the set grows by a wrapper per addon, not by another 77 MB of Bun runtime.
  check("no per-addon app binary is expected any more",
    names.filter((n) => n.endsWith("-linux-x64")).length === 1, names.join(", "));

  // The shape of the original bug: one addon's set omits the other's wrapper,
  // which is why the caller passes every installed addon rather than just its own.
  const one = releaseArtifacts([all[0]!]);
  const others = all.slice(1);
  if (others.length > 0) {
    check("one addon's set does not cover another's",
      others.every((o) => !one.includes(o.wrapperArtifact)));
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
  const gateFn = ["hostname_boundary", "server_name_hosts", "vhost_body_ok", "vhost_template_ok"]
    .map((n) => bashFunction(W, n))
    .join("\n");
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

console.log("\n== an application name may never reach SQL as text ==");

// `site.application` is the one value in the panel write that does not come
// from this addon. It is the *source* site's application name, and CloudPanel
// validates nothing on the way to it: VhostTemplateAddCommand stores
// `trim($input->getOption("name"))` as given, SiteAddPhpCommand copies that name
// into site.application verbatim, and /etc/sudoers.d/cloudpanel lets every
// local account run clpctlWrapper. Interpolating it was a SQL injection that
// escalated to an arbitrary root write, because the read-back runs `sqlite3
// -readonly` as root and writefile() is compiled in even there.
//
// Two things are pinned. The predicate, driven as the real bash function; and
// the structural property that the statement holds no application text at all,
// which is what makes the predicate a second line of defence rather than the
// only one.
{
  const W = "addons/stager/wrapper/clp-action-stager";
  const fn = bashFunction(W, "application_ok");
  const ok = (name: string) =>
    execFileSync("bash", ["-c", `${fn}\nif application_ok "$1"; then echo YES; else echo NO; fi`, "_", name],
      { encoding: "utf-8" }).trim() === "YES";

  // Every stock template name on this box, plus the two site.application values
  // that force a character beyond [A-Za-z0-9]: PrestaShop 1.7 the dot, and the
  // stager's own throwaway template names the hyphen and the digits.
  const REAL = [
    "Generic", "WordPress", "Static", "ReverseProxy", "Nodejs", "Python", "WHMCS",
    "WooCommerce", "Laminas", "CakePHP 5", "CodeIgniter 4", "Contao 4", "Drupal 11",
    "Joomla 6", "Laravel 13", "Magento 2", "Matomo 5", "Mautic 7", "Moodle 5",
    "Neos 9", "Nextcloud 34", "OwnCloud 12", "PrestaShop 1.7", "Shopware 6",
    "Slim 4", "Symfony 8", "TYPO3 14", "Yii 2",
    "clp-stager-src2", "clp-stager-20260907T090213Z-56f3aa", "My_App",
  ];
  for (const name of REAL) {
    check(`a real application name is accepted: ${name}`, ok(name));
  }

  // The reproduced payloads. The first rewrote site.user to root; the second
  // reached an unrelated row; the third created a root-owned file through
  // writefile() under -readonly.
  const PAYLOADS = [
    "Generic', user = 'root",
    "Generic' WHERE 1=1; UPDATE site SET user = 'root",
    "Generic' AND 1=1; SELECT writefile('/tmp/x','ALL ALL=(ALL) NOPASSWD: ALL'); SELECT '1",
    "Generic'",
    'Generic"',
    "Generic;",
    "Generic--",
    "Generic\nWordPress",
    "Generic`id`",
    "Generic$(id)",
    "",
    " Generic",
    "Generic ",
    "-Generic",
    "../../etc/passwd",
    "x".repeat(65),
  ];
  for (const name of PAYLOADS) {
    check(`refused: ${JSON.stringify(name)}`, !ok(name));
  }

  // The predicate is not the whole answer, and this is the half that would
  // survive someone adding a caller that forgets to call it. Neither statement
  // may contain the application as text: it goes in through readfile(), the same
  // way the nginx body does.
  const src = readFileSync(W, "utf-8");
  const stmt = src.slice(src.indexOf("panel_write_site() {"));
  const body = stmt.slice(0, stmt.indexOf("\n}\n") + 2);
  check("the panel write never interpolates the application name",
    !body.includes("'${application}'") && !body.includes('${application}"')
    && body.includes("readfile('${app_file}')"),
    body.split("\n").filter((l) => l.includes("application")).join(" | "));
  // Three: the UPDATE, and the read-back in each of its two forms -- with a
  // carried vhost and with only the application to put back.
  check("and neither form of the read-back does either",
    (body.match(/application = CAST\(readfile/g) ?? []).length === 3,
    body.split("\n").filter((l) => l.includes("application =")).join(" | "));

  // vhost_template_exists put the same value in a query and doubled the quotes
  // in it, which is sanitizing rather than rejecting. It must now refuse.
  const existsFn = [bashFunction(W, "application_ok"), bashFunction(W, "vhost_template_exists")].join("\n");
  const asked = execFileSync("bash", ["-c",
    `${existsFn}\npanel_query() { printf 'ASKED: %s\\n' "$1" >&2; echo 1; }\n` +
    `if vhost_template_exists "$1"; then echo YES; else echo NO; fi`,
    "_", "Generic', user = 'root"], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  check("a template name that fails the predicate is reported missing, not escaped",
    asked === "NO", asked);
  check("and no query is made for it at all",
    !execFileSync("bash", ["-c",
      `${existsFn}\npanel_query() { printf 'ASKED' >&2; echo 1; }\n` +
      `vhost_template_exists "$1" 2>&1 || true`,
      "_", "Generic', user = 'root"], { encoding: "utf-8" }).includes("ASKED"));
  check("a legitimate name is still queried",
    execFileSync("bash", ["-c",
      `${existsFn}\npanel_query() { printf 'ASKED' >&2; echo 1; }\n` +
      `vhost_template_exists "$1" 2>&1 || true`,
      "_", "WordPress"], { encoding: "utf-8" }).includes("ASKED"));
}

console.log("\n== learning what CloudPanel substituted into a vhost ==");

// site:add:php is the only site:add verb with a --vhostTemplate option, so for
// a static or reverse-proxy clone the source's config can only be carried by
// writing the panel record and rendering the file. Rendering it means knowing
// what this panel put in each {{placeholder}} -- learned by comparing the pair
// the panel wrote for the clone a moment ago, rather than by reimplementing a
// processor list a panel update can change.
//
// A wrong value here is a wrong nginx config, so what these actually pin is the
// refusals: the walk must consume the rendered file exactly to EOF, and a
// placeholder appearing twice must resolve identically both times.
{
  const W = "addons/stager/wrapper/clp-action-stager";
  const MAP_FNS = ["learn_vhost_map", "render_vhost_body"]
    .map((n) => bashFunction(W, n))
    .join("\n");
  // The array and the reject variable are file-level state the two functions
  // share, so a test that drove them without both would be driving something
  // that cannot exist.
  const MAP_PREAMBLE = 'declare -A VHOST_MAP=()\nVHOST_MAP_REJECT=""\n' + MAP_FNS;

  // NUL-separated because the values are nginx config: {{php_settings}} is nine
  // lines and {{settings}} is empty, and any line- or field-based encoding would
  // lose one of them.
  const DUMP = [
    'if learn_vhost_map "$1" "$2"; then',
    '  for k in "${!VHOST_MAP[@]}"; do printf \'%s\\0%s\\0\' "$k" "${VHOST_MAP[$k]}"; done',
    "else",
    "  printf 'REJECT\\0%s\\0' \"$VHOST_MAP_REJECT\"",
    "fi",
  ].join("\n");

  const learn = (stored: string, rendered: string): Map<string, string> => {
    const d = mkdtempSync(`${tmpdir()}/clp-stager-map-`);
    try {
      writeFileSync(`${d}/stored`, stored);
      writeFileSync(`${d}/rendered`, rendered);
      const out = execFileSync("bash", ["-c", `${MAP_PREAMBLE}\n${DUMP}`, "_", `${d}/stored`, `${d}/rendered`],
        { encoding: "utf-8" });
      const parts = out.split("\0");
      const map = new Map<string, string>();
      for (let i = 0; i + 1 < parts.length; i += 2) map.set(parts[i]!, parts[i + 1]!);
      return map;
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };

  const render = (body: string, stored: string, rendered: string): string => {
    const d = mkdtempSync(`${tmpdir()}/clp-stager-render-`);
    try {
      writeFileSync(`${d}/stored`, stored);
      writeFileSync(`${d}/rendered`, rendered);
      return execFileSync("bash", ["-c",
        `${MAP_PREAMBLE}\nlearn_vhost_map "$1" "$2" || { printf 'LEARN-REJECT: %s' "$VHOST_MAP_REJECT"; exit 0; }\n` +
        `render_vhost_body "$3" || printf 'RENDER-REJECT: %s' "$VHOST_MAP_REJECT"`,
        "_", `${d}/stored`, `${d}/rendered`, body], { encoding: "utf-8" });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };

  // Modelled line for line on a real stored/rendered pair off a CloudPanel
  // 2.5.4 box: a placeholder on its own line, one inline inside a directive,
  // one appearing twice, one expanding to several lines and one to nothing.
  const STORED = [
    "server {",
    "  {{ssl_certificate}}",
    "  server_name stg.example.com;",
    "  {{root}}",
    "",
    "  {{nginx_access_log}}",
    "",
    "  {{settings}}",
    "",
    "  location / {",
    "    {{root}}",
    "  }",
    "",
    "  location ~ .php$ {",
    "    fastcgi_pass 127.0.0.1:{{php_fpm_port}};",
    '    fastcgi_param PHP_VALUE "{{php_settings}}";',
    "  }",
    "}",
  ].join("\n");

  const ROOT = "root /home/addon-stgexamp-ab12cd/htdocs/stg.example.com;";
  const RENDERED = [
    "server {",
    "  ssl_certificate /etc/nginx/ssl-certificates/stg.example.com.crt;",
    "  server_name stg.example.com;",
    `  ${ROOT}`,
    "",
    "  access_log /home/addon-stgexamp-ab12cd/logs/nginx/access.log main;",
    "",
    "  ",
    "",
    "  location / {",
    `    ${ROOT}`,
    "  }",
    "",
    "  location ~ .php$ {",
    "    fastcgi_pass 127.0.0.1:18031;",
    '    fastcgi_param PHP_VALUE "',
    "memory_limit=512M;",
    'display_errors=off;";',
    "  }",
    "}",
    // The panel writes the rendered template plus one newline the template
    // itself does not carry. Every site on the box measured this way.
    "",
  ].join("\n");

  const map = learn(STORED, RENDERED);
  check("the walk recovers every placeholder", map.size === 6 && !map.has("REJECT"),
    [...map.keys()].join(", "));
  check("a placeholder on its own line", map.get("ssl_certificate") ===
    "ssl_certificate /etc/nginx/ssl-certificates/stg.example.com.crt;", map.get("ssl_certificate"));
  check("one inline inside a directive", map.get("php_fpm_port") === "18031", map.get("php_fpm_port"));
  check("one that appears twice resolves once", map.get("root") === ROOT, map.get("root"));
  check("one that expands to several lines",
    map.get("php_settings") === "\nmemory_limit=512M;\ndisplay_errors=off;",
    JSON.stringify(map.get("php_settings")));
  check("one that expands to nothing", map.get("settings") === "", JSON.stringify(map.get("settings")));

  // The walk is only sound because it fails rather than guesses. Both of these
  // would otherwise produce a plausible-looking map and a wrong nginx config.
  const trailing = learn(STORED, `${RENDERED}# something the template does not have\n`);
  check("a walk that does not consume the file is refused",
    trailing.get("REJECT") !== undefined, [...trailing.keys()].join(", "));

  const inconsistent = learn(STORED, RENDERED.replace(`    ${ROOT}`, "    root /somewhere/else;"));
  check("a placeholder that would resolve two ways is refused",
    inconsistent.get("REJECT") !== undefined, [...inconsistent.keys()].join(", "));
  check("and says which placeholder", (inconsistent.get("REJECT") ?? "").includes("{{root}}"),
    inconsistent.get("REJECT"));

  // Rendering the stored body back through its own learned map must reproduce
  // the file it was learned from. If that does not hold, nothing built on the
  // map can be trusted either.
  check("the map round-trips the body it was learned from",
    `${render(STORED, STORED, RENDERED)}\n` === RENDERED);

  // An unknown placeholder is a refusal, never an empty string. CloudPanel's own
  // removeEmptyPlaceholders() blanks leftovers; copying that here would turn an
  // unknown {{root}} into a server block with no document root, which nginx
  // accepts and serves as the wrong thing.
  const unknown = render(STORED.replace("{{root}}", "{{nodejs_proxy_pass}}"), STORED, RENDERED);
  check("a placeholder the panel did not use is refused, not blanked",
    unknown.startsWith("RENDER-REJECT") && unknown.includes("nodejs_proxy_pass"), unknown);

  // The column's convention is not the file's, and the difference is load
  // bearing. Every panel-written site.vhost_template on this box ends with `}`
  // -- all 31 rows measured -- while the file it renders to ends with exactly
  // one newline, and the walk above compensates for that. A body stored with a
  // trailing newline is therefore a body this addon cannot read back: the clone
  // this implementation first produced, stg.demo.clp-stg.local, stored 10 as its
  // last codepoint and refused to be cloned again.
  const withNewline = learn(`${STORED}\n`, RENDERED);
  check("a stored body carrying a trailing newline is refused",
    withNewline.get("REJECT") !== undefined, [...withNewline.keys()].join(", "));
  check("which is what a re-clone of this addon's own output used to hit",
    (withNewline.get("REJECT") ?? "").includes("does not end with the text after"),
    withNewline.get("REJECT"));

  // So the installer has to stage the two halves the way the panel writes them.
  // Read out of the wrapper rather than asserted about a string, because the two
  // writes sit twenty lines apart and drifting apart again is the failure.
  {
    const src = readFileSync("addons/stager/wrapper/clp-action-stager", "utf-8");
    const from = src.indexOf("carry_vhost() {");
    const fn = src.slice(from, src.indexOf("\n}\n", from));
    check("the carried body is staged without a trailing newline",
      fn.includes(`printf '%s' "$composed" > "$body"`) && !fn.includes(`printf '%s\\n' "$composed"`),
      fn.split("\n").filter((l) => l.includes('> "$body"')).join(" | "));
    check("and the rendered file is staged with one",
      fn.includes(`printf '\\n' >> "$rendered"`),
      fn.split("\n").filter((l) => l.includes("$rendered")).join(" | "));

    // Every failure that can run after the UPDATE has to put the row back as
    // well as the file, and that is more branches than it looks:
    // panel_update_site returning 1 from its *read-back* means the UPDATE
    // already ran. Leaving the row alone there is the one disagreement the
    // file-first ordering exists to prevent -- the panel regenerates the file
    // from the row -- reached by the failure path instead of the success path.
    const calls = fn.split("\n").map((l) => l.trim())
      .filter((l) => l === "carry_restore" || l === "carry_restore row");
    const writeAt = fn.indexOf('panel_update_site "$target" "$type" "$application" "$body"');
    const after = fn.slice(writeAt).split("\n").map((l) => l.trim()).filter((l) => l.startsWith("carry_restore"));
    check("every restore that can follow the panel write restores the row too",
      writeAt !== -1 && after.length === 2 && after.every((l) => l === "carry_restore row"),
      after.join(" | "));
    check("and the ones that cannot do not touch the row",
      calls.length === 4 && calls.filter((l) => l === "carry_restore").length === 2,
      calls.join(" | "));
  }
}

console.log("\n== composing a clone's vhost from its source's ==");

// Four things separate a source's stored body from its clone's, and every one
// of them is something CloudPanel generated rather than something an operator
// chose: the http->https redirect block, which only an apex or www hostname
// earns; the shape of the server_name line; any hand edit that names the source
// hostname; and nothing else at all.
{
  const W = "addons/stager/wrapper/clp-action-stager";
  const fns = ["hostname_boundary", "strip_redirect_block", "take_redirect_block",
               "fold_server_name", "generated_server_name", "compose_vhost_body"]
    .map((n) => bashFunction(W, n))
    .join("\n");

  const compose = (bodies: Record<string, string>, source: string, target: string): string => {
    const d = mkdtempSync(`${tmpdir()}/clp-stager-compose-`);
    try {
      for (const [domain, body] of Object.entries(bodies)) writeFileSync(`${d}/${domain}`, body);
      // vhost_of is the one panel read compose_vhost_body makes, so stubbing it
      // is what lets the transform be driven on any machine -- the same reason
      // vhost_template_body was split out of build_vhost_template.
      return execFileSync("bash", ["-c",
        `vhost_of() { cat "${d}/$1"; }\nVHOST_COMPOSE_REJECT=""\n${fns}\n` +
        `compose_vhost_body "$1" "$2" || printf 'REJECT: %s' "$VHOST_COMPOSE_REJECT"`,
        "_", source, target], { encoding: "utf-8" });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };

  // A static site's stored body, apex, with the redirect block CloudPanel
  // prepends for one, and two hand edits: one naming the source hostname and
  // one naming a hostname that merely ends in it.
  const STATIC_SOURCE = [
    "server {",
    "  {{ssl_certificate}}",
    "  server_name www.example.com;",
    "  return 301 https://example.com$request_uri;",
    "}",
    "",
    "server {",
    "  {{ssl_certificate}}",
    "  server_name example.com www1.example.com;",
    "  {{root}}",
    '  add_header Content-Security-Policy "default-src https://example.com";',
    '  add_header X-Unrelated "https://notexample.com/keep";',
    "  index index.html;",
    "}",
  ].join("\n");

  const SUB_TARGET = [
    "server {",
    "  {{ssl_certificate}}",
    "  server_name stg.example.com;",
    "  {{root}}",
    "  index index.html;",
    "}",
  ].join("\n");

  const out = compose(
    { "example.com": STATIC_SOURCE, "stg.example.com": SUB_TARGET },
    "example.com", "stg.example.com"
  );

  // First, because two of the checks below are phrased as absences and an empty
  // string satisfies both.
  check("composition produced a body at all", out.trim().length > 0, JSON.stringify(out));
  check("the source's redirect block is dropped", !out.includes("return 301"), out);
  check("the clone's own server_name replaces the source's",
    out.includes("server_name stg.example.com;") && !out.includes("server_name example.com"), out);
  check("a hand edit naming the source is rewritten to the target",
    out.includes('default-src https://stg.example.com'), out);
  check("a hostname that merely ends in the source is left alone",
    out.includes("https://notexample.com/keep"), out);
  check("the clone's own name is not mangled into a double prefix",
    !out.includes("stg.stg.example.com"), out);
  check("CloudPanel's placeholders survive untouched",
    out.includes("{{root}}") && out.includes("{{ssl_certificate}}"), out);

  // The mirror case: the clone is itself an apex, so it earns a redirect block
  // of its own, taken from what the panel wrote for it rather than from the
  // source's.
  const APEX_TARGET = [
    "server {",
    "  {{ssl_certificate}}",
    "  server_name www.staging.test;",
    "  return 301 https://staging.test$request_uri;",
    "}",
    "",
    "server {",
    "  {{ssl_certificate}}",
    "  server_name staging.test www1.staging.test;",
    "  {{root}}",
    "  index index.html;",
    "}",
  ].join("\n");

  const apex = compose(
    { "example.com": STATIC_SOURCE, "staging.test": APEX_TARGET },
    "example.com", "staging.test"
  );
  check("an apex clone gets its own redirect block",
    apex.includes("return 301 https://staging.test$request_uri;")
    && !apex.includes("https://example.com$request_uri"), apex);
  check("and only one of them", (apex.match(/return 301/g) ?? []).length === 1, apex);
  check("the apex clone's two-name server_name is used",
    apex.includes("server_name staging.test www1.staging.test;"), apex);
}

console.log("\n== the fallback carries vhosts the template route has to refuse ==");

// vhost_body_ok is vhost_template_ok without the {{server_name}} requirement,
// which exists only because clpctl's vhost-template:add demands the placeholder.
// The fallback does not go through that verb, so it can carry a source whose
// server_name line is itself the hand edit -- the one case docs/DECISIONS.md
// listed as a known gap. What it must still refuse is a clone that would answer
// for the site it was cloned from.
{
  const W = "addons/stager/wrapper/clp-action-stager";
  const fns = ["hostname_boundary", "vhost_body_ok", "server_name_hosts"].map((n) => bashFunction(W, n)).join("\n");
  const gate = (body: string) => {
    const d = mkdtempSync(`${tmpdir()}/clp-stager-body-gate-`);
    try {
      writeFileSync(`${d}/body`, body);
      return execFileSync("bash", ["-c",
        `VHOST_REJECT=""\n${fns}\nif vhost_body_ok "$1" "$2" "$3"; then echo PASS; else echo "REJECT: $VHOST_REJECT"; fi`,
        "_", `${d}/body`, "example.com", "stg.example.com"], { encoding: "utf-8" }).trim();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };

  const handEdited = ["server {", "  server_name stg.example.com *.stg.example.com;", "  {{root}}", "}"].join("\n");
  check("a hand-edited server_name naming the target is accepted",
    gate(handEdited) === "PASS", gate(handEdited));

  const noPlaceholder = ["server {", "  server_name stg.example.com;", "}"].join("\n");
  check("and it needs no {{server_name}} placeholder", gate(noPlaceholder) === "PASS", gate(noPlaceholder));

  const foreign = ["server {", "  server_name other.test;", "}"].join("\n");
  check("a server_name outside the target is still refused",
    gate(foreign).startsWith("REJECT"), gate(foreign));

  // stg.example.com is a subdomain of example.com, so a naive "ends with the
  // source" test would pass this. It is judged against the target.
  const sibling = ["server {", "  server_name evil.example.com;", "}"].join("\n");
  check("a sibling under the source's domain is refused",
    gate(sibling).startsWith("REJECT"), gate(sibling));

  const leaked = ["server {", "  server_name stg.example.com;", "  # see https://example.com/docs", "}"].join("\n");
  check("the source hostname surviving anywhere is refused",
    gate(leaked).startsWith("REJECT"), gate(leaked));

  // Every one of these was ACCEPTED before the gate stopped selecting lines
  // with `grep -E '^[[:space:]]*server_name '`, which demands a literal space
  // at a line start and compares case-sensitively. Driven end to end through the
  // real compose_vhost_body for renaissance.bg -> stg.renaissance.bg, the first
  // two gave a clone that claims the production apex and every subdomain of it.
  //
  // nginx -t does not catch any of them -- a duplicate server_name is a warning
  // and exits 0 -- and sites-enabled/*.conf glob order decides which block
  // wins, so a staging name that sorts first takes production's traffic.
  const HOSTILE: [string, string][] = [
    ["a tab instead of a space, in upper case",
      "server {\n  server_name\tEXAMPLE.COM;\n  {{root}}\n}"],
    ["a tab and a wildcard over the source",
      "server {\n  server_name\t*.example.com;\n  {{root}}\n}"],
    ["a wildcard over the source, spaced normally",
      "server {\n  server_name *.example.com;\n  {{root}}\n}"],
    ["a list whose second line is hostile",
      "server {\n  server_name stg.example.com\n                victim-production.test;\n  {{root}}\n}"],
    ["a value on its own line",
      "server {\n  server_name\n    victim-production.test;\n  {{root}}\n}"],
    ["sharing a line with another directive",
      "server {\n  listen 8443; server_name victim-production.test;\n  {{root}}\n}"],
    ["several spaces before the value",
      "server {\n  server_name    victim-production.test;\n  {{root}}\n}"],
    ["a catch-all default server",
      "server {\n  server_name _;\n  {{root}}\n}"],
    ["a regular expression server_name",
      "server {\n  server_name ~^.+$;\n  {{root}}\n}"],
    ["the target in upper case beside a hostile name",
      "server {\n  server_name STG.EXAMPLE.COM VICTIM-PRODUCTION.TEST;\n  {{root}}\n}"],
    ["a second server block further down the file",
      "server {\n  server_name stg.example.com;\n  {{root}}\n}\n\nserver {\n  server_name victim-production.test;\n}"],
  ];
  for (const [label, body] of HOSTILE) {
    check(`refused: ${label}`, gate(body).startsWith("REJECT"), `${JSON.stringify(body)} -> ${gate(body)}`);
  }

  // And the shapes that must still pass, because a gate that refuses everything
  // is a gate that has stopped being one. DNS is case-insensitive, so the
  // clone's own name in upper case is the clone's own name.
  const BENIGN: [string, string][] = [
    ["a tab before the clone's own name", "server {\n  server_name\tstg.example.com;\n  {{root}}\n}"],
    ["the clone's own name in upper case", "server {\n  server_name STG.EXAMPLE.COM;\n  {{root}}\n}"],
    ["a wildcard under the clone", "server {\n  server_name stg.example.com *.stg.example.com;\n  {{root}}\n}"],
    ["a value spanning two lines, both below the clone",
      "server {\n  server_name stg.example.com\n                a.stg.example.com;\n  {{root}}\n}"],
    ["sharing a line with another directive", "server {\n  listen 8443; server_name stg.example.com;\n  {{root}}\n}"],
    ["the {{server_name}} placeholder itself", "server {\n  {{server_name}}\n  {{root}}\n}"],
    ["a commented-out server_name nginx would not act on",
      "server {\n  server_name stg.example.com;\n  # server_name victim-production.test;\n  {{root}}\n}"],
  ];
  for (const [label, body] of BENIGN) {
    check(`accepted: ${label}`, gate(body) === "PASS", `${JSON.stringify(body)} -> ${gate(body)}`);
  }
}

console.log("\n== reusing an artifact already in the release tree ==");

// Reuse is only sound because it is gated on the release's own recorded
// checksum. The case worth spending a test on is the third one: a file sitting
// in the release tree under the right name whose bytes are not the right bytes
// must be downloaded again, not trusted for being in the right place.
{
  const dir = mkdtempSync(`${tmpdir()}/clp-addons-cache-test-`);
  try {
    const tag = "v9.9.9";
    mkdirSync(`${dir}/${tag}`, { recursive: true });
    const bytes = Buffer.from("the artifact");
    const digest = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(`${dir}/${tag}/good`, bytes);
    writeFileSync(`${dir}/${tag}/tampered`, Buffer.from("something else"));

    check("a matching copy is reused", cachedArtifact(tag, "good", digest, dir)?.equals(bytes) === true);
    check("an absent copy is not reused", cachedArtifact(tag, "missing", digest, dir) === null);
    check("a copy that does not match its checksum is not reused",
      cachedArtifact(tag, "tampered", digest, dir) === null);
    check("a copy under a different tag is not reused",
      cachedArtifact("v9.9.8", "good", digest, dir) === null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n== archiving an instance is not a rolling window ==");

// make_snapshot used to prune its own output directory to the five newest
// archives. Correct for an instance's snapshots/ directory, which exists to roll
// back the update that just happened. Wrong for the pre-delete archive, which
// goes to /var/backups/clp-addons/<addon>: that directory holds one archive per
// deleted instance, each the last copy of data whose CloudPanel site is already
// gone. So `uninstall --purge` on six or more instances destroyed archives it had
// written itself earlier in the same run.
{
  const W = "addons/instatic/wrapper/clp-action-instatic";
  const fns = ["prune_snapshots", "make_snapshot"].map((n) => bashFunction(W, n)).join("\n");
  // make_snapshot reports failure through warn() and logs through log().
  const preamble = `log() { :; }\nwarn() { printf 'WARN: %s\\n' "$*" >&2; }\n${fns}`;

  const dir = mkdtempSync(`${tmpdir()}/clp-addons-archive-`);
  try {
    const inst = `${dir}/instance`;
    mkdirSync(`${inst}/data`, { recursive: true });
    mkdirSync(`${inst}/uploads`, { recursive: true });
    // A real SQLite file, so the sqlite3 .backup branch is the one exercised.
    execFileSync("sqlite3", [`${inst}/data/instatic.db`, "create table t(x); insert into t values(1);"]);
    writeFileSync(`${inst}/instatic.env`, "INSTATIC_SECRET_KEY=deadbeef\n");

    const backups = `${dir}/backups`;
    mkdirSync(backups, { recursive: true });

    // Six deletions, the way uninstall --purge makes them: one archive each,
    // into the one shared directory.
    for (let i = 1; i <= 6; i++) {
      execFileSync("bash", ["-c",
        `${preamble}\nmake_snapshot "$1" "$2"`,
        "_", inst, `${backups}/site${i}.example.com-deleted-2020010${i}.tar.gz`],
        { encoding: "utf-8" });
    }

    const kept = readdirSync(backups).sort();
    check("every deleted instance's archive survives the sixth delete",
      kept.length === 6, `kept ${kept.length}: ${kept.join(", ")}`);
    check("the first instance deleted is still archived",
      kept.includes("site1.example.com-deleted-20200101.tar.gz"), kept.join(", "));

    // The rolling window itself still has to work, or update would fill the
    // root filesystem with pre-update snapshots instead.
    const rolling = `${dir}/snapshots`;
    mkdirSync(rolling, { recursive: true });
    for (let i = 1; i <= 7; i++) writeFileSync(`${rolling}/pre-update-0.0.${i}-2020010${i}.tar.gz`, "x");
    execFileSync("bash", ["-c", `${preamble}\nprune_snapshots "$1"`, "_", rolling]);
    check("an instance's own snapshots are still pruned to five",
      readdirSync(rolling).length === 5, `${readdirSync(rolling).length}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n== addons are told apart by the path they are mounted at ==");

// One CloudPanel site serves every addon, so the path is the only thing that
// says which one a request is for. The case worth guarding is a prefix that is
// not a whole segment: a bare startsWith() sends /instatic-notes to instatic and
// hands it a sub-path of "-notes", which is a 404 from somewhere unexpected
// rather than from the router.
{
  const all = ["instatic", "stager"];
  const hit = (p: string) => {
    const m = splitMount(p, all);
    return m ? `${m.addon}:${m.rest}` : "none";
  };

  check("a bare mount is that addon's root", hit("/instatic") === "instatic:/", hit("/instatic"));
  check("a trailing slash is still its root", hit("/instatic/") === "instatic:/", hit("/instatic/"));
  check("a sub-path keeps its leading slash", hit("/instatic/api/instances") === "instatic:/api/instances",
    hit("/instatic/api/instances"));
  check("the second addon is reached too", hit("/stager/jobs/abc") === "stager:/jobs/abc", hit("/stager/jobs/abc"));
  check("a query-free deep path survives", hit("/stager/new") === "stager:/new", hit("/stager/new"));

  check("the site root belongs to no addon", hit("/") === "none", hit("/"));
  check("an unknown mount belongs to no addon", hit("/nope") === "none", hit("/nope"));
  // The prefix bug, both directions.
  check("a longer name is not the addon's mount", hit("/instatic-notes") === "none", hit("/instatic-notes"));
  check("a name merely starting the same is not it", hit("/instaticx/api") === "none", hit("/instaticx/api"));
  check("a name ending in the addon is not it", hit("/my-stager") === "none", hit("/my-stager"));

  // Every registered addon must actually be reachable at the path the CLI
  // advertises to the panel, or the injected nav points at a 404.
  for (const name of ADDON_NAMES) {
    check(`${name} is reachable at ${mountPath(name)}`,
      hit(`${mountPath(name)}/x`) === `${name}:/x`, hit(`${mountPath(name)}/x`));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
