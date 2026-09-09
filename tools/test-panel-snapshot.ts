import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { readPanelDatabase } from "../lib/panel-snapshot";

let failed = 0;
let passed = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok    ${label}`);
    passed++;
  } else {
    console.log(`  FAIL  ${label}${detail ? `: ${detail}` : ""}`);
    failed++;
  }
}

function createDatabase(path: string, setup: (db: Database) => void): void {
  const db = new Database(path);
  try {
    setup(db);
  } finally {
    db.close(true);
  }
}

function sidecars(path: string): string[] {
  const stem = basename(path);
  return readdirSync(dirname(path))
    .filter((entry) => entry === `${stem}-wal` || entry === `${stem}-shm`)
    .sort();
}

const implementation = readFileSync(join(import.meta.dir, "../lib/panel-snapshot.ts"), "utf-8");
check(
  "the snapshot reader uses Bun's read-only SQLite API",
  implementation.includes('import { Database } from "bun:sqlite"') &&
    implementation.includes("{ readonly: true }"),
);
check("the snapshot reader no longer invokes the sqlite3 CLI", !implementation.includes('"sqlite3"'));
check("the snapshot reader closes its database connection", implementation.includes("db.close()"));
check("the root-only snapshot guard remains", implementation.includes("process.getuid") && implementation.includes("must run as root"));

const fixtureDir = mkdtempSync(join(tmpdir(), "panel-snapshot-test-"));
try {
  const missingPath = join(fixtureDir, "missing.sqlite");
  const missing = readPanelDatabase(missingPath);
  check("a missing panel database is treated as empty", missing.sites.length === 0 && missing.allocatedPorts.length === 0);
  check("a missing database is not created", !existsSync(missingPath));

  const partialPath = join(fixtureDir, "partial.sqlite");
  createDatabase(partialPath, (db) => {
    db.run("CREATE TABLE site (domain_name TEXT, user TEXT, type TEXT, reverse_proxy_url TEXT)");
    db.query("INSERT INTO site VALUES (?, ?, ?, ?)").run(
      "pipe|domain.example",
      "clp|customer",
      "php|fpm",
      "http://127.0.0.1:39123/path|literal",
    );
    db.run("CREATE TABLE php_settings (pool_port INTEGER)");
    db.query("INSERT INTO php_settings VALUES (?)").run(39001);
    db.run("CREATE TABLE nodejs_settings (port INTEGER)");
    db.query("INSERT INTO nodejs_settings VALUES (?)").run(39002);
  });

  const beforeBytes = readFileSync(partialPath);
  const beforeMtime = statSync(partialPath).mtimeMs;
  const beforeSidecars = sidecars(partialPath);
  const partial = readPanelDatabase(partialPath);
  const site = partial.sites[0];
  check(
    "missing tables do not discard rows from existing tables",
    partial.sites.length === 1 && partial.allocatedPorts.join(",") === "39001,39002,39123",
    JSON.stringify(partial),
  );
  check(
    "SQLite values containing pipes remain intact",
    site?.domain === "pipe|domain.example" && site.user === "clp|customer" && site.type === "php|fpm",
    JSON.stringify(site),
  );
  check("a read-only scan leaves database bytes unchanged", readFileSync(partialPath).equals(beforeBytes));
  check("a read-only scan leaves database mtime unchanged", statSync(partialPath).mtimeMs === beforeMtime);
  check(
    "a read-only scan creates no SQLite WAL sidecars",
    beforeSidecars.length === 0 && sidecars(partialPath).length === 0,
    `${beforeSidecars.join(",")} -> ${sidecars(partialPath).join(",")}`,
  );

  const malformedPath = join(fixtureDir, "malformed.sqlite");
  writeFileSync(malformedPath, "this is not a SQLite database\n");
  const malformed = readPanelDatabase(malformedPath);
  check("a malformed database is treated as empty", malformed.sites.length === 0 && malformed.allocatedPorts.length === 0);
  check("a malformed database produces no WAL sidecars", sidecars(malformedPath).length === 0);

  const walPath = join(fixtureDir, "wal.sqlite");
  const walDb = new Database(walPath);
  try {
    walDb.run("PRAGMA journal_mode=WAL");
    walDb.run("PRAGMA wal_autocheckpoint=0");
    walDb.run("CREATE TABLE site (domain_name TEXT, user TEXT, type TEXT, reverse_proxy_url TEXT)");
    walDb.query("INSERT INTO site VALUES (?, ?, ?, ?)").run(
      "wal.example",
      "wal-user",
      "php",
      "http://127.0.0.1:39124/",
    );
    walDb.run("CREATE TABLE php_settings (pool_port INTEGER)");
    walDb.query("INSERT INTO php_settings VALUES (?)").run(39003);

    const originalFiles = [walPath, `${walPath}-wal`, `${walPath}-shm`];
    const beforeWal = originalFiles.map((file) => ({
      file,
      bytes: readFileSync(file),
      mtimeMs: statSync(file).mtimeMs,
    }));
    const wal = readPanelDatabase(walPath);
    const afterWal = originalFiles.map((file) => ({
      file,
      bytes: readFileSync(file),
      mtimeMs: statSync(file).mtimeMs,
    }));
    check(
      "a WAL database remains readable from the isolated copy",
      wal.sites[0]?.domain === "wal.example" && wal.allocatedPorts.join(",") === "39003,39124",
      JSON.stringify(wal),
    );
    check(
      "a WAL scan leaves the original database and sidecars byte-for-byte unchanged",
      beforeWal.length === afterWal.length && beforeWal.every((before, index) => {
        const after = afterWal[index];
        return after?.file === before.file && after.mtimeMs === before.mtimeMs && after.bytes.equals(before.bytes);
      }),
    );
  } finally {
    walDb.close(true);
  }
} finally {
  rmSync(fixtureDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
