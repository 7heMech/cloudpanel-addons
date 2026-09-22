import { describe, expect, test } from "bun:test";
import { jobApiRoute, type JobProgress } from "../lib/job-stream";
import { JOB_ID_RE, validateJobId } from "../lib/job-id";
import { snapshotAgeSeconds, type PanelSnapshot } from "../lib/snapshot-reader";
import { handle as stagerHandle } from "../addons/stager/app/index";
import { handle as instaticHandle } from "../addons/instatic/app/index";
import { stagerService } from "../addons/stager/app/service";
import { instaticService } from "../addons/instatic/app/service";

const ID = "20260916T093000Z-a1b2c3";

interface TestJob extends JobProgress {
  id: string;
}

function reader(job: Partial<TestJob> = {}, ok = true) {
  return async (id: string) => ok
    ? { ok: true, data: { job: { id, state: "done", step: "", ...job } as TestJob, log: "log" } }
    : { ok: false, error: "job not found" };
}

describe("the shared job route", () => {
  test("returns null for a path it does not own, so the addon's router decides", async () => {
    for (const path of ["/", "/api/jobs", "/api/instances/x/logs", "/jobs/" + ID]) {
      expect(await jobApiRoute({ req: new Request("http://x" + path), path, method: "GET", getJob: reader() }))
        .toBeNull();
    }
  });

  test("returns null for a non-GET on a path it does own", async () => {
    // A POST here is not "job not found"; it is a route this addon may still
    // define, and answering it would take that decision away.
    const path = `/api/jobs/${ID}`;
    const req = new Request("http://x" + path, { method: "POST" });
    expect(await jobApiRoute({ req, path, method: "POST", getJob: reader() })).toBeNull();
  });

  test("polls by default and streams on the events path", async () => {
    const poll = await jobApiRoute({
      req: new Request(`http://x/api/jobs/${ID}`), path: `/api/jobs/${ID}`, method: "GET", getJob: reader(),
    });
    expect(poll!.headers.get("Content-Type")).toBe("application/json");

    const events = await jobApiRoute({
      req: new Request(`http://x/api/jobs/${ID}/events`),
      path: `/api/jobs/${ID}/events`, method: "GET", getJob: reader(),
    });
    expect(events!.headers.get("Content-Type")).toBe("text/event-stream");
    await events!.body?.cancel();
  });

  test("streams when the client asks for it by header rather than by path", async () => {
    const path = `/api/jobs/${ID}`;
    const req = new Request("http://x" + path, { headers: { Accept: "text/event-stream" } });
    const res = await jobApiRoute({ req, path, method: "GET", getJob: reader() });
    expect(res!.headers.get("Content-Type")).toBe("text/event-stream");
    await res!.body?.cancel();
  });

  test("refuses a malformed id and a malformed encoding with the same 400", async () => {
    for (const raw of ["..", "%", "%zz", "not-a-job", "20260916T093000Z-A1B2C3"]) {
      const path = `/api/jobs/${raw}`;
      const res = await jobApiRoute({
        req: new Request("http://x/api/jobs/x"), path, method: "GET", getJob: reader(),
      });
      expect(res!.status).toBe(400);
      expect(await res!.json()).toEqual({ ok: false, error: "not a valid job id" });
    }
  });

  test("a missing job is a 404 on both the polling and streaming paths", async () => {
    const poll = await jobApiRoute({
      req: new Request(`http://x/api/jobs/${ID}`), path: `/api/jobs/${ID}`, method: "GET", getJob: reader({}, false),
    });
    expect(poll!.status).toBe(404);
    const events = await jobApiRoute({
      req: new Request(`http://x/api/jobs/${ID}/events`),
      path: `/api/jobs/${ID}/events`, method: "GET", getJob: reader({}, false),
    });
    expect(events!.status).toBe(404);
    expect(events!.headers.get("Content-Type")).toBe("application/json");
  });

  test("a terminal job's stream carries one event and closes", async () => {
    const path = `/api/jobs/${ID}/events`;
    const res = await jobApiRoute({
      req: new Request("http://x" + path), path, method: "GET", getJob: reader({ state: "done" }),
    });
    const read = res!.body!.getReader();
    const first = await read.read();
    const text = typeof first.value === "string" ? first.value : new TextDecoder().decode(first.value);
    expect(text).toContain("data: ");
    expect((await read.read()).done).toBe(true);
  });
});

describe("both addons answer through the shared route", () => {
  const cases = [
    { name: "stager", handle: stagerHandle, service: stagerService },
    { name: "instatic", handle: instaticHandle, service: instaticService },
  ] as const;

  for (const { name, handle, service } of cases) {
    test(`${name}: an invalid job id is a 400 JSON body`, async () => {
      const res = await handle(new Request("http://x/api/jobs/../events"), "/api/jobs/../events");
      expect(res.status).toBe(400);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      expect((await res.json() as { error: string }).error).toContain("not a valid job id");
    });

    test(`${name}: a known job polls as JSON and streams on Accept`, async () => {
      const original = service.getJob;
      // @ts-expect-error the test substitutes a reader with the same shape
      service.getJob = async (id: string) => ({
        ok: true, data: { job: { id, state: "done", step: "" }, log: "done" },
      });
      try {
        const poll = await handle(new Request(`http://x/api/jobs/${ID}`), `/api/jobs/${ID}`);
        expect(poll.headers.get("Content-Type")).toBe("application/json");
        const stream = await handle(
          new Request(`http://x/api/jobs/${ID}`, { headers: { Accept: "text/event-stream" } }),
          `/api/jobs/${ID}`,
        );
        expect(stream.headers.get("Content-Type")).toBe("text/event-stream");
        await stream.body?.cancel();
      } finally {
        service.getJob = original;
      }
    });
  }
});

describe("the job id syntax has one definition", () => {
  test("accepts what the job store creates and rejects everything else", () => {
    expect(validateJobId(ID)).toBe(ID);
    for (const bad of ["", "20260916T093000Z-A1B2C3", "20260916T093000Z-a1b2c", "../" + ID,
      `${ID}\n`, "20260916T0930Z-a1b2c3", 42, null, undefined]) {
      expect(validateJobId(bad)).toBeNull();
    }
    // The pattern is anchored at both ends: an id reaches a path join.
    expect(JOB_ID_RE.source.startsWith("^")).toBe(true);
    expect(JOB_ID_RE.source.endsWith("$")).toBe(true);
  });
});

describe("panel snapshot age", () => {
  const at = (updatedAt: string): PanelSnapshot => ({ updatedAt } as PanelSnapshot);

  test("a current snapshot is seconds old", () => {
    expect(snapshotAgeSeconds(at(new Date().toISOString()))).toBeLessThan(5);
  });

  test("a stale snapshot reports its age", () => {
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    expect(snapshotAgeSeconds(at(hourAgo))).toBeGreaterThanOrEqual(3595);
  });

  test("a snapshot from the future is a clock disagreement, not negative age", () => {
    expect(snapshotAgeSeconds(at(new Date(Date.now() + 3600_000).toISOString()))).toBe(0);
  });

  test("an unreadable timestamp is infinitely old, not fresh", () => {
    // NaN compares false against every staleness threshold, so the old
    // arithmetic reported an unparseable snapshot as current.
    for (const bad of ["", "not a date", "0000-13-45T99:99:99Z"]) {
      expect(snapshotAgeSeconds(at(bad))).toBe(Infinity);
    }
  });
});
