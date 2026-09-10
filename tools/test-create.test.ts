// Tests for create unwinding rollback (Finding 5) and docker logs stderr capture (Finding 10)
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const REPO = join(import.meta.dir, "..");

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return value == null ? "" : String(value);
}

test.serial("create unwinds and cleans up on docker pull failure", () => {
  const root = mkdtempSync(`${tmpdir()}/create-test-`);
  try {
    const bin = `${root}/bin`;
    mkdirSync(bin, { recursive: true });

    // Mock docker: ps returns nothing, pull exits 1, rm logs removal
    writeFileSync(`${bin}/docker`, `#!/bin/sh
if [ "$1" = "ps" ]; then
  exit 0
fi
if [ "$1" = "pull" ]; then
  echo "docker pull failed" >&2
  exit 1
fi
if [ "$1" = "rm" ]; then
  echo "docker-rm $2 $3" >> "$TEST_ROOT/actions"
  exit 0
fi
exit 0
`, { mode: 0o755 });

    // Mock clpctl: logs site:add and site:delete
    writeFileSync(`${bin}/mock_panel`, `#!/bin/sh
if [ "$1" = "site:add:reverse-proxy" ]; then
  echo "panel-site-added $2" >> "$TEST_ROOT/actions"
  exit 0
fi
if [ "$1" = "site:delete" ]; then
  echo "panel-site-deleted $2" >> "$TEST_ROOT/actions"
  exit 0
fi
exit 0
`, { mode: 0o755 });

    const idPath = `${root}/panel-identity.conf`;
    writeFileSync(idPath, "PRIMARY=panel.example.com\nALIASES=\n");
    chmodSync(idPath, 0o600);

    const dbPath = `${root}/panel.db`;
    const db = new Database(dbPath);
    db.run("CREATE TABLE site (domain_name TEXT, type TEXT, reverse_proxy_url TEXT, user TEXT)");
    db.close();

    const instancesDir = `${root}/instances`;
    const lockDir = `${root}/lock`;
    mkdirSync(lockDir, { recursive: true });

    const result = spawnSync("bun", [
      "run", "cli/index.ts", "action", "instatic", "create",
      "--domain", "fail-pull.example.com",
      "--port", "39150",
      "--tag", "0.0.18",
      "--tls", "no",
    ], {
      cwd: REPO,
      encoding: "utf8",
      env: {
        ...process.env,
        TEST_ROOT: root,
        PATH: `${bin}:${process.env.PATH}`,
        DATA_BASE_DIR: instancesDir,
        PANEL_DB: dbPath,
        CLPCTL: `${bin}/mock_panel`,
        PANEL_IDENTITY_FILE: idPath,
        LOCK_DIR: lockDir,
      },
    });

    // Create should fail because docker pull failed
    expect(result.status).not.toBe(0);

    // Unwind should have cleaned up the directory
    expect(existsSync(`${instancesDir}/fail-pull.example.com`)).toBe(false);

    // Unwind should have removed container and deleted the CloudPanel site created by this run
    const actions = existsSync(`${root}/actions`) ? outputText(readFileSync(`${root}/actions`, "utf8")) : "";
    expect(actions).toContain("panel-site-added --domainName=fail-pull.example.com");
    expect(actions).toContain("docker-rm -f instatic-fail-pull.example.com");
    expect(actions).toContain("panel-site-deleted --domainName=fail-pull.example.com");

    // Output JSON should reflect failure
    const stdout = outputText(result.stdout);
    expect(stdout).toContain('"ok":false');
    expect(stdout).toContain("failed to pull");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.serial("create unwinds and cleans up on container start failure", () => {
  const root = mkdtempSync(`${tmpdir()}/create-test-`);
  try {
    const bin = `${root}/bin`;
    mkdirSync(bin, { recursive: true });

    writeFileSync(`${bin}/docker`, `#!/bin/sh
if [ "$1" = "ps" ]; then
  exit 0
fi
if [ "$1" = "pull" ]; then
  exit 0
fi
if [ "$1" = "run" ]; then
  echo "failed to start" >&2
  exit 1
fi
if [ "$1" = "rm" ]; then
  echo "docker-rm $2 $3" >> "$TEST_ROOT/actions"
  exit 0
fi
exit 0
`, { mode: 0o755 });

    writeFileSync(`${bin}/mock_panel`, `#!/bin/sh
if [ "$1" = "site:add:reverse-proxy" ]; then
  echo "panel-site-added $2" >> "$TEST_ROOT/actions"
  exit 0
fi
if [ "$1" = "site:delete" ]; then
  echo "panel-site-deleted $2" >> "$TEST_ROOT/actions"
  exit 0
fi
exit 0
`, { mode: 0o755 });

    const idPath = `${root}/panel-identity.conf`;
    writeFileSync(idPath, "PRIMARY=panel.example.com\nALIASES=\n");
    chmodSync(idPath, 0o600);

    const dbPath = `${root}/panel.db`;
    const db = new Database(dbPath);
    db.run("CREATE TABLE site (domain_name TEXT, type TEXT, reverse_proxy_url TEXT, user TEXT)");
    db.close();

    const instancesDir = `${root}/instances`;
    const lockDir = `${root}/lock`;
    mkdirSync(lockDir, { recursive: true });

    const result = spawnSync("bun", [
      "run", "cli/index.ts", "action", "instatic", "create",
      "--domain", "fail-start.example.com",
      "--port", "39151",
      "--tag", "0.0.18",
      "--tls", "no",
    ], {
      cwd: REPO,
      encoding: "utf8",
      env: {
        ...process.env,
        TEST_ROOT: root,
        PATH: `${bin}:${process.env.PATH}`,
        DATA_BASE_DIR: instancesDir,
        PANEL_DB: dbPath,
        CLPCTL: `${bin}/mock_panel`,
        PANEL_IDENTITY_FILE: idPath,
        LOCK_DIR: lockDir,
      },
    });

    expect(result.status).not.toBe(0);
    expect(existsSync(`${instancesDir}/fail-start.example.com`)).toBe(false);

    const actions = existsSync(`${root}/actions`) ? outputText(readFileSync(`${root}/actions`, "utf8")) : "";
    expect(actions).toContain("panel-site-added --domainName=fail-start.example.com");
    expect(actions).toContain("docker-rm -f instatic-fail-start.example.com");
    expect(actions).toContain("panel-site-deleted --domainName=fail-start.example.com");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.serial("docker logs capture includes both stdout and stderr (Finding 10)", () => {
  const root = mkdtempSync(`${tmpdir()}/logs-test-`);
  try {
    const bin = `${root}/bin`;
    mkdirSync(bin, { recursive: true });

    const data = `${root}/instances/logtest.example.com`;
    mkdirSync(data, { recursive: true });
    writeFileSync(`${data}/meta.json`, JSON.stringify({
      domain: "logtest.example.com",
      port: 39152,
      tag: "0.0.18",
      container: "instatic-logtest.example.com",
    }));

    // Mock docker: ps reports container exists, logs outputs to both stdout and stderr
    writeFileSync(`${bin}/docker`, `#!/bin/sh
if [ "$1" = "ps" ]; then
  echo "instatic-logtest.example.com"
  exit 0
fi
if [ "$1" = "logs" ]; then
  echo "standard output diagnostic"
  echo "crash error trace on stderr" >&2
  exit 0
fi
exit 0
`, { mode: 0o755 });

    const idPath = `${root}/panel-identity.conf`;
    writeFileSync(idPath, "PRIMARY=panel.example.com\nALIASES=\n");
    chmodSync(idPath, 0o600);

    const lockDir = `${root}/lock`;
    mkdirSync(lockDir, { recursive: true });

    const result = spawnSync("bun", [
      "run", "cli/index.ts", "action", "instatic", "logs",
      "--domain", "logtest.example.com",
    ], {
      cwd: REPO,
      encoding: "utf8",
      env: {
        ...process.env,
        TEST_ROOT: root,
        PATH: `${bin}:${process.env.PATH}`,
        DATA_BASE_DIR: `${root}/instances`,
        PANEL_IDENTITY_FILE: idPath,
        LOCK_DIR: lockDir,
      },
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(outputText(result.stdout));
    expect(parsed.ok).toBe(true);
    expect(parsed.data.logs).toContain("standard output diagnostic");
    expect(parsed.data.logs).toContain("crash error trace on stderr");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
