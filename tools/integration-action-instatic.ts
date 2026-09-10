// Integration tests for `clp-addons action instatic`, run against a real
// installed binary on a real CloudPanel host.
//
// This is NOT part of `bun test` / CI. It requires:
//   - root (the binary refuses to run as anyone else, and this script also
//     inspects Docker containers and the CloudPanel panel database)
//   - Docker
//   - an installed `clp-addons` binary
//   - a real CloudPanel host, with its panel SQLite database in place
//
// It is a manual, host-side smoke test. `bun test` only collects
// `*.test.ts` / `*.spec.*` / `*_test.*`, so the `integration-` prefix keeps
// this out of that discovery on purpose -- see tools/test-action-instatic.test.ts
// for the in-process unit test that exercises addons/instatic/action.ts
// directly and needs none of the above.
//
// Usage:
//   bun tools/integration-action-instatic.ts [path-to-clp-addons-binary]
//
// Two things are checked, and the second is the one that has actually broken:
//
//   1. Hostile input is rejected, and rejection produces no side effects.
//   2. Valid input reaches the verb body.
//
// (2) exists because of a silent failure mode specific to this binary's
// argument-handling code. Under a trailing `cond && emitErr("...")` guard, a
// false condition (the *success* case) can make the calling function return
// without emitting anything, so the process exits with no output at all. It
// looks identical to a no-op. Asserting that each verb emits *something*
// catches it; asserting only that bad input is rejected does not.

import { accessSync, constants, existsSync, unlinkSync } from "node:fs";

const BIN = process.argv[2] ?? "/usr/local/bin/clp-addons";

try {
  accessSync(BIN, constants.X_OK);
} catch {
  console.error(`not executable: ${BIN}`);
  process.exit(2);
}

if (process.getuid?.() !== 0) {
  console.error("must run as root");
  process.exit(2);
}

let pass = 0;
let fail = 0;

/** Run `$BIN action instatic <args>`, returning the last line of stdout. */
function runAction(args: string[]): string {
  const result = Bun.spawnSync([BIN, "action", "instatic", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: process.env,
  });
  const stdout = Buffer.from(result.stdout ?? new Uint8Array()).toString("utf-8");
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  return lines.length > 0 ? lines[lines.length - 1]! : "";
}

/** Assert the JSON reply matches a pattern. */
function expect(label: string, pattern: RegExp, args: string[]): void {
  const out = runAction(args);
  if (pattern.test(out)) {
    console.log(`  ok    ${label}`);
    pass++;
  } else {
    console.log(`  FAIL  ${label}\n        wanted /${pattern.source}/\n        got    ${out || "<no output>"}`);
    fail++;
  }
}

/** Assert a file does not exist. */
function expectAbsent(label: string, path: string): void {
  if (existsSync(path)) {
    console.log(`  FAIL  ${label} (${path} was created)`);
    fail++;
  } else {
    console.log(`  ok    ${label}`);
    pass++;
  }
}

function spawnText(cmd: string[]): string {
  const result = Bun.spawnSync(cmd, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: process.env,
  });
  return Buffer.from(result.stdout ?? new Uint8Array()).toString("utf-8").trim();
}

console.log("== rejects hostile input ==");
expect(
  "shell metacharacters in --domain",
  /"ok":false.*invalid domain/,
  ["create", "--domain", "foo.com; touch /tmp/clp-test-pwned", "--port", "39000", "--tag", "0.0.18"],
);
expect(
  "path traversal in --domain",
  /"ok":false.*invalid domain/,
  ["stop", "--domain", "../../../tmp/clp-test-traversal"],
);
expect("malformed domain label", /"ok":false.*invalid domain/, ["stop", "--domain", "bad..example.com"]);
expect("single-label domain", /"ok":false.*invalid domain/, ["stop", "--domain", "localhost"]);
expect(
  "port below the reserved range",
  /"ok":false.*outside reserved range/,
  ["create", "--domain", "a.example.com", "--port", "8080", "--tag", "0.0.18"],
);
expect(
  "port above the reserved range",
  /"ok":false.*outside reserved range/,
  ["create", "--domain", "a.example.com", "--port", "40000", "--tag", "0.0.18"],
);
expect(
  "non-numeric port",
  /"ok":false.*(must be an integer|outside reserved)/,
  ["create", "--domain", "a.example.com", "--port", "39000x", "--tag", "0.0.18"],
);
expect(
  "tag 'latest'",
  /"ok":false.*exact version/,
  ["create", "--domain", "a.example.com", "--port", "39000", "--tag", "latest"],
);
expect(
  "tag as a branch name",
  /"ok":false.*exact version/,
  ["create", "--domain", "a.example.com", "--port", "39000", "--tag", "main"],
);
expect(
  "unknown flag",
  /"ok":false.*unknown argument/,
  ["create", "--domain", "a.example.com", "--port", "39000", "--tag", "0.0.18", "--registry", "evil.io"],
);
expect("unknown verb", /"ok":false.*unknown verb/, ["exec", "--domain", "a.example.com"]);
expect("flag without a value", /"ok":false.*needs a value/, ["stop", "--domain"]);
expect(
  "delete confirm mismatch",
  /"ok":false.*confirm must equal/,
  ["delete", "--domain", "a.example.com", "--confirm", "b.example.com"],
);
expect(
  "update rejects --port",
  /"ok":false.*does not take --port/,
  ["update", "--domain", "a.example.com", "--port", "39000", "--tag", "0.0.18"],
);
expect(
  "stop rejects --tag",
  /"ok":false.*takes only --domain/,
  ["stop", "--domain", "a.example.com", "--tag", "0.0.18"],
);

console.log("== rejection leaves nothing behind ==");
expectAbsent("no file from the injection attempt", "/tmp/clp-test-pwned");
expectAbsent("no lock file outside the lock dir", "/tmp/clp-test-traversal.lock");

console.log("== valid input reaches the verb body ==");
// Each of these must produce a reply. Silence means the guard-clause
// regression is back and the verb is exiting before it runs.
const NOPE = "absent-instance.example.com";
expect("start reaches the body", /"ok":(true|false)/, ["start", "--domain", NOPE]);
expect("stop reaches the body", /"ok":(true|false)/, ["stop", "--domain", NOPE]);
expect("restart reaches the body", /"ok":(true|false)/, ["restart", "--domain", NOPE]);
expect("status reaches the body", /"ok":true.*absent/, ["status", "--domain", NOPE]);
expect("logs reaches the body", /"ok":(true|false)/, ["logs", "--domain", NOPE]);
expect("snapshot reaches the body", /"ok":(true|false)/, ["snapshot", "--domain", NOPE]);
expect("update reaches the body", /"ok":false.*no such instance/, ["update", "--domain", NOPE, "--tag", "0.0.18"]);
expect("delete reaches the body", /"ok":(true|false)/, ["delete", "--domain", NOPE, "--confirm", NOPE]);
expect("recreate reaches the body", /"ok":false.*no such instance/, ["recreate", "--domain", NOPE]);
expect(
  "recreate rejects --tag",
  /"ok":false.*takes only --domain/,
  ["recreate", "--domain", NOPE, "--tag", "0.0.18"],
);

// create is the one verb whose body has side effects, so stop it at its
// first guard rather than letting it build anything.
const containerNames = spawnText(["docker", "ps", "-a", "--format", "{{.Names}}"])
  .split("\n")
  .filter((name) => name.length > 0);
const existingInstatic = containerNames.find((name) => name.startsWith("instatic-"));
if (existingInstatic) {
  const existing = existingInstatic.slice("instatic-".length);
  expect(
    "create reaches the body",
    /"ok":false.*already exists/,
    ["create", "--domain", existing, "--port", "39999", "--tag", "0.0.18"],
  );
} else {
  console.log("  skip  create reaches the body (no existing instance to collide with)");
}

// The instance identity model: an instance runs as the site user CloudPanel
// created for its domain, and never as a system account. A regression here
// is not visible from the outside -- a container that cannot write its
// database still serves pages -- so it is asserted rather than eyeballed.
console.log("== instances run as their own site user ==");
const running = spawnText(["docker", "ps", "--filter", "label=clp-addon=instatic", "--format", "{{.Names}}"])
  .split("\n")
  .find((name) => name.length > 0);
if (running) {
  const dom = running.startsWith("instatic-") ? running.slice("instatic-".length) : running;
  const want = spawnText([
    "sqlite3",
    "-readonly",
    "/home/clp/htdocs/app/data/db.sq3",
    `SELECT user FROM site WHERE domain_name = '${dom}';`,
  ]);
  const wantUidText = want ? spawnText(["id", "-u", want]) : "";
  const wantUid = wantUidText !== "" && /^\d+$/.test(wantUidText) ? Number(wantUidText) : undefined;
  const gotUidField = spawnText(["docker", "inspect", running, "--format", "{{.Config.User}}"]);
  const gotUid = gotUidField.split(":")[0] ?? "";

  if (wantUid !== undefined && gotUid === String(wantUid)) {
    console.log(`  ok    ${dom} runs as ${want} (uid ${wantUid})`);
    pass++;
  } else {
    console.log(`  FAIL  ${dom} runs as uid ${gotUid || "<image default>"}, expected ${want} (uid ${wantUid ?? "?"})`);
    fail++;
  }

  if ((wantUid ?? 0) >= 1000 && want !== "clp") {
    console.log(`  ok    ${want} is a site account, not the panel account`);
    pass++;
  } else {
    console.log(`  FAIL  ${want} is not a site account (uid ${wantUid ?? "?"})`);
    fail++;
  }

  // The failure this actually catches: data owned by someone the container
  // is not, which leaves it serving reads and silently refusing every write.
  const writeProbe = Bun.spawnSync(
    ["docker", "exec", running, "sh", "-c", "touch /app/data/.wtest && rm -f /app/data/.wtest"],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: process.env },
  );
  if (writeProbe.success) {
    console.log(`  ok    ${dom} can write its own data directory`);
    pass++;
  } else {
    console.log(`  FAIL  ${dom} cannot write /app/data`);
    fail++;
  }
} else {
  console.log("  skip  instance identity (no running instance)");
}

// Best-effort cleanup of any lock left by rejected verbs above; the binary
// owns /run/lock/clp-addons and clears its own locks on success.
try {
  const lockDir = "/run/lock/clp-addons";
  if (existsSync(lockDir)) {
    const glob = new Bun.Glob("*.lock");
    for (const entry of glob.scanSync({ cwd: lockDir, absolute: true })) {
      try {
        unlinkSync(entry);
      } catch {
        // best effort
      }
    }
  }
} catch {
  // best effort
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
