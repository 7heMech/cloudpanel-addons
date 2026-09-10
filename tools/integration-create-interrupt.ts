// Phase 3 acceptance: killing a container mid-create must leave no site, no
// container, and no state row behind.
//
// The cleanup path is the interesting part, not the happy path. It has been
// wrong before: an earlier version deleted the CloudPanel site on any
// failure, including when the site pre-existed and the run had only adopted
// it.
//
// This is NOT part of `bun test` / CI, and it must never be run against a
// production panel. It requires:
//   - root (it inspects/mutates Docker, the CloudPanel panel database,
//     nginx config, and /etc/hosts)
//   - Docker
//   - an installed `clp-addons` binary
//   - a real CloudPanel host, with its panel SQLite database in place
//
// It writes to /etc/hosts and creates and then force-destroys a real
// CloudPanel site (container, vhost, database row, and on-disk state) for
// the given test domain. Run it only on a disposable CloudPanel host.
//
// `bun test` only collects `*.test.ts` / `*.spec.*` / `*_test.*`, so the
// `integration-` prefix keeps this out of that discovery on purpose.
//
// Usage:
//   bun tools/integration-create-interrupt.ts [test-domain]
//
// Note on the name: nothing here sends a signal to the create action. The
// action process is left running; what gets killed is the Docker container
// underneath it (`docker rm -f`), simulating a crashing image rather than an
// interrupted CLI process. The action is then awaited to completion and its
// own failure handling is what is under test.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const ACTION = "/usr/local/bin/clp-addons";
const DOMAIN = process.argv[2] ?? "interrupt-test.clp-stg.local";
const PANEL_DB = "/home/clp/htdocs/app/data/db.sq3";
const STATE = `/var/lib/clp-addons/instatic/${DOMAIN}`;
const CONTAINER = `instatic-${DOMAIN}`;
const VHOST = `/etc/nginx/sites-enabled/${DOMAIN}.conf`;
const STDOUT_PATH = "/tmp/create-out.json";
const STDERR_PATH = "/tmp/create-err.log";

if (process.getuid?.() !== 0) {
  console.error("must run as root");
  process.exit(2);
}

let fail = false;

/** Assert `actual === want`, printing a labelled ok/FAIL line. */
function check(label: string, actual: string, want: string): void {
  if (actual === want) {
    console.log(`  ok    ${label}`);
  } else {
    console.log(`  FAIL  ${label} (got ${actual}, wanted ${want})`);
    fail = true;
  }
}

/** Run a command synchronously and return trimmed stdout (ignoring failure). */
function spawnText(cmd: string[]): string {
  const result = Bun.spawnSync(cmd, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: process.env,
  });
  return Buffer.from(result.stdout ?? new Uint8Array()).toString("utf-8").trim();
}

/** Run a command synchronously, discarding output, and report success. */
function spawnOk(cmd: string[]): boolean {
  const result = Bun.spawnSync(cmd, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: process.env,
  });
  return result.exitCode === 0;
}

function containerCount(): string {
  return spawnText(["docker", "ps", "-a", "--format", "{{.Names}}"])
    .split("\n")
    .filter((name) => name === CONTAINER).length.toString();
}

/** Remove the test /etc/hosts entry, leaving all other lines untouched. */
function removeHostsEntry(): void {
  if (!existsSync("/etc/hosts")) return;
  const lines = readFileSync("/etc/hosts", "utf-8").split("\n");
  const kept = lines.filter((line) => !line.trimEnd().endsWith(` ${DOMAIN}`));
  if (kept.length !== lines.length) {
    writeFileSync("/etc/hosts", kept.join("\n"));
  }
}

async function main(): Promise<void> {
  console.log(`== preparing a clean slate for ${DOMAIN} ==`);
  spawnOk(["docker", "rm", "-f", CONTAINER]);
  spawnOk(["clpctl", "site:delete", `--domainName=${DOMAIN}`, "--force"]);
  rmSync(STATE, { recursive: true, force: true });
  const hosts = existsSync("/etc/hosts") ? readFileSync("/etc/hosts", "utf-8") : "";
  if (!hosts.includes(DOMAIN)) {
    writeFileSync("/etc/hosts", `${hosts}127.0.0.1 ${DOMAIN}\n`);
  }

  console.log("== starting create, then killing the container mid-run ==");
  const outFile = Bun.file(STDOUT_PATH);
  const errFile = Bun.file(STDERR_PATH);
  const action = Bun.spawn({
    cmd: [ACTION, "action", "instatic", "create", "--domain", DOMAIN, "--port", "39100", "--tag", "0.0.18"],
    stdin: "ignore",
    stdout: outFile,
    stderr: errFile,
    env: process.env,
  });

  // Wait for the container to exist, then destroy it so the health check
  // fails the way a crashing image would. No signal is ever sent to the
  // action process itself -- it keeps running and is expected to notice the
  // container is gone and fail its own way.
  let killed = false;
  for (let i = 0; i < 120; i++) {
    const names = spawnText(["docker", "ps", "-a", "--format", "{{.Names}}"]).split("\n");
    if (names.includes(CONTAINER)) {
      await Bun.sleep(2000);
      killed = spawnOk(["docker", "rm", "-f", CONTAINER]);
      console.log("  killed the container mid-create");
      break;
    }
    await Bun.sleep(1000);
  }
  if (!killed) {
    console.log("  note: container never appeared; create failed earlier");
  }

  const rc = await action.exited;
  console.log(`  action exit code: ${rc}`);
  const stdout = existsSync(STDOUT_PATH) ? readFileSync(STDOUT_PATH, "utf-8") : "";
  const lastLine = stdout.split("\n").filter((line) => line.length > 0).pop() ?? "";
  console.log(`  reply: ${lastLine}`);

  console.log("== nothing may be left behind ==");
  check("action reported failure", rc !== 0 ? "yes" : "no", "yes");
  check("no container", containerCount(), "0");
  check(
    "no CloudPanel site row",
    spawnText(["sqlite3", "-readonly", PANEL_DB, `SELECT COUNT(*) FROM site WHERE domain_name='${DOMAIN}';`]),
    "0",
  );
  check("no vhost on disk", existsSync(VHOST) ? "present" : "absent", "absent");
  check("no instance state directory", existsSync(STATE) ? "present" : "absent", "absent");
  check("nginx config still valid", spawnOk(["nginx", "-t"]) ? "ok" : "broken", "ok");
}

try {
  await main();
} finally {
  removeHostsEntry();
  rmSync(STDOUT_PATH, { force: true });
  rmSync(STDERR_PATH, { force: true });
}

console.log(fail ? "FAIL" : "PASS");
process.exit(fail ? 1 : 0);
