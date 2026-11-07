import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const repo = join(import.meta.dir, "..");
const root = mkdtempSync(`${tmpdir()}/uninstall-test-`);
const stateDir = join(root, "state");
const configFile = join(root, "instatic.conf");
const binary = join(root, "clp-addons");
const libexec = join(root, "libexec");
const identityPath = join(root, "panel-identity.conf");
const eventsPath = join(root, "events");

const childScript = String.raw`
import { mock } from "bun:test";
import { appendFileSync, existsSync, rmSync } from "node:fs";

const root = process.env.CLP_TEST_ROOT;
const configFile = root + "/instatic.conf";
const event = (name) => appendFileSync(root + "/events", name + "\n");

const realPaths = await import("./cli/paths.ts");
mock.module("./cli/paths.ts", () => ({
  ...realPaths,
  CLI_BIN: root + "/clp-addons",
  LIBEXEC_DIR: root + "/libexec",
  STATE_DIR: root + "/state",
}));
const realCatalog = await import("./cli/addon-catalog.ts");
mock.module("./cli/addon-catalog.ts", () => ({
  ...realCatalog,
  ADDONS: { ...realCatalog.ADDONS, instatic: { ...realCatalog.ADDONS.instatic, configFile } },
}));
const realProvision = await import("./cli/provision.ts");
mock.module("./cli/provision.ts", () => ({
  ...realProvision,
  installedConfig: (spec) => spec.configFile === configFile && existsSync(configFile),
  reconcilePanelIdentity: (_quiet, specs) => {
    if (specs?.length === 0) rmSync(root + "/panel-identity.conf", { force: true });
  },
  stopUnits: () => event("stopUnits"),
}));
mock.module("./cli/reconcile.ts", () => ({
  reconcileAnchors: (_quiet, _exclude, managerNav) => { event("anchors nav=" + managerNav); return true; },
  reconcileNginx: (_quiet, enabled) => { event("nginx " + enabled); return process.env.CLP_TEST_NGINX_FAILS !== "1"; },
}));
mock.module("./cli/php-guard.ts", () => ({ reconcilePhpGuard: (wanted) => event("phpGuard " + wanted) }));
mock.module("./cli/inject.ts", () => ({ purgeTwigCache: () => event("purgeTwigCache") }));
mock.module("./cli/operation-lock.ts", () => ({ withOperationLockSync: (_name, fn) => fn() }));
class TestFatal extends Error {}
const realUtil = await import("./cli/util.ts");
mock.module("./cli/util.ts", () => ({
  ...realUtil,
  Fatal: TestFatal,
  fatal: (message) => { throw new TestFatal(message); },
  log: { step: () => {}, ok: () => {}, warn: () => {}, err: () => {}, plain: () => {} },
  requireRoot: () => {},
}));

const { cmdSelfUninstall } = await import("./cli/uninstall.ts");
try {
  cmdSelfUninstall(JSON.parse(process.env.CLP_TEST_ARGS));
  console.log(JSON.stringify({ ok: true }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
}
`;

function uninstall(args: readonly string[], nginxFails = false): { ok: boolean; error?: string; events: string[] } {
  const result = spawnSync(process.execPath, ["-e", childScript], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, CLP_TEST_ROOT: root, CLP_TEST_ARGS: JSON.stringify(args), CLP_TEST_NGINX_FAILS: nginxFails ? "1" : "0" },
  });
  if (result.status !== 0) throw new Error(`uninstall harness failed: ${result.stderr || result.stdout}`);
  const events = existsSync(eventsPath) ? readFileSync(eventsPath, "utf8").trim().split("\n") : [];
  return { ...(JSON.parse(result.stdout.trim().split("\n").at(-1)!) as { ok: boolean; error?: string }), events };
}

beforeEach(() => {
  for (const path of [stateDir, libexec]) {
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(join(stateDir, "settings.json"), "{}\n");
  for (const path of [binary, identityPath]) writeFileSync(path, "x");
  rmSync(configFile, { force: true });
  rmSync(eventsPath, { force: true });
});

test("refuses while an addon is enabled and names the disable command", () => {
  writeFileSync(configFile, "RUN_AS=clp-addons\n");
  const result = uninstall(["--yes"]);
  expect(result.ok).toBe(false);
  expect(result.error).toContain("clp-addons disable instatic");
  expect(result.events).toEqual([]);
  expect(existsSync(binary)).toBe(true);
});

test("without --yes it only says what it would remove", () => {
  const result = uninstall([]);
  expect(result.ok).toBe(false);
  expect(result.error).toContain("Re-run with --yes");
  expect(result.events).toEqual([]);
  expect(existsSync(binary)).toBe(true);
});

test.each([{ args: ["instatic", "--yes"] }, { args: ["--purge", "--yes"] }])("refuses $args", ({ args }) => {
  const result = uninstall(args);
  expect(result.ok).toBe(false);
  expect(result.events).toEqual([]);
});

test("with every addon disabled it removes the installation and keeps addon data", () => {
  const result = uninstall(["--yes"]);
  expect(result).toEqual({
    ok: true,
    events: ["anchors nav=false", "nginx false", "purgeTwigCache", "stopUnits", "phpGuard false"],
  });
  for (const path of [binary, libexec, identityPath]) expect(existsSync(path)).toBe(false);
  expect(existsSync(join(stateDir, "settings.json"))).toBe(true);
});

test("a CloudPanel change it cannot undo stops it before the units or the binary go", () => {
  const result = uninstall(["--yes"], true);
  expect(result.ok).toBe(false);
  expect(result.error).toContain("still installed");
  expect(result.events).toEqual(["anchors nav=false", "nginx false"]);
  expect(existsSync(binary)).toBe(true);
  expect(existsSync(identityPath)).toBe(true);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));
