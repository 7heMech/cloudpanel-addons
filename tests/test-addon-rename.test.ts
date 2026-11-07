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
function migrate(root: string, revert = false): { warnings: string[]; error?: string } {
  const script = `
    import { mock } from "bun:test";
    import { writeFileSync } from "node:fs";
    const root = ${JSON.stringify(root)};
    const warnings = [];
    const realPaths = await import("./cli/paths.ts");
    mock.module("./cli/paths.ts", () => ({ ...realPaths, CONFIG_DIR: root + "/etc", STATE_DIR: root + "/state", LOCK_DIR: root + "/locks", SYSTEMD_DIR: root + "/systemd" }));
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
    let error;
    try {
      const renames = migrateOldAddonNames();
      if (${revert}) revertAddonRenames(renames);
    } catch (caught) { error = caught.message; }
    process.stdout.write(JSON.stringify({ warnings, error }));
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

function save(root: string, file: string, value: unknown): void {
  const path = join(root, "state", file);
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}

for (const enabled of [true, false]) {
  test(`PHP Resources migration keeps its policy and ${enabled ? "enabled" : "disabled"} record`, () => {
    const root = fixture();
    if (enabled) writeFileSync(join(root, "etc/php-resources.conf"), "# clp-addons: php-resources\n");
    const policy = { version: 1, categories: [{ id: "custom" }], assignments: { "site.test": "custom" }, defaultCategoryId: "custom" };
    save(root, "php-resources/policy.json", policy);
    migrate(root);
    expect(existsSync(join(root, "etc/php-resources.conf"))).toBe(false);
    expect(existsSync(join(root, "state/php-resources"))).toBe(false);
    expect(existsSync(join(root, "etc/resource-limits.conf"))).toBe(enabled);
    expect(JSON.parse(readFileSync(join(root, "state/resource-limits/policy.json"), "utf8"))).toEqual(policy);
    migrate(root);
    expect(existsSync(join(root, "etc/resource-limits.conf"))).toBe(enabled);
  });
}

for (const enabled of [true, false]) {
  for (const protectedMemory of [true, false]) {
    test(`saved staging memory survives with System Tweaks ${enabled ? "on" : "off"} and protections ${protectedMemory ? "on" : "off"}`, () => {
      const root = fixture();
      if (enabled) writeFileSync(join(root, "etc/system-tweaks.conf"), "# clp-addons: system-tweaks\n");
      const memory = { profile: "cache", mysql: protectedMemory, redis: protectedMemory, oom: protectedMemory };
      const hardening = { version: 1, databaseLoopback: true, rootLocks: { ssh: true } };
      save(root, "system-tweaks/settings.json", { ...hardening, memory });
      save(root, "system-tweaks/memory.json", { mysqlRemovedAt: 1234, redisCapped: true });
      migrate(root);
      expect(JSON.parse(readFileSync(join(root, "state/resource-limits/settings.json"), "utf8"))).toEqual({ version: 1, memory });
      expect(JSON.parse(readFileSync(join(root, "state/system-tweaks/settings.json"), "utf8"))).toEqual(hardening);
      expect(JSON.parse(readFileSync(join(root, "state/resource-limits/memory.json"), "utf8"))).toEqual({ mysqlRemovedAt: 1234, redisCapped: true });
      expect(existsSync(join(root, "state/system-tweaks/memory.json"))).toBe(false);
      expect(existsSync(join(root, "etc/resource-limits.conf"))).toBe(enabled && protectedMemory);
      // Repeated repair must not turn a later-disabled addon back on.
      rmSync(join(root, "etc/resource-limits.conf"), { force: true });
      migrate(root);
      expect(existsSync(join(root, "etc/resource-limits.conf"))).toBe(false);
    });
  }
}

test("a failed update restores both original addons and memory runtime state", () => {
  const root = fixture();
  writeFileSync(join(root, "etc/php-resources.conf"), "# clp-addons: php-resources\n");
  writeFileSync(join(root, "etc/system-tweaks.conf"), "# clp-addons: system-tweaks\n");
  const memory = { profile: "database", mysql: true, redis: false, oom: true };
  save(root, "php-resources/policy.json", { version: 1, assignments: { "shop.test": "lite" } });
  save(root, "system-tweaks/settings.json", { version: 1, memory, databaseLoopback: true });
  save(root, "system-tweaks/memory.json", { redisCapped: true });
  migrate(root, true);
  expect(existsSync(join(root, "etc/php-resources.conf"))).toBe(true);
  expect(existsSync(join(root, "etc/resource-limits.conf"))).toBe(false);
  expect(existsSync(join(root, "state/resource-limits"))).toBe(false);
  expect(JSON.parse(readFileSync(join(root, "state/system-tweaks/settings.json"), "utf8")).memory).toEqual(memory);
  expect(existsSync(join(root, "state/system-tweaks/memory.json"))).toBe(true);
  expect(existsSync(join(root, "state/php-resources/policy.json"))).toBe(true);
});

test("an early dev install's default OOM protection migrates without saved settings", () => {
  const root = fixture();
  writeFileSync(join(root, "etc/system-tweaks.conf"), "# clp-addons: system-tweaks\n");
  mkdirSync(join(root, "systemd/nginx.service.d"), { recursive: true });
  writeFileSync(join(root, "systemd/nginx.service.d/zz-clp-addons-oom.conf"), "# Managed by clp-addons System Tweaks: when memory runs out\n");
  migrate(root);
  expect(existsSync(join(root, "etc/resource-limits.conf"))).toBe(true);
  expect(JSON.parse(readFileSync(join(root, "state/resource-limits/settings.json"), "utf8")).memory.oom).toBe(true);
});

test("invalid saved memory aborts and restores the PHP rename instead of enabling defaults", () => {
  const root = fixture();
  writeFileSync(join(root, "etc/php-resources.conf"), "# clp-addons: php-resources\n");
  save(root, "php-resources/policy.json", { version: 1, categories: [] });
  save(root, "system-tweaks/settings.json", { version: 1, memory: { profile: "wrong", oom: false } });
  expect(migrate(root).error).toContain("invalid System Tweaks memory settings");
  expect(existsSync(join(root, "etc/php-resources.conf"))).toBe(true);
  expect(existsSync(join(root, "etc/resource-limits.conf"))).toBe(false);
  expect(existsSync(join(root, "state/php-resources/policy.json"))).toBe(true);
  expect(existsSync(join(root, "state/resource-limits"))).toBe(false);
});

test("conflicting memory settings are both kept and the operator sees a failure", () => {
  const root = fixture();
  const source = { profile: "database", mysql: true, redis: false, oom: true };
  const target = { ...source, profile: "cache", mysql: false };
  save(root, "system-tweaks/settings.json", { version: 1, memory: source });
  save(root, "resource-limits/settings.json", { version: 1, memory: target });
  expect(migrate(root).error).toContain("different memory settings");
  expect(JSON.parse(readFileSync(join(root, "state/system-tweaks/settings.json"), "utf8")).memory).toEqual(source);
  expect(JSON.parse(readFileSync(join(root, "state/resource-limits/settings.json"), "utf8")).memory).toEqual(target);
});

test("enabled PHP with disabled System Tweaks does not reactivate saved memory protections", () => {
  const root = fixture();
  writeFileSync(join(root, "etc/php-resources.conf"), "# clp-addons: php-resources\n");
  save(root, "php-resources/policy.json", { version: 1, categories: [] });
  save(root, "system-tweaks/settings.json", { version: 1, memory: { profile: "cache", mysql: true, redis: true, oom: true } });
  expect(migrate(root).error).toBeUndefined();
  expect(existsSync(join(root, "etc/resource-limits.conf"))).toBe(true);
  expect(JSON.parse(readFileSync(join(root, "state/resource-limits/settings.json"), "utf8")).memory)
    .toEqual({ profile: "cache", mysql: false, redis: false, oom: false });
});

test("retrying an upgrade before upkeep rewrites the old OOM marker keeps the migrated policy", () => {
  const root = fixture();
  writeFileSync(join(root, "etc/system-tweaks.conf"), "# clp-addons: system-tweaks\n");
  const memory = { profile: "database", mysql: true, redis: false, oom: true };
  save(root, "system-tweaks/settings.json", { version: 1, memory });
  mkdirSync(join(root, "systemd/nginx.service.d"), { recursive: true });
  writeFileSync(join(root, "systemd/nginx.service.d/zz-clp-addons-oom.conf"), "# Managed by clp-addons System Tweaks: when memory runs out\n");
  expect(migrate(root).error).toBeUndefined();
  expect(migrate(root).error).toBeUndefined();
  expect(JSON.parse(readFileSync(join(root, "state/resource-limits/settings.json"), "utf8")).memory).toEqual(memory);
});
