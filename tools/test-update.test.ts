import { expect, mock, test } from "bun:test";

const calls: string[] = [];
let hasInstalledAddon = true;
const provisioning = {
  serviceUser: false,
  legacyInstall: true,
  dirs: false,
  hmacKey: false,
  sudoers: false,
  legacyUnits: true,
  legacyUsers: true,
  units: false,
  snapshot: false,
  running: false,
  anchors: false,
  nginx: false,
};

function resetProvisioning(): void {
  Object.assign(provisioning, {
    serviceUser: false,
    legacyInstall: true,
    dirs: false,
    hmacKey: false,
    sudoers: false,
    legacyUnits: true,
    legacyUsers: true,
    units: false,
    snapshot: false,
    running: false,
    anchors: false,
    nginx: false,
  });
}

function record(name: string): (...args: unknown[]) => void {
  return (..._args: unknown[]) => calls.push(name);
}

mock.module("../cli/release", () => ({
  CLI_VERSION: "1.2.3",
  resolveRelease: async () => {
    calls.push("resolveRelease");
    return { tag: "v1.2.3", assets: new Map<string, string>() };
  },
  fetchVerified: async () => {
    calls.push("fetchVerified");
    return [];
  },
  verifyAttestation: async () => {
    calls.push("verifyAttestation");
  },
  loadLocal: () => [],
}));

mock.module("../cli/provision", () => ({
  ensureDirs: () => { calls.push("ensureDirs"); provisioning.dirs = true; },
  ensureHmacKey: () => { calls.push("ensureHmacKey"); provisioning.hmacKey = true; },
  ensureServiceUser: () => { calls.push("ensureServiceUser"); provisioning.serviceUser = true; },
  ensureTimerArmed: record("ensureTimerArmed"),
  hardenBackups: record("hardenBackups"),
  installSessionValidator: record("installSessionValidator"),
  installSudoers: () => { calls.push("installSudoers"); provisioning.sudoers = true; },
  installUnits: () => { calls.push("installUnits"); provisioning.units = true; },
  installWrapper: record("installWrapper"),
  installedConfig: () => hasInstalledAddon,
  purgeTwigCache: record("purgeTwigCache"),
  removeLegacyInstall: () => { calls.push("removeLegacyInstall"); provisioning.legacyInstall = false; },
  removeLegacyUnits: () => { calls.push("removeLegacyUnits"); provisioning.legacyUnits = false; },
  removeLegacyUsers: () => { calls.push("removeLegacyUsers"); provisioning.legacyUsers = false; },
  removeSudoers: record("removeSudoers"),
  startUnits: () => { calls.push("startUnits"); provisioning.running = true; },
  stopUnits: record("stopUnits"),
  unitActive: () => "inactive",
  unitPid: () => null,
  writeConfig: (spec: { name: string }) => calls.push(`writeConfig:${spec.name}`),
}));

mock.module("../cli/inject", () => ({
  KNOWN_GOOD_PANEL_VERSIONS: [],
  inspect: () => ({ state: "ok" }),
  inspectNginxProxy: () => ({ state: "missing" }),
  masterVhostHost: () => null,
  panelVersion: () => "test",
  purgeTwigCache: record("purgeInjectCache"),
  reconcile: () => {
    calls.push("reconcile");
    provisioning.anchors = true;
    return { statuses: [], changed: false };
  },
  reconcileNginxProxy: () => {
    calls.push("reconcileNginxProxy");
    provisioning.nginx = true;
    return { state: "ok", changed: false };
  },
}));

mock.module("../cli/util", () => ({
  Fatal: class Fatal extends Error {},
  fatal: (message: string): never => { throw new Error(message); },
  log: { step: () => {}, ok: () => {}, warn: () => {}, err: () => {}, plain: () => {} },
  parseFlags: (argv: string[]) => {
    const flags: Record<string, string | true> = {};
    for (const arg of argv) {
      if (!arg.startsWith("--")) continue;
      const equal = arg.indexOf("=");
      flags[arg.slice(2, equal === -1 ? undefined : equal)] = equal === -1 ? true : arg.slice(equal + 1);
    }
    return { positional: [], flags };
  },
  requireRoot: () => {},
  tryRun: () => ({ ok: true, out: "" }),
  writeAtomic: () => {},
}));

mock.module("../lib/panel-snapshot", () => ({
  generateSnapshot: () => { calls.push("generateSnapshot"); provisioning.snapshot = true; },
}));

const { cmdUpdate } = await import("../cli/index");

test("an up-to-date update still runs provisioning and reconciliation", async () => {
  calls.length = 0;
  resetProvisioning();
  hasInstalledAddon = true;

  await cmdUpdate(["--version=v1.2.3"]);

  expect(calls).not.toContain("fetchVerified");
  expect(calls).not.toContain("verifyAttestation");
  for (const name of [
    "ensureServiceUser",
    "removeLegacyInstall",
    "ensureDirs",
    "ensureHmacKey",
    "installSudoers",
    "removeLegacyUnits",
    "removeLegacyUsers",
    "installUnits",
    "generateSnapshot",
    "startUnits",
    "reconcile",
    "reconcileNginxProxy",
  ]) {
    expect(calls).toContain(name);
  }
  expect(calls).toContain("writeConfig:instatic");
  expect(calls).toContain("writeConfig:stager");
  expect(provisioning).toEqual({
    serviceUser: true,
    legacyInstall: false,
    dirs: true,
    hmacKey: true,
    sudoers: true,
    legacyUnits: false,
    legacyUsers: false,
    units: true,
    snapshot: true,
    running: true,
    anchors: true,
    nginx: true,
  });
});

test("an up-to-date update with no addons keeps the no-service branch", async () => {
  calls.length = 0;
  resetProvisioning();
  hasInstalledAddon = false;

  await cmdUpdate(["--version=v1.2.3"]);

  expect(calls).not.toContain("fetchVerified");
  expect(calls).toContain("ensureServiceUser");
  expect(calls).toContain("removeLegacyUnits");
  expect(calls).toContain("removeLegacyUsers");
  expect(calls).toContain("installSudoers");
  expect(calls).not.toContain("installUnits");
  expect(calls).not.toContain("generateSnapshot");
  expect(calls).not.toContain("startUnits");
  expect(calls).not.toContain("reconcileNginxProxy");
});
