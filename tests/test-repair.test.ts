// Regression coverage for the unattended repair path aborting whenever no CloudPanel
// operator session exists. `repair` runs unattended every 15 minutes via
// clp-addons-reconcile.timer; it must complete its reconciliation even when no live
// panel session exists. Readiness checks the fixed directory and helper contract, so a
// live session file is not required for unattended repair or interactive install.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");

// Keep the module mocks inside a child process. Bun keeps mock.module overrides for the
// whole test process, and a top-level repair mock can otherwise replace cli/inject for a
// later test file when the test runner discovers files in a different order.
const PROBE = String.raw`
  import { mock } from "bun:test";
  import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";

  const phpFixture = mkdtempSync(join(tmpdir(), "clp-repair-php-"));
  const realPaths = await import("./cli/paths.ts");
  mock.module("./cli/paths.ts", () => ({
    ...realPaths,
    PHP_ROOT: join(phpFixture, "php"),
    PHP_FPM_BIN_DIR: join(phpFixture, "sbin"),
  }));

  const calls = [];
  let hasInstalledAddon = true;
  const provisioning = {
    dirs: false,
    sudoers: false,
    units: false,
    nginx: false,
  };

  function resetProvisioning() {
    Object.assign(provisioning, { dirs: false, sudoers: false, units: false, nginx: false });
  }

  class TestFatal extends Error {}

  function parseFlags(argv) {
    const positional = [];
    const flags = {};
    for (const arg of argv) {
      if (!arg.startsWith("--")) {
        positional.push(arg);
        continue;
      }
      const equal = arg.indexOf("=");
      flags[arg.slice(2, equal === -1 ? undefined : equal)] = equal === -1 ? true : arg.slice(equal + 1);
    }
    return { positional, flags };
  }

  const realProvision = await import("./cli/provision.ts?repair-test-real");
  mock.module("./cli/release.ts", () => ({
    CLI_VERSION: "1.2.3",
    resolveRelease: async () => ({ tag: "v1.2.3", assets: new Map() }),
    fetchVerified: async (_release, names = []) => names.map((name) => ({ name, bytes: Buffer.from(name, "utf-8") })),
    verifyAttestation: async () => {},
    loadLocal: (_dir, names = []) => names.map((name) => ({ name, bytes: Buffer.from(name, "utf-8") })),
  }));

  mock.module("./cli/provision.ts", () => ({
    ...realProvision,
    ensureDirs: (_specs, verifySession) => {
      calls.push(verifySession ? "ensureDirs:verifySession" : "ensureDirs");
      provisioning.dirs = true;
    },
    ensureAuthHelperReady: () => calls.push("ensureAuthHelperReady"),
    warnIfPanelSessionUnreadable: () => {
      // The real repair helper never throws; it only records a warning.
      calls.push("warnIfPanelSessionUnreadable");
    },
    ensureServiceUser: () => calls.push("ensureServiceUser"),
    ensureTimerArmed: (unit) => calls.push("ensureTimerArmed:" + unit),
    ensurePathWatching: (unit) => calls.push("ensurePathWatching:" + unit),
    hardenBackups: () => calls.push("hardenBackups"),
    reconcilePanelIdentity: () => { calls.push("reconcilePanelIdentity"); provisioning.sudoers = true; },
    installUnits: () => { calls.push("installUnits"); provisioning.units = true; return false; },
    installedConfig: () => hasInstalledAddon,
    purgeTwigCache: () => calls.push("purgeTwigCache"),
    removeLegacyUnits: () => calls.push("removeLegacyUnits"),
    startUnits: () => calls.push("startUnits"),
    stopUnits: () => calls.push("stopUnits"),
    unitActive: () => "active",
    managerSocketProblem: () => null,
    unitPid: () => 1234,
    writeConfig: (spec) => calls.push("writeConfig:" + spec.name),
  }));

  mock.module("./cli/inject.ts", () => ({
    KNOWN_GOOD_PANEL_VERSIONS: [],
    inspect: () => ({ state: "ok" }),
    inspectNginxProxy: () => ({ state: "missing" }),
    masterVhostHost: () => null,
    panelVersion: () => "test",
    purgeTwigCache: () => calls.push("purgeInjectCache"),
    reconcile: () => {
      calls.push("reconcile");
      return { statuses: [], changed: false };
    },
    reconcileNginxProxy: () => {
      calls.push("reconcileNginxProxy");
      provisioning.nginx = true;
      return { state: "ok", changed: false };
    },
  }));

  mock.module("./cli/util.ts", () => ({
    Fatal: TestFatal,
    fatal: (message) => { throw new TestFatal(message); },
    log: { step: () => {}, ok: (message) => calls.push("ok:" + message), warn: () => {}, err: () => {}, plain: () => {} },
    parseFlags,
    requireRoot: () => {},
    run: () => "",
    tryRun: (cmd) => ({ ok: !cmd.startsWith(phpFixture), out: "fixture FPM rejected configuration" }),
    writeAtomic: () => {},
  }));

  mock.module("./lib/panel-snapshot.ts", () => ({
        getLivePanelInfo: () => ({
      updatedAt: new Date().toISOString(),
      portRange: { min: 39000, max: 39999 },
      allocatedPorts: [],
      sites: [],
    }),
  }));

  const { cmdInstall } = await import("./cli/install.ts");
  const { cmdRepair } = await import("./cli/repair.ts");

  async function repairResult() {
    calls.length = 0;
    resetProvisioning();
    hasInstalledAddon = true;
    let threw = false;
    try {
      await cmdRepair(["--quiet"]);
    } catch {
      threw = true;
    }
    return { threw, calls: [...calls], provisioning: { ...provisioning } };
  }

  const repairWithoutSession = await repairResult();

  calls.length = 0;
  resetProvisioning();
  hasInstalledAddon = false;
  let installThrew = false;
  try {
    await cmdInstall(["stager", "--local=/tmp/does-not-matter"]);
  } catch (error) {
    installThrew = error instanceof TestFatal;
  }

  const installWithoutSession = { threw: installThrew, calls: [...calls], provisioning: { ...provisioning } };
  mkdirSync(join(phpFixture, "php/8.3/fpm/conf.d"), { recursive: true });
  mkdirSync(join(phpFixture, "sbin"));
  writeFileSync(join(phpFixture, "sbin/php-fpm8.3"), "");
  hasInstalledAddon = true;
  calls.length = 0;
  let guardFailure;
  try { await cmdRepair([]); }
  catch (error) { guardFailure = error.message; }
  const failedRepairCalls = [...calls];
  rmSync(phpFixture, { recursive: true, force: true });

  process.stdout.write(JSON.stringify({
    repairWithoutSession,
    installWithoutSession,
    guardFailure,
    failedRepairCalls,
  }));
`;

function runProbe(): {
  repairWithoutSession: { threw: boolean; calls: string[]; provisioning: Record<string, boolean> };
  installWithoutSession: { threw: boolean; calls: string[]; provisioning: Record<string, boolean> };
  guardFailure: string;
  failedRepairCalls: string[];
} {
  const result = spawnSync(process.execPath, ["-e", PROBE], { cwd: REPO, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

const result = runProbe();

test("repair propagates a real PHP guard failure without claiming completion", () => {
  expect(result.guardFailure).toContain("php-fpm8.3 rejected the config: fixture FPM rejected configuration");
  expect(result.failedRepairCalls.some((call) => call.startsWith("ok:repair complete"))).toBe(false);
});

test("repair completes reconciliation even when no panel session exists", () => {
  expect(result.repairWithoutSession.threw).toBe(false);
  expect(result.repairWithoutSession.calls).not.toContain("ensureDirs:verifySession");
  expect(result.repairWithoutSession.calls).toContain("ensureDirs");
  expect(result.repairWithoutSession.calls).toContain("warnIfPanelSessionUnreadable");
  for (const name of ["reconcilePanelIdentity", "installUnits", "reconcileNginxProxy"]) {
    expect(result.repairWithoutSession.calls).toContain(name);
  }
  expect(result.repairWithoutSession.provisioning).toEqual({
    dirs: true,
    sudoers: true,
    units: true,
    nginx: true,
  });
});

test("repair checks persistent enablement for every installed timer", () => {
  expect(result.repairWithoutSession.calls).toContain("ensureTimerArmed:clp-addons-reconcile.timer");
  expect(result.repairWithoutSession.calls).toContain("ensureTimerArmed:clp-addons-cloudflare-ips-reconcile.timer");
});

test("install proceeds when the fixed directory has no live panel session", () => {
  expect(result.installWithoutSession.threw).toBe(false);
  expect(result.installWithoutSession.calls).toContain("ensureDirs:verifySession");
  expect(result.installWithoutSession.calls).toContain("ensureAuthHelperReady");
  expect(result.installWithoutSession.calls).toContain("reconcilePanelIdentity");
  expect(result.installWithoutSession.calls).toContain("installUnits");
});
