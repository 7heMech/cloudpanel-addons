import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobGet, jobSet, readJobLog, watchJobRecord } from "../cli/job-store";

const ID = "20260911T160031Z-35e759";

function makeJob(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "clp-job-watch-"));
  const dir = join(root, ID);
  mkdirSync(dir);
  jobSet(dir, "state", "running");
  jobSet(dir, "step", "starting");
  writeFileSync(join(dir, "log"), "first\n");
  return { root, dir };
}

function snapshot(dir: string) {
  return {
    job: { state: jobGet(dir, "state"), step: jobGet(dir, "step"), event: jobGet(dir, "event") },
    log: readJobLog(dir),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

test("watchJobRecord emits its initial snapshot and changes", async () => {
  const { root, dir } = makeJob();
  try {
    const seen: Array<ReturnType<typeof snapshot>> = [];
    const watching = watchJobRecord({ dir, intervalMs: 5, read: () => snapshot(dir), emit: (value) => seen.push(value as ReturnType<typeof snapshot>) });
    await waitFor(() => seen.length === 1);

    jobSet(dir, "step", "copying");
    await waitFor(() => seen.length === 2);
    expect(seen[1]!.job.step).toBe("copying");

    appendFileSync(join(dir, "log"), "second\n");
    await waitFor(() => seen.length === 3);
    expect(seen[2]!.log).toContain("second");

    jobSet(dir, "event", "restarting");
    await waitFor(() => seen.length === 4);
    expect(seen[3]!.job.event).toBe("restarting");

    jobSet(dir, "step", "copying-again");
    await waitFor(() => seen.length === 5);
    expect(seen[4]!.job.step).toBe("copying-again");
    jobSet(dir, "state", "done");
    await watching;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("watchJobRecord stops after a terminal state", async () => {
  const { root, dir } = makeJob();
  try {
    const seen: unknown[] = [];
    const watching = watchJobRecord({ dir, intervalMs: 5, read: () => snapshot(dir), emit: (value) => seen.push(value) });
    await waitFor(() => seen.length === 1);
    jobSet(dir, "state", "done");
    await watching;
    expect(seen).toHaveLength(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("watchJobRecord stops on abort and does not emit unchanged records", async () => {
  const { root, dir } = makeJob();
  try {
    const controller = new AbortController();
    const seen: unknown[] = [];
    const watching = watchJobRecord({
      dir,
      intervalMs: 5,
      signal: controller.signal,
      read: () => snapshot(dir),
      emit: (value) => seen.push(value),
    });
    await waitFor(() => seen.length === 1);
    await Bun.sleep(25);
    expect(seen).toHaveLength(1);
    controller.abort();
    await watching;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
