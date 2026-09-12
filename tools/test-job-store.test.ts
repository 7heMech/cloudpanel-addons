import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createJobDir, createJobLog, jobCommonFields, jobDir, jobGet, jobSet, jobTimestamp,
  JOB_ID_RE, listJobIds, newJobId, pruneJobs, startJobUnit,
} from "../cli/job-store";

function withJobsDir<T>(fn: (jobsDir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "clp-jobs-"));
  try {
    return fn(join(dir, "jobs"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ageDir(path: string, milliseconds: number): void {
  const when = (Date.now() - milliseconds) / 1000;
  utimesSync(path, when, when);
}

describe("the shared job record", () => {
  it("mints ids the validators accept, newest sorting last by name", () => {
    const id = newJobId();
    expect(JOB_ID_RE.test(id)).toBe(true);
    // The id's stamp is what `listJobIds` sorts on, so it has to be the same
    // shape for every addon.
    expect(id.slice(0, 16)).toMatch(/^[0-9]{8}T[0-9]{6}Z$/);
    expect(jobTimestamp(true)).toMatch(/^[0-9]{8}T[0-9]{6}Z$/);
    expect(jobTimestamp()).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/);
  });

  it("writes fields owner-only and leaves no temporary behind", () => {
    withJobsDir((jobsDir) => {
      const dir = createJobDir(jobsDir, "20260911T160031Z-35e759");
      jobSet(dir, "state", "running");
      expect(jobGet(dir, "state")).toBe("running");
      expect(statSync(join(dir, "state")).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(readdirSync(dir).filter((f) => f.includes(".tmp."))).toEqual([]);
      expect(statSync(createJobLog(dir)).mode & 0o777).toBe(0o600);
    });
  });

  it("reads a missing field as empty rather than throwing", () => {
    withJobsDir((jobsDir) => {
      const dir = createJobDir(jobsDir, "20260911T160031Z-35e759");
      expect(jobGet(dir, "error")).toBe("");
      expect(jobCommonFields(dir)).toEqual({
        state: "", step: "", error: "", createdAt: "", startedAt: "", finishedAt: "",
      });
    });
  });

  it("lists only real job directories, newest first", () => {
    withJobsDir((jobsDir) => {
      for (const id of ["20260911T160031Z-35e759", "20260910T080000Z-aaaaaa"]) createJobDir(jobsDir, id);
      // Neither of these is a job, and both have turned up in a jobs directory:
      // a stray file, and a directory whose name is not an id.
      writeFileSync(join(jobsDir, "notes.txt"), "");
      mkdirSync(join(jobsDir, "scratch"));
      expect(listJobIds(jobsDir)).toEqual(["20260911T160031Z-35e759", "20260910T080000Z-aaaaaa"]);
    });
  });

  it("has no opinion about a jobs directory that does not exist yet", () => {
    withJobsDir((jobsDir) => {
      expect(listJobIds(jobsDir)).toEqual([]);
      expect(pruneJobs({ addon: "instatic", jobsDir, retentionDays: 14, stuckMessage: "x" }))
        .toEqual({ removed: 0, stuck: 0 });
    });
  });
});

describe("pruning job records", () => {
  const prune = (jobsDir: string, onStuck?: (id: string, state: string) => void) =>
    pruneJobs({
      addon: "instatic",
      jobsDir,
      retentionDays: 14,
      stuckMessage: "the creation job stopped without recording a result",
      onStuck,
    });

  it("drops a finished record once it is past its retention", () => {
    withJobsDir((jobsDir) => {
      const stale = createJobDir(jobsDir, "20260801T120000Z-aaaaaa");
      jobSet(stale, "state", "done");
      ageDir(stale, 20 * 24 * 60 * 60 * 1000);
      const fresh = createJobDir(jobsDir, "20260911T160031Z-35e759");
      jobSet(fresh, "state", "done");

      expect(prune(jobsDir)).toEqual({ removed: 1, stuck: 0 });
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
    });
  });

  it("fails a record whose runner is gone, so the hostname is not blocked forever", () => {
    withJobsDir((jobsDir) => {
      // Nothing on this machine runs clp-addon-instatic-job-<id>, so the unit
      // check answers the same way it does for a job killed by a reboot.
      const dir = createJobDir(jobsDir, "20260911T160031Z-35e759");
      jobSet(dir, "state", "running");
      ageDir(dir, 10 * 60 * 1000);

      const seen: string[] = [];
      expect(prune(jobsDir, (id, state) => seen.push(`${id}:${state}`)))
        .toEqual({ removed: 0, stuck: 1 });
      expect(seen).toEqual(["20260911T160031Z-35e759:running"]);
      expect(jobGet(dir, "state")).toBe("failed");
      expect(jobGet(dir, "error")).toBe("the creation job stopped without recording a result");
    });
  });

  it("gives a young record without a unit the benefit of the doubt", () => {
    withJobsDir((jobsDir) => {
      // systemd-run returns before the unit is necessarily visible, so a job
      // queued moments ago must not be declared dead.
      const dir = createJobDir(jobsDir, "20260911T160031Z-35e759");
      jobSet(dir, "state", "queued");

      expect(prune(jobsDir)).toEqual({ removed: 0, stuck: 0 });
      expect(jobGet(dir, "state")).toBe("queued");
    });
  });

  it("ignores anything in the directory that is not a job", () => {
    withJobsDir((jobsDir) => {
      mkdirSync(jobsDir, { recursive: true });
      const loose = join(jobsDir, "README");
      writeFileSync(loose, "");
      ageDir(loose, 400 * 24 * 60 * 60 * 1000);
      // A directory, too: prune removes directories, and one that is not named
      // like a job is not this code's to delete however old it is.
      const scratch = join(jobsDir, "scratch");
      mkdirSync(scratch);
      ageDir(scratch, 400 * 24 * 60 * 60 * 1000);

      expect(prune(jobsDir)).toEqual({ removed: 0, stuck: 0 });
      expect(existsSync(loose)).toBe(true);
      expect(existsSync(scratch)).toBe(true);
      expect(existsSync(jobDir(jobsDir, "README"))).toBe(true);
    });
  });
});

describe("starting transient job units", () => {
  it("configures background resource limits via systemd properties", () => {
    const origSpawnSync = Bun.spawnSync;
    let capturedArgs: string[] = [];
    try {
      // @ts-expect-error test mock
      Bun.spawnSync = (args: string[]) => {
        capturedArgs = args;
        return { success: true, stdout: "", stderr: "", exitCode: 0 };
      };
      startJobUnit({
        addon: "stager",
        id: "20260911T160031Z-35e759",
        description: "test job",
        actionBinary: "/usr/local/bin/clp-addons",
      });
      expect(capturedArgs).toContain("--property=CPUWeight=50");
      expect(capturedArgs).toContain("--property=IOWeight=50");
      expect(capturedArgs).toContain("--property=Type=exec");
      expect(capturedArgs).toContain("--collect");
    } finally {
      Bun.spawnSync = origSpawnSync;
    }
  });
});
