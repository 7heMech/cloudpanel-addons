import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const repo = join(import.meta.dir, "..");
const root = mkdtempSync(`${tmpdir()}/uninstall-test-`);
const legacyActionDir = join(root, "legacy-actions");
const stateDir = join(root, "state");
const configFile = join(root, "instatic.conf");
const actionBin = join(root, "clp-addons");
const identityPath = join(root, "panel-identity.conf");
const callsPath = join(root, "calls");
const identityReadsPath = join(root, "identity-reads");
const domains = ["alpha.example.test", "beta.example.test", "gamma.example.test"];
let failureDomain: string | undefined;

const action = String.raw`#!/bin/sh
set -eu
[ "$1" = action ] && [ "$2" = instatic ] && [ "$3" = delete ]
domain="$5"
printf '%s\n' "$domain" >> "$CLP_TEST_CALLS"
if [ ! -r "$CLP_TEST_IDENTITY" ]; then
  echo "panel identity is not readable" >&2
  exit 31
fi
printf '%s|' "$domain" >> "$CLP_TEST_IDENTITY_READS"
cat "$CLP_TEST_IDENTITY" >> "$CLP_TEST_IDENTITY_READS"
printf '\n' >> "$CLP_TEST_IDENTITY_READS"
if [ "$CLP_TEST_FAIL_DOMAIN" = "$domain" ]; then
  echo "simulated delete failure" >&2
  exit 7
fi
printf '%s\n' '{"ok":true,"data":{"status":"deleted"}}'
`;

const childScript = String.raw`
import { mock } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = process.env.CLP_TEST_ROOT;
const stateDir = process.env.CLP_TEST_STATE;
const configFile = process.env.CLP_TEST_CONFIG;
const actionBin = process.env.CLP_TEST_ACTION_BIN;
const identityPath = process.env.CLP_TEST_IDENTITY;
const legacyActionDir = process.env.CLP_TEST_LEGACY_ACTION_DIR;
if (!root || !stateDir || !configFile || !actionBin || !identityPath || !legacyActionDir) {
  throw new Error("test fixture environment is incomplete");
}

const spec = {
  name: "instatic",
  title: "Instatic",
  description: "test addon",
  configFile,
  requiresUnits: [],
  stateDir,
  targets: [],
};
let removeSudoersCalls = 0;

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

function tryAction(command, args) {
  if (command !== actionBin) return { ok: true, out: "" };
  const result = spawnSync(command, args, { encoding: "utf8", env: process.env });
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  return { ok: result.status === 0, out: (stderr || stdout || String(result.error ?? "")).trim() };
}

// Derived from the real module rather than hand-listed, so any export
// cli/index.ts (or anything it imports, e.g. cli/recon.ts) starts reading
// is picked up automatically. Only the paths the test deliberately redirects
// into the temp fixture root are overridden below.
const realPaths = await import("./cli/paths.ts");
mock.module("./cli/paths.ts", () => ({
  ...realPaths,
  ADDONS: { ...realPaths.ADDONS, instatic: spec },
  ARTIFACT_MANIFEST_PATH: root + "/artifacts.json",
  CLI_BIN: actionBin,
  LIBEXEC_DIR: legacyActionDir,
  SOCKET_PATH: root + "/manager.sock",
}));
mock.module("./cli/release.ts", () => ({
  CLI_VERSION: "1.0.0",
  fetchVerified: async () => [],
  loadLocal: () => [],
  resolveRelease: async () => ({ tag: "v1.0.0", assets: new Map() }),
  verifyAttestation: async () => {},
}));
// Derived from the real module for the same reason as the cli/paths.ts mock
// above: a hand-listed replacement silently turns any newly added export into
// undefined for every consumer reached through cli/index.ts. Every function
// below that touches the real system (users, sudoers, systemd units, the
// filesystem outside the test fixture) stays explicitly overridden; only
// exports the test does not care about are inherited from the real module.
const realProvision = await import("./cli/provision.ts");
mock.module("./cli/provision.ts", () => ({
  ...realProvision,
  ensureDirs: () => {},
  ensureServiceUser: () => {},
  ensureTimerArmed: () => {},
  hardenBackups: () => {},
  installSudoers: () => {},
  installUnits: () => {},
  installedConfig: () => existsSync(configFile),
  purgeTwigCache: () => {},
  removeLegacyInstall: () => {},
  removeLegacyUnits: () => {},
  removeLegacyUsers: () => {},
  removeSudoers: () => {
    removeSudoersCalls++;
    rmSync(identityPath, { force: true });
  },
  startUnits: () => {},
  stopUnits: () => {},
  unitActive: () => "inactive",
  unitPid: () => null,
  warnIfPanelSessionUnreadable: () => {},
  writeConfig: () => {},
}));
mock.module("./cli/inject.ts", () => ({
  KNOWN_GOOD_PANEL_VERSIONS: [],
  inspect: () => ({ state: "ok" }),
  inspectNginxProxy: () => ({ state: "missing" }),
  masterVhostHost: () => null,
  panelVersion: () => "test",
  purgeTwigCache: () => {},
  reconcile: () => ({ statuses: [], changed: false }),
  reconcileNginxProxy: () => ({ state: "missing", changed: false }),
}));
class TestFatal extends Error {}
mock.module("./cli/util.ts", () => ({
  Fatal: TestFatal,
  fatal: (message) => { throw new TestFatal(message); },
  log: { step: () => {}, ok: () => {}, warn: () => {}, err: () => {}, plain: () => {} },
  parseFlags,
  requireRoot: () => {},
  tryRun: tryAction,
  writeAtomic: () => {},
}));
mock.module("./lib/panel-snapshot.ts", () => ({ generateSnapshot: () => {} }));
mock.module("./lib/sso-auth.ts", () => ({ authenticateRequest: async () => ({ response: null }) }));
mock.module("./cli/auth-action.ts", () => ({ runAuthActionStdin: async () => 0 }));
mock.module("./addons/instatic/app/index.ts", () => ({ handle: async () => new Response() }));
mock.module("./addons/stager/app/index.ts", () => ({ handle: async () => new Response() }));
mock.module("./lib/mount.ts", () => ({ splitMount: () => null }));
mock.module("./lib/app-http.ts", () => ({ SECURITY_HEADERS: {}, esc: (value) => value, escJs: (value) => value }));
mock.module("./lib/app-ui.ts", () => ({ renderLayout: () => "" }));
mock.module("./lib/update-check.ts", () => ({ checkCliUpdate: async () => null }));

const { cmdUninstall } = await import("./cli/index.ts");
try {
  cmdUninstall(["instatic", "--yes", "--purge"]);
  console.log(JSON.stringify({ ok: true, removeSudoersCalls }));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    removeSudoersCalls,
  }));
}
`;

function resetFixture(): void {
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(legacyActionDir, { recursive: true });
  for (const domain of domains) {
    mkdirSync(join(stateDir, domain), { recursive: true });
    writeFileSync(join(stateDir, domain, "meta.json"), "{}\n");
  }
  writeFileSync(configFile, "RUN_AS=clp-addons\n");
  writeFileSync(identityPath, "PRIMARY=panel.example.test\nALIASES=\n");
  writeFileSync(actionBin, action, { mode: 0o755 });
  chmodSync(actionBin, 0o755);
  rmSync(callsPath, { force: true });
  rmSync(identityReadsPath, { force: true });
  failureDomain = undefined;
}

function runUninstall(): { ok: boolean; error?: string; removeSudoersCalls: number } {
  const result = spawnSync(process.execPath, ["-e", childScript], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      CLP_TEST_ROOT: root,
      CLP_TEST_STATE: stateDir,
      CLP_TEST_CONFIG: configFile,
      CLP_TEST_ACTION_BIN: actionBin,
      CLP_TEST_IDENTITY: identityPath,
      CLP_TEST_LEGACY_ACTION_DIR: legacyActionDir,
      CLP_TEST_FAIL_DOMAIN: failureDomain ?? "",
      CLP_TEST_CALLS: callsPath,
      CLP_TEST_IDENTITY_READS: identityReadsPath,
    },
  });
  if (result.status !== 0) {
    throw new Error(`uninstall harness failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout.trim()) as { ok: boolean; error?: string; removeSudoersCalls: number };
}

beforeEach(resetFixture);

test.serial("purge deletes every instance before removing panel identity", () => {
  const result = runUninstall();
  expect(result).toEqual({ ok: true, removeSudoersCalls: 1 });
  expect(readFileSync(callsPath, "utf8").trim().split("\n")).toEqual(domains);
  const identityReads = readFileSync(identityReadsPath, "utf8");
  for (const domain of domains) {
    expect(identityReads).toContain(`${domain}|PRIMARY=panel.example.test`);
  }
  expect(existsSync(identityPath)).toBe(false);
  expect(existsSync(stateDir)).toBe(false);
});

test.serial("purge preserves state and identity when an instance delete fails", () => {
  failureDomain = domains[1];
  const result = runUninstall();
  expect(result.ok).toBe(false);
  expect(result.removeSudoersCalls).toBe(0);
  expect(result.error).toBe(`could not remove instatic instances; state preserved for retry: ${failureDomain}`);
  expect(readFileSync(callsPath, "utf8").trim().split("\n")).toEqual(domains);
  const identityReads = readFileSync(identityReadsPath, "utf8");
  for (const domain of domains) {
    expect(identityReads).toContain(`${domain}|PRIMARY=panel.example.test`);
  }
  expect(existsSync(identityPath)).toBe(true);
  expect(existsSync(stateDir)).toBe(true);
  expect(existsSync(join(stateDir, failureDomain ?? "", "meta.json"))).toBe(true);
  expect(existsSync(configFile)).toBe(true);
  expect(existsSync(actionBin)).toBe(true);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));
