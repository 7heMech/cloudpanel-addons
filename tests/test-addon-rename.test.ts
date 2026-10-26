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
function migrate(root: string, revert = false): { warnings: string[] } {
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
    const { migrateOldAddonNames, revertAddonRenames } = await import("./cli/addons.ts");
    const renames = migrateOldAddonNames();
    if (${revert}) revertAddonRenames(renames);
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

test("with state under both names nothing is renamed, and the operator is told which to keep", () => {
  const root = fixture();
  writeFileSync(join(root, "etc", "wp-login.conf"), "# clp-addons: wp-login\n");
  mkdirSync(join(root, "state", "wp-login"));
  writeFileSync(join(root, "state", "wp-login", "mainwp.json"), "old");
  mkdirSync(join(root, "state", "wp-tools"));
  writeFileSync(join(root, "state", "wp-tools", "mainwp.json"), "new");
  expect(migrate(root).warnings[0]).toContain("both hold state");
  expect(readFileSync(join(root, "etc", "wp-login.conf"), "utf8")).toBe("# clp-addons: wp-login\n");
  expect(existsSync(join(root, "etc", "wp-tools.conf"))).toBe(false);
  expect(readFileSync(join(root, "state", "wp-tools", "mainwp.json"), "utf8")).toBe("new");
  expect(readFileSync(join(root, "state", "wp-login", "mainwp.json"), "utf8")).toBe("old");
});

test("a failed update hands the addon back under its old name to the binary it restores", () => {
  const root = fixture();
  writeFileSync(join(root, "etc", "wp-login.conf"), "# clp-addons: wp-login\nRUN_AS=clp-addons\n");
  mkdirSync(join(root, "state", "wp-login"));
  writeFileSync(join(root, "state", "wp-login", "mainwp.json"), "{}");
  migrate(root, true);
  expect(readFileSync(join(root, "etc", "wp-login.conf"), "utf8")).toBe("# clp-addons: wp-login\nRUN_AS=clp-addons\n");
  expect(existsSync(join(root, "etc", "wp-tools.conf"))).toBe(false);
  expect(readFileSync(join(root, "state", "wp-login", "mainwp.json"), "utf8")).toBe("{}");
  expect(existsSync(join(root, "state", "wp-tools"))).toBe(false);
});

test("an empty old state directory is cleared away rather than reported every repair", () => {
  const root = fixture();
  mkdirSync(join(root, "state", "wp-login"));
  mkdirSync(join(root, "state", "wp-tools"));
  writeFileSync(join(root, "state", "wp-tools", "mainwp.json"), "new");
  expect(migrate(root).warnings).toEqual([]);
  expect(existsSync(join(root, "state", "wp-login"))).toBe(false);
  expect(readFileSync(join(root, "state", "wp-tools", "mainwp.json"), "utf8")).toBe("new");
});
