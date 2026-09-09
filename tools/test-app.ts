import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { mountPath, splitMount } from "../lib/mount";
import { authCookie, verifyToken } from "../lib/sso-auth";
import { parseSums } from "../cli/release";
import { validateDomain as validateInstaticDomain } from "../addons/instatic/app/service";
import { validateDomain as validateStagerDomain, expandTarget } from "../addons/stager/app/service";
import { CLIENT_JS as INSTATIC_CLIENT_JS, dashboardView } from "../addons/instatic/app/views";
import { CLIENT_JS as STAGER_CLIENT_JS, jobsView } from "../addons/stager/app/views";
import { BASE_CLIENT_JS, renderLayout } from "../lib/app-ui";
import { headerTarget, headerUpdateScript } from "../lib/panel-nav";
import { isNewerVersion } from "../lib/update-check";
import { isNewerThan } from "../addons/instatic/app/tags";
import { getNextAvailablePort, type PanelSnapshot } from "../lib/snapshot-reader";

let failed = 0;
let passed = 0;
function check(label: string, condition: boolean, detail = ""): void {
  if (condition) { console.log(`  ok    ${label}`); passed++; }
  else {
    console.log(`  FAIL  ${label}${detail ? `: ${detail}` : ""}`);
    failed++;
  }
}

check("addons use the CloudPanel /addons/ prefix", mountPath("instatic") === "/addons/instatic");
check("external paths route to Instatic", splitMount("/addons/instatic/api/instances", ["instatic", "stager"])?.rest === "/api/instances");
check("Nginx-stripped paths still route internally", splitMount("/instatic/api/instances", ["instatic"])?.rest === "/api/instances");
check("unrelated paths do not route to an addon", splitMount("/addons/instatic-notes", ["instatic"]) === null);

check("valid domains are accepted by both addons",
  validateInstaticDomain("site.example.com") === "site.example.com" &&
  validateStagerDomain("site.example.com") === "site.example.com");
check("invalid domains are rejected", validateInstaticDomain("site/../example") === null);
check("stager expands a bare target label", expandTarget("staging", "site.example.com") === "staging.site.example.com");

const instanceHtml = dashboardView([], 39000, Infinity);
const jobsHtml = jobsView([], Infinity);
check("Instatic pages use the new mount", instanceHtml.includes("/addons/instatic/"));
check("Stager pages use the new mount", jobsHtml.includes("/addons/stager/"));

check("SSO cookie uses the required scope", authCookie("token").startsWith("clp_addons_token=token; Path=/addons; HttpOnly; SameSite=Lax"));
check("invalid HMAC tokens fail closed", verifyToken("not-a-token") === null);

for (const [name, source] of [
  ["shared client", BASE_CLIENT_JS],
  ["Instatic client", BASE_CLIENT_JS + INSTATIC_CLIENT_JS],
  ["Stager client", BASE_CLIENT_JS + STAGER_CLIENT_JS],
  ["header update check", headerUpdateScript("0.9.3")],
] as const) {
  try {
    new Function(source);
    check(`${name} script parses`, true);
  } catch (error) {
    check(`${name} script parses`, false, error instanceof Error ? error.message : String(error));
  }
}

const snapshot = (allocatedPorts: number[]): PanelSnapshot => ({
  updatedAt: new Date().toISOString(),
  portRange: { min: 39000, max: 39999 },
  allocatedPorts,
  sites: [],
});
check("port allocation starts at 39000", getNextAvailablePort(snapshot([])) === 39000);
check("port allocation skips snapshot and in-flight ports", getNextAvailablePort(snapshot([39000]), [39001]) === 39002);
let exhausted = false;
try {
  getNextAvailablePort({ ...snapshot([]), portRange: { min: 39000, max: 39001 } }, [39000, 39001]);
} catch {
  exhausted = true;
}
check("an exhausted port range fails closed", exhausted);

check("addon and CLI version comparisons are numeric",
  isNewerThan("0.0.18", "0.0.9") && isNewerVersion("v0.9.4", "0.9.3") && !isNewerVersion("0.9.3", "0.9.3"));
const page = renderLayout("Test", "<p>content</p>", {
  brand: "Test",
  base: "/addons/test",
  nav: [],
  script: "",
  updateNotice: { current: "0.9.3", latest: "0.9.4" },
});
check("shared layout renders an update notice", page.includes("update-banner") && page.includes("v0.9.4"));
check("header target keeps the native anchor and addon marker", headerTarget("Instatic").anchorAfter.includes("clp_sites") && headerTarget("Instatic").snippet("/addons/instatic").includes("clp-addon-nav"));

const sums = parseSums("a".repeat(64) + "  clp-addons-linux-x64\n" + "b".repeat(64) + " *clp-verify-session\n");
check("release checksums parse normal and binary formats", sums.get("clp-addons-linux-x64") === "a".repeat(64) && sums.get("clp-verify-session") === "b".repeat(64));

const validator = "libexec/clp-verify-session";
check("the session validator is executable", existsSync(validator) && (statSync(validator).mode & 0o111) !== 0);
const sessionDir = mkdtempSync(`${tmpdir()}/session-test-`);
const now = Math.floor(Date.now() / 1000);
const sessionData = (updated: number) =>
  `_sf2_meta|a:3:{s:1:"u";i:${updated};s:1:"c";i:${updated};s:1:"l";i:300;}` +
  `_security_main|s:12:"authenticated";b:1;s:4:"user";s:5:"admin";`;
writeFileSync(`${sessionDir}/sess_valid`, sessionData(now));
writeFileSync(`${sessionDir}/sess_expired`, sessionData(now - 301));
writeFileSync(`${sessionDir}/sess_not_authenticated`,
  `_sf2_meta|a:3:{s:1:"u";i:${now};s:1:"c";i:${now};s:1:"l";i:300;}` +
  `_security_main|s:13:"authenticated";b:0;s:4:"user";s:5:"admin";s:6:"remember";b:1;`);
const runValidator = (cookie: string) => execFileSync(validator, [`--cookie=${cookie}`], {
  encoding: "utf-8",
  env: { ...process.env, CLP_ADDONS_PHP_SESSION_DIR: sessionDir },
}).trim();
check("the session validator accepts an authenticated live session", runValidator("valid") === '{"valid":true,"user":"admin"}');
check("the session validator rejects expired sessions", runValidator("expired") === '{"valid":false}');
check("the session validator rejects an unauthenticated token", runValidator("not_authenticated") === '{"valid":false}');
check("the session validator rejects traversal cookie IDs", runValidator("../etc/passwd") === '{"valid":false}');
rmSync(sessionDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
