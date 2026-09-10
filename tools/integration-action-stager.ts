#!/usr/bin/env bun
/**
 * Integration test for `clp-addons action stager`.
 *
 * MANUALLY INVOKED. This is NOT part of `bun test` and is NOT run in CI: it
 * requires root, Docker, an installed `clp-addons` binary, and a real
 * CloudPanel host to run against. Anywhere else, it just fails the
 * root/executable preflight checks below.
 *
 * Invocation:
 *   bun tools/integration-action-stager.ts [path-to-clp-addons-binary]
 *
 * (defaults to /usr/local/bin/clp-addons if no path is given)
 *
 * This is the integration sibling of tools/test-action-stager.test.ts, which
 * imports addons/stager/action.ts and drives runStagerAction() directly, in
 * process, against a scratch panel database -- no root, no Docker, no
 * binary. This file instead spawns the real installed binary as a real
 * subprocess against a real panel, and asks the same two questions of it:
 *
 *   1. Hostile input is rejected, and rejection produces no side effects.
 *   2. Valid input reaches the verb body.
 *
 * (2) matters because of a failure mode this class of CLI parsing has hit
 * before: a validation guard whose *success* case (the condition being
 * false) causes the function to return non-zero and the process to exit with
 * no output at all. That looks identical to a no-op. Asserting only that bad
 * input is rejected does not catch it; asserting that every verb answers
 * with *something* does.
 *
 * Nothing here creates a site. Every case either fails validation or names a
 * domain that does not exist, so the binary answers before it would ever
 * reach clpctl.
 *
 * Every call goes through Bun.spawnSync with an argument array -- never a
 * shell string -- so hostile input reaches the binary uninterpreted rather
 * than being reinterpreted by a shell along the way.
 */

import { accessSync, constants, existsSync } from "node:fs";

const BIN = process.argv[2] ?? "/usr/local/bin/clp-addons";

function isExecutable(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

if (!isExecutable(BIN)) {
  console.error(`not executable: ${BIN}`);
  process.exit(2);
}

if (process.getuid?.() !== 0) {
  console.error("must run as root");
  process.exit(2);
}

let pass = 0;
let fail = 0;

function outputText(value: Uint8Array | null | undefined): string {
  return value ? Buffer.from(value).toString("utf-8") : "";
}

/** Mirrors `tail -1`: the last line, after dropping one trailing newline. */
function lastLine(text: string): string {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length > 0 ? (lines[lines.length - 1] ?? "") : "";
}

/** Assert the JSON reply matches a pattern. */
function expect(label: string, pattern: RegExp, args: string[]): void {
  const result = Bun.spawnSync([BIN, "action", "stager", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: process.env,
  });
  const out = lastLine(outputText(result.stdout));
  if (pattern.test(out)) {
    console.log(`  ok    ${label}`);
    pass++;
  } else {
    console.log(`  FAIL  ${label}`);
    console.log(`        wanted /${pattern.source}/`);
    console.log(`        got    ${out || "<no output>"}`);
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

console.log("== rejects hostile input ==");
expect(
  "shell metacharacters in --source",
  /"ok":false.*invalid domain for --source/,
  ["clone", "--source", "foo.com; touch /tmp/clp-stager-pwned", "--target", "stg.example.test"],
);
expect(
  "shell metacharacters in --target",
  /"ok":false.*invalid domain for --target/,
  ["clone", "--source", "example.test", "--target", "stg.example.test$(id>/tmp/clp-stager-pwned)"],
);
expect(
  "path traversal in --target",
  /"ok":false.*invalid domain for --target/,
  ["clone", "--source", "example.test", "--target", "../../../tmp/clp-stager-traversal"],
);
expect(
  "malformed domain label",
  /"ok":false.*invalid domain for --domain/,
  ["describe", "--domain", "bad..example.com"],
);
expect(
  "single-label domain",
  /"ok":false.*invalid domain for --domain/,
  ["describe", "--domain", "localhost"],
);
expect(
  "a domain over 253 characters",
  /"ok":false.*is too long/,
  ["describe", "--domain", `${"a".repeat(250)}.example.test`],
);
expect(
  "path traversal in --job",
  /"ok":false.*invalid job id/,
  ["job", "--job", "../../etc/shadow"],
);
expect(
  "a job id in the wrong shape",
  /"ok":false.*invalid job id/,
  ["job", "--job", "not-a-job"],
);
expect("an unknown verb", /"ok":false.*unknown verb/, ["frobnicate"]);
expect("an unknown argument", /"ok":false.*unknown argument/, ["sites", "--wat", "1"]);
expect(
  "--tls with a value that is not yes or no",
  /"ok":false.*takes yes or no/,
  ["clone", "--source", "example.test", "--target", "stg.example.test", "--tls", "maybe"],
);

expectAbsent("no file was created by the metacharacter cases", "/tmp/clp-stager-pwned");
expectAbsent("no file was created by the traversal case", "/tmp/clp-stager-traversal");

console.log("");
console.log("== rejects arguments a verb does not take ==");
expect("sites takes nothing", /"ok":false.*takes no arguments/, ["sites", "--domain", "example.test"]);
expect(
  "describe takes only --domain",
  /"ok":false.*takes only --domain/,
  ["describe", "--domain", "example.test", "--source", "other.test"],
);
expect(
  "job takes only --job",
  /"ok":false.*takes only --job/,
  ["job", "--job", "20260101T000000Z-abcdef", "--domain", "example.test"],
);
expect(
  "clone does not take --job",
  /"ok":false.*clone takes --source/,
  ["clone", "--source", "example.test", "--target", "stg.example.test", "--job", "20260101T000000Z-abcdef"],
);

console.log("");
console.log("== refuses nonsensical clones ==");
expect(
  "cloning a site into itself",
  /"ok":false.*same site/,
  ["clone", "--source", "example.test", "--target", "example.test"],
);
expect(
  "a source that is not a CloudPanel site",
  /"ok":false.*no CloudPanel site/,
  ["clone", "--source", "no-such-site.example.test", "--target", "stg.no-such-site.example.test"],
);
expect(
  "describing a site that does not exist",
  /"ok":false.*no CloudPanel site/,
  ["describe", "--domain", "no-such-site.example.test"],
);

console.log("");
console.log("== valid input reaches the verb body ==");
expect("sites answers with a list", /"ok":true.*"sites":\[/, ["sites"]);
expect("jobs answers with a list", /"ok":true.*"jobs":\[/, ["jobs"]);
expect("prune answers with a count", /"ok":true.*"removed":[0-9]+/, ["prune"]);
expect(
  "job on an unknown id says so rather than nothing",
  /"ok":false.*no such job/,
  ["job", "--job", "20260101T000000Z-abcdef"],
);

console.log("");
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
