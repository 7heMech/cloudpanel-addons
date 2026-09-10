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

// The .test.ts suffix keeps this suite in Bun's default discovery set.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { findMasterVhost, masterVhostHost, NGINX_PROXY_BLOCK, inspectNginxProxy, reconcile, reconcileNginxProxy, type Injection } from "../cli/inject";
import { headerTarget } from "../lib/panel-nav";
import type { AddonTarget } from "../cli/paths";

function check(label: string, cond: boolean, detail = ""): void {
  test.serial(label, () => {
    expect(cond, detail).toBe(true);
  });
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

// The single manager header target preserves native order, uses Addons label, and includes update check.
const navOriginal = `<div class="nav-link-container w-100"><a>Dashboard</a>${headerTarget("0.9.3").anchorAfter}</div>`;
writeFileSync(file, navOriginal);

const managerInjection: Injection = {
  addon: "manager",
  target: { ...headerTarget("0.9.3"), template: TEMPLATE },
  url: "/addons/",
};
reconcile([managerInjection], PATHS);
check("native links precede addon navigation", body().indexOf("Dashboard") < body().indexOf("clp_sites") && body().indexOf("clp_sites") < body().indexOf("clp-addon-nav"));
check("manager link has Addons label and no Bootstrap nav-link class", body().includes(">Addons</a>") && !body().includes('class="nav-link"'));
check("manager header target contains update badge and script", body().includes("clp-addon-update-badge") && body().includes("window.__clpAddonsUpdateInit"));

// Repeated reconciliation does not duplicate the manager entry
reconcile([managerInjection], PATHS);
check("manager navigation is not duplicated on repeat reconciliation", (body().match(/class="clp-addon-nav"/g) ?? []).length === 1);

// Manager injection and multi-addon install/uninstall lifecycle (1 addon and 2 addons).
const instaticTemplate = "instatic.html.twig";
const instaticFile = `${dir}/${instaticTemplate}`;
const instaticOriginal = '<div class="site-list"><!-- instatic-anchor --></div>';
writeFileSync(instaticFile, instaticOriginal);

const stagerTemplate = "stager.html.twig";
const stagerFile = `${dir}/${stagerTemplate}`;
const stagerOriginal = '<div class="actions"><!-- stager-anchor --></div>';
writeFileSync(stagerFile, stagerOriginal);

function simulateInstalledInjections(installed: string[], exclude?: string): Injection[] {
  const active = installed.filter((n) => n !== exclude);
  const injs: Injection[] = [];
  if (active.length > 0) {
    injs.push({ addon: "manager", target: { ...headerTarget("0.9.3"), template: TEMPLATE }, url: "/addons/" });
  }
  for (const name of active) {
    if (name === "instatic") {
      injs.push({ addon: "instatic", target: { slug: "new-site", template: instaticTemplate, anchorAfter: "<!-- instatic-anchor -->", required: false, snippet: (url) => `<span>Instatic at ${url}</span>` }, url: "/addons/instatic" });
    }
    if (name === "stager") {
      injs.push({ addon: "stager", target: { slug: "site-action", template: stagerTemplate, anchorAfter: "<!-- stager-anchor -->", required: false, snippet: (url) => `<span>Stager at ${url}</span>` }, url: "/addons/stager" });
    }
  }
  return injs;
}

const readInstatic = () => readFileSync(instaticFile, "utf-8");
const readStager = () => readFileSync(stagerFile, "utf-8");

// 1 addon installed (instatic):
reconcile(simulateInstalledInjections(["instatic"]), PATHS);
check("1 addon installed: header has manager nav entry", body().includes(">Addons</a>"));
check("1 addon installed: addon target is injected", readInstatic().includes("Instatic at /addons/instatic"));
check("1 addon installed: uninstalled addon is untouched", readStager() === stagerOriginal);

// 2 addons installed (instatic + stager):
reconcile(simulateInstalledInjections(["instatic", "stager"]), PATHS);
check("2 addons installed: header still has exactly 1 manager nav entry", (body().match(/class="clp-addon-nav"/g) ?? []).length === 1);
check("2 addons installed: first addon target is present", readInstatic().includes("Instatic at /addons/instatic"));
check("2 addons installed: second addon target is present", readStager().includes("Stager at /addons/stager"));

// Uninstall 1 of 2 addons (instatic uninstalled with exclude="instatic"):
reconcile(simulateInstalledInjections(["instatic", "stager"], "instatic"), PATHS);
check("uninstall 1 of 2: manager nav entry is retained in header", body().includes(">Addons</a>"));
check("uninstall 1 of 2: manager nav entry is not duplicated", (body().match(/class="clp-addon-nav"/g) ?? []).length === 1);
check("uninstall 1 of 2: uninstalled addon target is removed and template restored", readInstatic() === instaticOriginal);
check("uninstall 1 of 2: remaining addon target is preserved", readStager().includes("Stager at /addons/stager"));

// Uninstall the remaining addon (stager uninstalled with exclude="stager"):
reconcile(simulateInstalledInjections(["stager"], "stager"), PATHS);
check("uninstall last addon: manager nav entry is removed and header restored", body() === navOriginal);
check("uninstall last addon: remaining addon target is removed and restored", readStager() === stagerOriginal);

// 1 addon alone installed and uninstalled:
reconcile(simulateInstalledInjections(["stager"]), PATHS);
check("single addon install: manager nav injected", body().includes(">Addons</a>"));
check("single addon install: addon target injected", readStager().includes("Stager at /addons/stager"));
reconcile(simulateInstalledInjections(["stager"], "stager"), PATHS);
check("single addon uninstall: manager nav removed and header restored", body() === navOriginal);
check("single addon uninstall: addon target removed and restored", readStager() === stagerOriginal);

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
const nginxManaged = readFileSync(nginxSource, "utf-8");
const nginxPristineBeforeDrift = readFileSync(`${nginxState}/vhost.pristine`, "utf-8");
const nginxHashBeforeDrift = readFileSync(`${nginxState}/vhost.sha256`, "utf-8");
const nginxPathBeforeDrift = readFileSync(`${nginxState}/vhost.path`, "utf-8");
const nginxUpdated = nginxOriginal.replace("panel.example.test", "panel-updated.example.test");
writeFileSync(nginxSource, nginxUpdated);
const nginxDrift = reconcileNginxProxy({ vhostPath: nginxLink, stateDir: nginxState, reload: false });
check("Nginx reconciliation refuses upstream drift", nginxDrift.state === "upstream-changed" && !nginxDrift.changed && nginxDrift.detail?.includes("no changes were made") === true);
check("Nginx upstream drift leaves the vhost untouched", readFileSync(nginxSource, "utf-8") === nginxUpdated);
check("Nginx upstream drift preserves the pristine baseline",
  readFileSync(`${nginxState}/vhost.pristine`, "utf-8") === nginxPristineBeforeDrift &&
  readFileSync(`${nginxState}/vhost.sha256`, "utf-8") === nginxHashBeforeDrift &&
  readFileSync(`${nginxState}/vhost.path`, "utf-8") === nginxPathBeforeDrift);
check("Nginx inspection exposes upstream drift", inspectNginxProxy({ vhostPath: nginxLink, stateDir: nginxState }).state === "upstream-changed");
writeFileSync(nginxSource, nginxManaged);
const nginxRemoved = reconcileNginxProxy({ vhostPath: nginxLink, stateDir: nginxState, enabled: false, reload: false });
check("Nginx reconciliation can remove its managed block", nginxRemoved.changed && readFileSync(nginxSource, "utf-8") === nginxOriginal);
check("removing the Nginx proxy clears its rollback state", !existsSync(`${nginxState}/vhost.pristine`) && !existsSync(`${nginxState}/vhost.sha256`));
rmSync(nginxDir, { recursive: true, force: true });

const discoveryDir = mkdtempSync(`${tmpdir()}/nginx-discovery-test-`);
const discoveryState = `${discoveryDir}/state`;
const discoveryMaster = `${discoveryDir}/cloudpanel.conf`;
const discoveryCustomer = `${discoveryDir}/customer.conf`;
const discoveryMasterContent = `server {\n    listen 8443 ssl;\n    server_name panel.example.test;\n}\n`;
const discoveryCustomerContent = `server {\n    listen 8443 ssl;\n    server_name customer.example.test;\n    root /home/clp/htdocs/customer;\n}\n`;
writeFileSync(discoveryMaster, discoveryMasterContent);
writeFileSync(discoveryCustomer, discoveryCustomerContent);
const savedVhostOverride = process.env.CLP_ADDONS_NGINX_VHOST;
delete process.env.CLP_ADDONS_NGINX_VHOST;
try {
  check("Nginx discovery uses the fixed CloudPanel vhost filename",
    findMasterVhost({ sitesDir: discoveryDir }) === discoveryMaster);
  const discoveryResult = reconcileNginxProxy({ sitesDir: discoveryDir, stateDir: discoveryState, reload: false });
  check("fixed-vhost discovery ignores customer-vhost heuristics",
    discoveryResult.state === "ok" && readFileSync(discoveryCustomer, "utf-8") === discoveryCustomerContent);
} finally {
  if (savedVhostOverride === undefined) delete process.env.CLP_ADDONS_NGINX_VHOST;
  else process.env.CLP_ADDONS_NGINX_VHOST = savedVhostOverride;
}
rmSync(discoveryDir, { recursive: true, force: true });

const ambiguousDir = mkdtempSync(`${tmpdir()}/nginx-ambiguous-test-`);
const ambiguousState = `${ambiguousDir}/state`;
const ambiguousVhost = `${ambiguousDir}/cloudpanel.conf`;
const ambiguousCustomer = `${ambiguousDir}/customer.conf`;
const ambiguousContent = `${discoveryMasterContent}\n${discoveryMasterContent.replace("panel.example.test", "panel-https.example.test")}`;
writeFileSync(ambiguousVhost, ambiguousContent);
writeFileSync(ambiguousCustomer, discoveryCustomerContent);
const ambiguousBefore = readFileSync(ambiguousVhost, "utf-8");
const ambiguousCustomerBefore = readFileSync(ambiguousCustomer, "utf-8");
const savedAmbiguousOverride = process.env.CLP_ADDONS_NGINX_VHOST;
delete process.env.CLP_ADDONS_NGINX_VHOST;
try {
  const ambiguousResult = reconcileNginxProxy({ sitesDir: ambiguousDir, stateDir: ambiguousState, reload: false });
  check("Nginx discovery refuses an ambiguous master vhost", ambiguousResult.state === "ambiguous" && !ambiguousResult.changed && ambiguousResult.detail?.includes("2 server blocks") === true);
  check("ambiguous master-vhost refusal makes no vhost changes", readFileSync(ambiguousVhost, "utf-8") === ambiguousBefore);
  check("ambiguous master-vhost refusal leaves customer vhosts untouched", readFileSync(ambiguousCustomer, "utf-8") === ambiguousCustomerBefore);
  check("ambiguous master-vhost refusal creates no rollback state", !existsSync(ambiguousState));
} finally {
  if (savedAmbiguousOverride === undefined) delete process.env.CLP_ADDONS_NGINX_VHOST;
  else process.env.CLP_ADDONS_NGINX_VHOST = savedAmbiguousOverride;
}
rmSync(ambiguousDir, { recursive: true, force: true });

const missingMasterDir = mkdtempSync(`${tmpdir()}/nginx-missing-master-test-`);
const missingMasterState = `${missingMasterDir}/state`;
const missingCustomer = `${missingMasterDir}/customer.conf`;
writeFileSync(missingCustomer, discoveryCustomerContent);
const missingCustomerBefore = readFileSync(missingCustomer, "utf-8");
const savedMissingOverride = process.env.CLP_ADDONS_NGINX_VHOST;
delete process.env.CLP_ADDONS_NGINX_VHOST;
try {
  const missingResult = reconcileNginxProxy({ sitesDir: missingMasterDir, stateDir: missingMasterState, reload: false });
  check("Nginx discovery fails closed when the fixed master vhost is absent",
    missingResult.state === "missing" && missingResult.detail?.includes("cloudpanel.conf") === true);
  check("missing master-vhost refusal does not mutate customer vhosts", readFileSync(missingCustomer, "utf-8") === missingCustomerBefore);
  check("missing master-vhost refusal creates no rollback state", !existsSync(missingMasterState));
} finally {
  if (savedMissingOverride === undefined) delete process.env.CLP_ADDONS_NGINX_VHOST;
  else process.env.CLP_ADDONS_NGINX_VHOST = savedMissingOverride;
}
rmSync(missingMasterDir, { recursive: true, force: true });

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

// Adversarial cases for the master-vhost server-block scanner: a `#` comment
// or a quoted string can contain characters that look like Nginx structure
// (braces, even the word "server") without being real config, and a whole
// server block can itself be commented out. None of that may confuse block
// discovery, brace matching, or the `listen 8443` / `server_name` checks that
// pick the one real CloudPanel server block out of the file.

// A `}` inside a `#` comment must not close the server block early -- the
// content after it (here, `server_name`) is still inside the real block.
const braceCommentDir = mkdtempSync(`${tmpdir()}/nginx-brace-comment-test-`);
const braceCommentState = `${braceCommentDir}/state`;
const braceCommentVhost = `${braceCommentDir}/cloudpanel.conf`;
const braceCommentContent =
  "server {\n    listen 8443 ssl;\n" +
  "    # a stray closing brace in a comment: } must not end the block early\n" +
  "    server_name panel.example.test;\n}\n";
writeFileSync(braceCommentVhost, braceCommentContent);
check("a closing brace inside a comment does not end the server block early",
  masterVhostHost({ vhostPath: braceCommentVhost }) === "panel.example.test");
const braceCommentResult = reconcileNginxProxy({ vhostPath: braceCommentVhost, stateDir: braceCommentState, reload: false });
check("a brace inside a comment still lets reconciliation inject at the real end of the block",
  braceCommentResult.state === "ok" &&
  readFileSync(braceCommentVhost, "utf-8") ===
    `${braceCommentContent.slice(0, -2)}\n${NGINX_PROXY_BLOCK}\n}\n`);
rmSync(braceCommentDir, { recursive: true, force: true });

// A `}` inside a quoted string must not close the server block early either.
const braceQuoteDir = mkdtempSync(`${tmpdir()}/nginx-brace-quote-test-`);
const braceQuoteState = `${braceQuoteDir}/state`;
const braceQuoteVhost = `${braceQuoteDir}/cloudpanel.conf`;
const braceQuoteContent =
  "server {\n    listen 8443 ssl;\n    server_name panel.example.test;\n" +
  '    add_header X-Note "a brace in a string: } does not close anything";\n}\n';
writeFileSync(braceQuoteVhost, braceQuoteContent);
check("a closing brace inside a quoted string does not end the server block early",
  masterVhostHost({ vhostPath: braceQuoteVhost }) === "panel.example.test");
const braceQuoteResult = reconcileNginxProxy({ vhostPath: braceQuoteVhost, stateDir: braceQuoteState, reload: false });
check("a brace inside a quoted string still lets reconciliation inject at the real end of the block",
  braceQuoteResult.state === "ok" &&
  readFileSync(braceQuoteVhost, "utf-8") ===
    `${braceQuoteContent.slice(0, -2)}\n${NGINX_PROXY_BLOCK}\n}\n`);
rmSync(braceQuoteDir, { recursive: true, force: true });

// Nested `location` blocks inside the server block must not be mistaken for
// the server block's own closing brace.
const nestedLocationDir = mkdtempSync(`${tmpdir()}/nginx-nested-location-test-`);
const nestedLocationState = `${nestedLocationDir}/state`;
const nestedLocationVhost = `${nestedLocationDir}/cloudpanel.conf`;
const nestedLocationContent =
  "server {\n    listen 8443 ssl;\n    server_name panel.example.test;\n" +
  "    location / {\n        try_files $uri $uri/ =404;\n    }\n" +
  "    location /api/ {\n        proxy_pass http://127.0.0.1:3000;\n    }\n}\n";
writeFileSync(nestedLocationVhost, nestedLocationContent);
check("nested location blocks do not truncate the enclosing server block",
  masterVhostHost({ vhostPath: nestedLocationVhost }) === "panel.example.test");
const nestedLocationResult = reconcileNginxProxy({ vhostPath: nestedLocationVhost, stateDir: nestedLocationState, reload: false });
check("nested location blocks still let reconciliation inject at the real end of the server block",
  nestedLocationResult.state === "ok" &&
  readFileSync(nestedLocationVhost, "utf-8") ===
    `${nestedLocationContent.slice(0, -2)}\n${NGINX_PROXY_BLOCK}\n}\n`);
rmSync(nestedLocationDir, { recursive: true, force: true });

// A `listen 8443` that only appears because the whole server block is
// commented out must not count as a match: the master vhost has zero real
// server blocks listening on 8443, which is ambiguous (fails closed), not a
// false-positive single match on commented-out text.
const commentedListenDir = mkdtempSync(`${tmpdir()}/nginx-commented-listen-test-`);
const commentedListenState = `${commentedListenDir}/state`;
const commentedListenVhost = `${commentedListenDir}/cloudpanel.conf`;
const commentedListenContent =
  "# server {\n#     listen 8443 ssl;\n#     server_name fake.example.test;\n# }\n" +
  "server {\n    listen 80;\n    server_name real.example.test;\n}\n";
writeFileSync(commentedListenVhost, commentedListenContent);
const commentedListenBefore = readFileSync(commentedListenVhost, "utf-8");
check("a listen 8443 that only exists inside a commented-out server block is not a match",
  masterVhostHost({ vhostPath: commentedListenVhost }) === null);
const commentedListenResult = reconcileNginxProxy({ vhostPath: commentedListenVhost, stateDir: commentedListenState, reload: false });
check("a commented-out listen 8443 leaves the vhost ambiguous rather than falsely resolved",
  commentedListenResult.state === "ambiguous" &&
  !commentedListenResult.changed &&
  commentedListenResult.detail?.includes("no server block listening on port 8443") === true);
check("refusing a commented-out 8443 match makes no vhost changes",
  readFileSync(commentedListenVhost, "utf-8") === commentedListenBefore);
check("refusing a commented-out 8443 match creates no rollback state", !existsSync(commentedListenState));
rmSync(commentedListenDir, { recursive: true, force: true });

rmSync(dir, { recursive: true, force: true });
