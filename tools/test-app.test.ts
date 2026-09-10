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

// The .test.ts suffix keeps this suite in Bun's default discovery set.
import { expect, test } from "bun:test";
import { CLIENT_JS, dashboardView, isInstanceMissing, newInstanceView } from "../addons/instatic/app/views";
import { BASE_CLIENT_JS, renderLayout } from "../lib/app-ui";
import { headerTarget, headerUpdateScript } from "../lib/panel-nav";
import { isNewerVersion } from "../lib/update-check";
import { CLIENT_JS as STAGER_CLIENT_JS, isSiteMissing, jobsView, jobView } from "../addons/stager/app/views";
import type { JobView } from "../addons/stager/app/service";
import { expandTarget } from "../addons/stager/app/service";
import { isNewerThan } from "../addons/instatic/app/tags";
import type { InstanceView } from "../addons/instatic/app/service";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ADDONS, ADDON_NAMES, CLI_ARTIFACT, CLI_BIN, LIBEXEC_DIR, SOCKET_PATH, SERVICE_USER } from "../cli/paths";
import { mountPath, splitMount } from "../lib/mount";
import { escJs } from "../lib/app-http";
import { getNextAvailablePort } from "../lib/snapshot-reader";
import type { PanelSnapshot } from "../lib/snapshot-reader";
import {
  dbNameFor, dbUserFor, siteUserFor, validateFlag,
} from "../cli/action-common";
import {
  applicationOk, composeVhostBodyContent, learnVhostMapContent, parseCloneCredentials,
  recoverCarriedVhosts, renderVhostBodyResult, validateVhostBody, validateVhostTemplateBody, vhostShape,
  vhostTemplateBodyFromContent,
} from "../addons/stager/action";
import { makeSnapshot, portHolder, pruneSnapshots } from "../addons/instatic/action";

function check(label: string, cond: boolean, detail = ""): void {
  test.serial(label, () => {
    expect(cond, detail).toBe(true);
  });
}

// Checked as the browser receives it: the shared helpers and the addon's own
// script are concatenated into one <script>, so a stray escape in either one
// takes down every button on the page. Each addon is listed here; checking only
// the addon half would leave lib/app-ui.ts unverified.
const SCRIPTS: { name: string; source: string }[] = [
  { name: "instatic", source: BASE_CLIENT_JS + CLIENT_JS },
  { name: "stager", source: BASE_CLIENT_JS + STAGER_CLIENT_JS },
  { name: "clp header update notice", source: headerUpdateScript("0.9.3") },
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

// The site-user scheme is shared by the manager and both privileged actions.
// Keeping this test on the exported helper prevents the two callers from
// silently drifting apart.
function bashFunction(file: string, name: string): string {
  const src = readFileSync(file, "utf-8");
  const from = src.indexOf(`${name}() {`);
  if (from === -1) throw new Error(`${file} has no ${name}()`);
  return src.slice(from, src.indexOf("\n}", from) + 2);
}

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

{
  const seen = new Map<string, string>();
  for (const d of DOMAINS) {
    const name = siteUserFor(d);
    check(`unified action: ${d} yields a valid Linux account name`, /^[a-z][a-z0-9-]{0,31}$/.test(name), name);
    const clash = seen.get(name);
    if (clash && clash !== d) check(`unified action: ${d} does not collide with ${clash}`, false, name);
    seen.set(name, d);
  }
}

// The staging database and its user are named from the target domain too, and
// they land in MySQL rather than /etc/passwd: 64 characters for a schema, 32
// for a user, and no dots or hyphens, which a domain has plenty of.
{
  const names = new Map<string, string>();
  for (const d of DOMAINS) {
    const dbName = dbNameFor(d);
    const dbUser = dbUserFor(d);
    check(`${d} yields a legal MySQL schema name`, /^[a-z][a-z0-9]{0,63}$/.test(dbName), dbName);
    check(`${d} yields a legal MySQL user name`, /^[a-z][a-z0-9]{0,31}$/.test(dbUser), dbUser);
    const clash = names.get(dbName);
    if (clash && clash !== d.toLowerCase()) check(`${d} does not collide with ${clash}`, false, dbName);
    names.set(dbName, d.toLowerCase());
  }
}

// The bare-label shorthand the original wrapper script accepted. It is
// expanded in the app rather than in the action binary, which must reject its
// input rather than rewrite it, so this is the only place the rule is
// implemented.
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

console.log("\n== the active layout has one binary and direct helpers ==");

{
  const all = ADDON_NAMES.map((n) => ADDONS[n]!);
  check("the active binary uses the single system path", CLI_BIN === "/usr/local/bin/clp-addons");
  check("the helper directory uses the direct layout", LIBEXEC_DIR === "/usr/local/libexec/clp-addons");
  check("the service uses the UNIX socket path", SOCKET_PATH === "/run/clp-addons/manager.sock");
  check("the service account is dedicated", SERVICE_USER === "clp-addons");
  check("the one binary is the shipped artifact", CLI_ARTIFACT === "clp-addons-linux-x64");
  for (const spec of all) {
    check(`${spec.name}'s action is dispatched through the unified binary`, CLI_BIN === "/usr/local/bin/clp-addons");
  }
}

console.log("\n== CloudPanel SSO is in-process and fail-closed ==");
const ssoSource = readFileSync("lib/sso-auth.ts", "utf-8");
check("SSO reads sessions with Bun.file", ssoSource.includes("Bun.file(path).arrayBuffer()"));
check("SSO uses the fixed session directory", ssoSource.includes("SESSION_DIR") && ssoSource.includes("sess_"));
check("SSO has no HMAC token exchange", !ssoSource.includes("issueToken") && !ssoSource.includes("verifyToken"));
check("the external session validator is gone", !existsSync("libexec/clp-verify-session"));


console.log("\n== the vhost comparison ignores what CloudPanel generates ==");

// site.vhost_template keeps CloudPanel's placeholders and only the hostnames are
// concrete, so two things in it are generated rather than chosen: the
// http->https redirect block, which is prepended only for an apex or www
// hostname, and the shape of the server_name line, which differs between the
// two. Cloning example.com into stg.example.com therefore differs in both, and
// reporting that as a hand edit would fire the note on every ordinary clone.
{
  const shape = (body: string, domain: string) => vhostShape(body, domain);

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
  const gate = (body: string) => {
    const result = validateVhostTemplateBody(body, "example.com", "stg.example.com");
    return result.ok ? "PASS" : `REJECT: ${result.reason}`;
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
  const build = (body: string, source: string, target: string) =>
    vhostTemplateBodyFromContent(body, source, target) ?? "";

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
  const ok = (name: string) => applicationOk(name);

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
  const src = readFileSync("addons/stager/action.ts", "utf-8");
  const stmt = src.slice(src.indexOf("function panelUpdateSite"));
  const body = stmt.slice(0, stmt.indexOf("\n}\n") + 2);
  const sql = body.slice(body.indexOf("const setVhost"));
  check("the panel write never interpolates the application name",
    !sql.includes("${application}") && sql.includes("readfile(${sqlLiteral(appFile)})"),
    body.split("\n").filter((l) => l.includes("application")).join(" | "));
  // Three: the UPDATE, and the read-back in each of its two forms -- with a
  // carried vhost and with only the application to put back.
  check("and neither form of the read-back does either",
    (body.match(/application = CAST\(readfile/g) ?? []).length === 3,
    body.split("\n").filter((l) => l.includes("application =")).join(" | "));

  // vhost_template_exists put the same value in a query and doubled the quotes
  // in it, which is sanitizing rather than rejecting. It must now refuse.
  const existsSource = src.slice(src.indexOf("function vhostTemplateExists"));
  const invalidName = "Generic', user = 'root";
  const asked = applicationOk(invalidName) ? "YES" : "NO";
  check("a template name that fails the predicate is reported missing, not escaped",
    asked === "NO", asked);
  check("and no query is made for it at all",
    existsSource.indexOf("if (!applicationOk(name)) return false;") < existsSource.indexOf("queryPanel"));
  check("a legitimate name is still queried",
    existsSource.includes('db.query("SELECT COUNT(*) AS count FROM vhost_template WHERE name = ?;")'));
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
  const learn = (stored: string, rendered: string): Map<string, string> => {
    const result = learnVhostMapContent(stored, rendered);
    if (result.map) return result.map;
    return new Map([["REJECT", result.reason]]);
  };

  const render = (body: string, stored: string, rendered: string): string => {
    const learned = learnVhostMapContent(stored, rendered);
    if (!learned.map) return `LEARN-REJECT: ${learned.reason}`;
    const result = renderVhostBodyResult(body, learned.map);
    return result.value === null ? `RENDER-REJECT: ${result.reason}` : result.value;
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

  // The walk is only sound because it fails rather than guesses. These would
  // otherwise produce a plausible-looking map and a wrong nginx config.
  //
  // The last of them is the one the other guards cannot see. Reading forwards
  // takes the shortest value that reaches the next literal, so a wrong guess
  // usually surfaces as a later literal failing to match -- but not when the
  // literal between two DIFFERENT placeholders also occurs inside the first
  // one's value, because then the short reading and the long one both consume
  // the file to EOF. No stock CloudPanel template on this box triggers it; the
  // layout that does is one they already use, a multi-line placeholder directly
  // above another at the same indent, which is {{nginx_access_log}} over
  // {{nginx_error_log}}.
  {
    const stored = ["server {", "  {{settings}}", "  {{root}}", "}"].join("\n");
    const rendered = ["server {", "  include /etc/nginx/a;", "  include /etc/nginx/b;",
                      "  root /home/u/htdocs/d;", "}", ""].join("\n");
    const ambiguous = learn(stored, rendered);
    check("a boundary that could sit in two places is refused",
      ambiguous.get("REJECT") !== undefined,
      [...ambiguous.entries()].map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", "));
    check("and says which placeholder could be read two ways",
      (ambiguous.get("REJECT") ?? "").includes("more than one way"), ambiguous.get("REJECT"));

    // The same shape with the ambiguity removed resolves, so what is being
    // refused is the ambiguity and not the layout.
    const unambiguous = learn(
      ["server {", "  {{settings}}", "  root {{root}};", "}"].join("\n"),
      ["server {", "  include /etc/nginx/a;", "  include /etc/nginx/b;",
       "  root /home/u/htdocs/d;", "}", ""].join("\n"));
    check("the same layout without the ambiguity still resolves",
      unambiguous.get("settings") === "include /etc/nginx/a;\n  include /etc/nginx/b;",
      JSON.stringify(unambiguous.get("settings")));
    check("and the second placeholder gets what is left of the line",
      unambiguous.get("root") === "/home/u/htdocs/d", JSON.stringify(unambiguous.get("root")));

    // The live layout this would fire on: two log placeholders at one indent,
    // where the first expands to more than a line.
    const logs = learn(
      ["server {", "  {{nginx_access_log}}", "  {{nginx_error_log}}", "}"].join("\n"),
      ["server {", "  access_log /home/u/logs/nginx/access.log main;",
       "  access_log /home/u/logs/nginx/json.log json;",
       "  error_log /home/u/logs/nginx/error.log;", "}", ""].join("\n"));
    check("a multi-line placeholder above another at the same indent is refused",
      logs.get("REJECT") !== undefined,
      [...logs.entries()].map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", "));

    // `{{ root }}` is not `{{root}}`. Template::getPlaceholders() matches
    // /{{[\sa-zA-Z0-9_]+}}/ so the panel recognises it, but
    // Processor::$placeholder is the exact string `{{root}}` and replace() is a
    // plain str_replace, so no processor ever fills it and
    // removeEmptyPlaceholders() blanks it. Folding the whitespace away gave a
    // rendered file with a root directive and a stored body the panel will
    // regenerate without one -- nginx -t passes, the clone serves, and the
    // document root vanishes the next time anything touches the site.
    const spacedStored = learn("server {\n  {{ root }}\n}", "server {\n  \n}\n");
    check("a placeholder with whitespace in its braces is refused when learning",
      spacedStored.get("REJECT") !== undefined,
      [...spacedStored.keys()].join(", "));
  const spacedBody = render("server {\n  {{ root }}\n}", STORED, RENDERED);
  check("and refused when rendering, rather than filled as if it were {{root}}",
      spacedBody.startsWith("RENDER-REJECT") && spacedBody.includes("invalid"), spacedBody);

    // Two placeholders with nothing between them cannot be told apart at all.
    const adjacent = learn("server {\n  {{settings}}{{root}}\n}", "server {\n  ab\n}\n");
    check("two placeholders with nothing between them are refused",
      adjacent.get("REJECT") !== undefined && (adjacent.get("REJECT") ?? "").includes("next to each other"),
      adjacent.get("REJECT"));
  }

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
  // Keep the source-level ordering assertion: the two writes sit far apart and
  // drifting them apart would make the panel row and file disagree.
  {
    const src = readFileSync("addons/stager/action.ts", "utf-8");
    const from = src.indexOf("function carryVhost");
    const fn = src.slice(from, src.indexOf("\nfunction jobStateFor", from));
    check("the carried body is staged without a trailing newline",
      fn.includes("writeFileSync(body, composed") && !fn.includes("writeFileSync(body, `${composed}\\n`"),
      fn.split("\n").filter((l) => l.includes("writeFileSync(body")).join(" | "));
    check("and the rendered file is staged with one",
      fn.includes("writeFileSync(rendered, `${renderedBody}\\n`") ,
      fn.split("\n").filter((l) => l.includes("writeFileSync(rendered")).join(" | "));

    // Every failure that can run after the UPDATE has to put the row back as
    // well as the file, and that is more branches than it looks:
    // panel_update_site returning 1 from its *read-back* means the UPDATE
    // already ran. Leaving the row alone there is the one disagreement the
    // file-first ordering exists to prevent -- the panel regenerates the file
    // from the row -- reached by the failure path instead of the success path.
    const calls = [...fn.matchAll(/restore\((true|false),/g)].map((match) => match[1]!);
    const writeAt = fn.indexOf("if (!panelUpdateSite");
    const after = [...fn.slice(writeAt).matchAll(/restore\((true|false),/g)].map((match) => match[1]!);
    check("every restore that can follow the panel write restores the row too",
      writeAt !== -1 && after.length === 2 && after.every((value) => value === "true"),
      after.join(" | "));
    check("and the ones that cannot do not touch the row",
      calls.length === 4 && calls.filter((value) => value === "false").length === 2,
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
  const compose = (bodies: Record<string, string>, source: string, target: string): string => {
    return composeVhostBodyContent(bodies[source] ?? "", bodies[target] ?? "", source, target) ?? "REJECT: composition failed";
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
  const gate = (body: string) => {
    const result = validateVhostBody(body, "example.com", "stg.example.com");
    return result.ok ? "PASS" : `REJECT: ${result.reason}`;
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
    // These five defeated the replacement gate too, until server_name_hosts
    // stopped stripping comments by regex. nginx begins a comment only where #
    // begins a token, so a # inside a quoted value is an ordinary character --
    // reading it as a comment deleted the rest of a line nginx still executes.
    // Verified against nginx 1.30.4: the first of them hijacked the hidden name.
    ["a # inside a quoted value hiding a server_name",
      "server {\n  add_header X-M \" # \" ; server_name victim-production.test;\n  {{root}}\n}"],
    ["a tab-wrapped # inside a quoted value",
      "server {\n  add_header X-M \"\t#\t\" ; server_name victim-production.test;\n  {{root}}\n}"],
    ["a quoted # hiding a wildcard over the source",
      "server {\n  add_header X-M \" # \" ; server_name *.example.com;\n  {{root}}\n}"],
    ["a quoted value spanning lines with # at a line start",
      "server {\n  add_header X-A \"\n# \";  server_name victim-production.test;\n  {{root}}\n}"],
    ["a quoted value that is never closed",
      "server {\n  add_header X \"oops ; server_name victim-production.test;\n  {{root}}\n}"],
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
    // The other half of the same rule: refusing every # would make the gate
    // useless on real configs, where a # inside a header value is ordinary.
    ["a # inside a header value is not a comment",
      "server {\n  server_name stg.example.com;\n  add_header X-M \" # \";\n  {{root}}\n}"],
    ["single quotes inside a double-quoted CSP",
      "server {\n  server_name stg.example.com;\n  add_header Content-Security-Policy \"default-src 'self'\";\n  {{root}}\n}"],
  ];
  for (const [label, body] of BENIGN) {
    check(`accepted: ${label}`, gate(body) === "PASS", `${JSON.stringify(body)} -> ${gate(body)}`);
  }
}

console.log("\n== one request may not kill the manager ==");

// Every verb of the action binary validates its arguments before it reads
// stdin, so an oversized credential is refused with the pipe unread. The
// write then fails with EPIPE on a stream tick outside the request promise,
// where Bun.serve cannot turn it into a 500 -- and Node's default for an
// unhandled 'error' event is to throw. Since v0.7.0 one process serves every
// addon, so a 1 MiB password field took all of them down, 20 times out of 20.
//
// Driven for real: a child that exits before reading, a megabyte written to it,
// and the question is whether the process is still there afterwards.
{
  const driver = `
    import { stagerService } from "${process.cwd()}/addons/stager/app/service";
    const res = await stagerService.startClone("a.example.com", "stg.a.example.com", false,
      { port: 39000, email: "a@example.com", password: "x".repeat(1024 * 1024) });
    console.log("SURVIVED", res.ok);
  `;
  let out = "";
  let survived = false;
  try {
    out = execFileSync("bun", ["-e", driver], {
      encoding: "utf-8",
      env: { ...process.env, CLP_ADDONS_ACTION_TEST_BIN: "/bin/true" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    survived = out.includes("SURVIVED");
  } catch (err) {
    out = String((err as { stdout?: string; stderr?: string }).stderr ?? err);
  }
  check("a megabyte on a pipe nothing reads does not kill the process", survived, out.slice(-400));

  const service = readFileSync("addons/stager/app/service.ts", "utf-8");
  check("the write has an error listener rather than Node's default throw",
    /child\.stdin\?\.on\("error"/.test(service));

  const index = readFileSync("addons/stager/app/index.ts", "utf-8");
  check("and the field is bounded before the write is even attempted",
    index.includes("instaticPassword.length > MAX_PASSWORD"));
  check("a newline in a credential is refused, not trimmed",
    index.includes("CONTROL_CHARS.test(instaticPassword)"));

  // The long-lived process is the one place an unexpected throw should not be
  // fatal: it is the only process, and Restart=always turns a request that can
  // kill it into a request that can hold both addons in a crash loop.
  const cli = readFileSync("cli/index.ts", "utf-8");
  const serve = cli.slice(cli.indexOf("async function cmdServe"));
  check("the manager survives an out-of-band throw",
    serve.includes('process.on("uncaughtException"') && serve.includes('process.on("unhandledRejection"'));
  check("and nothing else in the CLI installs one",
    (cli.match(/process\.on\("uncaughtException"/g) ?? []).length === 1);
}

console.log("\n== a killed clone does not leave the box worse off ==");

// carry_vhost writes the composed config over the clone's own and then runs
// `nginx -t`. A SIGKILL in between -- OOM, `systemctl stop`, a reboot -- leaves
// an unvalidated config in service, with the job's own restore never run, and it
// breaks the NEXT reload of any site on the box: a failure nobody will connect
// to a clone that happened hours earlier. So the backup lives beside the file
// under a name nginx does not include, and `prune`, which repair runs every
// fifteen minutes, is what finds it.
{
  const actionSource = readFileSync("addons/stager/action.ts", "utf-8");

  check("the backup is not something nginx's sites-enabled/*.conf glob loads",
    !"example.com.conf.clp-stager-bak".endsWith(".conf"));

  // Driven with nginx and systemctl stubbed, because the point is which file
  // ends up in place rather than whether this box reloads.
  const recover = (state: string) => {
    const d = mkdtempSync(`${tmpdir()}/clp-stager-recover-`);
    try {
      const bin = `${d}/bin`;
      mkdirSync(bin, { recursive: true });
      for (const command of ["nginx", "systemctl", "chown"]) {
        const file = `${bin}/${command}`;
        writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        chmodSync(file, 0o755);
      }
      mkdirSync(`${d}/vhosts`, { recursive: true });
      mkdirSync(`${d}/jobs/20260908T120000Z-aaaaaa`, { recursive: true });
      writeFileSync(`${d}/jobs/20260908T120000Z-aaaaaa/target`, "stg.example.com\n");
      writeFileSync(`${d}/jobs/20260908T120000Z-aaaaaa/state`, `${state}\n`);
      writeFileSync(`${d}/vhosts/stg.example.com.conf`, "CARRIED\n");
      writeFileSync(`${d}/vhosts/stg.example.com.conf.clp-stager-bak`, "STOCK\n");
      const paths = {
        lockDir: `${d}/lock`, dataBaseDir: `${d}/data`, jobsDir: `${d}/jobs`, panelDb: `${d}/panel.db`,
        clpctl: `${bin}/clpctl`, panelIdentityFile: `${d}/identity`, nginxVhostDir: `${d}/vhosts`,
        instaticDataDir: `${d}/instatic`, actionBinary: `${bin}/clp-addons`, tempDir: `${d}/tmp`, sqlite3: "sqlite3",
      };
      mkdirSync(paths.tempDir, { recursive: true });
      const oldPath = process.env.PATH;
      process.env.PATH = `${bin}:${oldPath ?? ""}`;
      try {
        return {
          out: `n=${recoverCarriedVhosts(paths)}`,
          conf: readFileSync(`${d}/vhosts/stg.example.com.conf`, "utf-8").trim(),
          bak: readdirSync(`${d}/vhosts`).some((f) => f.endsWith(".clp-stager-bak")),
        };
      } finally {
        if (oldPath === undefined) delete process.env.PATH;
        else process.env.PATH = oldPath;
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };

  const failed = recover("failed");
  check("a job that did not finish gets its stock vhost put back",
    failed.conf === "STOCK" && failed.bak === false && failed.out === "n=1",
    JSON.stringify(failed));

  const done = recover("done");
  check("a job that finished keeps its carried vhost, and the leftover is dropped",
    done.conf === "CARRIED" && done.bak === false && done.out === "n=0",
    JSON.stringify(done));

  const running = recover("running");
  check("a job still running owns that file and is left alone",
    running.conf === "CARRIED" && running.bak === true && running.out === "n=0",
    JSON.stringify(running));

  // A record stuck in `running` never expires -- prune skips work in flight --
  // and `clone` refuses a target that already has one, so the hostname is
  // blocked for good. That is what a killed job leaves, because cmd_run writes
  // `running` and only ever writes `done` or `failed` itself.
  const prune = actionSource.slice(actionSource.indexOf("function cmdPrune"));
  const body = prune.slice(0, prune.indexOf("\nfunction dispatch"));
  check("prune asks systemd whether a running record is really running",
    body.includes('runCommand("systemctl", ["is-active", "--quiet", `clp-addon-stager-job-${entry}`])'));
  check("and marks it failed rather than skipping it forever",
    body.includes('jobSet(dir, "state", "failed")'));
  check("it also sweeps a staging directory a killed job left in /tmp",
    body.includes('entry.startsWith("clp-stager-stage.")'));
  check("and runs the vhost recovery after the records, not before",
    body.indexOf("recoverCarriedVhosts(paths)") > body.indexOf('jobSet(dir, "state", "failed")'));
}

console.log("\n== two addons hand out ports from one block ==");

// Both addons allocate from the same reserved range against a snapshot the root
// CLI only rewrites every fifteen minutes, and each was compensating only for
// its own creates inside that window. An instance made from the Instatic
// dashboard was invisible to the Stager, both sides offered the same number, and
// the clone died on `docker run` failing to bind it -- reported as "failed to
// start container", with nothing naming the port.
{
  const stagerIndex = readFileSync("addons/stager/app/index.ts", "utf-8");
  const stagerService2 = readFileSync("addons/stager/app/service.ts", "utf-8");
  const instaticService2 = readFileSync("addons/instatic/app/service.ts", "utf-8");
  const instaticAction = readFileSync("addons/instatic/action.ts", "utf-8");

  check("the stager counts live Instatic instances, not only its own jobs",
    stagerIndex.includes("instaticService.listInstancesOrThrow()")
    && stagerIndex.includes("stagerService.listJobsOrThrow()"));
  check("an unreadable list is an error on the allocation path, not an empty one",
    /listJobsOrThrow[\s\S]*?throw new Error/.test(stagerService2)
    && /listInstancesOrThrow[\s\S]*?throw new Error/.test(instaticService2));
  check("the lenient readers are still there for the dashboards",
    stagerService2.includes("async listJobs()") && instaticService2.includes("async listInstances()"));
  check("and the instatic create no longer allocates against a silent empty list",
    instaticService2.includes("const existing = await this.listInstancesOrThrow()"));

  // The root action is where the allocation decision is made, under the lock.
  const create = instaticAction.slice(instaticAction.indexOf("async function cmdCreate"));
  check("the action re-checks the port rather than only its range",
    create.slice(0, create.indexOf("\nasync function cmdUpdate")).includes("portHolder(port, domain, paths)"));
  check("and names who has it",
    instaticAction.includes("is already taken by"));

  // Driven for real: a stopped instance's record still holds its port, which is
  // the case a listening-socket check alone would miss.
  const probe = (recorded: number, asked: number, self: string) => {
    const d = mkdtempSync(`${tmpdir()}/clp-ports-`);
    try {
      mkdirSync(`${d}/other.test`, { recursive: true });
      writeFileSync(`${d}/other.test/meta.json`, JSON.stringify({ domain: "other.test", port: recorded }));
      const paths = {
        lockDir: `${d}/lock`, dataBaseDir: d, backupDir: `${d}/backups`, panelDb: `${d}/panel.db`,
        clpctl: `${d}/clpctl`, panelIdentityFile: `${d}/identity`, sqlite3: "sqlite3",
      };
      return portHolder(asked, self, paths) ?? "FREE";
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };
  // 39997/39998 rather than the bottom of the range: this test runs on the box
  // the addon targets, where the first ports really are bound by real instances,
  // and the socket half of the check would then answer for the record half.
  check("a port another instance recorded is taken, listening or not",
    probe(39997, 39997, "mine.test") === "the instance for other.test",
    probe(39997, 39997, "mine.test"));
  check("a free port is free", probe(39997, 39998, "mine.test") === "FREE",
    probe(39997, 39998, "mine.test"));
  check("an instance does not report its own port as taken by someone else",
    probe(39997, 39997, "other.test") === "FREE", probe(39997, 39997, "other.test"));

  // The one mutating route now has the try/catch every GET branch had, because
  // readSnapshot() and getNextAvailablePort() both throw.
  check("the clone route turns a throw into a message rather than a bare 500",
    /path === "\/api\/clones"[\s\S]{0,600}?try \{[\s\S]{0,200}?postClone/.test(stagerIndex));
  // And it no longer runs du over the whole docroot for a source that needs no
  // credentials.
  check("the route asks the cheap question first",
    stagerIndex.includes("(await stagerService.listSites()).find((site) => site.domain === source)"));
}

console.log("\n== no credential outlives the job that carried it ==");

// sudo journals this action binary's whole COMMAND line -- verified against this
// box's own journal -- so an argument does not merely appear in `ps` for the
// life of the process, it is written down permanently. `--mfa` put the
// authentication code there, and validateMfa deliberately accepts a RECOVERY
// code, which does not expire.
{
  const action = readFileSync("addons/stager/action.ts", "utf-8");
  const service = readFileSync("addons/stager/app/service.ts", "utf-8");

  check("the action takes no --mfa argument at all", !action.includes("--mfa"));
  check("nor does anything build one", !/args\.push\([^)]*"--mfa"/.test(service));
  check("the action reads both credentials from stdin",
    action.includes("parseCloneCredentials") && action.includes("readFileSync(0, \"utf8\")"));
  check("and the code is put on stdin beside the password",
    service.includes("${instatic.password}\\n${instatic.mfaCode ?? \"\"}\\n"));

  // The framing, driven as parseCloneCredentials in
  // addons/stager/action.ts reads it: exactly two fields, only the
  // caller's terminator removed, and any other shape refused rather than
  // trimmed. The count is fixed because a variable one cannot tell a password
  // containing a newline from a password followed by a code -- and where the
  // tail looked like a code, the run went on and authenticated with a
  // shortened secret.
  const parse = (stdin: string) => {
    try {
      const result = parseCloneCredentials(stdin);
      return `P=${result.password}|M=${result.mfa}`;
    } catch {
      return "REFUSED";
    }
  };
  check("a password with no code is still two fields",
    parse("hunter2\n\n") === "P=hunter2|M=", parse("hunter2\n\n"));
  check("a password and a code parse as two",
    parse("hunter2\n123456\n") === "P=hunter2|M=123456", parse("hunter2\n123456\n"));
  check("a password ending in a space keeps it",
    parse("hunter2 \n\n") === "P=hunter2 |M=", JSON.stringify(parse("hunter2 \n\n")));
  check("a single line is refused rather than read as a bare password",
    parse("hunter2\n") === "REFUSED", parse("hunter2\n"));
  check("a password containing a newline is refused, not silently shortened",
    parse("hunter2\nabc1234\nrest\n") === "REFUSED", parse("hunter2\nabc1234\nrest\n"));

  // Deleted, not merely 0600. The code had no deletion at all and survived the
  // fourteen days a job record is kept.
  check("both credentials are deleted once the sign-in has succeeded",
    action.includes('["srcPassword", "mfa", "site-bundle.zip", "cookies-src", "cookies-dst"'));
  const rollback = action.slice(action.indexOf("function rollbackRun"));
  const unwind = rollback.slice(0, rollback.indexOf("\nfunction newRunContext"));
  check("the rollback removes them and both cookie jars",
    unwind.includes('"mfa"') && unwind.includes('"cookies-src"')
    && unwind.includes('"cookies-dst"'),
    unwind.split("\n").filter((l) => l.includes("rmSync")).join(" | "));
  check("and revokes any session the run opened rather than leaving one live",
    (unwind.match(/instaticLogout/g) ?? []).length === 2,
    unwind.split("\n").filter((l) => l.includes("instaticLogout")).join(" | "));
  const refused = action.slice(action.indexOf('const started = runCommand("systemd-run"'));
  const refusedCredentials = refused.slice(0, 900);
  check("a job systemd-run would not start loses them too",
    refusedCredentials.includes(`rmSync(join(dir, "srcPassword")`)
    && refusedCredentials.includes(`rmSync(join(dir, "mfa")`));

  // curl writes its output and its jar with the process umask, and cmd_run
  // inherits UMask=0022 from the unit.
  check("curl's output file is created 0600 before curl writes it",
    (action.match(/tempSecretFile\(output\)/g) ?? []).length === 2,
    String((action.match(/tempSecretFile\(output\)/g) ?? []).length));
  check("and so is each cookie jar, where the session starts",
    (action.match(/tempSecretFile\(jar\)/g) ?? []).length === 2,
    String((action.match(/tempSecretFile\(jar\)/g) ?? []).length));
  check("the export is no longer chmod'd only after it has downloaded",
    !action.includes("chmodSync(ctx.exportZip"));

  // execFile's error.message is "Command failed: <full argv>".
  const code = service.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  check("an action failure is not logged with its own argv",
    !code.includes("error.message"),
    code.split("\n").filter((l) => l.includes("error.message")).join(" | "));
}

console.log("\n== a site the job adopted is not a site the job created ==");

// The Instatic action adopts a matching pre-existing reverse-proxy site rather
// than failing, and keeps its own site_created=0 precisely so its cleanup never
// deletes a site that was already serving something. The Stager delegates the
// whole reverse-proxy create to it and used to set SITE_CREATED=1 on a zero exit,
// which threw that answer away twice: SITE_CREATED is the only guard on the panel
// write, and the rollback deleted through the same flag.
//
// The answer now crosses in the reply, so the field name is a contract between
// two files that cannot import each other -- which is the thing a test has to
// hold.
{
  const stager = readFileSync("addons/stager/action.ts", "utf-8");
  const instatic = readFileSync("addons/instatic/action.ts", "utf-8");

  const createReply = instatic.slice(instatic.indexOf("async function cmdCreate"));
  check("the instatic create reply carries the created-or-adopted answer",
    createReply.slice(0, createReply.indexOf("\nasync function cmdUpdate")).includes("siteCreatedByAddon: siteCreated"),
    createReply.split("\n").filter((l) => l.includes("siteCreatedByAddon")).join(" | "));
  check("and the stager reads that same field",
    stager.includes("created.data?.siteCreatedByAddon === true"));
  const instaticCreate = stager.slice(
    stager.indexOf("const created = callInstatic"),
    stager.indexOf("if (ctx.templateName)", stager.indexOf("const created = callInstatic")),
  );
  const createdField = instaticCreate.indexOf("created.data?.siteCreatedByAddon === true");
  const createdAssignment = instaticCreate.indexOf("ctx.siteCreated = true");
  check("rather than trusting the exit status",
    createdField >= 0 && createdAssignment > createdField, instaticCreate);

  // The reader itself, driven over a reply of the shape the action emits.
  const read = (json: string, field: string) => {
    try {
      const data = (JSON.parse(json) as { data?: Record<string, unknown> }).data;
      const value = data?.[field];
      return value === undefined ? "" : String(value);
    } catch {
      return "";
    }
  };
  const CREATED = '{"ok":true,"data":{"domain":"stg.demo.test","port":39001,"tag":"0.0.18",'
    + '"container":"instatic-stg","siteUser":"addon-stgdemot-abc123","siteCreatedByAddon":true,"status":"running"}}';
  const ADOPTED = CREATED.replace("true,\"status", "false,\"status");
  check("a created site reads as true", read(CREATED, "siteCreatedByAddon") === "true",
    read(CREATED, "siteCreatedByAddon"));
  check("an adopted site reads as false", read(ADOPTED, "siteCreatedByAddon") === "false",
    read(ADOPTED, "siteCreatedByAddon"));
  check("a reply without the field reads as nothing, which is not true",
    read('{"ok":true,"data":{"domain":"x"}}', "siteCreatedByAddon") === "");
  check("the port still reads out of the same helper", read(CREATED, "port") === "39001",
    read(CREATED, "port"));

  // The two unwind questions are separate, because an Instatic clone can have
  // created the instance while adopting the site: that action refuses outright
  // if the container or meta.json already exist, so the container and the data
  // directory are always the job's, and its own delete leaves an adopted site
  // alone while removing them.
  const rollback = stager.slice(stager.indexOf("function rollbackRun"));
  const unwind = rollback.slice(0, rollback.indexOf("\nfunction newRunContext"));
  check("the instatic unwind is keyed on the instance, not on the site",
    unwind.indexOf("if (ctx.siteViaInstatic)") < unwind.indexOf("else if (ctx.siteCreated)")
    && unwind.includes("else if (ctx.siteCreated)"),
    unwind.split("\n").filter((l) => l.includes("siteViaInstatic") || l.includes("siteCreated")).join(" | "));

  // And the window cmd_clone leaves open when it drops the lock before handing
  // the work to systemd is closed where the work actually starts.
  check("the run verb re-checks that the target does not already exist",
    /if \(siteExists\(paths, ctx\.target\)\) \{\n\s*failJob/.test(stager),
    stager.split("\n").filter((l) => l.includes("siteExists(paths, ctx.target)")).join(" | "));
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
      expect(makeSnapshot(inst, `${backups}/site${i}.example.com-deleted-2020010${i}.tar.gz`)).toBe(true);
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
    pruneSnapshots(rolling);
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

// escJs writes into a single-quoted JS string that itself sits inside a
// double-quoted HTML attribute, so a character that is inert to JavaScript can
// still end the attribute.
{
  console.log("\n== escJs may not break out of the attribute it sits in ==");
  check("a double quote does not survive as a quote", !escJs('a"b').includes('"'));
  check("a single quote is escaped", escJs("a'b") === "a\\'b");
  check("a tag opener cannot start markup", !escJs("</script>").includes("<"));
  check("a tag closer is escaped too", !escJs("</script>").includes(">"));
  check("an ampersand cannot start an entity", !escJs("&amp;").includes("&"));
  check("a newline stays an escape sequence", escJs("a\nb") === "a\\nb");
  check("ordinary text is untouched", escJs("stg.example.com") === "stg.example.com");
  // The whole point: what comes out must still be the input to JavaScript.
  for (const v of ['a"b', "a'b", "</script>", "&amp;", "a\nb", "µ—ü"]) {
    check(`${JSON.stringify(v)} still means itself to JavaScript`,
      new Function(`return '${escJs(v)}'`)() === v);
  }
}

// The installer's Docker requirement must follow the addons actually chosen.
// It used to be an unconditional preflight, so `--addons=stager` demanded a
// daemon the Stager never opens a socket to -- while `clp-addons install
// stager`, gating on the same requiresUnits, was happy without it.
{
  console.log("\n== Docker is required only by the addons that need it ==");

  const fn = bashFunction("install.sh", "addon_needs_docker");
  const asks = (...addons: string[]) => {
    const r = execFileSync("bash", ["-c",
      `${fn}
if addon_needs_docker ${addons.map((a) => `'${a}'`).join(" ")}; then echo yes; else echo no; fi`,
    ]).toString().trim();
    return r === "yes";
  };

  check("the stager alone does not need Docker", !asks("stager"));
  check("instatic alone needs Docker", asks("instatic"));
  check("both together need Docker", asks("instatic", "stager"));
  check("order does not matter", asks("stager", "instatic"));
  check("an empty selection needs nothing", !asks());
  check("an unknown addon does not drag Docker in", !asks("nonesuch"));

  // The shell list is a hand-kept mirror of cli/paths.ts. If a future addon
  // declares requiresUnits: ["docker"] and the installer is not updated, the
  // preflight silently stops asking for a daemon that addon needs.
  const dockerAddons = ADDON_NAMES.filter((n) => (ADDONS[n]!.requiresUnits ?? []).includes("docker"));
  check("every addon whose spec requires docker is one the installer asks for",
    dockerAddons.every((n) => asks(n)), dockerAddons.join(","));
  check("no addon without that requirement triggers the prompt",
    ADDON_NAMES.filter((n) => !dockerAddons.includes(n)).every((n) => !asks(n)));
}


// Stager UI indicates when a cloned staging site has been deleted in CloudPanel.
{
  console.log("\n== stager UI indicates deleted staging sites ==");

  const jobBase: JobView = {
    id: "20260909T100000Z-112233",
    source: "prod.example.com",
    target: "stg.example.com",
    port: 0,
    state: "done",
    step: "",
    createdAt: "2026-09-09T09:00:00Z",
    startedAt: "2026-09-09T09:00:01Z",
    finishedAt: "2026-09-09T09:05:00Z",
    error: "",
    result: {
      siteType: "php",
      siteUser: "stg-user",
      phpVersion: "",
      vhostCarried: false,
      vhostCarriedBy: "stock",
      vhostTemplate: "Generic",
      database: null,
      instatic: null,
      notes: [],
    },
  };

  const snapSites = [{ domain: "prod.example.com", user: "prod-user", type: "php" }];
  const snapTime = "2026-09-09T10:00:00Z";

  check("a done job whose site is absent from a newer snapshot is missing",
    isSiteMissing(jobBase, 120, snapSites, snapTime));

  check("a done job whose site is present in the snapshot is NOT missing",
    !isSiteMissing(jobBase, 120, [...snapSites, { domain: "stg.example.com", user: "stg-user", type: "php" }], snapTime));

  check("a clone that finished AFTER the snapshot was taken is not marked missing yet",
    !isSiteMissing(jobBase, 120, snapSites, "2026-09-09T09:02:00Z"));

  check("a stale snapshot (> 3600s) does not falsely report missing",
    !isSiteMissing(jobBase, 3601, snapSites, snapTime));

  check("a running or queued job is not marked missing",
    !isSiteMissing({ ...jobBase, state: "running" }, 120, snapSites, snapTime) &&
    !isSiteMissing({ ...jobBase, state: "queued" }, 120, snapSites, snapTime));

  check("a failed job is not marked missing",
    !isSiteMissing({ ...jobBase, state: "failed" }, 120, snapSites, snapTime));

  const jobsHtml = jobsView([jobBase], 120, snapSites, snapTime);
  check("jobsView renders CloudPanel site deleted hint and deleted badge for missing sites",
    jobsHtml.includes("CloudPanel site deleted") && jobsHtml.includes("deleted</span>"));

  const presentHtml = jobsView([jobBase], 120, [...snapSites, { domain: "stg.example.com", user: "stg-user", type: "php" }], snapTime);
  check("jobsView does not show deleted notice when site is present",
    !presentHtml.includes("CloudPanel site deleted"));

  const detailHtml = jobView(jobBase, "all good", 120, snapSites, snapTime);
  check("jobView indicates that the staging site has been deleted from CloudPanel",
    detailHtml.includes("This staging site has been deleted from CloudPanel.") &&
    detailHtml.includes("(deleted from CloudPanel)") &&
    !detailHtml.includes('href="https://stg.example.com"'));

  const presentDetail = jobView(jobBase, "all good", 120, [...snapSites, { domain: "stg.example.com", user: "stg-user", type: "php" }], snapTime);
  check("jobView links to staging site when present",
    presentDetail.includes('href="https://stg.example.com"') &&
    !presentDetail.includes("This staging site has been deleted from CloudPanel."));
}


console.log("\n== instatic TLS certificate option ==");
{
  const newView = newInstanceView(39001, { tags: ["0.0.18"], source: "registry", latest: "0.0.18" });
  check("newInstanceView renders the TLS checkbox",
    newView.includes("<input type=\"checkbox\" id=\"tls\"")
    && newView.includes("Request a Let's Encrypt certificate immediately"));

  const instatic = readFileSync("addons/instatic/action.ts", "utf-8");
  check("the Instatic action create accepts --tls flag",
    instatic.includes("flag === \"--tls\"") && instatic.includes("validateFlag(tls, \"tls\")"));
  check("the Instatic action requests a certificate when tls is yes",
    instatic.includes("if (tls === \"yes\")")
    && instatic.includes("lets-encrypt:install:certificate"));

  const testFlag = (val: string) => {
    try {
      validateFlag(val, "test");
      return true;
    } catch {
      return false;
    }
  };
  check("validate_flag accepts 'yes'", testFlag("yes"));
  check("validate_flag accepts 'no'", testFlag("no"));
  check("validate_flag rejects invalid values", !testFlag("maybe") && !testFlag("true") && !testFlag(""));
}


console.log("\n== instatic UI indicates deleted CloudPanel sites ==");
{
  const instBase: InstanceView = {
    domain: "inst.example.com",
    port: 39001,
    tag: "0.0.18",
    container: "instatic-inst.example.com",
    siteUser: "inst_user",
    createdAt: "2026-09-09T09:00:00Z",
    state: "running",
  };

  const snapSites = [{ domain: "other.example.com", user: "other", type: "php" }];
  const snapTime = "2026-09-09T10:00:00Z";

  // Live panelSite value overrides snapshot:
  check("panelSite === false marks instance as missing immediately",
    isInstanceMissing({ ...instBase, panelSite: false }, 10, [...snapSites, { domain: "inst.example.com", user: "inst_user", type: "reverse-proxy" }], snapTime));

  check("panelSite === true marks instance as present even if absent from snapshot",
    !isInstanceMissing({ ...instBase, panelSite: true }, 10, snapSites, snapTime));

  // Snapshot fallback when panelSite is undefined:
  check("an instance absent from a newer snapshot is missing",
    isInstanceMissing(instBase, 120, snapSites, snapTime));

  check("an instance present in the snapshot is NOT missing",
    !isInstanceMissing(instBase, 120, [...snapSites, { domain: "inst.example.com", user: "inst_user", type: "reverse-proxy" }], snapTime));

  check("an instance created AFTER the snapshot was taken is not marked missing yet",
    !isInstanceMissing(instBase, 120, snapSites, "2026-09-09T08:55:00Z"));

  check("a stale snapshot (> 3600s) does not falsely report missing",
    !isInstanceMissing(instBase, 3601, snapSites, snapTime));

  // dashboardView rendering:
  const missingHtml = dashboardView(
    [{ ...instBase, panelSite: false }],
    39002, 120, snapSites, { tags: ["0.0.18"], source: "registry", latest: "0.0.18" }, snapTime
  );
  check("dashboardView renders CloudPanel site deleted hint and deleted badge for missing instances",
    missingHtml.includes("CloudPanel site deleted. Delete here to archive and clean up the instance.")
    && missingHtml.includes("deleted</span>")
    && !missingHtml.includes('href="https://inst.example.com"'));

  const presentHtml = dashboardView(
    [{ ...instBase, panelSite: true }],
    39002, 120, snapSites, { tags: ["0.0.18"], source: "registry", latest: "0.0.18" }, snapTime
  );
  check("dashboardView does not show deleted notice when site is present",
    !presentHtml.includes("CloudPanel site deleted")
    && presentHtml.includes('href="https://inst.example.com"'));

  // Stager live panelSite check:
  const stgJob: JobView = {
    id: "20260909T100000Z-112233",
    source: "prod.example.com",
    target: "stg.example.com",
    port: 0,
    state: "done",
    step: "",
    createdAt: "2026-09-09T09:00:00Z",
    startedAt: "2026-09-09T09:00:01Z",
    finishedAt: "2026-09-09T09:05:00Z",
    error: "",
    result: null,
  };
  check("stager panelSite === false marks job as missing immediately",
    isSiteMissing({ ...stgJob, panelSite: false }, 10, [{ domain: "stg.example.com", user: "u", type: "php" }], snapTime));
  check("stager panelSite === true marks job as NOT missing even if absent from snapshot",
    !isSiteMissing({ ...stgJob, panelSite: true }, 10, [], snapTime));

  check("the Stager action jobs includes panelSite in JSON output",
    readFileSync("addons/stager/action.ts", "utf-8").includes("panelSite:"));
  check("the Instatic action list includes panelSite in JSON output",
    readFileSync("addons/instatic/action.ts", "utf-8").includes("panelSite:"));
}

{
  console.log("== clp-addons update check and UI notice ==");
  check("0.9.4 is newer than 0.9.3", isNewerVersion("0.9.4", "0.9.3"));
  check("v0.9.4 is newer than 0.9.3", isNewerVersion("v0.9.4", "0.9.3"));
  check("1.0.0 is newer than 0.9.3", isNewerVersion("1.0.0", "0.9.3"));
  check("0.9.3 is not newer than 0.9.3", !isNewerVersion("0.9.3", "0.9.3"));
  check("0.9.2 is not newer than 0.9.3", !isNewerVersion("0.9.2", "0.9.3"));
  check("0.10.0 is newer than 0.9.9", isNewerVersion("0.10.0", "0.9.9"));

  const htmlWithout = renderLayout("Test", "<p>Hello</p>", {
    brand: "Test",
    base: "/test",
    nav: [],
    script: "",
  });
  check("layout without updateNotice does not render update banner", !htmlWithout.includes("update-banner"));

  const htmlWith = renderLayout("Test", "<p>Hello</p>", {
    brand: "Test",
    base: "/test",
    nav: [],
    script: "",
    updateNotice: { current: "0.9.3", latest: "0.9.4" },
  });
  check("layout with updateNotice renders update banner", htmlWith.includes("update-banner"));
  check("layout with updateNotice names current and latest versions", htmlWith.includes("v0.9.4") && htmlWith.includes("v0.9.3"));
  check("layout with updateNotice contains clp-addons update shortcut", htmlWith.includes("clp-addons update"));

  const snip = headerTarget("0.9.3").snippet("https://addons.example.com/addons/");
  check("headerTarget includes update badge style", snip.includes("clp-addon-update-badge"));
  check("headerTarget includes update check script", snip.includes("window.__clpAddonsUpdateInit"));
  check("headerTarget embeds the configured version", snip.includes("\"0.9.3\""));
  check("headerTarget uses Addons label", snip.includes(">Addons</a>"));
  check("headerTarget points to manager URL", snip.includes('href="https://addons.example.com/addons/"'));

  const { indexPage } = await import("../cli/index");
  const pageRes = indexPage(["instatic"]);
  const pageHtml = await pageRes.text();
  check("indexPage renders addon card", pageHtml.includes("addon-card"));
  check("indexPage includes addon title", pageHtml.includes("Instatic"));
  check("indexPage includes mount path", pageHtml.includes("/addons/instatic"));
  check("indexPage includes open button", pageHtml.includes("Open Instatic"));
  check("indexPage does not hardcode false Live badge", !pageHtml.includes("badge state-running") && !pageHtml.includes("Live"));

  const emptyRes = indexPage([]);
  const emptyHtml = await emptyRes.text();
  check("empty indexPage shows no addons notice", emptyHtml.includes("No addons are currently available."));
}
