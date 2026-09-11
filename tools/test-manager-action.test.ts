// The manager's own privileged verbs: enabling an addon that already ships in
// the binary, disabling one, and applying a release.
//
// Everything here is about the seam that makes those safe to offer from a web
// page: which verbs the root gateway will run at all, and the job record that
// carries the outcome across the manager restart each of them ends with.
import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANAGER_ALLOWED_VERBS } from "../lib/gateway-protocol";
import { createAuthActionServer } from "../cli/auth-action";
import {
  activeManagerJob, createJob, type CreateJobOptions, latestManagerJob, parseManagerFlags, pruneManagerJobs, readManagerJob,
  runManagerJob, type ManagerOps,
} from "../cli/manager-action";
import { handleManagerRoute, indexPage, installedInjections, safeDecodePathSegment } from "../cli/index";
import { listJobIds } from "../cli/job-store";
import { csrfCookieHeader, newCsrfToken } from "../lib/app-http";

function makeJobsDir(): string {
  return mkdtempSync(join(tmpdir(), "clp-manager-jobs-"));
}

function writeJob(jobsDir: string, id: string, fields: Record<string, string>): string {
  const dir = join(jobsDir, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [field, value] of Object.entries(fields)) {
    writeFileSync(join(dir, field), `${value}\n`, { mode: 0o600 });
  }
  writeFileSync(join(dir, "log"), "", { mode: 0o600 });
  return dir;
}

function age(dir: string, minutes: number): void {
  const when = new Date(Date.now() - minutes * 60 * 1000);
  utimesSync(dir, when, when);
}

async function gatewayReply(request: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "clp-manager-gateway-"));
  const sockPath = join(dir, "gateway.sock");
  const server = createAuthActionServer();
  try {
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    return await new Promise<string>((resolve) => {
      let reply = "";
      Bun.connect({
        unix: sockPath,
        socket: {
          open(conn) { conn.write(request); },
          data(_conn, chunk) { reply += Buffer.from(chunk).toString("utf8"); },
          close() { resolve(reply); },
        },
      });
    });
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const NOOP_OPS: ManagerOps = { enable: () => {}, disable: () => {}, update: async () => {} };

describe("the gateway's manager namespace", () => {
  test("offers exactly the verbs a page may ask for", () => {
    expect([...MANAGER_ALLOWED_VERBS].sort()).toEqual(["disable", "enable", "job", "update"]);
  });

  // The runner is started by the transient unit the create path launches, and
  // by nothing else. Reaching it through the gateway would skip the check that
  // makes a second click follow the first click's job instead of starting a
  // second enable.
  test("will not run the job runner", async () => {
    const reply = await gatewayReply('{"kind":"action","addon":"manager","verb":"run","args":["--job","20260908T120000Z-aaaaaa"]}\n');
    expect(JSON.parse(reply)).toEqual({ ok: false, error: "invalid verb" });
  });

  test("will not be talked into an addon it does not know", async () => {
    const reply = await gatewayReply('{"kind":"action","addon":"constructor","verb":"enable"}\n');
    expect(JSON.parse(reply)).toEqual({ ok: false, error: "unknown addon" });
  });
});

describe("the two spellings this action is reached by", () => {
  // The manager builds `--addon=stager`; startJobUnit, shared with the addons,
  // builds `--job <id>`. Reading only the first spelling meant every job the
  // runner was handed arrived with no id at all.
  test("reads the job id systemd's transient unit passes", () => {
    expect(parseManagerFlags(["--job", "20260908T120000Z-aaaaaa"])).toEqual({ job: "20260908T120000Z-aaaaaa" });
  });

  test("reads the flags the manager builds", () => {
    expect(parseManagerFlags(["--addon=stager"])).toEqual({ addon: "stager" });
  });

  test("does not swallow the next flag as a value", () => {
    expect(parseManagerFlags(["--addon", "--id", "20260908T120000Z-aaaaaa"])).toEqual({ id: "20260908T120000Z-aaaaaa" });
  });
});

describe("the manager's job record", () => {
  test("runs the requested operation and records that it finished", async () => {
    const jobsDir = makeJobsDir();
    try {
      writeJob(jobsDir, "20260908T120000Z-aaaaaa", { kind: "enable", addon: "stager", state: "queued" });
      const enabled: string[] = [];
      const code = await runManagerJob("20260908T120000Z-aaaaaa", { ...NOOP_OPS, enable: (a) => { enabled.push(a); } }, jobsDir);
      expect(code).toBe(0);
      expect(enabled).toEqual(["stager"]);
      const read = readManagerJob("20260908T120000Z-aaaaaa", jobsDir);
      expect(read?.job.state).toBe("done");
      expect(read?.job.error).toBe("");
      expect(read?.job.finishedAt).not.toBe("");
    } finally {
      rmSync(jobsDir, { recursive: true, force: true });
    }
  });

  // The failure has to survive in the record: the process that asked for the
  // work is restarted by the work, so there is no connection left to answer.
  test("keeps the reason a failed operation failed", async () => {
    const jobsDir = makeJobsDir();
    try {
      writeJob(jobsDir, "20260908T120000Z-bbbbbb", { kind: "update", state: "queued" });
      const code = await runManagerJob("20260908T120000Z-bbbbbb", {
        ...NOOP_OPS,
        update: async () => { throw new Error("checksum mismatch for clp-addons-linux-x64"); },
      }, jobsDir);
      expect(code).toBe(1);
      const read = readManagerJob("20260908T120000Z-bbbbbb", jobsDir);
      expect(read?.job.state).toBe("failed");
      expect(read?.job.error).toBe("checksum mismatch for clp-addons-linux-x64");
    } finally {
      rmSync(jobsDir, { recursive: true, force: true });
    }
  });

  test("refuses a record whose kind this binary cannot run", async () => {
    const jobsDir = makeJobsDir();
    try {
      writeJob(jobsDir, "20260908T120000Z-cccccc", { kind: "reboot-everything", state: "queued" });
      expect(await runManagerJob("20260908T120000Z-cccccc", NOOP_OPS, jobsDir)).toBe(1);
      expect(readManagerJob("20260908T120000Z-cccccc", jobsDir)?.job.state).toBe("failed");
    } finally {
      rmSync(jobsDir, { recursive: true, force: true });
    }
  });

  test("reads nothing for a job that was never written", () => {
    const jobsDir = makeJobsDir();
    try {
      expect(readManagerJob("20260908T120000Z-dddddd", jobsDir)).toBeNull();
      expect(latestManagerJob(jobsDir)).toBeNull();
    } finally {
      rmSync(jobsDir, { recursive: true, force: true });
    }
  });

  test("treats the newest record as the one a reloaded page is following", () => {
    const jobsDir = makeJobsDir();
    try {
      writeJob(jobsDir, "20260908T120000Z-aaaaaa", { kind: "enable", state: "done" });
      writeJob(jobsDir, "20260909T090000Z-bbbbbb", { kind: "update", state: "running" });
      expect(latestManagerJob(jobsDir)).toBe("20260909T090000Z-bbbbbb");
    } finally {
      rmSync(jobsDir, { recursive: true, force: true });
    }
  });
});

describe("one click, one job", () => {
  // A record seconds old counts as live even with no unit yet: systemd-run
  // returns before `systemctl is-active` can necessarily see the unit.
  test("a just-created job is what a second click finds", () => {
    const jobsDir = makeJobsDir();
    try {
      writeJob(jobsDir, "20260908T120000Z-aaaaaa", { kind: "enable", state: "queued" });
      expect(activeManagerJob(jobsDir)).toBe("20260908T120000Z-aaaaaa");
    } finally {
      rmSync(jobsDir, { recursive: true, force: true });
    }
  });

  test("a finished job never blocks the next one", () => {
    const jobsDir = makeJobsDir();
    try {
      writeJob(jobsDir, "20260908T120000Z-aaaaaa", { kind: "enable", state: "done" });
      writeJob(jobsDir, "20260908T130000Z-bbbbbb", { kind: "update", state: "failed" });
      expect(activeManagerJob(jobsDir)).toBeNull();
    } finally {
      rmSync(jobsDir, { recursive: true, force: true });
    }
  });

  // Without this, a reboot during an update leaves a record that says "running"
  // for ever, and the page keeps following a job nothing is working on.
  test("maintenance fails a job whose runner is gone and keeps the reason", () => {
    const jobsDir = makeJobsDir();
    try {
      const dir = writeJob(jobsDir, "20260908T120000Z-aaaaaa", { kind: "update", state: "running" });
      age(dir, 30);
      expect(activeManagerJob(jobsDir)).toBeNull();
      const { stuck } = pruneManagerJobs(jobsDir);
      expect(stuck).toBe(1);
      const read = readManagerJob("20260908T120000Z-aaaaaa", jobsDir);
      expect(read?.job.state).toBe("failed");
      expect(read?.job.error).toContain("runner is gone");
    } finally {
      rmSync(jobsDir, { recursive: true, force: true });
    }
  });

  test("concurrent create requests serialize and only create and start one job", async () => {
    const jobsDir = makeJobsDir();
    const lockDir = makeJobsDir();
    const startedUnits: any[] = [];
    const replies: any[] = [];

    try {
      const options: CreateJobOptions = {
        jobsDir,
        lockDir,
        startUnit: (opts) => {
          startedUnits.push(opts);
          return { ok: true, stdout: "", stderr: "" };
        },
        emitReply: false,
        onReply: (data) => replies.push(data),
      };

      const results = await Promise.all([
        createJob("enable", "stager", options),
        createJob("enable", "stager", options),
        createJob("enable", "stager", options),
      ]);

      expect(results).toEqual([0, 0, 0]);
      expect(startedUnits).toHaveLength(1);
      expect(listJobIds(jobsDir)).toHaveLength(1);
      expect(replies).toHaveLength(3);

      const created = replies.filter((r) => r.data?.existing === false);
      const reused = replies.filter((r) => r.data?.existing === true);
      expect(created).toHaveLength(1);
      expect(reused).toHaveLength(2);
      expect(reused[0].data.jobId).toBe(created[0].data.jobId);
      expect(reused[1].data.jobId).toBe(created[0].data.jobId);
    } finally {
      rmSync(jobsDir, { recursive: true, force: true });
      rmSync(lockDir, { recursive: true, force: true });
    }
  });
});

describe("the panel's Addons entry", () => {
  // It used to be derived from "at least one addon is enabled", which was the
  // same thing until an addon could be disabled from the page the entry leads
  // to. Disabling the last one then took the link away and left no way back to
  // the page that would offer the addons again.
  test("survives every addon being disabled", () => {
    expect(installedInjections(undefined, true).some((injection) => injection.addon === "manager")).toBe(true);
  });

  test("goes when the installation itself goes", () => {
    expect(installedInjections(undefined, false).some((injection) => injection.addon === "manager")).toBe(false);
  });
});

describe("the manager index", () => {
  async function render(...args: Parameters<typeof indexPage>): Promise<string> {
    return indexPage(...args).text();
  }

  test("offers an addon that is compiled in but not enabled", async () => {
    const html = await render(["instatic"], null, { available: ["stager"] });
    expect(html).toContain("<h2>Available</h2>");
    expect(html).toContain("enableAddon('stager')");
    expect(html).toContain("Open Instatic");
    expect(html).toContain("disableAddon('instatic')");
  });

  test("shows no Available section when every addon is on", async () => {
    const html = await render(["instatic", "stager"], null, { available: [] });
    expect(html).not.toContain("<h2>Available</h2>");
    // The handlers are always defined; what must be absent is anything calling them.
    expect(html).not.toContain("enableAddon('");
  });

  // The notice is what this project offers instead of unattended updates, so
  // the action on it has to be a deliberate press, not a background task.
  test("turns the release notice into a button only here", async () => {
    const withUpdate = await render(["instatic"], { current: "1.0.0", latest: "1.1.0" });
    expect(withUpdate).toContain('onclick="updateNow()"');
    expect(withUpdate).toContain("1.1.0");
    // No notice, no button: the page never offers to replace the binary when
    // there is nothing newer to replace it with.
    const withoutUpdate = await render(["instatic"], null);
    expect(withoutUpdate).not.toContain('onclick="updateNow()"');
  });

  test("follows a job that is still going and hides the panel when none is", async () => {
    const job = {
      id: "20260908T120000Z-aaaaaa", kind: "enable", addon: "stager", state: "running",
      step: "enabling stager", error: "", createdAt: "", startedAt: "", finishedAt: "",
    };
    const running = await render(["instatic"], null, { job });
    expect(running).toContain("watchJob('20260908T120000Z-aaaaaa')");
    expect(running).toContain("Enabling stager");
    expect(running).not.toContain('id="job-card" hidden');

    const idle = await render(["instatic"], null, { job: null });
    expect(idle).toContain('id="job-card" hidden');
    expect(idle).not.toContain("watchJob('");
  });

  test("reports a failure that happened while the page was gone", async () => {
    const html = await render(["instatic"], null, {
      job: {
        id: "20260908T120000Z-aaaaaa", kind: "update", addon: "", state: "failed",
        step: "", error: "checksum mismatch", createdAt: "", startedAt: "", finishedAt: "",
      },
    });
    expect(html).toContain("Updating clp-addons failed.");
    expect(html).toContain("checksum mismatch");
    expect(html).toContain("dismissFailure('20260908T120000Z-aaaaaa')");
  });

  // Serving nothing is a legitimate state now, so the page has to read as an
  // offer rather than as a dead end.
  test("offers the addons back when none is enabled", async () => {
    const html = await render([], null, { available: ["instatic", "stager"] });
    expect(html).toContain("No addons are enabled. Enable one below to add it to CloudPanel.");
    expect(html).toContain("enableAddon('instatic')");
    expect(html).toContain("enableAddon('stager')");
  });

  test("still says so plainly when this binary carries no addon at all", async () => {
    const html = await render([], null, { available: [] });
    expect(html).toContain("No addons are currently available.");
  });

  test("sets the CSRF cookie the buttons have to echo back", async () => {
    const res = indexPage(["instatic"], null, { csrf: "token-value" });
    expect(res.headers.get("set-cookie")).toContain("clp_addons_csrf=token-value");
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });
});

describe("manager route decoding and safe segment decoder", () => {
  test("safeDecodePathSegment decodes valid percent encodings and normal strings", () => {
    expect(safeDecodePathSegment("stager")).toBe("stager");
    expect(safeDecodePathSegment("20260908T120000Z-aaaaaa")).toBe("20260908T120000Z-aaaaaa");
    expect(safeDecodePathSegment("hello%20world")).toBe("hello world");
    expect(safeDecodePathSegment("foo%2Dbar")).toBe("foo-bar");
  });

  test("safeDecodePathSegment catches URIError and returns null for malformed percent encoding", () => {
    expect(safeDecodePathSegment("%FF")).toBeNull();
    expect(safeDecodePathSegment("%E0%A4")).toBeNull();
    expect(safeDecodePathSegment("%c0%af")).toBeNull();
    expect(safeDecodePathSegment("%2")).toBeNull();
    expect(safeDecodePathSegment("%")).toBeNull();
  });

  test("handleManagerRoute returns HTTP 400 for malformed percent encoding in job routes", async () => {
    const fakeServer = {} as any;
    // Malformed job ID
    const resJob = await handleManagerRoute(
      new Request("http://localhost/api/jobs/%FF"),
      "/api/jobs/%FF",
      fakeServer,
    );
    expect(resJob).not.toBeNull();
    expect(resJob!.status).toBe(400);
    const bodyJob = (await resJob!.json()) as { ok: boolean; error: string };
    expect(bodyJob.ok).toBe(false);
    expect(bodyJob.error).toBe("not a valid job id");

    // Malformed job ID with /events
    const resEvents = await handleManagerRoute(
      new Request("http://localhost/api/jobs/%FF/events"),
      "/api/jobs/%FF/events",
      fakeServer,
    );
    expect(resEvents).not.toBeNull();
    expect(resEvents!.status).toBe(400);
    const bodyEvents = (await resEvents!.json()) as { ok: boolean; error: string };
    expect(bodyEvents.ok).toBe(false);
    expect(bodyEvents.error).toBe("not a valid job id");
  });

  test("handleManagerRoute returns HTTP 400 for malformed percent encoding in addon routes", async () => {
    const fakeServer = {} as any;
    const token = newCsrfToken();
    const req = new Request("http://localhost/api/addons/%FF/enable", {
      method: "POST",
      headers: {
        host: "localhost",
        origin: "http://localhost",
        cookie: csrfCookieHeader(token),
        "x-clp-addons-csrf": token,
      },
    });
    const res = await handleManagerRoute(req, "/api/addons/%FF/enable", fakeServer);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("invalid addon name");
  });
});
