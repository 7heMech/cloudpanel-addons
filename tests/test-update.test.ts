import { expect, mock, test } from "bun:test";

// The mocks below are registered at import time and Bun keeps mock.module
// overrides for the life of the runtime, so this file only stays contained
// because the suite runs under `bun test --isolate`.
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { ARTIFACT_MANIFEST_PATH, CLI_ARTIFACT, CLI_BIN, LIBEXEC_DIR, LOCK_DIR } from "../cli/paths";
import * as realProvision from "../cli/provision";

const calls: string[] = [];
let hasInstalledAddon = true;
let artifactsAvailable = false;
let artifactTampered = false;
let resolvedReleaseTag = "v1.2.3";
let handoffFailure = false;
let manifestWriteFailure = false;
let previousIsSecure = true;
let keepAsideFailure = false;
/** null leaves the kept-aside manifest unreadable, as an out-of-band install does. */
let previousChecksum: string | null = null;
let managerUnitState = "active";

/** The operation the lock file names while it is held, if it is held. */
function lockedOperation(): string | null {
  try {
    return originalReadFileSync(join(LOCK_DIR, "operation.lock"), "utf8").split("\n")[0] || null;
  } catch {
    return null;
  }
}

const PREVIOUS_BIN = `${LIBEXEC_DIR}/clp-addons.previous`;
const PREVIOUS_MANIFEST = `${LIBEXEC_DIR}/artifacts.previous.json`;
const tracked = new Set([
  CLI_BIN, ARTIFACT_MANIFEST_PATH, PREVIOUS_BIN, PREVIOUS_MANIFEST,
  `${CLI_BIN}.rollback`, `${ARTIFACT_MANIFEST_PATH}.rollback`,
]);
/** Which of the tracked paths the box currently has. */
const present = new Set<string>();

function installedOnBox(binary: boolean, manifest = binary): void {
  present.clear();
  if (binary) present.add(CLI_BIN);
  if (manifest) present.add(ARTIFACT_MANIFEST_PATH);
}
const provisioning = {
  serviceUser: false,
  legacyInstall: true,
  dirs: false,
  sudoers: false,
  legacyUnits: true,
  legacyUsers: true,
  units: false,
  running: false,
  anchors: false,
  nginx: false,
};

function resetProvisioning(): void {
  resolvedReleaseTag = "v1.2.3";
  handoffFailure = false;
  manifestWriteFailure = false;
  previousIsSecure = true;
  keepAsideFailure = false;
  previousChecksum = null;
  managerUnitState = "active";
  installedOnBox(true);
  Object.assign(provisioning, {
    serviceUser: false,
    legacyInstall: true,
    dirs: false,
    sudoers: false,
    legacyUnits: true,
    legacyUsers: true,
    units: false,
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
const originalExistsSync = nodeFs.existsSync;
const originalMkdirSync = nodeFs.mkdirSync;
const originalRmSync = nodeFs.rmSync;
const originalLinkSync = nodeFs.linkSync;
const originalCopyFileSync = nodeFs.copyFileSync;
const originalRenameSync = nodeFs.renameSync;
class TestFatal extends Error {}

mock.module("node:fs", () => ({
  ...nodeFs,
  existsSync(path: string | URL) {
    const key = String(path);
    return tracked.has(key) ? present.has(key) : originalExistsSync(path);
  },
  mkdirSync(path: string | URL, options?: any) {
    const key = String(path);
    // The libexec directory is root-owned on a real box; the rest is the
    // temporary lock directory, which the test really does create.
    if (key.startsWith(LIBEXEC_DIR)) return undefined;
    return originalMkdirSync(path as any, options);
  },
  linkSync(from: string | URL, to: string | URL) {
    const source = String(from);
    const target = String(to);
    if (keepAsideFailure && target === PREVIOUS_BIN) throw new Error("no space left on device");
    if (!tracked.has(source) && !tracked.has(target)) return originalLinkSync(from, to);
    if (!present.has(source)) throw new Error(`no such file: ${source}`);
    calls.push(`link:${source}->${target}`);
    present.add(target);
  },
  copyFileSync(from: string | URL, to: string | URL) {
    const source = String(from);
    const target = String(to);
    if (keepAsideFailure && target === PREVIOUS_BIN) throw new Error("no space left on device");
    if (!tracked.has(source) && !tracked.has(target)) return originalCopyFileSync(from, to);
    if (!present.has(source)) throw new Error(`no such file: ${source}`);
    calls.push(`copy:${source}->${target}`);
    present.add(target);
  },
  renameSync(from: string | URL, to: string | URL) {
    const source = String(from);
    const target = String(to);
    if (!tracked.has(source) && !tracked.has(target)) return originalRenameSync(from, to);
    calls.push(`rename:${source}->${target}`);
    present.delete(source);
    present.add(target);
  },
  rmSync(path: string | URL, options?: any) {
    const key = String(path);
    if (tracked.has(key)) {
      present.delete(key);
      return undefined;
    }
    return originalRmSync(path as any, options);
  },
  lstatSync(path: string | URL, ...rest: unknown[]) {
    const key = String(path);
    if (artifactsAvailable && (key === ARTIFACT_MANIFEST_PATH || artifactBytes.has(key))) {
      return {
        isFile: () => true,
        uid: 0,
        mode: key === ARTIFACT_MANIFEST_PATH ? 0o100600 : 0o100755,
      } as ReturnType<typeof nodeFs.lstatSync>;
    }
    // The kept-aside pair is checked before it is restored, so the test has to
    // be able to say it is there and whether it is root-owned and unwritable.
    if (tracked.has(key) && present.has(key)) {
      return {
        isFile: () => true,
        uid: previousIsSecure ? 0 : 1000,
        mode: key.endsWith(".json") ? 0o100600 : 0o100755,
      } as ReturnType<typeof nodeFs.lstatSync>;
    }
    return originalLstatSync(path, ...(rest as Parameters<typeof originalLstatSync> extends [any, ...infer T] ? T : never));
  },
  readFileSync(path: string | URL | number, options?: any) {
    const key = String(path);
    if (artifactsAvailable && key === ARTIFACT_MANIFEST_PATH) {
      return options === undefined || typeof options === "object" ? Buffer.from(artifactManifest) : artifactManifest;
    }
    if (previousChecksum !== null && key === PREVIOUS_MANIFEST) {
      const saved = JSON.stringify({ version: 1, tag: "1.1.0", artifacts: { [CLI_ARTIFACT]: previousChecksum } });
      return options === undefined || typeof options === "object" ? Buffer.from(saved) : saved;
    }
    if (previousChecksum !== null && key === PREVIOUS_BIN) {
      const kept = Buffer.from("kept-aside binary", "utf-8");
      return typeof options === "string" ? kept.toString(options as BufferEncoding) : kept;
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
    return { tag: resolvedReleaseTag, assets: new Map<string, string>() };
  },
  fetchVerified: async (_release: unknown, names: string[] = []) => {
    calls.push("fetchVerified");
    return names.map((name) => ({ name, bytes: Buffer.from(name, "utf-8") }));
  },
  verifyAttestation: async () => {
    calls.push("verifyAttestation");
  },
  loadLocal: (_dir: string, names: string[]) => {
    calls.push("loadLocal");
    return names.map((name) => ({ name, bytes: Buffer.from(name, "utf-8") }));
  },
}));

mock.module("../cli/provision", () => ({
  ...realProvision,
  ensureDirs: () => { calls.push("ensureDirs"); provisioning.dirs = true; },
  ensureAuthHelperReady: () => calls.push("ensureAuthHelperReady"),
  ensureServiceUser: () => { calls.push("ensureServiceUser"); provisioning.serviceUser = true; },
  ensureTimerArmed: record("ensureTimerArmed"),
  hardenBackups: record("hardenBackups"),
  reconcilePanelIdentity: () => { calls.push("reconcilePanelIdentity"); provisioning.sudoers = true; },
  installUnits: () => { calls.push("installUnits"); provisioning.units = true; },
  installedConfig: () => hasInstalledAddon,
  purgeTwigCache: record("purgeTwigCache"),
  removeLegacyInstall: () => { calls.push("removeLegacyInstall"); provisioning.legacyInstall = false; },
  removeLegacyUnits: () => { calls.push("removeLegacyUnits"); provisioning.legacyUnits = false; },
  removeLegacyUsers: () => { calls.push("removeLegacyUsers"); provisioning.legacyUsers = false; },
  removeSudoers: record("removeSudoers"),
  startUnits: (options?: { beforeManagerRestart?: () => void }) => {
    options?.beforeManagerRestart?.();
    calls.push("startUnits");
    provisioning.running = true;
  },
  stopUnits: record("stopUnits"),
  unitActive: () => managerUnitState,
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
  Fatal: TestFatal,
  fatal: (message: string): never => { throw new Error(message); },
  log: { step: () => {}, ok: (msg: string) => { calls.push(`log.ok:${msg}`); }, warn: (msg: string) => { calls.push(`log.warn:${msg}`); }, err: () => {}, plain: () => {} },
  parseFlags: (argv: string[]) => {
    const flags: Record<string, string | true> = {};
    for (const arg of argv) {
      if (!arg.startsWith("--")) continue;
      const equal = arg.indexOf("=");
      flags[arg.slice(2, equal === -1 ? undefined : equal)] = equal === -1 ? true : arg.slice(equal + 1);
    }
    return { positional: argv.filter((arg) => !arg.startsWith("--")), flags };
  },
  requireRoot: () => {},
  run: (cmd: string, args: string[]) => {
    calls.push(`run:${cmd} ${args.join(" ")}`);
    if (handoffFailure && cmd === CLI_BIN && args[0] === "update") throw new Error("target handoff failed");
    return "";
  },
  tryRun: (cmd: string, args: string[]) => {
    calls.push(`tryRun:${cmd} ${args.join(" ")}`);
    return { ok: true, out: "" };
  },
  writeAtomic: (path: string) => {
    calls.push(`writeAtomic:${path}`);
    if (manifestWriteFailure && path === ARTIFACT_MANIFEST_PATH) throw new Error("manifest write failed");
    const operation = lockedOperation();
    if (operation) calls.push(`locked:${operation}:${path}`);
    if (tracked.has(path)) present.add(path);
  },
}));

mock.module("../lib/panel-snapshot", () => ({
  getLivePanelInfo: () => ({
    updatedAt: new Date().toISOString(),
    portRange: { min: 39000, max: 39999 },
    allocatedPorts: [],
    sites: [],
  }),
}));

const { cmdInstall } = await import("../cli/install");
const { cmdUpdate } = await import("../cli/update");
const handoffCall = (tag: string, ...args: string[]) =>
  `run:${CLI_BIN} ${["update", ...args, `--version=${tag}`, "--no-self-update", "--updated-from=1.2.3"].join(" ")}`;

test("install enables bundled addons with no release checks or gh, even when all addons were disabled", async () => {
  for (const enabled of [true, false]) {
    calls.length = 0;
    resetProvisioning();
    hasInstalledAddon = enabled;
    artifactsAvailable = false;
    await cmdInstall(["stager"]);
    expect(calls).not.toContain("resolveRelease");
    expect(calls).not.toContain("fetchVerified");
    expect(calls).not.toContain("verifyAttestation");
    expect(calls).not.toContain("loadLocal");
    expect(calls).not.toContain(`writeAtomic:${CLI_BIN}`);
    for (const name of ["ensureDirs", "ensureAuthHelperReady", "writeConfig:stager", "installUnits", "startUnits", "reconcile", "reconcileNginxProxy"]) {
      expect(calls).toContain(name);
    }
  }
});

test("install with an explicit release verifies artifacts before replacing the binary", async () => {
  calls.length = 0;
  resetProvisioning();
  hasInstalledAddon = false;
  await cmdInstall(["stager", "--version=v1.2.3"]);
  expect(calls).toContain("resolveRelease");
  expect(calls).toContain("fetchVerified");
  expect(calls).toContain("verifyAttestation");
  expect(calls.indexOf(`writeAtomic:${CLI_BIN}`)).toBeGreaterThan(calls.indexOf("verifyAttestation"));
  expect(calls).toContain("startUnits");
});

test("bootstrap local artifacts are checked without invoking the remote verifier", async () => {
  calls.length = 0;
  resetProvisioning();
  await cmdInstall(["stager", "--local=/tmp/bootstrap"]);
  expect(calls).toContain("loadLocal");
  expect(calls).not.toContain("resolveRelease");
  expect(calls).not.toContain("verifyAttestation");
  expect(calls).toContain(`writeAtomic:${CLI_BIN}`);
  expect(calls).toContain("startUnits");
});

test.each([{ flags: ["--version"] }, { flags: ["--local"] }, { flags: ["--version=v1.2.3", "--local=/tmp/bootstrap"] }])("install refuses incomplete or conflicting artifact flags %j", async ({ flags }) => {
  calls.length = 0;
  await expect(cmdInstall(["stager", ...flags])).rejects.toThrow();
  expect(calls).not.toContain("writeConfig:stager");
});

test("an update hands provisioning to the installed target binary", async () => {
  calls.length = 0;
  resetProvisioning();
  hasInstalledAddon = true;
  artifactsAvailable = false;
  artifactTampered = false;

  await cmdUpdate(["--version=v1.2.3"]);

  expect(calls).toContain("fetchVerified");
  expect(calls).toContain("verifyAttestation");
  expect(calls).toContain(handoffCall("v1.2.3", "--version=v1.2.3"));
  expect(calls.indexOf(handoffCall("v1.2.3", "--version=v1.2.3"))).toBeGreaterThan(calls.indexOf(`writeAtomic:${CLI_BIN}`));
  expect(calls).not.toContain("reconcile");
  expect(calls).not.toContain("startUnits");
  expect(provisioning).toEqual({
    serviceUser: false,
    legacyInstall: true,
    dirs: false,
    sudoers: false,
    legacyUnits: true,
    legacyUsers: true,
    units: false,
    running: false,
    anchors: false,
    nginx: false,
  });
});

test("the update handoff pins a latest release to the version it installed", async () => {
  calls.length = 0;
  resetProvisioning();
  artifactsAvailable = false;
  resolvedReleaseTag = "v1.3.0";

  await cmdUpdate([]);

  expect(calls).toContain(handoffCall("v1.3.0"));
  expect(calls).not.toContain("reconcile");
  expect(calls).not.toContain("startUnits");
});

test("a failed target-binary handoff rolls back without outgoing-process provisioning", async () => {
  calls.length = 0;
  resetProvisioning();
  artifactsAvailable = false;
  resolvedReleaseTag = "v1.3.0";
  handoffFailure = true;

  try {
    await expect(cmdUpdate([])).rejects.toThrow("rolled the binary and its manifest back; the box is running clp-addons 1.2.3");
  } finally {
    handoffFailure = false;
  }

  expect(calls).toContain(handoffCall("v1.3.0"));
  expect(calls).not.toContain("reconcile");
  expect(calls).not.toContain("startUnits");
  // The binary and the manifest go back together: restoring one without the
  // other leaves the box claiming a version it is not running.
  expect(calls).toContain(`rename:${CLI_BIN}.rollback->${CLI_BIN}`);
  expect(calls).toContain(`rename:${ARTIFACT_MANIFEST_PATH}.rollback->${ARTIFACT_MANIFEST_PATH}`);
  expect(calls).toContain("tryRun:systemctl restart clp-addons-auth.socket clp-addons-auth.service clp-addons.service");
  expect(present.has(CLI_BIN)).toBe(true);
  expect(present.has(ARTIFACT_MANIFEST_PATH)).toBe(true);
});

test("an update takes the operation lock before it writes anything, and releases it", async () => {
  calls.length = 0;
  resetProvisioning();
  artifactsAvailable = false;
  resolvedReleaseTag = "v1.3.0";

  await cmdUpdate([]);

  expect(calls).toContain(`locked:update:${CLI_BIN}`);
  expect(calls.indexOf(`locked:update:${CLI_BIN}`)).toBeLessThan(calls.indexOf(handoffCall("v1.3.0")));
  expect(lockedOperation()).toBeNull();
});

test("the operation lock is released when the update fails", async () => {
  calls.length = 0;
  resetProvisioning();
  artifactsAvailable = false;
  resolvedReleaseTag = "v1.3.0";
  handoffFailure = true;

  try {
    await expect(cmdUpdate([])).rejects.toThrow("rolled the binary and its manifest back");
  } finally {
    handoffFailure = false;
  }

  expect(lockedOperation()).toBeNull();
});

test("an update keeps the replaced binary for the next rollback", async () => {
  calls.length = 0;
  resetProvisioning();
  artifactsAvailable = false;
  resolvedReleaseTag = "v1.3.0";

  await cmdUpdate([]);

  expect(calls).toContain(`link:${CLI_BIN}->${LIBEXEC_DIR}/clp-addons.previous`);
  expect(calls.indexOf(`link:${CLI_BIN}->${LIBEXEC_DIR}/clp-addons.previous`))
    .toBeLessThan(calls.indexOf(`writeAtomic:${CLI_BIN}`));
  expect(present.has(`${LIBEXEC_DIR}/clp-addons.previous`)).toBe(true);
  expect(present.has(`${LIBEXEC_DIR}/artifacts.previous.json`)).toBe(true);
});

test("an update with no earlier binary says so rather than pretending to roll back", async () => {
  calls.length = 0;
  resetProvisioning();
  artifactsAvailable = false;
  resolvedReleaseTag = "v1.3.0";
  handoffFailure = true;
  installedOnBox(false);

  try {
    await expect(cmdUpdate([])).rejects.toThrow("no usable earlier binary was kept");
  } finally {
    handoffFailure = false;
  }

  expect(calls).not.toContain(`rename:${CLI_BIN}.rollback->${CLI_BIN}`);
});

test("a replacement that fails part-way rolls back as far as the handoff does", async () => {
  calls.length = 0;
  resetProvisioning();
  artifactsAvailable = false;
  resolvedReleaseTag = "v1.3.0";
  manifestWriteFailure = true;

  try {
    await expect(cmdUpdate([])).rejects.toThrow("rolled the binary and its manifest back; the box is running clp-addons 1.2.3");
  } finally {
    manifestWriteFailure = false;
  }

  // The binary was already swapped when the manifest write failed, so the box
  // must not be left on it.
  expect(calls).not.toContain(handoffCall("v1.3.0"));
  expect(calls).toContain(`rename:${CLI_BIN}.rollback->${CLI_BIN}`);
  expect(calls).toContain(`rename:${ARTIFACT_MANIFEST_PATH}.rollback->${ARTIFACT_MANIFEST_PATH}`);
});

test("a kept-aside binary that is not root-owned and unwritable is not restored", async () => {
  calls.length = 0;
  resetProvisioning();
  artifactsAvailable = false;
  resolvedReleaseTag = "v1.3.0";
  handoffFailure = true;
  previousIsSecure = false;

  try {
    await expect(cmdUpdate([])).rejects.toThrow("no usable earlier binary was kept");
  } finally {
    handoffFailure = false;
    previousIsSecure = true;
  }

  expect(calls).not.toContain(`rename:${CLI_BIN}.rollback->${CLI_BIN}`);
});

test.each([
  { name: "agrees with", checksum: Bun.CryptoHasher.hash("sha256", Buffer.from("kept-aside binary", "utf-8"), "hex"), warns: false },
  { name: "disagrees with", checksum: "0".repeat(64), warns: true },
])("a kept-aside binary that $name its manifest is restored either way", async ({ checksum, warns }) => {
  calls.length = 0;
  resetProvisioning();
  artifactsAvailable = false;
  resolvedReleaseTag = "v1.3.0";
  handoffFailure = true;
  previousChecksum = checksum;

  try {
    await expect(cmdUpdate([])).rejects.toThrow("rolled the binary and its manifest back");
  } finally {
    handoffFailure = false;
    previousChecksum = null;
  }

  // Refusing on a mismatch would leave the box on the binary that just failed.
  expect(calls).toContain(`rename:${CLI_BIN}.rollback->${CLI_BIN}`);
  const warned = calls.some((call) => call.startsWith("log.warn:") && call.includes("does not match the checksum"));
  expect(warned).toBe(warns);
});

test("an update that cannot keep the running binary aside never starts", async () => {
  calls.length = 0;
  resetProvisioning();
  artifactsAvailable = false;
  resolvedReleaseTag = "v1.3.0";
  keepAsideFailure = true;

  try {
    await expect(cmdUpdate([])).rejects.toThrow("could not keep the running binary aside, so the update was not started");
  } finally {
    keepAsideFailure = false;
  }

  // Nothing was replaced, so there is nothing to roll back and nothing to say
  // about which version the box is running.
  expect(calls).not.toContain(`writeAtomic:${CLI_BIN}`);
  expect(calls).not.toContain(handoffCall("v1.3.0"));
  expect(calls).not.toContain(`rename:${CLI_BIN}.rollback->${CLI_BIN}`);
});

test("a handoff that leaves the manager down rolls back too", async () => {
  calls.length = 0;
  resetProvisioning();
  artifactsAvailable = false;
  resolvedReleaseTag = "v1.3.0";
  managerUnitState = "failed";

  await expect(cmdUpdate([])).rejects.toThrow("rolled the binary and its manifest back; the box is running clp-addons 1.2.3");

  expect(calls).toContain(handoffCall("v1.3.0"));
  expect(calls).toContain(`rename:${CLI_BIN}.rollback->${CLI_BIN}`);
});

test("the handed-off target binary finalizes all provisioning before restarting services", async () => {
  calls.length = 0;
  resetProvisioning();
  hasInstalledAddon = true;
  artifactsAvailable = true;

  await cmdUpdate(["--version=v1.2.3", "--no-self-update", "--updated-from=1.1.0"]);

  for (const name of [
    "ensureServiceUser",
    "removeLegacyInstall",
    "ensureDirs",
    "reconcilePanelIdentity",
    "removeLegacyUnits",
    "removeLegacyUsers",
    "installUnits",
    "reconcile",
    "reconcileNginxProxy",
    "startUnits",
  ]) {
    expect(calls).toContain(name);
  }
  expect(calls).toContain("writeConfig:instatic");
  expect(calls).toContain("writeConfig:stager");
  expect(calls.some((call) => call.startsWith(`run:${CLI_BIN} update`))).toBe(false);
  expect(calls).toContain("log.ok:clp-addons updated from 1.1.0 to 1.2.3");
  expect(calls.indexOf("startUnits")).toBeGreaterThan(calls.indexOf("reconcile"));
  expect(calls.indexOf("startUnits")).toBeGreaterThan(calls.indexOf("reconcileNginxProxy"));
  expect(provisioning).toEqual({
    serviceUser: true,
    legacyInstall: false,
    dirs: true,
    sudoers: true,
    legacyUnits: false,
    legacyUsers: false,
    units: true,
    running: true,
    anchors: true,
    nginx: true,
  });
  artifactsAvailable = false;
});

test("the update handoff invokes restart marker before spawning the target binary", async () => {
  calls.length = 0;
  resetProvisioning();
  artifactsAvailable = false;
  resolvedReleaseTag = "v1.3.0";
  let markerCalls = 0;

  await cmdUpdate([], {
    beforeManagerRestart: () => {
      markerCalls++;
      calls.push("beforeManagerRestart");
    },
  });

  expect(markerCalls).toBe(1);
  expect(calls).toContain(handoffCall("v1.3.0"));
  expect(calls.indexOf("beforeManagerRestart")).toBeLessThan(calls.indexOf(handoffCall("v1.3.0")));
});

test("the update calls its restart marker immediately before service restart", async () => {
  calls.length = 0;
  resetProvisioning();
  hasInstalledAddon = true;
  artifactsAvailable = true;
  let markerCalls = 0;

  await cmdUpdate(
    ["--version=v1.2.3", "--no-self-update", "--updated-from=1.1.0"],
    { beforeManagerRestart: () => { markerCalls++; calls.push("beforeManagerRestart"); } },
  );

  expect(markerCalls).toBe(1);
  expect(calls.indexOf("beforeManagerRestart")).toBeLessThan(calls.indexOf("startUnits"));
  artifactsAvailable = false;
});

test("the update handoff refuses to provision from the outgoing process", async () => {
  calls.length = 0;
  resetProvisioning();
  artifactsAvailable = false;
  resolvedReleaseTag = "v1.3.0";

  await expect(cmdUpdate(["--version=v1.3.0", "--no-self-update"])).rejects.toThrow(
    "update handoff expected 1.3.0 but the running process is 1.2.3",
  );
  expect(calls.some((call) => call.startsWith(`run:${CLI_BIN} update`))).toBe(false);
  expect(calls).not.toContain("startUnits");
});

test("an up-to-date update with no addons keeps the no-service branch", async () => {
  calls.length = 0;
  resetProvisioning();
  hasInstalledAddon = false;
  artifactsAvailable = true;
  artifactTampered = false;
  resolvedReleaseTag = "v1.2.3";

  await cmdUpdate(["--version=v1.2.3"]);

  expect(calls).not.toContain("fetchVerified");
  expect(calls).not.toContain("verifyAttestation");
  expect(calls.some((call) => call.startsWith(`run:${CLI_BIN} update`))).toBe(false);
  expect(calls).toContain("reconcile");
  expect(calls).toContain("startUnits");
  expect(calls.filter((c) => c.startsWith("writeConfig:"))).toHaveLength(0);
  expect(calls).toContain("log.ok:clp-addons 1.2.3 is up to date");
  expect(provisioning).toEqual({
    serviceUser: true,
    legacyInstall: false,
    dirs: true,
    sudoers: true,
    legacyUnits: false,
    legacyUsers: false,
    units: true,
    running: true,
    anchors: true,
    nginx: true,
  });
  artifactsAvailable = false;
});

test("updating from a fully disabled state still hands off to the target binary", async () => {
  calls.length = 0;
  resetProvisioning();
  hasInstalledAddon = false;
  artifactsAvailable = false;
  artifactTampered = false;
  resolvedReleaseTag = "v1.3.0";

  await cmdUpdate(["--version=v1.3.0"]);

  expect(calls).toContain("fetchVerified");
  expect(calls).toContain("verifyAttestation");
  expect(calls).toContain(handoffCall("v1.3.0", "--version=v1.3.0"));
  expect(calls.filter((c) => c.startsWith("writeConfig:"))).toHaveLength(0);
  expect(calls.some((call) => call.startsWith("log.ok:clp-addons updated"))).toBe(false);
  expect(provisioning).toEqual({
    serviceUser: false,
    legacyInstall: true,
    dirs: false,
    sudoers: false,
    legacyUnits: true,
    legacyUsers: true,
    units: false,
    running: false,
    anchors: false,
    nginx: false,
  });
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
  expect(calls.some((call) => call.startsWith(`run:${CLI_BIN} update`))).toBe(false);
  expect(calls).toContain("reconcile");
  expect(calls).toContain("startUnits");
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
  expect(calls).toContain(handoffCall("v1.2.3", "--version=v1.2.3"));
  artifactsAvailable = false;
  artifactTampered = false;
});
