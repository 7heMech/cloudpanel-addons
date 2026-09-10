// Exercise the production delete function with isolated paths and command doubles.
// The .test.ts suffix keeps this suite in Bun's default discovery set.
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const REPO = join(import.meta.dir, "..");
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
    writeFileSync(`${data}/meta.json`, JSON.stringify({ siteCreatedByAddon: true, port: 39000 }));

    const bin = `${root}/bin`;
    mkdirSync(bin, { recursive: true });

    writeFileSync(`${bin}/docker`, `#!/bin/sh
if [ "$SCENARIO" = "docker-fails" ]; then exit 1; fi
if [ "$1" = "ps" ]; then echo instatic-example.com; else echo docker-removed >> "$TEST_ROOT/actions"; fi
`, { mode: 0o755 });

    writeFileSync(`${bin}/mock_panel`, `#!/bin/sh
echo panel-deleted >> "$TEST_ROOT/actions"
if [ "$SCENARIO" = "panel-fails" ]; then exit 1; fi
`, { mode: 0o755 });

    writeFileSync(`${bin}/tar`, `#!/bin/sh
if [ "$SCENARIO" = "archive-fails" ]; then exit 1; fi
exec /usr/bin/tar "$@"
`, { mode: 0o755 });

    const idPath = `${root}/panel-identity.conf`;
    writeFileSync(idPath, "PRIMARY=panel.example.com\nALIASES=\n");
    chmodSync(idPath, 0o600);

    const dbPath = `${root}/panel.db`;
    if (scenario === "database-fails") {
      writeFileSync(dbPath, "NOT A SQLITE DATABASE");
    } else {
      const db = new Database(dbPath);
      db.run("CREATE TABLE site (domain_name TEXT, type TEXT, reverse_proxy_url TEXT)");
      if (scenario === "present" || scenario === "panel-fails" || scenario === "archive-fails" || scenario === "docker-fails") {
        db.run("INSERT INTO site VALUES ('example.com', 'reverse-proxy', 'http://127.0.0.1:39000')");
      } else if (scenario === "changed-site") {
        db.run("INSERT INTO site VALUES ('example.com', 'php', '')");
      }
      db.close();
    }

    const result = spawnSync("bun", ["run", "cli/index.ts", "action", "instatic", "delete", "--domain", "example.com", "--confirm", "example.com"], {
      cwd: REPO,
      encoding: "utf8",
      env: {
        ...process.env,
        SCENARIO: scenario,
        TEST_ROOT: root,
        PATH: `${bin}:${process.env.PATH}`,
        DATA_BASE_DIR: `${root}/instances`,
        BACKUP_DIR: `${root}/backups`,
        PANEL_DB: dbPath,
        CLPCTL: `${bin}/mock_panel`,
        PANEL_IDENTITY_FILE: idPath,
      },
    });

    const successful = ["missing", "present"].includes(scenario);
    expect(result.status === 0, `${scenario}: ${outputText(result.stdout)} ${outputText(result.stderr)}`).toBe(successful);
    expect(existsSync(data), `${scenario}: data retention`).toBe(!successful);
    const actions = existsSync(`${root}/actions`) ? outputText(readFileSync(`${root}/actions`, "utf8")) : "";
    if (["archive-fails", "database-fails", "changed-site", "docker-fails"].includes(scenario)) expect(actions).toBe("");
    if (scenario === "missing") expect(actions).toBe("docker-removed\n");
    if (scenario === "present") expect(actions).toBe("docker-removed\npanel-deleted\n");
    if (scenario === "panel-fails") expect(actions).toBe("docker-removed\npanel-deleted\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
