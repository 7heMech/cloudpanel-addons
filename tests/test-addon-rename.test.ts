import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "clp-rename-"));
  roots.push(root);
  mkdirSync(join(root, "etc"));
  mkdirSync(join(root, "state"));
  return root;
}

/** Runs the migration with the paths, config writer and log pointed at `root`. */
function migrate(root: string): { warnings: string[] } {
  const script = `
    import { mock } from "bun:test";
    import { writeFileSync } from "node:fs";
    const root = ${JSON.stringify(root)};
    const warnings = [];
    const realPaths = await import("./cli/paths.ts");
    mock.module("./cli/paths.ts", () => ({ ...realPaths, CONFIG_DIR: root + "/etc", STATE_DIR: root + "/state" }));
    const realProvision = await import("./cli/provision.ts");
    mock.module("./cli/provision.ts", () => ({
      ...realProvision,
      writeConfig: (spec) => writeFileSync(spec.configFile, "# clp-addons: " + spec.name + "\\n"),
    }));
    const realUtil = await import("./cli/util.ts");
    mock.module("./cli/util.ts", () => ({
      ...realUtil,
      log: { ...realUtil.log, ok: () => {}, warn: (message) => { warnings.push(message); } },
    }));
    const { migrateOldAddonNames } = await import("./cli/addons.ts");
    migrateOldAddonNames();
    process.stdout.write(JSON.stringify({ warnings }));
  `;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: repo, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}");
}

test("an enabled wp-login becomes wp-tools with its MainWP and Varnish state", () => {
  const root = fixture();
  writeFileSync(join(root, "etc", "wp-login.conf"), "# clp-addons: wp-login\n");
  mkdirSync(join(root, "state", "wp-login"));
  writeFileSync(join(root, "state", "wp-login", "mainwp.json"), "{\"connections\":[1]}");
  expect(migrate(root).warnings).toEqual([]);
  expect(existsSync(join(root, "etc", "wp-login.conf"))).toBe(false);
  expect(readFileSync(join(root, "etc", "wp-tools.conf"), "utf8")).toContain("wp-tools");
  expect(existsSync(join(root, "state", "wp-login"))).toBe(false);
  expect(readFileSync(join(root, "state", "wp-tools", "mainwp.json"), "utf8")).toBe("{\"connections\":[1]}");
  expect(migrate(root).warnings).toEqual([]);
});

test("a disabled wp-login keeps its state for re-enabling, and stays disabled", () => {
  const root = fixture();
  mkdirSync(join(root, "state", "wp-login"));
  writeFileSync(join(root, "state", "wp-login", "varnish.json"), "{}");
  migrate(root);
  expect(existsSync(join(root, "etc", "wp-tools.conf"))).toBe(false);
  expect(readFileSync(join(root, "state", "wp-tools", "varnish.json"), "utf8")).toBe("{}");
});

test("state already under the new name is never overwritten", () => {
  const root = fixture();
  writeFileSync(join(root, "etc", "wp-login.conf"), "");
  mkdirSync(join(root, "state", "wp-login"));
  writeFileSync(join(root, "state", "wp-login", "mainwp.json"), "old");
  mkdirSync(join(root, "state", "wp-tools"));
  writeFileSync(join(root, "state", "wp-tools", "mainwp.json"), "new");
  expect(migrate(root).warnings[0]).toContain("was left in place");
  expect(readFileSync(join(root, "state", "wp-tools", "mainwp.json"), "utf8")).toBe("new");
  expect(readFileSync(join(root, "state", "wp-login", "mainwp.json"), "utf8")).toBe("old");
});
