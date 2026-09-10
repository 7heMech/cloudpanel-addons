// Exercise the production delete function with isolated paths and command doubles.
// The .test.ts suffix keeps this suite in Bun's default discovery set.
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const source = readFileSync("addons/instatic/wrapper/clp-action-instatic", "utf8").split("# --- argument parsing")[0]!;
const SCENARIOS = ["missing", "present", "archive-fails", "database-fails", "docker-fails", "panel-fails", "changed-site"] as const;

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return value == null ? "" : String(value);
}

for (const scenario of SCENARIOS) test.serial(`delete ${scenario}`, () => {
  const root = mkdtempSync(`${tmpdir()}/delete-test-`);
  try {
    const data = `${root}/instances/example.com`;
    mkdirSync(data, { recursive: true });
    writeFileSync(`${data}/meta.json`, "{}");
    const isolated = source
      .replace('readonly DATA_BASE_DIR="/var/lib/clp-addons/instatic"', `readonly DATA_BASE_DIR="${root}/instances"`)
      .replace('readonly BACKUP_DIR="/var/backups/clp-addons/instatic"', `readonly BACKUP_DIR="${root}/backups"`)
      .replace('readonly CLPCTL="/usr/bin/clpctl"', 'readonly CLPCTL="mock_panel"');
    const script = isolated + `
read_meta() { if [[ $1 == siteCreatedByAddon ]]; then echo true; else echo 39000; fi; }
sqlite3() { [[ $SCENARIO != database-fails ]] || return 1; if [[ $SCENARIO == missing ]]; then echo 0; else echo 1; fi; }
site_is_our_proxy() { [[ $SCENARIO != changed-site ]]; }
make_snapshot() { [[ $SCENARIO != archive-fails ]] || return 1; touch "$2"; }
docker() {
  [[ $SCENARIO != docker-fails ]] || return 1
  if [[ $1 == ps ]]; then echo instatic-example.com; else echo docker-removed >> "$TEST_ROOT/actions"; fi
}
mock_panel() { echo panel-deleted >> "$TEST_ROOT/actions"; [[ $SCENARIO != panel-fails ]]; }
cmd_delete example.com example.com
`;
    const result = spawnSync("bash", [], { input: script, encoding: "utf8", env: { ...process.env, SCENARIO: scenario, TEST_ROOT: root } });
    const successful = ["missing", "present"].includes(scenario);
    expect(result.status === 0, `${scenario}: ${outputText(result.stdout)} ${outputText(result.stderr)}`).toBe(successful);
    expect(existsSync(data), `${scenario}: data retention`).toBe(!successful);
    const actions = existsSync(`${root}/actions`) ? outputText(readFileSync(`${root}/actions`, "utf8")) : "";
    if (["archive-fails", "database-fails", "changed-site"].includes(scenario)) expect(actions).toBe("");
    if (scenario === "missing") expect(actions).toBe("docker-removed\n");
    if (scenario === "present") expect(actions).toBe("docker-removed\npanel-deleted\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
