import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function captureErrors<T>(work: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...values: unknown[]) => lines.push(values.map(String).join(" "));
  try {
    return { value: await work(), lines };
  } finally {
    console.error = original;
  }
}

const tempDir = mkdtempSync(join("/tmp", "clp-stager-spawn-"));
const actionProbePath = join(tempDir, "action-probe");
const modePath = join(tempDir, "mode");
const argvPath = join(tempDir, "argv");
const stdinPath = join(tempDir, "stdin");
const servicePath = join(dirname(fileURLToPath(import.meta.url)), "../addons/stager/app/service.ts");
const previousActionTestBin = process.env.CLP_ADDONS_ACTION_TEST_BIN;
const originalGetuid = Object.getOwnPropertyDescriptor(process, "getuid");
const needsDirectActionForTest = process.getuid?.() !== 0;

if (needsDirectActionForTest) {
  Object.defineProperty(process, "getuid", { value: () => 0, configurable: true, writable: true });
}

const action = `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$@" > ${shellQuote(argvPath)}
mode=$(<${shellQuote(modePath)})
case "$mode" in
  success)
    cat > ${shellQuote(stdinPath)}
    printf '%s\\n' '{"ok":true,"data":{"job":"20260909T120000Z-abcdef"}}'
    printf '%s\\n' 'action diagnostic' >&2
    ;;
  nonzero)
    printf '%s\\n' 'not JSON'
    printf '%s\\n' 'action rejected request' >&2
    exit 9
    ;;
  json-nonzero)
    printf '%s\\n' '{"ok":false,"error":"policy rejected"}'
    exit 9
    ;;
  timeout)
    printf '%s' '{"ok":true,"data":{"job":"should-not-be-accepted"}}'
    sleep 1
    ;;
  max-buffer)
    printf '%s' '{"ok":true,"data":{"job":"should-not-be-accepted"}}'
    head -c 4096 /dev/zero | tr '\\0' ' '
    ;;
  malformed)
    printf '%s\\n' 'not JSON'
    ;;
  early-exit)
    exit 0
    ;;
esac
`;

try {
  writeFileSync(actionProbePath, action, { mode: 0o700 });
  chmodSync(actionProbePath, 0o700);
  writeFileSync(modePath, "success\n");

  process.env.CLP_ADDONS_ACTION_TEST_BIN = actionProbePath;
  const { callWrapper, stagerService } = await import("../addons/stager/app/service.ts");

  const password = "secret password that must stay off argv";
  const mfaCode = "654321";
  const success = await captureErrors(() => stagerService.startClone(
    "source.example.com",
    "staging.source.example.com",
    true,
    { port: 39000, email: "admin@example.com", password, mfaCode },
  ));
  assert.deepEqual(success.value, {
    ok: true,
    data: { job: "20260909T120000Z-abcdef" },
  });
  assert(success.lines.some((line) => line.includes("[action:clone] action diagnostic")));
  const argv = readFileSync(argvPath, "utf8");
  assert(argv.startsWith("action\nstager\nclone\n"));
  assert(argv.includes("--email\nadmin@example.com\n"));
  assert(!argv.includes(password));
  assert(!argv.includes(mfaCode));
  assert.equal(readFileSync(stdinPath, "utf8"), `${password}\n${mfaCode}\n`);

  writeFileSync(modePath, "nonzero\n");
  const failed = await captureErrors(() => stagerService.startClone(
    "source.example.com",
    "staging.source.example.com",
    false,
    { port: 39000, email: "admin@example.com", password, mfaCode },
  ));
  assert.deepEqual(failed.value, { ok: false, error: "action rejected request" });
  assert(!failed.lines.join("\n").includes(password));
  assert(!failed.lines.join("\n").includes(mfaCode));

  writeFileSync(modePath, "json-nonzero\n");
  const jsonFailure = await stagerService.getJob("20260909T120000Z-abcdef");
  assert.deepEqual(jsonFailure, { ok: false, error: "policy rejected" });

  writeFileSync(modePath, "timeout\n");
  const timedOut = await callWrapper("job", [], undefined, { timeout: 25 });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error, "action process terminated");

  writeFileSync(modePath, "max-buffer\n");
  const overLimit = await callWrapper("job", [], undefined, { maxBuffer: 256 });
  assert.equal(overLimit.ok, false);
  assert.equal(overLimit.error, "action output exceeded 256 bytes");

  writeFileSync(modePath, "malformed\n");
  const malformed = await stagerService.getJob("20260909T120000Z-abcdef");
  assert.deepEqual(malformed, { ok: false, error: "action returned a malformed reply" });

  writeFileSync(modePath, "early-exit\n");
  const earlyExit = await stagerService.startClone(
    "source.example.com",
    "staging.source.example.com",
    false,
    {
      port: 39000,
      email: "admin@example.com",
      password: "x".repeat(1024 * 1024),
      mfaCode,
    },
  );
  assert.deepEqual(earlyExit, { ok: false, error: "action returned a malformed reply" });

  const service = readFileSync(servicePath, "utf8");
  assert.match(service, /Bun\.spawn/);
  assert.match(service, /new TextEncoder\(\)\.encode\(input \?\? ""\)/);
  assert.match(service, /timeout: options\.timeout/);
  assert.match(service, /maxBuffer: options\.maxBuffer/);
  assert.doesNotMatch(service, /from "node:child_process"/);

  const timeoutProbe = Bun.spawn({
    cmd: ["bash", "-c", "sleep 1"],
    stdin: new Uint8Array(),
    stdout: "ignore",
    stderr: "ignore",
    timeout: 25,
  });
  assert.equal(await timeoutProbe.exited, 143);

  console.log("stager spawn tests: 7 passed, 0 failed");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
  if (previousActionTestBin === undefined) delete process.env.CLP_ADDONS_ACTION_TEST_BIN;
  else process.env.CLP_ADDONS_ACTION_TEST_BIN = previousActionTestBin;
  if (originalGetuid) Object.defineProperty(process, "getuid", originalGetuid);
}
