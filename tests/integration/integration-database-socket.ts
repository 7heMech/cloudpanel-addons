// Compile with bun build --compile, then run in a disposable Debian 12 Docker
// container booted with systemd and mariadb-server/iproute2 installed.
// This restarts the container's database and creates fictional test data.
// The container must have CLP_DISPOSABLE_DB_TEST=1; never run on a real server.
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { runCommand } from "../../cli/action-common";
import { DATABASE_FILE, databaseStatus, reconcileDatabaseFile, setDatabaseLoopback } from "../../addons/system-tweaks/database";

if (process.getuid?.() !== 0 || process.env.CLP_DISPOSABLE_DB_TEST !== "1" || !existsSync("/.dockerenv")) {
  throw new Error("run only inside the disposable Docker test container with CLP_DISPOSABLE_DB_TEST=1");
}

function command(name: string, args: string[]): string {
  const result = runCommand(name, args, 120_000);
  assert.ok(result.ok, `${name} ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
const systemctl = (...args: string[]) => command("systemctl", args);
const sql = (statement: string, connection: string[] = ["--protocol=socket"]) => command("mariadb", [
  "--no-defaults", ...connection, "--batch", "--skip-column-names", `--execute=${statement}`,
]);
const pid = () => systemctl("show", "mysql", "--property=MainPID", "--value");
const ownIp = command("hostname", ["-I"]).split(/\s+/)[0]!;
const readRow = (connection: string[]) => assert.equal(sql("SELECT value FROM socket_probe.marker", connection), "still here");
const tcp = (host: string) => ["--protocol=tcp", `--host=${host}`, "--user=socket_probe", "--password=fixture", "--connect-timeout=3"];
const assertWide = () => assert.ok(databaseStatus().exposed.some((address) => address.endsWith(":3306")), "expected the original public socket");
const assertLocal = () => {
  const status = databaseStatus();
  assert.equal(status.running, true);
  assert.deepEqual(status.exposed, []);
  readRow(tcp("127.0.0.1"));
  readRow(tcp("::1"));
  readRow(["--protocol=socket"]);
  readRow(["--protocol=socket", "--socket=@mariadb"]);
  const remote = runCommand("mariadb", ["--no-defaults", ...tcp(ownIp), "--execute=SELECT 1"], 5_000);
  assert.equal(remote.ok, false, "the container's non-loopback address must not accept TCP");
};

systemctl("stop", "mysql", "mariadb.socket");
systemctl("start", "mariadb.socket", "mysql");
sql("DROP DATABASE IF EXISTS socket_probe; DROP USER IF EXISTS 'socket_probe'@'%'; CREATE DATABASE socket_probe; CREATE TABLE socket_probe.marker (value VARCHAR(32)); INSERT INTO socket_probe.marker VALUES ('still here'); CREATE USER 'socket_probe'@'%' IDENTIFIED BY 'fixture'; GRANT SELECT ON socket_probe.* TO 'socket_probe'@'%'");
const originalUnit = systemctl("cat", "mariadb.socket");
const baseConfig = readFileSync("/etc/mysql/mariadb.conf.d/50-server.cnf", "utf8");
assertWide();
readRow(tcp(ownIp));
console.log(command("mariadb", ["--version"]));

// Reproduce the reported failure: restarting only MariaDB leaves systemd's
// public socket in place even with the loopback option file present.
const optionFile = "/etc/mysql/mariadb.conf.d/zz-clp-addons-loopback.cnf";
writeFileSync(optionFile, DATABASE_FILE);
systemctl("restart", "mysql");
assertWide();
rmSync(optionFile);
console.log("Reproduced: bind-address plus a service-only restart still leaves *:3306 listening");

await setDatabaseLoopback(true);
assertLocal();
const activePid = pid();
await setDatabaseLoopback(true);
assert.equal(pid(), activePid, "reapplying an active setting should not restart MariaDB");
await setDatabaseLoopback(false);
assertWide();
assert.equal(systemctl("cat", "mariadb.socket"), originalUnit);
assert.equal(readFileSync("/etc/mysql/mariadb.conf.d/50-server.cnf", "utf8"), baseConfig);
readRow(tcp(ownIp));
console.log("Enable/disable: real IPv4, IPv6, Unix and abstract sockets, data preservation and original configuration passed");

const beforeRepair = pid();
assert.ok(reconcileDatabaseFile(true));
assert.equal(pid(), beforeRepair, "repair must not restart the service");
assertWide();
await setDatabaseLoopback(true);
assertLocal();
const beforeWithdrawal = pid();
assert.ok(reconcileDatabaseFile(false));
assert.equal(pid(), beforeWithdrawal, "addon withdrawal must not restart the service");
assertLocal();
assert.equal(systemctl("cat", "mariadb.socket"), originalUnit);
systemctl("stop", "mysql", "mariadb.socket");
systemctl("start", "mariadb.socket", "mysql");
assertWide();
console.log("Repair/withdrawal: configuration reconciled without changing live listeners or restarting the database");

for (const failure of ["start", "daemon-reload"]) {
  let failed = false;
  await assert.rejects(setDatabaseLoopback(true, {
    run(name, args) {
      if (!failed && name === "systemctl" && args[0] === failure) {
        failed = true;
        return { ok: false, stdout: "", stderr: `injected ${failure} failure`, exitCode: 1 };
      }
      return runCommand(name, args, 120_000);
    },
  }), new RegExp(`injected ${failure} failure`));
  assert.ok(failed);
  assertWide();
  assert.equal(systemctl("is-active", "mariadb.socket"), "active");
  assert.equal(systemctl("is-active", "mysql"), "active");
  assert.equal(systemctl("cat", "mariadb.socket"), originalUnit);
  readRow(tcp(ownIp));
  console.log(`Rollback after ${failure} failure: original configuration, service, sockets and data restored`);
}
