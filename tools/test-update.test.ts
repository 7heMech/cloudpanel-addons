import { expect, mock, test } from "bun:test";
import * as nodeFs from "node:fs";
import { ARTIFACT_MANIFEST_PATH, CLI_ARTIFACT, CLI_BIN } from "../cli/paths";
import * as realProvision from "../cli/provision";

const calls: string[] = [];
let hasInstalledAddon = true;
let artifactsAvailable = false;
let artifactTampered = false;
const provisioning = {
  serviceUser: false,
  legacyInstall: true,
  dirs: false,
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

const installedArtifacts = [
  { name: CLI_ARTIFACT, path: CLI_BIN },
];
const artifactBytes = new Map(installedArtifacts.map(({ path }) => [path, Buffer.from(path, "utf-8")]));
const artifactChecksums = Object.fromEntries(installedArtifacts.map(({ name, path }) => [
  name,
  Bun.CryptoHasher.hash("sha256", artifactBytes.get(path)!, "hex"),
]));
const artifactManifest = JSON.stringify({ version: 1, tag: "1.2.3", artifacts: artifactChecksums });
const originalLstatSync = nodeFs.lstatSync;
const originalReadFileSync = nodeFs.readFileSync;

mock.module("node:fs", () => ({
  ...nodeFs,
  lstatSync(path: string | URL, ...rest: unknown[]) {
    const key = String(path);
    if (artifactsAvailable && (key === ARTIFACT_MANIFEST_PATH || artifactBytes.has(key))) {
      return {
        isFile: () => true,
        uid: 0,
        mode: key === ARTIFACT_MANIFEST_PATH ? 0o100600 : 0o100755,
      } as ReturnType<typeof nodeFs.lstatSync>;
    }
    return originalLstatSync(path, ...(rest as Parameters<typeof originalLstatSync> extends [any, ...infer T] ? T : never));
  },
  readFileSync(path: string | URL | number, options?: any) {
    const key = String(path);
    if (artifactsAvailable && key === ARTIFACT_MANIFEST_PATH) {
      return options === undefined || typeof options === "object" ? Buffer.from(artifactManifest) : artifactManifest;
    }
    const bytes = artifactsAvailable ? artifactBytes.get(key) : undefined;
    if (bytes) {
      const content = artifactTampered && key === CLI_BIN ? Buffer.from("tampered", "utf-8") : bytes;
      return typeof options === "string" ? content.toString(options as BufferEncoding) : content;
    }
    return originalReadFileSync(path as any, options as any);
  },
}));

mock.module("../cli/release", () => ({
  CLI_VERSION: "1.2.3",
  resolveRelease: async () => {
    calls.push("resolveRelease");
    return { tag: "v1.2.3", assets: new Map<string, string>() };
  },
  fetchVerified: async (_release: unknown, names: string[] = []) => {
    calls.push("fetchVerified");
    return names.map((name) => ({ name, bytes: Buffer.from(name, "utf-8") }));
  },
  verifyAttestation: async () => {
    calls.push("verifyAttestation");
  },
  loadLocal: () => [],
}));

mock.module("../cli/provision", () => ({
  ...realProvision,
  ensureDirs: () => { calls.push("ensureDirs"); provisioning.dirs = true; },
  ensureAuthHelperReady: () => calls.push("ensureAuthHelperReady"),
  ensureServiceUser: () => { calls.push("ensureServiceUser"); provisioning.serviceUser = true; },
  ensureTimerArmed: record("ensureTimerArmed"),
  hardenBackups: record("hardenBackups"),
  installSudoers: () => { calls.push("installSudoers"); provisioning.sudoers = true; },
  installUnits: () => { calls.push("installUnits"); provisioning.units = true; },
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
  artifactsAvailable = false;
  artifactTampered = false;

  await cmdUpdate(["--version=v1.2.3"]);

  expect(calls).toContain("fetchVerified");
  expect(calls).toContain("verifyAttestation");
  for (const name of [
    "ensureServiceUser",
    "removeLegacyInstall",
    "ensureDirs",
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
  artifactsAvailable = false;
  artifactTampered = false;

  await cmdUpdate(["--version=v1.2.3"]);

  expect(calls).toContain("fetchVerified");
  expect(calls).toContain("verifyAttestation");
  expect(calls).toContain("ensureServiceUser");
  expect(calls).toContain("removeLegacyUnits");
  expect(calls).toContain("removeLegacyUsers");
  expect(calls).toContain("installSudoers");
  expect(calls).not.toContain("installUnits");
  expect(calls).not.toContain("generateSnapshot");
  expect(calls).not.toContain("startUnits");
  expect(calls).not.toContain("reconcileNginxProxy");
});

test("a same-version update reuses verified installed artifacts", async () => {
  calls.length = 0;
  resetProvisioning();
  hasInstalledAddon = true;
  artifactsAvailable = true;
  artifactTampered = false;

  await cmdUpdate(["--version=v1.2.3"]);

  expect(calls).not.toContain("fetchVerified");
  expect(calls).not.toContain("verifyAttestation");
  expect(calls).toContain("installUnits");
  expect(calls).toContain("reconcileNginxProxy");
  artifactsAvailable = false;
});

test("a same-version update repairs a changed installed artifact", async () => {
  calls.length = 0;
  resetProvisioning();
  hasInstalledAddon = true;
  artifactsAvailable = true;
  artifactTampered = true;

  await cmdUpdate(["--version=v1.2.3"]);

  expect(calls).toContain("fetchVerified");
  expect(calls).toContain("verifyAttestation");
  artifactsAvailable = false;
  artifactTampered = false;
});
