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
check("the snapshot reader creates a SQLite-consistent snapshot", implementation.includes('"VACUUM INTO ?"'));
check("the snapshot reader validates snapshot integrity", implementation.includes('"PRAGMA integrity_check;"'));
check("the snapshot reader does not copy live database sidecars", !implementation.includes("copyFileSync"));
check("the snapshot reader closes its database connection", implementation.includes("db.close()"));
check("the root-only snapshot guard remains", implementation.includes("process.getuid") && implementation.includes("must run as root"));

const fixtureDir = mkdtempSync(join(tmpdir(), "panel-snapshot-test-"));
try {
  const missingPath = join(fixtureDir, "missing.sqlite");
  const missing = readPanelDatabase(missingPath);
  check("a missing panel database is treated as empty", missing.sites.length === 0 && missing.allocatedPorts.length === 0);
  check("a missing database is not created", !existsSync(missingPath));

  const missingSitePath = join(fixtureDir, "missing-site.sqlite");
  createDatabase(missingSitePath, (db) => {
    db.run("CREATE TABLE php_settings (pool_port INTEGER)");
    db.query("INSERT INTO php_settings VALUES (?)").run(39004);
  });
  let missingSiteError = "";
  try {
    readPanelDatabase(missingSitePath);
  } catch (error) {
    missingSiteError = error instanceof Error ? error.message : String(error);
  }
  check(
    "a valid database without the required site table fails loudly",
    missingSiteError.includes("required panel table site") && missingSiteError.includes("no such table"),
    missingSiteError,
  );

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
  let malformedError = "";
  try {
    readPanelDatabase(malformedPath);
  } catch (error) {
    malformedError = error instanceof Error ? error.message : String(error);
  }
  check(
    "a malformed database fails loudly instead of becoming an empty snapshot",
    malformedError.includes("unable to create panel database snapshot") && malformedError.includes("not a database"),
    malformedError,
  );
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
      "a WAL database remains readable from the consistent snapshot",
      wal.sites[0]?.domain === "wal.example" && wal.allocatedPorts.join(",") === "39003,39124",
      JSON.stringify(wal),
    );
    check(
      "a WAL scan leaves the original database and WAL bytes unchanged",
      beforeWal[0] !== undefined && afterWal[0] !== undefined &&
        beforeWal[1] !== undefined && afterWal[1] !== undefined &&
        beforeWal[0].bytes.equals(afterWal[0].bytes) &&
        beforeWal[0].mtimeMs === afterWal[0].mtimeMs &&
        beforeWal[1].bytes.equals(afterWal[1].bytes) &&
        beforeWal[1].mtimeMs === afterWal[1].mtimeMs,
    );
    check(
      "a WAL scan does not create, remove, or resize SQLite sidecars",
      beforeWal.length === afterWal.length && beforeWal.every((before, index) => {
        const after = afterWal[index];
        return after?.file === before.file && after.mtimeMs === before.mtimeMs && after.bytes.length === before.bytes.length;
      }),
    );
  } finally {
    walDb.close(true);
  }

  const concurrentPath = join(fixtureDir, "concurrent.sqlite");
  const concurrentDb = new Database(concurrentPath);
  concurrentDb.run("PRAGMA journal_mode=WAL");
  concurrentDb.run("PRAGMA wal_autocheckpoint=0");
  concurrentDb.run("CREATE TABLE site (domain_name TEXT, user TEXT, type TEXT, reverse_proxy_url TEXT)");
  concurrentDb.query("INSERT INTO site VALUES (?, ?, ?, NULL)").run("v0.example", "writer", "php");
  concurrentDb.run("CREATE TABLE php_settings (pool_port INTEGER)");
  concurrentDb.query("INSERT INTO php_settings VALUES (?)").run(39000);
  concurrentDb.close(false);

  const writerScript = `
    import { Database } from "bun:sqlite";
    const db = new Database(process.argv[2]);
    let version = 0;
    try {
      while (version < 1000) {
        db.run("BEGIN IMMEDIATE");
        try {
          db.query("UPDATE site SET domain_name = ?, user = ?, type = ?").run(
            "v" + version + ".example",
            "writer",
            "php",
          );
          db.query("UPDATE php_settings SET pool_port = ?").run(39000 + version);
          db.run("COMMIT");
          version++;
        } catch (error) {
          db.run("ROLLBACK");
          throw error;
        }
      }
    } finally {
      db.close();
    }
  `;
  const writer = Bun.spawn([process.execPath, "-e", writerScript, concurrentPath], {
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    const consistentSnapshots: boolean[] = [];
    for (let attempt = 0; attempt < 12; attempt++) {
      const snapshot = readPanelDatabase(concurrentPath);
      const domain = snapshot.sites[0]?.domain;
      const version = domain?.match(/^v(\d+)\.example$/)?.[1];
      const port = snapshot.allocatedPorts.find((value) => value >= 39000 && value < 40000);
      consistentSnapshots.push(version !== undefined && port !== undefined && Number(version) === port - 39000);
    }
    check(
      "concurrent WAL writes produce internally consistent snapshots",
      consistentSnapshots.length === 12 && consistentSnapshots.every(Boolean),
      JSON.stringify(consistentSnapshots),
    );
  } finally {
    writer.kill();
    await writer.exited;
  }
} finally {
  rmSync(fixtureDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
