// Regression coverage for the unattended repair path aborting whenever no CloudPanel
// operator session exists. `repair` runs unattended every 15 minutes via
// clp-addons-reconcile.timer; it must complete its reconciliation even when the panel
// session check would fail, while the interactive `install` path must keep failing loudly.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");

// Keep the module mocks inside a child process. Bun keeps mock.module overrides for the
// whole test process, and a top-level repair mock can otherwise replace cli/inject for a
// later test file when the test runner discovers files in a different order.
const PROBE = String.raw`
  import { mock } from "bun:test";

  const calls = [];
  let hasInstalledAddon = true;
  let sessionAvailable = true;
  const provisioning = {
    dirs: false,
    sudoers: false,
    units: false,
    snapshot: false,
    nginx: false,
  };

  function resetProvisioning() {
    Object.assign(provisioning, { dirs: false, sudoers: false, units: false, snapshot: false, nginx: false });
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
      // Faithful to the real ensurePanelSessionReadable contract: asking ensureDirs to
      // verify the session throws when none is available. This makes the pre-fix repair
      // call fail before any reconciliation can run.
      if (verifySession && !sessionAvailable) {
        throw new TestFatal("could not find a regular CloudPanel session owned by clp in /var/lib/php/sessions");
      }
    },
    warnIfPanelSessionUnreadable: () => {
      // The real repair helper never throws; it only records a warning.
      calls.push("warnIfPanelSessionUnreadable");
    },
    ensureServiceUser: () => calls.push("ensureServiceUser"),
    ensureTimerArmed: () => calls.push("ensureTimerArmed"),
    hardenBackups: () => calls.push("hardenBackups"),
    installSudoers: () => { calls.push("installSudoers"); provisioning.sudoers = true; },
    installUnits: () => { calls.push("installUnits"); provisioning.units = true; return false; },
    installedConfig: () => hasInstalledAddon,
    purgeTwigCache: () => calls.push("purgeTwigCache"),
    removeLegacyInstall: () => calls.push("removeLegacyInstall"),
    removeLegacyUnits: () => calls.push("removeLegacyUnits"),
    removeLegacyUsers: () => calls.push("removeLegacyUsers"),
    removeSudoers: () => calls.push("removeSudoers"),
    startUnits: () => calls.push("startUnits"),
    stopUnits: () => calls.push("stopUnits"),
    unitActive: () => "active",
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
    log: { step: () => {}, ok: () => {}, warn: () => {}, err: () => {}, plain: () => {} },
    parseFlags,
    requireRoot: () => {},
    tryRun: () => ({ ok: true, out: "" }),
    writeAtomic: () => {},
  }));

  mock.module("./lib/panel-snapshot.ts", () => ({
    generateSnapshot: () => { calls.push("generateSnapshot"); provisioning.snapshot = true; },
  }));

  const { cmdInstall, cmdRepair } = await import("./cli/index.ts");

  function repairResult(session) {
    calls.length = 0;
    resetProvisioning();
    hasInstalledAddon = true;
    sessionAvailable = session;
    let threw = false;
    try {
      cmdRepair(["--quiet"]);
    } catch {
      threw = true;
    }
    return { threw, calls: [...calls], provisioning: { ...provisioning } };
  }

  const repairWithoutSession = repairResult(false);
  const repairWithSession = repairResult(true);

  calls.length = 0;
  resetProvisioning();
  hasInstalledAddon = false;
  sessionAvailable = false;
  let installThrew = false;
  try {
    await cmdInstall(["stager", "--local=/tmp/does-not-matter"]);
  } catch (error) {
    installThrew = error instanceof TestFatal;
  }

  process.stdout.write(JSON.stringify({
    repairWithoutSession,
    repairWithSession,
    installWithoutSession: { threw: installThrew, calls: [...calls], provisioning: { ...provisioning } },
  }));
`;

function runProbe(): {
  repairWithoutSession: { threw: boolean; calls: string[]; provisioning: Record<string, boolean> };
  repairWithSession: { threw: boolean; calls: string[]; provisioning: Record<string, boolean> };
  installWithoutSession: { threw: boolean; calls: string[]; provisioning: Record<string, boolean> };
} {
  const result = spawnSync(process.execPath, ["-e", PROBE], { cwd: REPO, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

const result = runProbe();

test("repair completes reconciliation even when no panel session exists", () => {
  expect(result.repairWithoutSession.threw).toBe(false);
  expect(result.repairWithoutSession.calls).not.toContain("ensureDirs:verifySession");
  expect(result.repairWithoutSession.calls).toContain("ensureDirs");
  expect(result.repairWithoutSession.calls).toContain("warnIfPanelSessionUnreadable");
  for (const name of ["installSudoers", "installUnits", "generateSnapshot", "reconcileNginxProxy"]) {
    expect(result.repairWithoutSession.calls).toContain(name);
  }
  expect(result.repairWithoutSession.provisioning).toEqual({
    dirs: true,
    sudoers: true,
    units: true,
    snapshot: true,
    nginx: true,
  });
});

test("repair still completes when a panel session is available", () => {
  expect(result.repairWithSession.threw).toBe(false);
  for (const name of ["installSudoers", "installUnits", "generateSnapshot", "reconcileNginxProxy"]) {
    expect(result.repairWithSession.calls).toContain(name);
  }
});

test("install still fails loudly when no panel session exists (interactive path is unchanged)", () => {
  expect(result.installWithoutSession.threw).toBe(true);
  expect(result.installWithoutSession.calls).toContain("ensureDirs:verifySession");
  expect(result.installWithoutSession.calls).not.toContain("installSudoers");
  expect(result.installWithoutSession.calls).not.toContain("installUnits");
  expect(result.installWithoutSession.calls).not.toContain("generateSnapshot");
});
