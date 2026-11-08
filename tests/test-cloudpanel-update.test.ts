// What a CloudPanel upgrade does to the files the addons patch: a changed file
// is recorded afresh and patched again only when the package version moved and
// every block still fits, and is otherwise left alone. Runs against throwaway
// files, with the installed package version passed in rather than read from dpkg.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NGINX_PROXY_BLOCK, inspectNginxProxy, inspectTemplates, reconcile, reconcileNginxProxy, type Injection,
} from "../cli/inject";
import { NGINX_MAINTENANCE_BLOCK, reconcileNginxMaintenance } from "../addons/maintenance/nginx";
import { applyClpctlGuard } from "../addons/system-tweaks/clpctl-guard";
import { backupCompressionStatus, reconcileBackupCompression, DEFAULT_BACKUP_COMPRESSION } from "../addons/system-tweaks/backup-compression";
import { rebaselineVerdict } from "../lib/baseline";
import { compareUpstream, conffileMd5, packageVersion, parseRange, rangeFit, upstreamVersion } from "../lib/cloudpanel-version";
import { cmdStatus } from "../cli/status";
import { holdAdvice, holdSummary } from "../lib/panel-holds";

const OLD = "2.5.4-3+clp-bookworm";
const NEW = "2.5.5-1+clp-bookworm";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "clp-panel-update-"));
  dirs.push(dir);
  return dir;
}

const TEMPLATE = "Frontend/Partial/header.html.twig";
const NAV = '<div class="nav-link-container">';
const SITES = '<div class="sites">';

function injection(addon: string, anchor: string, required = true): Injection {
  return {
    addon,
    url: `/addons/${addon}`,
    target: { slug: "link", template: TEMPLATE, anchorAfter: anchor, required, snippet: (url) => `<a href="${url}">${addon}</a>` },
  };
}

/** A templates directory holding CloudPanel's header as `original`, patched by two addons under OLD. */
function patchedHeader(original = `<header>\n${NAV}\n</div>\n${SITES}\n</div>\n</header>\n`) {
  const dir = tempDir();
  const file = join(dir, TEMPLATE);
  mkdirSync(join(dir, "Frontend/Partial"), { recursive: true });
  writeFileSync(file, original);
  const options = { templatesDir: dir, stateDir: join(dir, "state") };
  const injections = [injection("manager", NAV), injection("stager", SITES)];
  const first = reconcile(injections, { ...options, panelVersion: OLD });
  expect(first.statuses.every((status) => status.state === "ok")).toBe(true);
  const record = (name: string) => readFileSync(join(options.stateDir, `Frontend_Partial_header.html.twig.${name}`), "utf-8");
  return {
    file, options, injections, record,
    read: () => readFileSync(file, "utf-8"),
    /** What a package upgrade does: the template replaced wholesale, no blocks in it. */
    upgrade: (markup: string) => writeFileSync(file, markup),
  };
}

test("a CloudPanel upgrade that changed a template whose anchors all still fit is recorded afresh and patched", () => {
  const h = patchedHeader();
  expect(h.record("version").trim()).toBe(OLD);
  const markup = `<header class="v2">\n${NAV}\n<span>new</span></div>\n${SITES}\n</div>\n</header>\n`;
  h.upgrade(markup);

  expect(inspectTemplates(h.injections, { ...h.options, panelVersion: NEW }).map((status) => status.state))
    .toEqual(["panel-updated", "panel-updated"]);
  const result = reconcile(h.injections, { ...h.options, panelVersion: NEW });
  expect(result.rebaselined).toEqual([{ file: TEMPLATE, from: OLD, to: NEW }]);
  expect(result.statuses.map((status) => status.state)).toEqual(["ok", "ok"]);
  expect(h.read()).toContain('<header class="v2">');
  expect(h.read()).toContain(">manager</a>");
  expect(h.read()).toContain(">stager</a>");
  expect(h.record("pristine")).toBe(markup);
  expect(h.record("version").trim()).toBe(NEW);

  // Settled: the next pass changes nothing, and taking the addons out gives back the new markup.
  expect(reconcile(h.injections, { ...h.options, panelVersion: NEW }).changed).toBe(false);
  reconcile([], { ...h.options, panelVersion: NEW });
  expect(h.read()).toBe(markup);
});

test("a CloudPanel upgrade that removed an anchor leaves the template and its record alone", () => {
  const h = patchedHeader();
  const pristine = h.record("pristine");
  const markup = `<header>\n${NAV}\n</div>\n<div class="sites-v2">\n</div>\n</header>\n`;
  h.upgrade(markup);

  const result = reconcile(h.injections, { ...h.options, panelVersion: NEW });
  expect(result.changed).toBe(false);
  expect(result.rebaselined).toEqual([]);
  expect(result.statuses).toEqual(h.injections.map((inj) => ({
    addon: inj.addon, slug: "link", state: "upstream-changed", template: TEMPLATE, reason: "anchor-missing", recorded: OLD, installed: NEW,
  })));
  expect(h.read()).toBe(markup);
  expect(h.record("pristine")).toBe(pristine);
  expect(h.record("version").trim()).toBe(OLD);
});

test("a CloudPanel upgrade that removed only an optional block's anchor patches the rest and leaves that block out", () => {
  const h = patchedHeader();
  // The manager's tab is required; the second block is an extra that can go without.
  const injections = [injection("manager", NAV), injection("terminal", SITES, false)];
  reconcile(injections, { ...h.options, panelVersion: OLD });
  const markup = `<header class="v2">\n${NAV}\n</div>\n<div class="sites-v2">\n</div>\n</header>\n`;
  h.upgrade(markup);

  const result = reconcile(injections, { ...h.options, panelVersion: NEW });
  expect(result.rebaselined).toEqual([{ file: TEMPLATE, from: OLD, to: NEW }]);
  expect(Object.fromEntries(result.statuses.map((status) => [status.addon, status.state])))
    .toEqual({ manager: "ok", terminal: "anchor-not-found-in-markup" });
  expect(h.read()).toContain(">manager</a>");
  expect(h.read()).not.toContain(">terminal</a>");
  expect(h.record("version").trim()).toBe(NEW);
});

test("a CloudPanel upgrade that repeated an anchor is refused, since the block could land in either place", () => {
  const h = patchedHeader();
  const markup = `<header>\n${NAV}\n</div>\n${SITES}\n</div>\n${SITES}\n</div>\n</header>\n`;
  h.upgrade(markup);
  const result = reconcile(h.injections, { ...h.options, panelVersion: NEW });
  expect(result.statuses.map((status) => status.state === "upstream-changed" && status.reason)).toEqual(["anchor-repeated", "anchor-repeated"]);
  expect(h.read()).toBe(markup);
});

test("changed bytes under the same CloudPanel version are someone's edit, and refused until the operator accepts them", () => {
  const h = patchedHeader();
  const edited = h.read().replace("<header>", "<header data-edited>");
  h.upgrade(edited);

  const refused = reconcile(h.injections, { ...h.options, panelVersion: OLD });
  expect(refused.statuses.map((status) => status.state === "upstream-changed" && status.reason)).toEqual(["edited", "edited"]);
  expect(h.read()).toBe(edited);

  // repair --rebaseline: the edit is taken, the blocks still have to fit.
  const accepted = reconcile(h.injections, { ...h.options, panelVersion: OLD, accept: true });
  expect(accepted.rebaselined).toEqual([{ file: TEMPLATE, from: OLD, to: OLD }]);
  expect(h.read()).toContain("<header data-edited>");
  expect(h.read().match(/>stager<\/a>/g)).toHaveLength(1);
});

test("accepting an edit still refuses one the blocks no longer fit", () => {
  const h = patchedHeader();
  h.upgrade(`<header>\n${NAV}\n</div>\n</header>\n`);
  const result = reconcile(h.injections, { ...h.options, panelVersion: OLD, accept: true });
  expect(result.statuses.every((status) => status.state === "upstream-changed" && status.reason === "anchor-missing")).toBe(true);
});

test("nothing is recorded afresh while dpkg is still replacing CloudPanel's files", () => {
  const h = patchedHeader();
  const halfWritten = `<header>\n${NAV}\n</div>\n${SITES}\n`;
  h.upgrade(halfWritten);
  const result = reconcile(h.injections, { ...h.options, panelVersion: null });
  expect(result.statuses.every((status) => status.state === "upstream-changed" && status.reason === "busy")).toBe(true);
  expect(h.read()).toBe(halfWritten);
  expect(h.record("version").trim()).toBe(OLD);
});

test("half a block left in the new markup is refused", () => {
  const h = patchedHeader();
  h.upgrade(`<header>\n${NAV}\n{# clp-addons:manager:link:start #}\n</div>\n${SITES}\n</div>\n</header>\n`);
  const result = reconcile(h.injections, { ...h.options, panelVersion: NEW });
  expect(result.statuses.every((status) => status.state === "upstream-changed" && status.reason === "stray-marker")).toBe(true);
});

test("a record from before versions were kept is refused on change, and gains a version while the file still matches", () => {
  const h = patchedHeader();
  rmSync(join(h.options.stateDir, "Frontend_Partial_header.html.twig.version"));
  // Unchanged: the record now vouches for the installed version.
  reconcile(h.injections, { ...h.options, panelVersion: NEW });
  expect(h.record("version").trim()).toBe(NEW);

  rmSync(join(h.options.stateDir, "Frontend_Partial_header.html.twig.version"));
  h.upgrade(`<header class="v2">\n${NAV}\n</div>\n${SITES}\n</div>\n</header>\n`);
  const result = reconcile(h.injections, { ...h.options, panelVersion: NEW });
  expect(result.statuses.every((status) => status.state === "upstream-changed" && status.reason === "unrecorded")).toBe(true);
});

test("an untouched template under a new CloudPanel keeps its record, and a later edit under that version is refused", () => {
  const h = patchedHeader();
  const patched = h.read();
  expect(reconcile(h.injections, { ...h.options, panelVersion: NEW }).changed).toBe(false);
  expect(h.record("version").trim()).toBe(NEW);

  h.upgrade(patched.replace("<header>", "<header data-edited>"));
  const result = reconcile(h.injections, { ...h.options, panelVersion: NEW });
  expect(result.statuses.every((status) => status.state === "upstream-changed" && status.reason === "edited")).toBe(true);
});

test("the rule itself: only a moved version explains a change, and fit is required either way", () => {
  const base = { recorded: OLD, installed: NEW, strayMarker: false, misfit: null };
  expect(rebaselineVerdict(base)).toBeNull();
  expect(rebaselineVerdict({ ...base, installed: OLD })).toBe("edited");
  expect(rebaselineVerdict({ ...base, recorded: null })).toBe("unrecorded");
  expect(rebaselineVerdict({ ...base, installed: null })).toBe("busy");
  expect(rebaselineVerdict({ ...base, installed: null, accept: true })).toBe("busy");
  expect(rebaselineVerdict({ ...base, misfit: "anchor-missing" })).toBe("anchor-missing");
  expect(rebaselineVerdict({ ...base, installed: OLD, accept: true })).toBeNull();
  expect(rebaselineVerdict({ ...base, installed: OLD, accept: true, strayMarker: true })).toBe("stray-marker");
});

// The panel's master vhost is a plain file of the cloudpanel package, so every
// CloudPanel upgrade writes it back without the proxy.
const VHOST = `server {\n    listen 8443 ssl;\n    server_name panel.example.test;\n}\n`;

function proxied() {
  const dir = tempDir();
  const vhostPath = join(dir, "cloudpanel.conf");
  writeFileSync(vhostPath, VHOST);
  const options = { vhostPath, stateDir: join(dir, "state"), reload: false };
  expect(reconcileNginxProxy({ ...options, panelVersion: OLD }).state).toBe("ok");
  return { vhostPath, options, read: () => readFileSync(vhostPath, "utf-8") };
}

test("a CloudPanel upgrade that rewrote the master vhost gets the proxy back when one 8443 server still takes it", () => {
  const v = proxied();
  const rewritten = VHOST.replace("server_name", "client_max_body_size 64m;\n    server_name");
  writeFileSync(v.vhostPath, rewritten);
  expect(inspectNginxProxy({ ...v.options, panelVersion: NEW }).state).toBe("panel-updated");
  const result = reconcileNginxProxy({ ...v.options, panelVersion: NEW });
  expect(result).toMatchObject({ state: "ok", changed: true, rebaselined: { from: OLD, to: NEW } });
  expect(v.read()).toContain(NGINX_PROXY_BLOCK);
  expect(v.read()).toContain("client_max_body_size 64m;");
});

test("a rewritten master vhost is refused under the same version, or when it already routes /addons/", () => {
  const v = proxied();
  const edited = VHOST.replace("server_name", "client_max_body_size 64m;\n    server_name");
  writeFileSync(v.vhostPath, edited);
  expect(reconcileNginxProxy({ ...v.options, panelVersion: OLD })).toMatchObject({
    state: "upstream-changed", changed: false, refusal: { reason: "edited", recorded: OLD, installed: OLD },
  });
  expect(v.read()).toBe(edited);

  const routed = VHOST.replace("}\n", "    location /addons/ { return 404; }\n}\n");
  writeFileSync(v.vhostPath, routed);
  expect(reconcileNginxProxy({ ...v.options, panelVersion: NEW })).toMatchObject({
    state: "upstream-changed", refusal: { reason: "conflict" },
  });
  expect(v.read()).toBe(routed);
});

function maintenanceFixture() {
  const root = tempDir();
  const settingsPath = join(root, "global_settings");
  mkdirSync(join(root, "cloudflare"));
  writeFileSync(join(root, "cloudflare", "ips"), "allow 173.245.48.0/20;\ndeny all;\n");
  writeFileSync(settingsPath, "client_max_body_size 128m;", { mode: 0o644 });
  const paths = {
    settingsPath, stateDir: join(root, "state"), panelDb: null, includePath: join(root, "maintenance.conf"),
    geoPath: join(root, "sites-enabled", "00-clp-addons-maintenance-client-ip.conf"), cloudflareIpsPath: join(root, "cloudflare", "ips"),
    vhostUid: process.getuid?.() ?? 0, reload: false,
  };
  expect(reconcileNginxMaintenance({ ...paths, packageVersion: "1.26.3-3" }).state).toBe("ok");
  return { settingsPath, paths, read: () => readFileSync(settingsPath, "utf-8") };
}

test("global_settings replaced by an Nginx upgrade gets the maintenance check back; edited in place it is refused", () => {
  const m = maintenanceFixture();
  // An interactive upgrade where the operator took the package's new file.
  writeFileSync(m.settingsPath, "client_max_body_size 256m;");
  expect(reconcileNginxMaintenance({ ...m.paths, packageVersion: "1.26.3-3" })).toMatchObject({
    state: "upstream-changed", refusal: { reason: "edited", recorded: "1.26.3-3", installed: "1.26.3-3" },
  });
  expect(m.read()).toBe("client_max_body_size 256m;");

  const result = reconcileNginxMaintenance({ ...m.paths, packageVersion: "1.26.3-4" });
  expect(result).toMatchObject({ state: "ok", changed: true, rebaselined: { from: "1.26.3-3", to: "1.26.3-4" } });
  expect(m.read()).toBe(`client_max_body_size 256m;\n${NGINX_MAINTENANCE_BLOCK}\n`);
});

test("global_settings that now defines a maintenance location of its own is refused after an upgrade", () => {
  const m = maintenanceFixture();
  const upgraded = "client_max_body_size 128m;\nerror_page 418 /teapot;";
  writeFileSync(m.settingsPath, upgraded);
  expect(reconcileNginxMaintenance({ ...m.paths, packageVersion: "1.26.3-4" })).toMatchObject({
    state: "upstream-changed", refusal: { reason: "conflict" },
  });
  expect(m.read()).toBe(upgraded);
});

test("the pinned security mitigations stay pinned on a CloudPanel version the templates were rebaselined for", () => {
  const h = patchedHeader();
  h.upgrade(`<header class="v2">\n${NAV}\n</div>\n${SITES}\n</div>\n</header>\n`);
  expect(reconcile(h.injections, { ...h.options, panelVersion: NEW }).rebaselined).toHaveLength(1);

  const dir = tempDir();
  const wrapper = join(dir, "clpctlWrapper");
  const shipped = "#!/bin/bash\n# the wrapper CloudPanel 2.5.5 ships\nexit 0\n";
  writeFileSync(wrapper, shipped, { mode: 0o700 });
  const guard = applyClpctlGuard({ version: upstreamVersion(NEW) + "-1", paths: { wrapper, backup: join(dir, "orig"), rootUid: process.getuid!() } });
  expect(guard.changed).toBe(false);
  expect(readFileSync(wrapper, "utf-8")).toBe(shipped);

  const remoteCommand = join(dir, "RemoteBackupCreateCommand.php");
  const tarCommand = join(dir, "TarCreateCommand.php");
  writeFileSync(remoteCommand, "<?php // CloudPanel 2.5.5's backup command\n");
  writeFileSync(tarCommand, "tar");
  const backup = { paths: { remoteCommand, tarCommand }, version: "2.5.5-1", run: () => ({ ok: true, stdout: "", stderr: "" }) };
  const on = { ...DEFAULT_BACKUP_COMPRESSION, enabled: true };
  expect(backupCompressionStatus(on, backup).supported).toBe(false);
  expect(() => reconcileBackupCompression(on, backup)).toThrow("not a version this tweak supports");
  expect(readFileSync(remoteCommand, "utf-8")).toBe("<?php // CloudPanel 2.5.5's backup command\n");
  expect(existsSync(join(dir, "orig"))).toBe(false);
});

test("versions compare without their Debian revision, and only an installed package has one", () => {
  expect(upstreamVersion(OLD)).toBe("2.5.4");
  expect(upstreamVersion("1:2.5.10-1")).toBe("2.5.10");
  expect(compareUpstream("2.5.10-1", "2.5.4")).toBeGreaterThan(0);
  const range = { min: "2.5.4", max: "2.5.4" };
  expect(rangeFit(OLD, range)).toBe("within");
  expect(rangeFit("2.5.3-1+clp-bookworm", range)).toBe("below");
  expect(rangeFit(NEW, range)).toBe("above");
  expect(rangeFit(null, range)).toBe("unknown");
  expect(parseRange('{"min":"2.5.4","max":"2.6"}')).toEqual({ min: "2.5.4", max: "2.6" });
  expect(parseRange('{"min":"2.6","max":"2.5"}')).toBeNull();
  expect(parseRange('{"min":"2.5.4"}')).toBeNull();
  expect(parseRange("not json")).toBeNull();
  expect(packageVersion("cloudpanel", () => `${OLD}\tii `)).toBe(OLD);
  expect(packageVersion("cloudpanel", () => `${NEW}\tiU `)).toBeNull();
  expect(packageVersion("cloudpanel", () => { throw new Error("no dpkg"); })).toBeNull();
});

test("each refusal says what happened and what to do", () => {
  const hold = { file: TEMPLATE, addons: ["Stager"], package: "CloudPanel", recorded: OLD, installed: NEW };
  expect(holdSummary({ ...hold, reason: "anchor-missing" })).toBe(`CloudPanel ${NEW} changed ${TEMPLATE}, and a line the addons attach to is gone.`);
  expect(holdAdvice({ ...hold, reason: "anchor-missing" })).toContain("clp-addons update");
  expect(holdAdvice({ ...hold, reason: "edited" })).toContain("clp-addons repair --rebaseline");
  expect(holdAdvice({ ...hold, reason: "busy" })).toContain("when the update finishes");
});

test("the Addons page lists what is paused, for which addons, and what to run; with nothing held it shows nothing", async () => {
  const { indexPage } = await import("../manager/views");
  const hold = { file: TEMPLATE, addons: ["Addons tab", "Stager"], reason: "edited" as const, package: "CloudPanel", recorded: OLD, installed: OLD };
  const page = await indexPage(["stager"], null, { holds: [hold] }).text();
  expect(page).toContain("Paused until checked");
  expect(page).toContain("<strong>Addons tab, Stager</strong>");
  expect(page).toContain(`${TEMPLATE} changed, but CloudPanel ${OLD} was not updated.`);
  expect(page).toContain("<code>clp-addons repair --rebaseline</code>");
  expect(await indexPage(["stager"], null, { holds: [] }).text()).not.toContain("Paused until checked");
});

test("a held package is installed, not being updated, so its files are judged like any other", () => {
  expect(packageVersion("cloudpanel", () => `${NEW}\thi `)).toBe(NEW);
  expect(packageVersion("cloudpanel", () => `${NEW}\thU `)).toBeNull();
  expect(packageVersion("cloudpanel", () => `${NEW}\tiiR`)).toBeNull();

  const h = patchedHeader();
  h.upgrade(`<header class="v2">\n${NAV}\n</div>\n${SITES}\n</div>\n</header>\n`);
  const held = packageVersion("cloudpanel", () => `${NEW}\thi `);
  expect(reconcile(h.injections, { ...h.options, panelVersion: held }).rebaselined).toEqual([{ file: TEMPLATE, from: OLD, to: NEW }]);
});

test("an upgrade that ships the same conffile does not take an edit dpkg kept for the operator", () => {
  const m = maintenanceFixture();
  const shipped = createHash("md5").update("client_max_body_size 128m;").digest("hex");
  writeFileSync(m.settingsPath, "client_max_body_size 256m;");
  expect(reconcileNginxMaintenance({ ...m.paths, packageVersion: "1.26.3-3", conffileMd5: shipped })).toMatchObject({
    state: "upstream-changed", refusal: { reason: "edited" },
  });
  // nginx-common moves on with the same global_settings: dpkg leaves the edit in place.
  expect(reconcileNginxMaintenance({ ...m.paths, packageVersion: "1.26.3-4", conffileMd5: shipped })).toMatchObject({
    state: "upstream-changed", refusal: { reason: "edited", recorded: "1.26.3-3", installed: "1.26.3-4" },
  });
  expect(m.read()).toBe("client_max_body_size 256m;");
  expect(holdSummary({ file: m.settingsPath, addons: [], reason: "edited", package: "nginx-common", recorded: "1.26.3-3", installed: "1.26.3-4" }))
    .toBe(`${m.settingsPath} was edited, and nginx-common 1.26.3-4 kept the edit rather than ship its own.`);
  // The operator vouches for it.
  expect(reconcileNginxMaintenance({ ...m.paths, packageVersion: "1.26.3-4", conffileMd5: shipped, accept: true }).state).toBe("ok");

  // An upgrade that does ship a new global_settings is taken.
  const n = maintenanceFixture();
  writeFileSync(n.settingsPath, "client_max_body_size 512m;");
  const newShipped = createHash("md5").update("client_max_body_size 512m;").digest("hex");
  expect(reconcileNginxMaintenance({ ...n.paths, packageVersion: "1.26.3-4", conffileMd5: newShipped })).toMatchObject({
    state: "ok", rebaselined: { from: "1.26.3-3", to: "1.26.3-4" },
  });

  expect(conffileMd5("nginx-common", "/etc/nginx/global_settings", () =>
    " /etc/nginx/nginx.conf 0123456789abcdef0123456789abcdef\n /etc/nginx/global_settings 04c005f50ebe00b15658f5c769f12d90\n"))
    .toBe("04c005f50ebe00b15658f5c769f12d90");
  expect(conffileMd5("nginx-common", "/etc/nginx/global_settings", () => " /etc/nginx/nginx.conf 0123456789abcdef0123456789abcdef\n")).toBeNull();
});

test.skipIf(process.getuid?.() === 0)("status refuses to run without root rather than read every record as an edit", async () => {
  await expect(cmdStatus()).rejects.toThrow("'status' reads records only root can read and must run as root");
});

test("a version that changes while a file is read means dpkg may have been writing it, so nothing is recorded", () => {
  const h = patchedHeader();
  const halfWritten = `<header class="v2">\n${NAV}\n</div>\n${SITES}\n`;
  h.upgrade(halfWritten);
  // dpkg is still configuring CloudPanel when the pass starts, and has finished by the time the file is judged.
  let reads = 0;
  const dpkg = () => (reads++ === 0 ? null : NEW);
  const result = reconcile(h.injections, { ...h.options, panelVersion: dpkg });
  expect(result.rebaselined).toEqual([]);
  expect(result.statuses.every((status) => status.state === "upstream-changed" && status.reason === "busy")).toBe(true);
  expect(h.read()).toBe(halfWritten);

  const v = proxied();
  writeFileSync(v.vhostPath, VHOST.replace("server_name", "client_max_body_size 64m;\n    server_name"));
  let vhostReads = 0;
  expect(reconcileNginxProxy({ ...v.options, panelVersion: () => (vhostReads++ === 0 ? OLD : NEW) })).toMatchObject({
    state: "upstream-changed", refusal: { reason: "busy" },
  });

  const m = maintenanceFixture();
  writeFileSync(m.settingsPath, "client_max_body_size 256m;");
  let settingsReads = 0;
  expect(reconcileNginxMaintenance({ ...m.paths, packageVersion: () => (settingsReads++ === 0 ? null : "1.26.3-4") })).toMatchObject({
    state: "upstream-changed", refusal: { reason: "busy" },
  });
});
