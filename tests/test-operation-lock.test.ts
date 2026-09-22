// One operation at a time, whichever entry point asked for it. A panel job, a
// root shell and the reconcile timer all write the same config files, units,
// Twig templates and Nginx fragments, so the second one has to wait and, when
// it gives up, say what it was waiting for.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLockSync } from "../cli/action-common";
import { OPERATION_LOCK_ENV, withOperationLock, withOperationLockSync } from "../cli/operation-lock";

const REPO = join(import.meta.dir, "..");

const HOLDER = String.raw`
  import { withOperationLockSync } from "./cli/operation-lock.ts";
  withOperationLockSync(process.env.CLP_TEST_OP, () => {
    process.stdout.write("held\n");
    Bun.sleepSync(Number(process.env.CLP_TEST_HOLD_MS));
  }, { lockDir: process.env.CLP_TEST_LOCK_DIR });
`;

/** A separate process holding the operation lock, already acquired on return. */
async function holder(lockDir: string, operation: string, holdMs: number) {
  const child = Bun.spawn([process.execPath, "-e", HOLDER], {
    cwd: REPO,
    env: {
      ...process.env,
      [OPERATION_LOCK_ENV]: "",
      CLP_TEST_LOCK_DIR: lockDir,
      CLP_TEST_OP: operation,
      CLP_TEST_HOLD_MS: String(holdMs),
    },
    stdout: "pipe",
    stderr: "inherit",
  });
  await child.stdout.getReader().read();
  return child;
}

function tempLockDir(): string {
  return mkdtempSync(join(tmpdir(), "clp-operation-lock-"));
}

test("withFileLockSync waits for another process and then runs", async () => {
  const dir = tempLockDir();
  try {
    const child = await holder(dir, "enable stager", 300);
    const started = Date.now();
    const result = withFileLockSync(join(dir, "operation.lock"), 10, "busy", () => "ran");
    expect(result).toBe("ran");
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    await child.exited;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a refusal names the operation in the way and when it started", async () => {
  const dir = tempLockDir();
  try {
    const child = await holder(dir, "enable stager", 2000);
    expect(() => withOperationLockSync("repair", () => "ran", { lockDir: dir, timeoutSeconds: 0.2 }))
      .toThrow(/clp-addons enable stager has been running since \d{4}-\d{2}-\d{2}T/);
    await child.exited;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the lock is released when the operation fails", () => {
  const dir = tempLockDir();
  try {
    expect(() => withOperationLockSync("repair", () => { throw new Error("boom"); }, { lockDir: dir }))
      .toThrow("boom");
    expect(withOperationLockSync("repair", () => "ran", { lockDir: dir, timeoutSeconds: 0.2 })).toBe("ran");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an operation nested inside another does not wait for itself", async () => {
  const dir = tempLockDir();
  try {
    const result = await withOperationLock("install stager", async () =>
      withOperationLockSync("enable stager", () => "ran", { lockDir: dir, timeoutSeconds: 0.2 }),
    { lockDir: dir, timeoutSeconds: 1 });
    expect(result).toBe("ran");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a re-exec marked as part of the operation does not wait for its parent", async () => {
  const dir = tempLockDir();
  try {
    const child = await holder(dir, "update", 2000);
    const inherited = Bun.spawn([process.execPath, "-e", HOLDER], {
      cwd: REPO,
      env: {
        ...process.env,
        [OPERATION_LOCK_ENV]: "update",
        CLP_TEST_LOCK_DIR: dir,
        CLP_TEST_OP: "update",
        CLP_TEST_HOLD_MS: "0",
      },
      stdout: "pipe",
      stderr: "inherit",
    });
    expect(await inherited.exited).toBe(0);
    await child.exited;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
