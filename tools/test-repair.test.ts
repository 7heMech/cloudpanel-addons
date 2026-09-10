// Regression coverage for the unattended repair path aborting whenever no CloudPanel
// operator session exists. `repair` runs unattended every 15 minutes via
// clp-addons-reconcile.timer; it must complete its reconciliation even when the panel
// session check would fail, while the interactive `install` path must keep failing loudly.
import { expect, mock, test } from "bun:test";
import * as realProvision from "../cli/provision";

const calls: string[] = [];
let hasInstalledAddon = true;
// Flips whether a readable CloudPanel session exists. Modeled on the real contract,
// established separately in tools/test-provision.test.ts: ensureDirs(specs, true) throws
// when verifySession is requested and no session is available; warnIfPanelSessionUnreadable
// never throws, session or not.
let sessionAvailable = true;
const provisioning = {
  dirs: false,
  sudoers: false,
  units: false,
  snapshot: false,
  nginx: false,
};

function resetProvisioning(): void {
  Object.assign(provisioning, { dirs: false, sudoers: false, units: false, snapshot: false, nginx: false });
}

class TestFatal extends Error {}

function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
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

mock.module("../cli/release", () => ({
  CLI_VERSION: "1.2.3",
  resolveRelease: async () => ({ tag: "v1.2.3", assets: new Map<string, string>() }),
  fetchVerified: async (_release: unknown, names: string[] = []) =>
    names.map((name) => ({ name, bytes: Buffer.from(name, "utf-8") })),
  verifyAttestation: async () => {},
  loadLocal: (_dir: string, names: string[] = []) => names.map((name) => ({ name, bytes: Buffer.from(name, "utf-8") })),
}));

mock.module("../cli/provision", () => ({
  ...realProvision,
  ensureDirs: (_specs: unknown, verifySession?: boolean) => {
    calls.push(verifySession ? "ensureDirs:verifySession" : "ensureDirs");
    provisioning.dirs = true;
    // Faithful to the real ensurePanelSessionReadable contract (see
    // tools/test-provision.test.ts): asking ensureDirs to verify the session throws when
    // none is available. This is what makes the pre-fix cmdRepair (which called
    // ensureDirs(all, true) unconditionally) abort before any reconciliation ran.
    if (verifySession && !sessionAvailable) {
      throw new TestFatal("could not find a regular CloudPanel session owned by clp in /var/lib/php/sessions");
    }
  },
  warnIfPanelSessionUnreadable: () => {
    // Real contract: this never throws, session or not -- it only warns.
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
  writeConfig: (spec: { name: string }) => calls.push(`writeConfig:${spec.name}`),
}));

mock.module("../cli/inject", () => ({
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

mock.module("../cli/util", () => ({
  Fatal: TestFatal,
  fatal: (message: string): never => { throw new TestFatal(message); },
  log: { step: () => {}, ok: () => {}, warn: () => {}, err: () => {}, plain: () => {} },
  parseFlags,
  requireRoot: () => {},
  tryRun: () => ({ ok: true, out: "" }),
  writeAtomic: () => {},
}));

mock.module("../lib/panel-snapshot", () => ({
  generateSnapshot: () => { calls.push("generateSnapshot"); provisioning.snapshot = true; },
}));

const { cmdInstall, cmdRepair } = await import("../cli/index");

test("repair completes reconciliation even when no panel session exists", () => {
  calls.length = 0;
  resetProvisioning();
  hasInstalledAddon = true;
  sessionAvailable = false;

  expect(() => cmdRepair(["--quiet"])).not.toThrow();

  // The fix: ensureDirs is never asked to verify the session on the unattended path, and
  // the (non-fatal) warning check runs instead.
  expect(calls).not.toContain("ensureDirs:verifySession");
  expect(calls).toContain("ensureDirs");
  expect(calls).toContain("warnIfPanelSessionUnreadable");

  // Reconciliation must still run to completion.
  for (const name of ["installSudoers", "installUnits", "generateSnapshot", "reconcileNginxProxy"]) {
    expect(calls).toContain(name);
  }
  expect(provisioning).toEqual({ dirs: true, sudoers: true, units: true, snapshot: true, nginx: true });
});

test("repair still completes when a panel session is available", () => {
  calls.length = 0;
  resetProvisioning();
  hasInstalledAddon = true;
  sessionAvailable = true;

  expect(() => cmdRepair(["--quiet"])).not.toThrow();

  for (const name of ["installSudoers", "installUnits", "generateSnapshot", "reconcileNginxProxy"]) {
    expect(calls).toContain(name);
  }
});

test("install still fails loudly when no panel session exists (interactive path is unchanged)", async () => {
  calls.length = 0;
  resetProvisioning();
  hasInstalledAddon = false;
  sessionAvailable = false;

  // "stager" has no requiresUnits, so this reaches ensureDirs without needing to mock a
  // systemctl probe. --local skips the network release fetch entirely.
  await expect(cmdInstall(["stager", "--local=/tmp/does-not-matter"])).rejects.toThrow(TestFatal);

  expect(calls).toContain("ensureDirs:verifySession");
  // It must fail before any reconciliation step runs.
  expect(calls).not.toContain("installSudoers");
  expect(calls).not.toContain("installUnits");
  expect(calls).not.toContain("generateSnapshot");
});
