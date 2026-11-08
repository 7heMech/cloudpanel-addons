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
  const realPaths = await import("./lib/paths.ts");
  mock.module("./lib/paths.ts", () => ({
    ...realPaths,
    PHP_ROOT: join(phpFixture, "php"),
    PHP_FPM_BIN_DIR: join(phpFixture, "sbin"),
    LOCK_DIR: join(phpFixture, "lock"),
    CONFFILES_RELEASED_FLAG: join(phpFixture, "lock/conffiles-released"),
  }));

  const calls = [];
  let hasInstalledAddon = true;

  class TestFatal extends Error {}

  // System Tweaks' own repair writes /etc and runs systemctl; its tests drive it with fixtures.
  const realSystemTweaks = await import("./addons/system-tweaks/action.ts");
  mock.module("./addons/system-tweaks/action.ts", () => ({ ...realSystemTweaks, systemTweaksMaintenance: async () => null }));

  const realProvision = await import("./cli/provision.ts?repair-test-real");
  mock.module("./lib/version.ts", () => ({ CLI_VERSION: "1.2.3", DEV_VERSION: "0.0.0-dev" }));
  mock.module("./cli/release.ts", () => ({
    resolveRelease: async () => ({ tag: "v1.2.3", assets: new Map() }),
    fetchVerified: async (_release, names = []) => names.map((name) => ({ name, bytes: Buffer.from(name, "utf-8") })),
    verifyAttestation: async () => {},
    loadLocal: (_dir, names = []) => names.map((name) => ({ name, bytes: Buffer.from(name, "utf-8") })),
  }));

  const { daemonReload } = await import("./lib/systemd.ts");
  mock.module("./lib/systemd.ts", () => ({ unitActive: () => "active", daemonReload }));
  const __catalog = await import("./addons/catalog.ts");
  const __enabled = () => hasInstalledAddon;
  // Every addon counts as enabled here, so the Nginx block one keeps in CloudPanel's files is left alone.
  const __addons = Object.fromEntries(Object.entries(__catalog.ADDONS).map(([name, spec]) =>
    [name, spec.panelBlock ? { ...spec, panelBlock: { ...spec.panelBlock, reconcile: () => true } } : spec]));
  mock.module("./addons/catalog.ts", () => ({ ...__catalog, ADDONS: __addons, addonEnabled: __enabled, enabledAddons: () => Object.values(__addons).filter(__enabled) }));
  mock.module("./cli/provision.ts", () => ({
    ...realProvision,
    ensureDirs: (_specs, verifySession) => {
      calls.push(verifySession ? "ensureDirs:verifySession" : "ensureDirs");
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
    reconcilePanelIdentity: () => calls.push("reconcilePanelIdentity"),
    installUnits: () => { calls.push("installUnits"); return false; },
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
    inspectTemplates: () => [],
    inspect: () => ({ state: "ok" }),
    inspectNginxProxy: () => ({ state: "missing" }),
    masterVhostHost: () => null,
    purgeTwigCache: () => calls.push("purgeInjectCache"),
    reconcile: () => {
      calls.push("reconcile");
      return { statuses: [], changed: false, rebaselined: [] };
    },
    reconcileNginxProxy: () => {
      calls.push("reconcileNginxProxy");
      return { state: "ok", changed: false };
    },
  }));

  const __realLog = await import("./lib/log.ts");
  // Installing writes the binary and its manifest under /usr/local and /var/lib.
  const { writeFileAtomic } = await import("./lib/atomic-write.ts");
  mock.module("./lib/atomic-write.ts", () => ({
    writeFileAtomic: (path, ...rest) => path.startsWith(tmpdir()) ? writeFileAtomic(path, ...rest) : undefined,
  }));
  mock.module("./lib/log.ts", () => ({
    ...__realLog,
    Fatal: TestFatal,
    fatal: (message) => { throw new TestFatal(message); },
    log: { step: () => {}, ok: (message) => calls.push("ok:" + message), warn: () => {}, err: () => {}, plain: () => {} },
    requireRoot: () => {},
  }));
  const __realCommand = await import("./lib/command.ts");
  mock.module("./lib/command.ts", () => ({
    ...__realCommand,
    run: () => "",
    tryRun: (cmd) => ({ ok: !cmd.startsWith(phpFixture), out: "fixture FPM rejected configuration" }),
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
    hasInstalledAddon = true;
    let threw = false;
    try {
      await cmdRepair(["--quiet"]);
    } catch {
      threw = true;
    }
    return { threw, calls: [...calls] };
  }

  const repairWithoutSession = await repairResult();

  calls.length = 0;
  hasInstalledAddon = false;
  let installError;
  try {
    await cmdInstall(["stager", "--local=/tmp/does-not-matter"]);
  } catch (error) {
    installError = String(error?.stack ?? error);
  }

  const installWithoutSession = { error: installError, calls: [...calls] };
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
  repairWithoutSession: { threw: boolean; calls: string[] };
  installWithoutSession: { error?: string; calls: string[] };
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
});

test("repair checks persistent enablement for every installed timer", () => {
  expect(result.repairWithoutSession.calls).toContain("ensureTimerArmed:clp-addons-reconcile.timer");
});

test("install proceeds when the fixed directory has no live panel session", () => {
  expect(result.installWithoutSession.error).toBeUndefined();
  expect(result.installWithoutSession.calls).toContain("ensureDirs:verifySession");
  expect(result.installWithoutSession.calls).toContain("ensureAuthHelperReady");
  expect(result.installWithoutSession.calls).toContain("reconcilePanelIdentity");
  expect(result.installWithoutSession.calls).toContain("installUnits");
});
