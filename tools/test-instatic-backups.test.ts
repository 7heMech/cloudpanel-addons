import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_INSTATIC_ACTION_PATHS, homeStorage, instanceStorage, makeNativeBackup, makeSnapshot, nativeBackupPath, parseInstaticAction,
} from "../addons/instatic/action";

const repo = join(import.meta.dir, "..");
const domain = "example.com";
const key = "INSTATIC_SECRET_KEY=the-original-encryption-key\n";

function fixture(legacy = false) {
  const root = mkdtempSync(join(tmpdir(), "instatic-backup-"));
  const paths = {
    ...DEFAULT_INSTATIC_ACTION_PATHS,
    homeDir: join(root, "home"), dataBaseDir: join(root, "state"), backupDir: join(root, "deleted"),
    panelDb: join(root, "panel.db"), lockDir: join(root, "locks"), jobsDir: join(root, "jobs"),
  };
  const state = join(paths.dataBaseDir, domain);
  mkdirSync(state, { recursive: true });
  const panel = new Database(paths.panelDb);
  panel.run("CREATE TABLE site (domain_name TEXT, type TEXT, reverse_proxy_url TEXT, user TEXT)");
  panel.run("INSERT INTO site VALUES (?, 'reverse-proxy', 'http://127.0.0.1:39000', 'site-user')", [domain]);
  panel.close();
  const meta = join(state, "meta.json");
  writeFileSync(meta, JSON.stringify({ domain, port: 39000, tag: "0.0.18", siteUser: "site-user", siteCreatedByAddon: false,
    ...(legacy ? {} : { storage: "site-home" }) }, null, 2));
  const storage = instanceStorage(domain, paths);
  mkdirSync(storage.dataDir, { recursive: true });
  mkdirSync(storage.uploadsDir, { recursive: true });
  writeFileSync(storage.envFile, key, { mode: 0o600 });
  writeFileSync(join(storage.uploadsDir, "photo.txt"), "original media");
  const dbFile = join(storage.dataDir, "instatic.db");
  const db = new Database(dbFile);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA wal_autocheckpoint=0");
  db.run("CREATE TABLE content (body TEXT)");
  db.run("INSERT INTO content VALUES ('committed in WAL')");
  return { root, paths, state, meta, storage, dbFile, db, cleanup() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

function rows(file: string): string[] {
  const db = new Database(file, { readonly: true });
  try { return (db.query("SELECT body FROM content").all() as Array<{ body: string }>).map((row) => row.body); }
  finally { db.close(); }
}

function extract(archive: string, root: string): string {
  const out = mkdtempSync(join(root, "extracted-"));
  execFileSync("tar", ["-xzf", archive, "-C", out]);
  return out;
}

test("native backup includes committed WAL data, the original key and recovery metadata, with no media duplication", () => {
  const f = fixture();
  try {
    expect(statSync(`${f.dbFile}-wal`).size).toBeGreaterThan(0);
    const archive = makeNativeBackup(domain, f.paths);
    expect(archive).toBe(join(f.paths.homeDir, "site-user", "backups", "databases", `instatic-${domain}.tar.gz`));
    expect(statSync(archive).mode & 0o777).toBe(0o600);
    const out = extract(archive, f.root);
    expect(rows(join(out, "data", "instatic.db"))).toEqual(["committed in WAL"]);
    expect(existsSync(join(out, "data", "instatic.db-wal"))).toBe(false);
    expect(existsSync(join(out, "data", "instatic.db-shm"))).toBe(false);
    expect(existsSync(join(out, "uploads"))).toBe(false);
    expect(readFileSync(join(out, "instatic.env"), "utf8")).toBe(key);
    expect(JSON.parse(readFileSync(join(out, "meta.json"), "utf8")).tag).toBe("0.0.18");
    // The source connection stays open and writable across the online backup.
    f.db.run("INSERT INTO content VALUES ('after backup')");
    expect(rows(join(out, "data", "instatic.db"))).toEqual(["committed in WAL"]);
    expect(rows(f.dbFile)).toHaveLength(2);
  } finally { f.cleanup(); }
});

test("failed SQLite backup preserves the last complete archive and cleans staging files", () => {
  const f = fixture();
  try {
    const archive = makeNativeBackup(domain, f.paths);
    const original = readFileSync(archive);
    expect(() => makeNativeBackup(domain, { ...f.paths, sqlite3: "/bin/false" })).toThrow("previous backup preserved");
    expect(readFileSync(archive)).toEqual(original);
    expect(readdirSync(dirname(archive))).toEqual([`instatic-${domain}.tar.gz`]);
    rmSync(f.storage.envFile);
    expect(() => makeNativeBackup(domain, f.paths)).toThrow("missing encryption key");
    expect(readFileSync(archive)).toEqual(original);
  } finally { f.cleanup(); }
});

test("missing and symlinked databases cannot publish an empty recovery archive", () => {
  const f = fixture();
  try {
    f.db.close();
    rmSync(f.dbFile);
    expect(() => makeNativeBackup(domain, f.paths)).toThrow("no SQLite database");
    symlinkSync(f.paths.panelDb, f.dbFile);
    expect(() => makeNativeBackup(domain, f.paths)).toThrow("no SQLite database");
    expect(existsSync(nativeBackupPath(domain, f.paths))).toBe(false);
  } finally { f.cleanup(); }
});

test("storage paths separate private data from uploads and reject panel user path traversal", () => {
  const f = fixture();
  try {
    expect(f.storage.dataDir).toBe(join(f.paths.homeDir, "site-user", "instatic", domain, "data"));
    expect(f.storage.envFile).toBe(join(dirname(f.storage.dataDir), ".instatic.env"));
    expect(f.storage.uploadsDir).toBe(join(f.paths.homeDir, "site-user", "htdocs", domain, "uploads"));
    const panel = new Database(f.paths.panelDb);
    panel.run("INSERT INTO site VALUES ('second.example.com', 'reverse-proxy', 'http://127.0.0.1:39001', 'site-user')");
    expect(nativeBackupPath("second.example.com", f.paths)).not.toBe(nativeBackupPath(domain, f.paths));
    panel.run("UPDATE site SET user='../root' WHERE domain_name=?", [domain]);
    panel.close();
    expect(() => homeStorage(domain, f.paths)).toThrow("no valid CloudPanel site user");
  } finally { f.cleanup(); }
});

function installCommands(f: ReturnType<typeof fixture>) {
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  const calls = join(f.root, "calls.jsonl");
  writeFileSync(calls, "");
  const containers = join(f.root, "containers.json");
  writeFileSync(containers, JSON.stringify({ [`instatic-${domain}`]: "running" }));
  const script = `#!${process.execPath}
import { Database } from 'bun:sqlite';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_CALLS, JSON.stringify([command, ...args]) + '\\n');
if (command === 'id') { console.log('1500'); process.exit(0); }
if (command === 'chown') process.exit(0);
if (command === 'curl') { console.log('200'); process.exit(0); }
if (command === 'ss') process.exit(0);
if (command === 'docker') {
  const file = process.env.TEST_CONTAINERS;
  const state = JSON.parse(readFileSync(file, 'utf8'));
  if (args[0] === 'ps') { console.log(Object.keys(state).join('\\n')); process.exit(0); }
  if (args[0] === 'inspect') { console.log(state[args.at(-1)] ?? 'absent'); process.exit(0); }
  if (args[0] === 'stop') {
    if (process.env.FAIL_STOP) process.exit(1);
    state[args[1]] = 'exited';
  }
  if (args[0] === 'rename') { state[args[2]] = state[args[1]]; delete state[args[1]]; }
  if (args[0] === 'rm') delete state[args.at(-1)];
  if (args[0] === 'start') state[args[1]] = 'running';
  if (args[0] === 'run') {
    const name = args[args.indexOf('--name') + 1];
    const data = args.find(x => x.endsWith(':/app/data')).slice(0, -10);
    const uploads = args.find(x => x.endsWith(':/app/uploads')).slice(0, -13);
    state[name] = 'running';
    const db = new Database(join(data, 'instatic.db'));
    if (!db.query("SELECT name FROM sqlite_master WHERE name='content'").get()) {
      db.run('CREATE TABLE content (body TEXT)'); db.run("INSERT INTO content VALUES ('created')");
    }
    if (process.env.FAIL_RUN) {
      db.run("UPDATE content SET body='bad migration'");
      writeFileSync(join(uploads, 'photo.txt'), 'bad media');
    }
    db.close();
    writeFileSync(file, JSON.stringify(state));
    if (process.env.FAIL_RUN) process.exit(1);
  }
  writeFileSync(file, JSON.stringify(state));
}
`;
  for (const command of ["docker", "id", "chown", "curl", "ss"]) writeFileSync(join(bin, command), script, { mode: 0o755 });
  return { bin, calls, containers };
}

function action(f: ReturnType<typeof fixture>, argv: string[], extraEnv: Record<string, string> = {}) {
  const commands = existsSync(join(f.root, "bin"))
    ? { bin: join(f.root, "bin"), calls: join(f.root, "calls.jsonl"), containers: join(f.root, "containers.json") }
    : installCommands(f);
  const script = `
    import { mock } from 'bun:test';
    Object.defineProperty(process, 'getuid', { value: () => 0 });
    const common = await import('./cli/action-common.ts');
    // The real domain/identity guard has its own tests. The fixture's identity
    // file cannot be owned by root in an unprivileged CI process.
    mock.module('./cli/action-common.ts', () => ({ ...common, validateDomain: value => value }));
    const { runInstaticAction } = await import('./addons/instatic/action.ts');
    process.exit(await runInstaticAction(${JSON.stringify(argv)}, { paths: ${JSON.stringify(f.paths)} }));
  `;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: repo, encoding: "utf8", env: {
    ...process.env, PATH: `${commands.bin}:${process.env.PATH}`, TEST_CALLS: commands.calls,
    TEST_CONTAINERS: commands.containers, ...extraEnv,
  } });
  if (!result.stdout.trim()) throw new Error(result.stderr || "action produced no JSON");
  return { code: result.status, reply: JSON.parse(result.stdout.trim()), stderr: result.stderr,
    calls: readFileSync(commands.calls, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]),
    containers: JSON.parse(readFileSync(commands.containers, "utf8")) };
}

test("recreate migrates stopped legacy data and keeps metadata at its original path", () => {
  const f = fixture(true);
  try {
    f.db.close();
    const result = action(f, ["recreate", `--domain=${domain}`]);
    expect(result.reply, result.stderr).toMatchObject({ ok: true });
    const storage = homeStorage(domain, f.paths);
    expect(rows(join(storage.dataDir, "instatic.db"))).toEqual(["committed in WAL"]);
    expect(readFileSync(storage.envFile, "utf8")).toContain(key.trim());
    expect(readFileSync(join(storage.uploadsDir, "photo.txt"), "utf8")).toBe("original media");
    expect(JSON.parse(readFileSync(f.meta, "utf8")).storage).toBe("site-home");
    expect(existsSync(f.storage.dataDir)).toBe(false);
    expect(existsSync(f.storage.envFile)).toBe(false);
    const run = result.calls.find((call) => call[0] === "docker" && call[1] === "run")!;
    expect(run).toContain(`${storage.dataDir}:/app/data`);
    expect(run).toContain(`${storage.uploadsDir}:/app/uploads`);
    expect(run).toContain(storage.envFile);
    expect(result.calls).toContainEqual(["chown", "root:1500", storage.envFile]);
    expect(statSync(storage.envFile).mode & 0o777).toBe(0o600);
    expect(statSync(storage.dataDir).mode & 0o777).toBe(0o750);
    expect(existsSync(nativeBackupPath(domain, f.paths))).toBe(true);
  } finally { f.cleanup(); }
});

test("failed legacy migration preserves the original data, key and container", () => {
  const f = fixture(true);
  try {
    f.db.close();
    const result = action(f, ["recreate", "--domain", domain], { FAIL_RUN: "1" });
    expect(result.reply.ok).toBe(false);
    expect(rows(f.dbFile)).toEqual(["committed in WAL"]);
    expect(readFileSync(f.storage.envFile, "utf8")).toBe(key);
    expect(readFileSync(join(f.storage.uploadsDir, "photo.txt"), "utf8")).toBe("original media");
    expect(existsSync(homeStorage(domain, f.paths).dataDir)).toBe(false);
    expect(JSON.parse(readFileSync(f.meta, "utf8")).storage).toBeUndefined();
    expect(result.containers).toEqual({ [`instatic-${domain}`]: "running" });
  } finally { f.cleanup(); }
});

test("failed update rolls back the database, uploads and metadata in the site home", () => {
  const f = fixture();
  try {
    f.db.close();
    const result = action(f, ["update", "--domain", domain, "--tag", "0.0.19"], { FAIL_RUN: "1" });
    expect(result.reply.ok).toBe(false);
    expect(rows(f.dbFile)).toEqual(["committed in WAL"]);
    expect(readFileSync(join(f.storage.uploadsDir, "photo.txt"), "utf8")).toBe("original media");
    expect(JSON.parse(readFileSync(f.meta, "utf8")).tag).toBe("0.0.18");
    expect(result.containers).toEqual({ [`instatic-${domain}`]: "running" });
    // Files copied back by root must be writable by the container's site UID.
    const lastChown = result.calls.findLastIndex((call) => call[0] === "chown" && call[1] === "-hR");
    const start = result.calls.findIndex((call) => call[0] === "docker" && call[1] === "start");
    expect(lastChown).toBeGreaterThan(0);
    expect(lastChown).toBeLessThan(start);
  } finally { f.cleanup(); }
});

test("restore rebuilds missing metadata and key from the clean backup instead of raw WAL files", () => {
  const f = fixture();
  try {
    makeNativeBackup(domain, f.paths);
    f.db.close();
    rmSync(f.meta);
    rmSync(f.storage.envFile);
    writeFileSync(f.dbFile, "inconsistent live copy");
    writeFileSync(`${f.dbFile}-wal`, "stale WAL");
    writeFileSync(`${f.dbFile}-shm`, "stale SHM");
    const result = action(f, ["recreate", "--domain", domain, "--from-backup"]);
    expect(result.reply, result.stderr).toMatchObject({ ok: true });
    expect(rows(f.dbFile)).toEqual(["committed in WAL"]);
    expect(readFileSync(f.storage.envFile, "utf8")).toContain(key.trim());
    expect(existsSync(`${f.dbFile}-wal`)).toBe(false);
    expect(existsSync(`${f.dbFile}-shm`)).toBe(false);
    expect(JSON.parse(readFileSync(f.meta, "utf8"))).toMatchObject({ domain, tag: "0.0.18", port: 39000, storage: "site-home", siteCreatedByAddon: false });
    expect(readFileSync(join(f.storage.uploadsDir, "photo.txt"), "utf8")).toBe("original media");
    expect(existsSync(result.reply.data.previousData)).toBe(true);
  } finally { f.cleanup(); }
});

test("ordinary recreate does not restore last night's data or generate a replacement key", () => {
  const f = fixture();
  try {
    makeNativeBackup(domain, f.paths);
    f.db.run("INSERT INTO content VALUES ('newer live data')");
    f.db.close();
    let result = action(f, ["recreate", "--domain", domain]);
    expect(result.reply, result.stderr).toMatchObject({ ok: true });
    expect(rows(f.dbFile)).toEqual(["committed in WAL", "newer live data"]);
    rmSync(f.storage.envFile);
    result = action(f, ["recreate", "--domain", domain]);
    expect(result.reply.ok).toBe(false);
    expect(result.reply.error).toContain("missing encryption key");
    expect(existsSync(f.storage.envFile)).toBe(false);
    expect(result.containers).toEqual({ [`instatic-${domain}`]: "running" });
  } finally { f.cleanup(); }
});

test("failed restore returns to the newer live database and its existing metadata", () => {
  const f = fixture();
  try {
    makeNativeBackup(domain, f.paths);
    f.db.run("INSERT INTO content VALUES ('newer live data')");
    f.db.close();
    const meta = readFileSync(f.meta, "utf8");
    const result = action(f, ["recreate", "--domain", domain, "--from-backup"], { FAIL_RUN: "1" });
    expect(result.reply.ok).toBe(false);
    expect(rows(f.dbFile)).toEqual(["committed in WAL", "newer live data"]);
    expect(readFileSync(f.meta, "utf8")).toBe(meta);
    expect(readFileSync(f.storage.envFile, "utf8")).toBe(key);
    expect(readFileSync(join(f.storage.uploadsDir, "photo.txt"), "utf8")).toBe("original media");
    expect(result.containers).toEqual({ [`instatic-${domain}`]: "running" });
  } finally { f.cleanup(); }
});

test("failed stop aborts migration without creating replacement storage", () => {
  const f = fixture(true);
  try {
    f.db.close();
    const result = action(f, ["recreate", "--domain", domain], { FAIL_STOP: "1" });
    expect(result.reply.ok).toBe(false);
    expect(rows(f.dbFile)).toEqual(["committed in WAL"]);
    expect(existsSync(homeStorage(domain, f.paths).dataDir)).toBe(false);
    expect(result.calls.some((call) => call[0] === "docker" && call[1] === "run")).toBe(false);
  } finally { f.cleanup(); }
});

test("backup parser restricts recovery to explicit recreate and supports batch backups", () => {
  expect(parseInstaticAction(["backup"]).domain).toBe("");
  expect(() => parseInstaticAction(["backup", "--from-backup"])).toThrow("only valid with recreate");
  expect(() => parseInstaticAction(["backup", "--tag", "0.0.18"])).toThrow("takes only --domain");
});

for (const verb of ["create", "run"]) test(`${verb} provisions the site-home layout and an initial recovery archive`, () => {
  const f = fixture();
  try {
    f.db.close();
    rmSync(f.state, { recursive: true });
    rmSync(f.storage.dataDir, { recursive: true });
    rmSync(f.storage.uploadsDir, { recursive: true });
    rmSync(f.storage.envFile);
    const commands = installCommands(f);
    writeFileSync(commands.containers, "{}");
    const job = "20260912T000000Z-abcdef";
    if (verb === "run") {
      const dir = join(f.paths.jobsDir, job);
      mkdirSync(dir, { recursive: true });
      for (const [field, value] of Object.entries({ domain, port: "39000", tag: "0.0.18", tls: "no" })) writeFileSync(join(dir, field), value);
    }
    const result = action(f, verb === "run" ? [verb, "--job", job] : [verb, "--domain", domain, "--port", "39000", "--tag", "0.0.18"]);
    expect(result.reply, result.stderr).toMatchObject({ ok: true });
    expect(rows(f.dbFile)).toEqual(["created"]);
    expect(JSON.parse(readFileSync(f.meta, "utf8")).storage).toBe("site-home");
    expect(existsSync(join(f.state, "data"))).toBe(false);
    expect(existsSync(nativeBackupPath(domain, f.paths))).toBe(true);
    expect(statSync(f.storage.envFile).mode & 0o777).toBe(0o600);
  } finally { f.cleanup(); }
});

test("delete archives the actual application data and leaves unrelated adopted-site files", () => {
  const f = fixture();
  try {
    f.db.close();
    makeNativeBackup(domain, f.paths);
    const unrelated = join(dirname(f.storage.uploadsDir), "index.html");
    writeFileSync(unrelated, "other site file");
    const result = action(f, ["delete", "--domain", domain, "--confirm", domain]);
    expect(result.reply, result.stderr).toMatchObject({ ok: true });
    expect(existsSync(f.storage.dataDir)).toBe(false);
    expect(existsSync(f.storage.uploadsDir)).toBe(false);
    expect(existsSync(f.storage.envFile)).toBe(false);
    expect(existsSync(nativeBackupPath(domain, f.paths))).toBe(false);
    expect(readFileSync(unrelated, "utf8")).toBe("other site file");
    const archive = join(f.paths.backupDir, readdirSync(f.paths.backupDir)[0]!);
    const out = extract(archive, f.root);
    expect(rows(join(out, "data", "instatic.db"))).toEqual(["committed in WAL"]);
    expect(readFileSync(join(out, "uploads", "photo.txt"), "utf8")).toBe("original media");
    expect(readFileSync(join(out, "instatic.env"), "utf8")).toBe(key);
  } finally { f.cleanup(); }
});

test("migration refuses conflicting destinations and symlinked site directories before stopping Docker", () => {
  const f = fixture(true);
  try {
    f.db.close();
    const destination = homeStorage(domain, f.paths);
    mkdirSync(destination.uploadsDir, { recursive: true });
    writeFileSync(join(destination.uploadsDir, "keep.txt"), "existing file");
    let result = action(f, ["recreate", "--domain", domain]);
    expect(result.reply.error).toContain("storage already exists");
    expect(readFileSync(join(destination.uploadsDir, "keep.txt"), "utf8")).toBe("existing file");
    rmSync(destination.uploadsDir, { recursive: true });
    symlinkSync(f.storage.uploadsDir, destination.uploadsDir);
    result = action(f, ["recreate", "--domain", domain]);
    expect(result.reply.error).toContain("symlinked storage");
    expect(result.calls.some((call) => call[0] === "docker" && call[1] === "stop")).toBe(false);
    expect(rows(f.dbFile)).toEqual(["committed in WAL"]);
  } finally { f.cleanup(); }
});

test("batch backups report unmigrated sites while still backing up healthy sites", () => {
  const f = fixture();
  try {
    f.db.close();
    const other = join(f.paths.dataBaseDir, "legacy.example.com");
    mkdirSync(other);
    writeFileSync(join(other, "meta.json"), JSON.stringify({ domain: "legacy.example.com", tag: "0.0.18", port: 39001 }));
    const result = action(f, ["backup"]);
    expect(result.reply.ok).toBe(false);
    expect(result.reply.data.backups).toEqual([{ domain, snapshot: nativeBackupPath(domain, f.paths) }]);
    expect(result.reply.data.failures[0].domain).toBe("legacy.example.com");
    expect(existsSync(nativeBackupPath(domain, f.paths))).toBe(true);
  } finally { f.cleanup(); }
});

test("restore rejects a backup for a different domain before altering the container", () => {
  const f = fixture();
  try {
    f.db.close();
    const recorded = readFileSync(f.meta, "utf8");
    const archive = makeNativeBackup(domain, f.paths);
    writeFileSync(f.meta, recorded.replace(domain, "different.example.com"));
    expect(() => makeNativeBackup(domain, f.paths)).toThrow("metadata does not match");
    // Simulate an externally restored archive, bypassing publication guards.
    expect(makeSnapshot(f.state, archive, f.paths.sqlite3, { ...f.storage, includeUploads: false })).toBe(true);
    writeFileSync(f.meta, recorded);
    const result = action(f, ["recreate", "--domain", domain, "--from-backup"]);
    expect(result.reply.error).toContain("does not match this site");
    expect(result.calls.some((call) => call[0] === "docker" && call[1] === "stop")).toBe(false);
    expect(rows(f.dbFile)).toEqual(["committed in WAL"]);
  } finally { f.cleanup(); }
});

test("a restored site-home archive recovers on a fresh instance with a different site user", () => {
  const f = fixture();
  try {
    makeNativeBackup(domain, f.paths);
    f.db.close();
    const homeArchive = join(f.root, "cloudpanel-home.tar");
    execFileSync("tar", ["-cf", homeArchive, "-C", f.paths.homeDir, "site-user"]);
    rmSync(f.paths.homeDir, { recursive: true });
    rmSync(f.state, { recursive: true });
    mkdirSync(f.paths.homeDir);
    execFileSync("tar", ["-xf", homeArchive, "-C", f.paths.homeDir]);
    renameSync(join(f.paths.homeDir, "site-user"), join(f.paths.homeDir, "restored-user"));
    const panel = new Database(f.paths.panelDb);
    panel.run("UPDATE site SET user='restored-user' WHERE domain_name=?", [domain]);
    panel.close();
    const storage = homeStorage(domain, f.paths);
    writeFileSync(join(storage.dataDir, "instatic.db"), "unreliable live copy");
    const commands = installCommands(f);
    writeFileSync(commands.containers, "{}");
    const result = action(f, ["recreate", "--domain", domain, "--from-backup"]);
    expect(result.reply, result.stderr).toMatchObject({ ok: true });
    expect(rows(join(storage.dataDir, "instatic.db"))).toEqual(["committed in WAL"]);
    expect(readFileSync(storage.envFile, "utf8")).toContain(key.trim());
    expect(readFileSync(join(storage.uploadsDir, "photo.txt"), "utf8")).toBe("original media");
    expect(JSON.parse(readFileSync(f.meta, "utf8"))).toMatchObject({ siteUser: "restored-user", storage: "site-home" });
    expect(result.containers).toEqual({ [`instatic-${domain}`]: "running" });
  } finally { f.cleanup(); }
});

test("an empty recovery database is rejected before stopping the live container", () => {
  const f = fixture();
  try {
    const archive = makeNativeBackup(domain, f.paths);
    f.db.close();
    const out = extract(archive, f.root);
    writeFileSync(join(out, "data", "instatic.db"), "");
    execFileSync("tar", ["-czf", archive, "-C", out, "."]);
    const result = action(f, ["recreate", "--domain", domain, "--from-backup"]);
    expect(result.reply.error).toContain("recovery database is invalid");
    expect(result.calls.some((call) => call[0] === "docker" && call[1] === "stop")).toBe(false);
    expect(rows(f.dbFile)).toEqual(["committed in WAL"]);
  } finally { f.cleanup(); }
});
