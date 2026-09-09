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
const wrapperPath = join(tempDir, "wrapper");
const modePath = join(tempDir, "mode");
const argvPath = join(tempDir, "argv");
const stdinPath = join(tempDir, "stdin");
const servicePath = join(dirname(fileURLToPath(import.meta.url)), "../addons/stager/app/service.ts");
const previousWrapper = process.env.STAGER_WRAPPER;
const originalGetuid = Object.getOwnPropertyDescriptor(process, "getuid");
const needsDirectWrapperForTest = process.getuid?.() !== 0;

if (needsDirectWrapperForTest) {
  Object.defineProperty(process, "getuid", { value: () => 0, configurable: true, writable: true });
}

const wrapper = `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$@" > ${shellQuote(argvPath)}
mode=$(<${shellQuote(modePath)})
case "$mode" in
  success)
    cat > ${shellQuote(stdinPath)}
    printf '%s\\n' '{"ok":true,"data":{"job":"20260909T120000Z-abcdef"}}'
    printf '%s\\n' 'wrapper diagnostic' >&2
    ;;
  nonzero)
    printf '%s\\n' 'wrapper rejected request' >&2
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
  writeFileSync(wrapperPath, wrapper, { mode: 0o700 });
  chmodSync(wrapperPath, 0o700);
  writeFileSync(modePath, "success\n");

  process.env.STAGER_WRAPPER = wrapperPath;
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
  assert(success.lines.some((line) => line.includes("[wrapper:clone] wrapper diagnostic")));
  const argv = readFileSync(argvPath, "utf8");
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
  assert.deepEqual(failed.value, { ok: false, error: "wrapper rejected request" });
  assert(!failed.lines.join("\n").includes(password));
  assert(!failed.lines.join("\n").includes(mfaCode));

  writeFileSync(modePath, "json-nonzero\n");
  const jsonFailure = await stagerService.getJob("20260909T120000Z-abcdef");
  assert.equal(jsonFailure.ok, false);
  assert.match(jsonFailure.error ?? "", /wrapper job exited 9/);

  writeFileSync(modePath, "timeout\n");
  const timedOut = await callWrapper("job", [], undefined, { timeout: 25 });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error, "wrapper process terminated");

  writeFileSync(modePath, "max-buffer\n");
  const overLimit = await callWrapper("job", [], undefined, { maxBuffer: 256 });
  assert.equal(overLimit.ok, false);
  assert.equal(overLimit.error, "wrapper output exceeded 256 bytes");

  writeFileSync(modePath, "malformed\n");
  const malformed = await stagerService.getJob("20260909T120000Z-abcdef");
  assert.deepEqual(malformed, { ok: false, error: "wrapper returned a malformed reply" });

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
  assert.deepEqual(earlyExit, { ok: false, error: "wrapper returned a malformed reply" });

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
  if (previousWrapper === undefined) delete process.env.STAGER_WRAPPER;
  else process.env.STAGER_WRAPPER = previousWrapper;
  if (originalGetuid) Object.defineProperty(process, "getuid", originalGetuid);
}
