import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * What a toggle is allowed to do.
 *
 * Enabling one addon used to re-run first-install work -- creating the service
 * user, probing the auth helper, sweeping legacy installs -- and then restart
 * the auth socket, the manager, the reconcile timer and the path watcher
 * whether or not anything about them had changed. These assertions are on the
 * exact command sequence rather than on the end state, because the end state
 * was already right; what was wrong was the cost of reaching it, and only the
 * sequence shows that.
 */

const repo = join(import.meta.dir, "..");

interface Run {
  calls: [string, string[]][];
  provision: string[];
  inject: string[];
  systemd: string[];
  cron: boolean;
  error?: string;
}

const childScript = String.raw`
import { mock } from "bun:test";
import { existsSync } from "node:fs";

const root = process.env.CLP_TEST_ROOT;
const calls = [];
const provision = [];
const inject = [];
const record = (bucket, name) => (...args) => { bucket.push(name); return undefined; };

const realPaths = await import("./cli/paths.ts");
const specs = Object.fromEntries(realPaths.ADDON_NAMES.map((name) => [name, {
  ...realPaths.ADDONS[name],
  configFile: root + "/etc/" + name + ".conf",
  stateDir: root + "/state/" + name,
}]));
mock.module("./cli/paths.ts", () => ({
  ...realPaths,
  ADDONS: specs,
  SYSTEMD_DIR: root + "/systemd",
  CONFIG_DIR: root + "/etc",
  STATE_DIR: root + "/state",
  LIBEXEC_DIR: root + "/libexec",
  LOCK_DIR: root + "/lock",
  SOCKET_DIR: root + "/run",
  INSTATIC_BACKUP_CRON: root + "/cron.d/instatic-backup",
}));

const realUtil = await import("./cli/util.ts");
class TestFatal extends Error {}
mock.module("./cli/util.ts", () => ({
  ...realUtil,
  Fatal: TestFatal,
  fatal: (message) => { throw new TestFatal(message); },
  log: { step: () => {}, ok: () => {}, warn: () => {}, err: () => {}, plain: () => {} },
  requireRoot: () => {},
  run: (cmd, args) => { calls.push([cmd, args]); return cmd === "id" ? "0" : ""; },
  tryRun: (cmd, args) => { calls.push([cmd, args]); return { ok: true, out: "" }; },
}));

// The real installUnits, applyToggleUnits, writeConfig, installedConfig and
// platformProvisioned are under test. Everything replaced below either needs
// root or reaches outside the fixture; each records that it was reached, which
// is most of what these tests assert.
const realProvision = await import("./cli/provision.ts");
mock.module("./cli/provision.ts", () => ({
  ...realProvision,
  ensureDirs: record(provision, "ensureDirs"),
  ensureServiceUser: record(provision, "ensureServiceUser"),
  ensureAuthHelperReady: record(provision, "ensureAuthHelperReady"),
  ensureRequiredUnits: record(provision, "ensureRequiredUnits"),
  ensureTimerArmed: record(provision, "ensureTimerArmed"),
  hardenBackups: record(provision, "hardenBackups"),
  reconcilePanelIdentity: record(provision, "reconcilePanelIdentity"),
  removeLegacyInstall: record(provision, "removeLegacyInstall"),
  removeLegacyUnits: record(provision, "removeLegacyUnits"),
  removeLegacyUsers: record(provision, "removeLegacyUsers"),
  removeSudoers: record(provision, "removeSudoers"),
  startUnits: record(provision, "startUnits"),
  stopUnits: record(provision, "stopUnits"),
  purgeTwigCache: record(provision, "purgeTwigCache"),
  warnIfPanelSessionUnreadable: () => {},
  unitActive: () => "active",
  unitPid: () => null,
}));
mock.module("./cli/inject.ts", () => ({
  KNOWN_GOOD_PANEL_VERSIONS: [],
  inspect: () => ({ state: "ok" }),
  inspectNginxMaintenance: () => ({ state: "ok" }),
  inspectNginxProxy: () => ({ state: "ok" }),
  masterVhostHost: () => null,
  panelVersion: () => "test",
  purgeTwigCache: record(inject, "purgeTwigCache"),
  reconcile: (injections) => { inject.push("reconcile:" + injections.length); return { statuses: [], changed: false }; },
  reconcileNginxMaintenance: () => { inject.push("maintenance"); return { state: "ok", changed: false }; },
  reconcileNginxProxy: () => { inject.push("proxy"); return { state: "ok", changed: false }; },
  findMasterVhost: () => null,
  panelVhostWatchPath: () => null,
}));
const realMaintenance = await import("./addons/maintenance/action.ts");
mock.module("./addons/maintenance/action.ts", () => ({
  ...realMaintenance,
  ensureMaintenanceData: () => {},
}));
const realSnapshot = await import("./lib/panel-snapshot.ts");
mock.module("./lib/panel-snapshot.ts", () => ({ ...realSnapshot, generateSnapshot: () => {} }));
const realSso = await import("./lib/sso-auth.ts");
mock.module("./lib/sso-auth.ts", () => ({
  ...realSso,
  authenticateRequest: async () => ({ response: null }),
  panelUserUid: () => 1000,
}));
mock.module("./lib/update-check.ts", () => ({ checkCliUpdate: async () => null }));

const cli = await import("./cli/index.ts");
let error;
try {
  for (const step of JSON.parse(process.env.CLP_TEST_STEPS)) {
    if (step.verb === "enable") await cli.applyEnable(step.addon);
    else cli.applyDisable(step.addon);
  }
} catch (err) {
  error = err instanceof Error ? err.message : String(err);
}
console.log(JSON.stringify({
  calls,
  provision,
  inject,
  systemd: calls.filter(([cmd]) => cmd === "systemctl").map(([, args]) => args.join(" ")),
  cron: existsSync(root + "/cron.d/instatic-backup"),
  error,
}));
`;

function fixture(options: { provisioned: boolean; enabled: string[] }): string {
  const root = mkdtempSync(join(tmpdir(), "toggle-test-"));
  for (const dir of ["etc", "state", "systemd", "cron.d", "libexec", "lock", "run"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  if (options.provisioned) {
    for (const unit of ["clp-addons.service", "clp-addons-auth.socket", "clp-addons-auth.service"]) {
      writeFileSync(join(root, "systemd", unit), "# placeholder\n");
    }
  }
  for (const name of options.enabled) {
    writeFileSync(join(root, "etc", `${name}.conf`), `# clp-addons: ${name}\nRUN_AS=clp-addons\n`);
    if (name !== "cloudflare-ips") continue;
    // Its units are part of "already enabled": a disable has to find them to
    // stop and remove them.
    for (const unit of ["clp-addons-cloudflare-ips-reconcile.timer", "clp-addons-cloudflare-ips-reconcile.service"]) {
      writeFileSync(join(root, "systemd", unit), "# placeholder\n");
    }
  }
  return root;
}

function toggle(
  steps: { verb: "enable" | "disable"; addon: string }[],
  options: { provisioned?: boolean; enabled?: string[] } = {},
): Run & { root: string } {
  const root = fixture({ provisioned: options.provisioned ?? true, enabled: options.enabled ?? [] });
  const result = spawnSync(process.execPath, ["-e", childScript], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, CLP_TEST_ROOT: root, CLP_TEST_STEPS: JSON.stringify(steps) },
  });
  if (result.status !== 0) throw new Error(`child failed: ${result.stderr}`);
  const line = result.stdout.trim().split("\n").at(-1)!;
  return { ...(JSON.parse(line) as Run), root };
}

test("enabling an addon restarts nothing that was already running", () => {
  const run = toggle([{ verb: "enable", addon: "stager" }]);
  expect(run.error).toBeUndefined();
  // The manager unit's text changes with the addon set, so systemd is told.
  expect(run.systemd).toEqual(["daemon-reload"]);
  // Not the auth socket, not the manager, not the armed reconcile timer.
  expect(run.systemd.join(" ")).not.toContain("restart");
  expect(run.provision).not.toContain("startUnits");
});

test("a toggle does not re-run first-install work", () => {
  const run = toggle([{ verb: "enable", addon: "stager" }]);
  for (const step of ["ensureServiceUser", "ensureAuthHelperReady", "removeLegacyInstall",
    "removeLegacyUnits", "removeLegacyUsers"]) {
    expect(run.provision).not.toContain(step);
  }
  // The addon's own dependencies are still checked: that is about this addon,
  // not about whether the box has ever been set up.
  expect(run.provision).toContain("ensureRequiredUnits");
});

test("enabling on a box that was never installed runs the full bootstrap", () => {
  const run = toggle([{ verb: "enable", addon: "stager" }], { provisioned: false });
  expect(run.error).toBeUndefined();
  expect(run.provision).toContain("ensureServiceUser");
  expect(run.provision).toContain("ensureAuthHelperReady");
  expect(run.provision).toContain("startUnits");
  expect(run.inject).toContain("proxy");
});

test("re-enabling an addon that is already on changes and reloads nothing", () => {
  const run = toggle([{ verb: "enable", addon: "stager" }, { verb: "enable", addon: "stager" }]);
  expect(run.error).toBeUndefined();
  // One daemon-reload for the first toggle, none for the second: the second
  // wrote the same manager unit text it found.
  expect(run.systemd).toEqual(["daemon-reload"]);
});

test("the Cloudflare timer is started when its units appear and stopped when they go", () => {
  const on = toggle([{ verb: "enable", addon: "cloudflare-ips" }]);
  expect(on.systemd).toContain("enable clp-addons-cloudflare-ips-reconcile.timer");
  expect(on.systemd).toContain("restart clp-addons-cloudflare-ips-reconcile.timer");

  const off = toggle([{ verb: "disable", addon: "cloudflare-ips" }], { enabled: ["cloudflare-ips"] });
  expect(off.systemd).toContain("disable --now clp-addons-cloudflare-ips-reconcile.timer");
  expect(existsSync(join(off.root, "systemd", "clp-addons-cloudflare-ips-reconcile.timer"))).toBe(false);
  expect(existsSync(join(off.root, "systemd", "clp-addons-cloudflare-ips-reconcile.service"))).toBe(false);
});

test("an addon with no panel markup does not touch the panel templates", () => {
  // cloudflare-ips declares no injection targets, so there is nothing to patch
  // and no Twig cache to purge.
  const run = toggle([{ verb: "enable", addon: "cloudflare-ips" }]);
  expect(run.inject).toEqual([]);
});

test("an addon with panel markup reconciles the anchors once", () => {
  const run = toggle([{ verb: "enable", addon: "stager" }]);
  expect(run.inject.filter((entry) => entry.startsWith("reconcile:")).length).toBe(1);
});

test("the Instatic backup cron appears with the addon and goes with it", () => {
  const on = toggle([{ verb: "enable", addon: "instatic" }]);
  expect(on.cron).toBe(true);
  const off = toggle([{ verb: "disable", addon: "instatic" }], { enabled: ["instatic"] });
  expect(off.cron).toBe(false);
});

test("only the toggled addon's config file is rewritten", () => {
  const run = toggle([{ verb: "enable", addon: "stager" }], { enabled: ["instatic"] });
  const instatic = readFileSync(join(run.root, "etc", "instatic.conf"), "utf8");
  // Still the fixture's own bytes: an enable used to rewrite every installed
  // addon's config with force, which is an install's job, not a toggle's.
  expect(instatic).toBe("# clp-addons: instatic\nRUN_AS=clp-addons\n");
  expect(existsSync(join(run.root, "etc", "stager.conf"))).toBe(true);
});

test("the panel identity is reconciled only when the enabled set empties or fills", () => {
  const first = toggle([{ verb: "enable", addon: "stager" }]);
  expect(first.provision).toContain("reconcilePanelIdentity");

  const second = toggle([{ verb: "enable", addon: "stager" }], { enabled: ["instatic"] });
  expect(second.provision).not.toContain("reconcilePanelIdentity");

  const last = toggle([{ verb: "disable", addon: "stager" }], { enabled: ["stager"] });
  expect(last.provision).toContain("reconcilePanelIdentity");

  const notLast = toggle([{ verb: "disable", addon: "stager" }], { enabled: ["stager", "instatic"] });
  expect(notLast.provision).not.toContain("reconcilePanelIdentity");
});

test("disabling leaves the addon's state directory and removes only its config", () => {
  const run = toggle([{ verb: "disable", addon: "stager" }], { enabled: ["stager", "instatic"] });
  expect(existsSync(join(run.root, "etc", "stager.conf"))).toBe(false);
  expect(existsSync(join(run.root, "etc", "instatic.conf"))).toBe(true);
  expect(existsSync(join(run.root, "state"))).toBe(true);
});

test("the manager unit written by a toggle describes exactly the enabled set", () => {
  const run = toggle([{ verb: "enable", addon: "stager" }], { enabled: ["instatic"] });
  const unit = readFileSync(join(run.root, "systemd", "clp-addons.service"), "utf8");
  expect(unit).toContain("STAGER_APP_DATA=");
  expect(unit).toContain("INSTATIC_APP_DATA=");
  expect(unit).not.toContain("MAINTENANCE_APP_DATA=");
});
