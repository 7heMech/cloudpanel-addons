// Two addons patching one CloudPanel template.
//
// This is the scenario the previous injector could not survive, and none of it
// was visible with a single addon installed. Pristine state was keyed by the
// addon rather than by the template, so the second addon to install snapshotted
// a file that already held the first addon's block -- stripped as if it were
// its own. Installing B deleted A's nav entry, the two reconciliation timers
// then overwrote each other every fifteen minutes, and uninstalling either one
// removed both because the markers were a module-level constant.
//
// Runs against a throwaway template, never the panel's own.

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { NGINX_PROXY_BLOCK, inspectNginxProxy, reconcile, reconcileNginxProxy, type Injection } from "../cli/inject";
import { headerTarget } from "../lib/panel-nav";
import type { AddonTarget } from "../cli/paths";

let failed = 0;
let passed = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) { console.log(`  ok    ${label}`); passed++; }
  else { console.log(`  FAIL  ${label}${detail ? `: ${detail}` : ""}`); failed++; }
}

// Everything happens under a temporary directory: this must not touch the
// panel's templates, must not disturb a real installation's snapshots, and must
// not need root to write under /var/lib.
const dir = mkdtempSync(`${tmpdir()}/inject-test-`);
const stateDir = `${dir}/state`;
const PATHS = { templatesDir: dir, stateDir };
const TEMPLATE = "header.html.twig";
const file = `${dir}/${TEMPLATE}`;
const ORIGINAL = `<html>\n<div class="nav-link-container w-100">\n</div>\n</html>\n`;
writeFileSync(file, ORIGINAL);

const target = (slug: string, label: string): AddonTarget => ({
  slug,
  template: TEMPLATE,
  anchorAfter: '<div class="nav-link-container w-100">',
  required: true,
  snippet: (url) => `\n  <a href="${url}">${label}</a>`,
});
const A: Injection = { addon: "alpha", target: target("nav", "AlphaNav"), url: "https://a.example.com" };
const B: Injection = { addon: "bravo", target: target("nav", "BravoNav"), url: "https://b.example.com" };

const body = () => readFileSync(file, "utf-8");
const hasA = () => body().includes("AlphaNav");
const hasB = () => body().includes("BravoNav");

reconcile([A], PATHS);
check("addon A alone is present", hasA() && !hasB());

reconcile([A, B], PATHS);
check("installing addon B keeps addon A", hasA(), body());
check("installing addon B adds addon B", hasB());

// The reconciliation timers run independently and repeatedly.
for (let i = 0; i < 3; i++) reconcile([A, B], PATHS);
check("repeated reconciliation is idempotent", hasA() && hasB());
const settled = body();
reconcile([A, B], PATHS);
check("the rendered file settles byte-for-byte", body() === settled);
check("neither addon's block is duplicated",
  (body().match(/AlphaNav/g) ?? []).length === 1 && (body().match(/BravoNav/g) ?? []).length === 1);

// Uninstalling one addon is reconciling without it.
reconcile([B], PATHS);
check("uninstalling addon A removes only addon A", !hasA() && hasB(), body());

reconcile([B], PATHS);
check("addon B survives a later reconciliation", hasB());

// Uninstalling the last addon restores the template exactly.
reconcile([], PATHS);
check("removing the last addon restores the original template", body() === ORIGINAL,
  JSON.stringify(body()));

const leftover = existsSync(stateDir) ? readdirSync(stateDir) : [];
check("no snapshot state is left behind", leftover.length === 0, leftover.join(", "));

// The shipped header targets preserve native order and support either addon alone.
const navOriginal = `<div class="nav-link-container w-100"><a>Dashboard</a>${headerTarget("Instatic").anchorAfter}</div>`;
writeFileSync(file, navOriginal);
const shipped = ["Instatic", "Stager"].map((name) => ({
  addon: name.toLowerCase(), target: { ...headerTarget(name), template: TEMPLATE }, url: `https://addons.example.com/${name.toLowerCase()}`,
}));
reconcile(shipped, PATHS);
check("native links precede addon navigation", body().indexOf("Dashboard") < body().indexOf("clp_sites") && body().indexOf("clp_sites") < body().indexOf("clp-addon-nav"));
check("addon navigation is alphabetical", body().indexOf(">Instatic</a>") < body().indexOf(">Stager</a>"));
check("both shipped links are inline and have no Bootstrap nav-link class", body().includes(">Instatic</a>") && body().includes(">Stager</a>") && !body().includes('class="nav-link"'));
reconcile([shipped[1]!], PATHS);
check("Stager navigation remains when Instatic is removed", body().includes(">Stager</a>") && !body().includes(">Instatic</a>"));
reconcile([], PATHS);
check("removing shipped navigation restores native header", body() === navOriginal);

const nginxDir = mkdtempSync(`${tmpdir()}/nginx-test-`);
const nginxSource = `${nginxDir}/cloudpanel.conf`;
const nginxLink = `${nginxDir}/enabled.conf`;
const nginxState = `${nginxDir}/state`;
const nginxOriginal = `server {\n    listen 8443 ssl;\n    server_name panel.example.test;\n}\n`;
writeFileSync(nginxSource, nginxOriginal);
symlinkSync(nginxSource, nginxLink);
const nginxResult = reconcileNginxProxy({ vhostPath: nginxLink, stateDir: nginxState, reload: false });
check("Nginx reconciliation injects the UNIX-socket proxy", nginxResult.state === "ok" && readFileSync(nginxSource, "utf-8").includes(NGINX_PROXY_BLOCK));
check("Nginx reconciliation preserves enabled-site symlinks", lstatSync(nginxLink).isSymbolicLink());
check("Nginx inspection accepts the managed block", inspectNginxProxy({ vhostPath: nginxLink, stateDir: nginxState }).state === "ok");
const nginxUpdated = nginxOriginal.replace("panel.example.test", "panel-updated.example.test");
writeFileSync(nginxSource, nginxUpdated);
const nginxReinjected = reconcileNginxProxy({ vhostPath: nginxLink, stateDir: nginxState, reload: false });
check("Nginx reconciliation recovers after a vhost regeneration", nginxReinjected.state === "ok" && readFileSync(nginxSource, "utf-8").includes("panel-updated.example.test"));
const nginxRemoved = reconcileNginxProxy({ vhostPath: nginxLink, stateDir: nginxState, enabled: false, reload: false });
check("Nginx reconciliation can remove its managed block", nginxRemoved.changed && readFileSync(nginxSource, "utf-8") === nginxUpdated);
check("removing the Nginx proxy clears its rollback state", !existsSync(`${nginxState}/vhost.pristine`) && !existsSync(`${nginxState}/vhost.sha256`));
rmSync(nginxDir, { recursive: true, force: true });

const nginxFailureDir = mkdtempSync(`${tmpdir()}/nginx-failure-test-`);
const nginxFailureVhost = `${nginxFailureDir}/cloudpanel.conf`;
const nginxFailureState = `${nginxFailureDir}/state`;
writeFileSync(nginxFailureVhost, nginxOriginal);
const fakeBin = `${nginxFailureDir}/bin`;
mkdirSync(fakeBin);
writeFileSync(`${fakeBin}/nginx`, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
chmodSync(`${fakeBin}/nginx`, 0o755);
const oldPath = process.env.PATH;
process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;
const nginxFailure = reconcileNginxProxy({ vhostPath: nginxFailureVhost, stateDir: nginxFailureState });
if (oldPath === undefined) delete process.env.PATH;
else process.env.PATH = oldPath;
check("Nginx validation failure restores the pristine vhost", nginxFailure.state === "validation-failed" && readFileSync(nginxFailureVhost, "utf-8") === nginxOriginal);
rmSync(nginxFailureDir, { recursive: true, force: true });

const nginxDisableFailureDir = mkdtempSync(`${tmpdir()}/nginx-disable-failure-test-`);
const nginxDisableFailureVhost = `${nginxDisableFailureDir}/cloudpanel.conf`;
const nginxDisableFailureState = `${nginxDisableFailureDir}/state`;
const nginxWithProxy = `${nginxOriginal.trimEnd()}\n${NGINX_PROXY_BLOCK}\n`;
writeFileSync(nginxDisableFailureVhost, nginxWithProxy);
mkdirSync(`${nginxDisableFailureDir}/bin`);
writeFileSync(`${nginxDisableFailureDir}/bin/nginx`, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
const previousPath = process.env.PATH;
process.env.PATH = `${nginxDisableFailureDir}/bin:${previousPath ?? ""}`;
const nginxDisableFailure = reconcileNginxProxy({
  vhostPath: nginxDisableFailureVhost,
  stateDir: nginxDisableFailureState,
  enabled: false,
});
if (previousPath === undefined) delete process.env.PATH;
else process.env.PATH = previousPath;
check("Nginx disable failure restores the previously active proxy",
  nginxDisableFailure.state === "validation-failed" && readFileSync(nginxDisableFailureVhost, "utf-8") === nginxWithProxy);
rmSync(nginxDisableFailureDir, { recursive: true, force: true });

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
