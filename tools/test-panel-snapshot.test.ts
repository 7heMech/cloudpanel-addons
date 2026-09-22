// The panel snapshot reader copies CloudPanel's live SQLite database without
// writing to it. Every assertion here is about that promise: the copy is
// consistent, the original keeps its bytes, mtime and sidecars, and a database
// it cannot read fails loudly rather than becoming an empty snapshot.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { readPanelDatabase } from "../lib/panel-snapshot";

let fixtureDir = "";
let counter = 0;

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "panel-snapshot-test-"));
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

function implementation(): string {
  return readFileSync(join(import.meta.dir, "../lib/panel-snapshot.ts"), "utf-8");
}

function fixture(stem: string): string {
  return join(fixtureDir, `${stem}-${counter++}.sqlite`);
}

function createDatabase(path: string, setup: (db: Database) => void): string {
  const db = new Database(path);
  try {
    setup(db);
  } finally {
    db.close(true);
  }
  return path;
}

function sidecars(path: string): string[] {
  const stem = basename(path);
  return readdirSync(dirname(path))
    .filter((entry) => entry === `${stem}-wal` || entry === `${stem}-shm`)
    .sort();
}

/** A panel database with the site table and two of the optional port tables. */
function partialDatabase(): string {
  return createDatabase(fixture("partial"), (db) => {
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
}

function walDatabase(path: string): Database {
  const db = new Database(path);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA wal_autocheckpoint=0");
  db.run("CREATE TABLE site (domain_name TEXT, user TEXT, type TEXT, reverse_proxy_url TEXT)");
  db.run("CREATE TABLE php_settings (pool_port INTEGER)");
  return db;
}

test("the snapshot reader uses Bun's read-only SQLite API", () => {
  expect(implementation()).toInclude('import { Database } from "bun:sqlite"');
  expect(implementation()).toInclude("{ readonly: true }");
});

test("the snapshot reader no longer invokes the sqlite3 CLI", () => {
  expect(implementation()).not.toInclude('"sqlite3"');
});

test("the snapshot reader creates a SQLite-consistent snapshot", () => {
  expect(implementation()).toInclude('"VACUUM INTO ?"');
});

test("the snapshot reader validates snapshot integrity", () => {
  expect(implementation()).toInclude('"PRAGMA integrity_check;"');
});

test("the snapshot reader does not copy live database sidecars", () => {
  expect(implementation()).not.toInclude("copyFileSync");
});

test("the snapshot reader closes its database connection", () => {
  expect(implementation()).toInclude("db.close()");
});

test("the root-only snapshot guard remains", () => {
  expect(implementation()).toInclude("process.getuid");
  expect(implementation()).toInclude("must run as root");
});

test("a missing panel database is treated as empty and is not created", () => {
  const path = fixture("missing");
  const missing = readPanelDatabase(path);
  expect(missing.sites).toHaveLength(0);
  expect(missing.allocatedPorts).toHaveLength(0);
  expect(existsSync(path)).toBe(false);
});

test("a valid database without the required site table fails loudly", () => {
  const path = createDatabase(fixture("missing-site"), (db) => {
    db.run("CREATE TABLE php_settings (pool_port INTEGER)");
    db.query("INSERT INTO php_settings VALUES (?)").run(39004);
  });
  expect(() => readPanelDatabase(path)).toThrow(/required panel table site[\s\S]*no such table|no such table[\s\S]*required panel table site/);
});

test("missing tables do not discard rows from existing tables", () => {
  const partial = readPanelDatabase(partialDatabase());
  expect(partial.sites).toHaveLength(1);
  expect(partial.allocatedPorts).toEqual([39001, 39002, 39123]);
});

test("SQLite values containing pipes remain intact", () => {
  const site = readPanelDatabase(partialDatabase()).sites[0];
  expect(site).toMatchObject({ domain: "pipe|domain.example", user: "clp|customer", type: "php|fpm" });
});

test("a panel without the Varnish column reports no Varnish sites instead of failing", () => {
  expect(readPanelDatabase(partialDatabase()).sites[0]?.varnishCache).toBe(false);
});

test("Varnish capability crosses the gateway per site", () => {
  const path = createDatabase(fixture("varnish"), (db) => {
    db.run("CREATE TABLE site (domain_name TEXT, user TEXT, type TEXT, varnish_cache BOOLEAN NOT NULL, reverse_proxy_url TEXT)");
    db.query("INSERT INTO site VALUES (?, ?, ?, ?, NULL)").run("cached.example", "cached", "php", 1);
    db.query("INSERT INTO site VALUES (?, ?, ?, ?, NULL)").run("plain.example", "plain", "php", 0);
  });
  const { sites } = readPanelDatabase(path);
  expect(sites.find((s) => s.domain === "cached.example")?.varnishCache).toBe(true);
  expect(sites.find((s) => s.domain === "plain.example")?.varnishCache).toBe(false);
});

test("a read-only scan leaves the database bytes, mtime and sidecars alone", () => {
  const path = partialDatabase();
  const beforeBytes = readFileSync(path);
  const beforeMtime = statSync(path).mtimeMs;
  expect(sidecars(path)).toEqual([]);

  readPanelDatabase(path);

  expect(readFileSync(path).equals(beforeBytes)).toBe(true);
  expect(statSync(path).mtimeMs).toBe(beforeMtime);
  expect(sidecars(path)).toEqual([]);
});

test("query errors on optional tables other than missing-table are rethrown", () => {
  const path = createDatabase(fixture("broken-optional"), (db) => {
    db.run("CREATE TABLE site (domain_name TEXT, user TEXT, type TEXT, reverse_proxy_url TEXT)");
    db.query("INSERT INTO site VALUES (?, ?, ?, ?)").run("test.example", "test-user", "php", "");
    db.run("CREATE VIEW python_settings AS SELECT * FROM undefined_table");
  });
  expect(() => readPanelDatabase(path)).toThrow("cannot read optional panel table python_settings");
});

test("a malformed database fails loudly instead of becoming an empty snapshot", () => {
  const path = fixture("malformed");
  writeFileSync(path, "this is not a SQLite database\n");
  expect(() => readPanelDatabase(path)).toThrow(/unable to create panel database snapshot[\s\S]*not a database/);
  expect(sidecars(path)).toEqual([]);
});

test("a WAL database remains readable from the consistent snapshot", () => {
  const path = fixture("wal");
  const db = walDatabase(path);
  try {
    db.query("INSERT INTO site VALUES (?, ?, ?, ?)").run("wal.example", "wal-user", "php", "http://127.0.0.1:39124/");
    db.query("INSERT INTO php_settings VALUES (?)").run(39003);
    const wal = readPanelDatabase(path);
    expect(wal.sites[0]?.domain).toBe("wal.example");
    expect(wal.allocatedPorts).toEqual([39003, 39124]);
  } finally {
    db.close(true);
  }
});

test("a WAL scan does not create, remove, resize or touch SQLite sidecars", () => {
  const path = fixture("wal-untouched");
  const db = walDatabase(path);
  try {
    db.query("INSERT INTO site VALUES (?, ?, ?, ?)").run("wal.example", "wal-user", "php", "http://127.0.0.1:39124/");
    db.query("INSERT INTO php_settings VALUES (?)").run(39003);

    const files = [path, `${path}-wal`, `${path}-shm`];
    const snap = () => files.map((file) => ({ file, bytes: readFileSync(file), mtimeMs: statSync(file).mtimeMs }));
    const before = snap();
    readPanelDatabase(path);
    const after = snap();

    expect(after.map((entry) => entry.file)).toEqual(before.map((entry) => entry.file));
    expect(after.map((entry) => entry.mtimeMs)).toEqual(before.map((entry) => entry.mtimeMs));
    expect(after.map((entry) => entry.bytes.length)).toEqual(before.map((entry) => entry.bytes.length));
    expect(after[0]?.bytes.equals(before[0]!.bytes)).toBe(true);
    expect(after[1]?.bytes.equals(before[1]!.bytes)).toBe(true);
  } finally {
    db.close(true);
  }
});

test("concurrent WAL writes produce internally consistent snapshots", async () => {
  const path = fixture("concurrent");
  const seed = walDatabase(path);
  seed.query("INSERT INTO site VALUES (?, ?, ?, NULL)").run("v0.example", "writer", "php");
  seed.query("INSERT INTO php_settings VALUES (?)").run(39000);
  seed.close(false);

  // The site row and the port row are written in one transaction, so a
  // snapshot that shows version N with a port other than 39000+N has torn.
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
  const writer = Bun.spawn([process.execPath, "-e", writerScript, path], { stdout: "ignore", stderr: "pipe" });
  try {
    for (let attempt = 0; attempt < 12; attempt++) {
      const snapshot = readPanelDatabase(path);
      const version = snapshot.sites[0]?.domain?.match(/^v(\d+)\.example$/)?.[1];
      const port = snapshot.allocatedPorts.find((value) => value >= 39000 && value < 40000);
      expect(version).toBeDefined();
      expect(port).toBeDefined();
      expect(Number(version)).toBe(port! - 39000);
    }
  } finally {
    writer.kill();
    await writer.exited;
  }
});
