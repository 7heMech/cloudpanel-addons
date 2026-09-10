import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const repo = join(import.meta.dir, "..");

function runAction(paths: Record<string, string>, argv: string[]): string {
  const script = `
    Object.defineProperty(process, "getuid", { value: () => 0, configurable: true });
    const { runStagerAction } = await import("./addons/stager/action.ts");
    const code = await runStagerAction(${JSON.stringify(argv)}, { paths: ${JSON.stringify(paths)} });
    process.exit(code);
  `;
  return execFileSync(process.execPath, ["-e", script], { cwd: repo, encoding: "utf8" }).trim();
}

function writeJob(dir: string, fields: Record<string, string>): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  for (const [field, value] of Object.entries(fields)) {
    writeFileSync(join(dir, field), `${value}\n`, { mode: 0o600 });
    chmodSync(join(dir, field), 0o600);
  }
  writeFileSync(join(dir, "log"), "line 1\nline 2\n", { mode: 0o600 });
  chmodSync(join(dir, "log"), 0o600);
}

test("the Stager sites action keeps its one-object field contract", () => {
  const root = mkdtempSync(join(tmpdir(), "clp-stager-action-test-"));
  const panelDb = join(root, "panel.db");
  try {
    const script = `
      import { Database } from "bun:sqlite";
      const db = new Database(${JSON.stringify(panelDb)});
      db.run("CREATE TABLE site (id INTEGER PRIMARY KEY, domain_name TEXT, type TEXT, user TEXT, root_directory TEXT, application TEXT, reverse_proxy_url TEXT, vhost_template TEXT)");
      db.run("CREATE TABLE php_settings (site_id INTEGER, php_version TEXT)");
      db.run("CREATE TABLE database (id INTEGER PRIMARY KEY, site_id INTEGER, name TEXT)");
      db.query("INSERT INTO site (id, domain_name, type, user, root_directory, application) VALUES (?, ?, ?, ?, ?, ?)").run(1, "alpha.example.test", "php", "alpha", "/home/alpha/htdocs/alpha.example.test", "WordPress");
      db.query("INSERT INTO php_settings (site_id, php_version) VALUES (?, ?)").run(1, "8.3");
      db.close();
    `;
    execFileSync(process.execPath, ["-e", script], { cwd: repo, encoding: "utf8" });
    const output = runAction({ panelDb, lockDir: join(root, "locks"), jobsDir: join(root, "jobs") }, ["sites"]);
    expect(output).toBe('{"ok":true,"data":{"sites":[{"domain":"alpha.example.test","siteType":"php","siteUser":"alpha","phpVersion":"8.3","application":"WordPress","databases":0}]}}');
    expect(output.split("\n")).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stager jobs are newest first and malformed results stay in one JSON reply", () => {
  const root = mkdtempSync(join(tmpdir(), "clp-stager-action-test-"));
  const jobsDir = join(root, "jobs");
  try {
    writeJob(join(jobsDir, "20260910T120000Z-abcdef"), {
      source: "alpha.example.test",
      target: "staging.example.test",
      state: "done",
      step: "recording the result",
      createdAt: "2026-09-10T12:00:00Z",
    });
    writeFileSync(join(jobsDir, "20260910T120000Z-abcdef", "result.json"), "{\n", { mode: 0o600 });
    chmodSync(join(jobsDir, "20260910T120000Z-abcdef", "result.json"), 0o600);
    writeJob(join(jobsDir, "20260910T130000Z-abcdef"), {
      source: "beta.example.test",
      target: "staging-beta.example.test",
      state: "queued",
      step: "queued",
      createdAt: "2026-09-10T13:00:00Z",
    });

    const output = runAction({ panelDb: join(root, "missing.db"), lockDir: join(root, "locks"), jobsDir }, ["jobs"]);
    const reply = JSON.parse(output) as { ok: boolean; data: { jobs: Array<{ id: string; result: unknown; panelSite: unknown }> } };
    expect(reply.ok).toBe(true);
    expect(reply.data.jobs.map((job) => job.id)).toEqual([
      "20260910T130000Z-abcdef",
      "20260910T120000Z-abcdef",
    ]);
    expect(reply.data.jobs[1]!.result).toBeNull();
    expect(reply.data.jobs[0]!.panelSite).toBeNull();
    expect(output.split("\n")).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
