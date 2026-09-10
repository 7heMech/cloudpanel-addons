import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_INSTATIC_ACTION_PATHS, deleteInstaticInstance, type InstaticActionPaths,
} from "../addons/instatic/action";
import { ActionFailure } from "../cli/action-common";

const SCENARIOS = ["missing", "present", "archive-fails", "database-fails", "docker-fails", "panel-fails", "changed-site"] as const;

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
}

for (const scenario of SCENARIOS) test.serial(`delete ${scenario}`, () => {
  const root = mkdtempSync(join(tmpdir(), "delete-test-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const actions = join(root, "actions");
    const data = join(root, "instances", "example.com");
    const panelDb = join(root, "panel.db");
    const panel = join(bin, "clpctl");
    const docker = join(bin, "docker");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "meta.json"), JSON.stringify({
      domain: "example.com", port: 39000, siteCreatedByAddon: true,
    }));

    if (scenario !== "database-fails") {
      const db = new Database(panelDb);
      db.run("CREATE TABLE site (domain_name TEXT, type TEXT, reverse_proxy_url TEXT, user TEXT);");
      if (scenario !== "missing") {
        const url = scenario === "changed-site" ? "http://127.0.0.1:39001" : "http://127.0.0.1:39000";
        db.query("INSERT INTO site (domain_name, type, reverse_proxy_url, user) VALUES (?, 'reverse-proxy', ?, 'addon-user');")
          .run("example.com", url);
      }
      db.close();
    }

    executable(docker, `
if [ "$1" = ps ]; then
  echo instatic-example.com
  exit 0
fi
if [ "${scenario}" = docker-fails ]; then exit 1; fi
printf 'docker-removed\\n' >> '${actions}'
`);
    executable(panel, `
printf 'panel-deleted\\n' >> '${actions}'
if [ "${scenario}" = panel-fails ]; then exit 1; fi
`);

    const backupDir = join(root, "backups");
    if (scenario === "archive-fails") writeFileSync(backupDir, "not a directory");
    const paths: InstaticActionPaths = {
      ...DEFAULT_INSTATIC_ACTION_PATHS,
      lockDir: join(root, "locks"),
      dataBaseDir: join(root, "instances"),
      backupDir,
      panelDb,
      clpctl: panel,
      panelIdentityFile: join(root, "identity"),
      sqlite3: "sqlite3",
    };

    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    let successful = false;
    try {
      deleteInstaticInstance({ domain: "example.com", confirm: "example.com" }, paths);
      successful = true;
    } catch (error) {
      expect(error instanceof ActionFailure || error instanceof Error).toBe(true);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }

    const expectedSuccess = scenario === "missing" || scenario === "present";
    expect(successful, scenario).toBe(expectedSuccess);
    expect(existsSync(data), `${scenario}: data retention`).toBe(!expectedSuccess);
    const actionLog = existsSync(actions) ? readFileSync(actions, "utf8") : "";
    if (["archive-fails", "database-fails", "changed-site"].includes(scenario)) expect(actionLog).toBe("");
    if (scenario === "missing") expect(actionLog).toBe("docker-removed\n");
    if (scenario === "present") expect(actionLog).toBe("docker-removed\npanel-deleted\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
