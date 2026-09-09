// Exercise the production delete function with isolated paths and command doubles.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const source = readFileSync("addons/instatic/wrapper/clp-action-instatic", "utf8").split("# --- argument parsing")[0]!;
for (const scenario of ["missing", "present", "archive-fails", "database-fails", "docker-fails", "panel-fails", "changed-site"]) {
  const root = mkdtempSync(`${tmpdir()}/delete-test-`);
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
  assert.equal(result.status === 0, successful, `${scenario}: ${result.stdout} ${result.stderr}`);
  assert.equal(existsSync(data), !successful, `${scenario}: data retention`);
  const actions = existsSync(`${root}/actions`) ? readFileSync(`${root}/actions`, "utf8") : "";
  if (["archive-fails", "database-fails", "changed-site"].includes(scenario)) assert.equal(actions, "");
  if (scenario === "missing") assert.equal(actions, "docker-removed\n");
  if (scenario === "present") assert.equal(actions, "docker-removed\npanel-deleted\n");
  rmSync(root, { recursive: true, force: true });
  console.log(`ok ${scenario}`);
}
