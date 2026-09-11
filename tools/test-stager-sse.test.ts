import { describe, it, expect } from "bun:test";
import { handle } from "../addons/stager/app/index";
import { stagerService, type JobView } from "../addons/stager/app/service";
import { CLIENT_JS } from "../addons/stager/app/views";
import { JOB_WATCH_JS } from "../lib/app-ui";

function mockJob(overrides: Partial<JobView> = {}): JobView {
  return {
    id: "20260910T093000Z-a1b2c3",
    source: "example.com",
    target: "stg.example.com",
    port: 0,
    state: "running",
    step: "Copying files",
    error: "",
    panelSite: true,
    createdAt: "2026-09-10T09:30:00Z",
    startedAt: "2026-09-10T09:30:01Z",
    finishedAt: "",
    result: null,
    ...overrides,
  };
}

const toText = (val: unknown): string => {
  if (typeof val === "string") return val;
  if (val instanceof Uint8Array || val instanceof ArrayBuffer) {
    return new TextDecoder().decode(val);
  }
  return String(val ?? "");
};

describe("Stager SSE job monitoring", () => {
  it("rejects invalid job IDs with 400 JSON", async () => {
    const req = new Request("http://localhost/api/jobs/../events");
    const res = await handle(req, "/api/jobs/../events");
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("not a valid job id");
  });

  it("returns 404 JSON if the job does not exist", async () => {
    const origGetJob = stagerService.getJob;
    stagerService.getJob = async () => ({ ok: false, error: "job not found" });
    try {
      const req = new Request("http://localhost/api/jobs/20260910T093000Z-000000/events");
      const res = await handle(req, "/api/jobs/20260910T093000Z-000000/events");
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      const body = (await res.json()) as { ok: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(body.error).toBe("job not found");
    } finally {
      stagerService.getJob = origGetJob;
    }
  });

  it("sets SSE response headers and disables Bun idle timeout via server.timeout(req, 0)", async () => {
    const origGetJob = stagerService.getJob;
    stagerService.getJob = async (id: string) => ({
      ok: true,
      data: { job: mockJob({ id, state: "done", step: "" }), log: "completed" },
    });

    try {
      let timeoutCalledWith: [Request, number] | null = null;
      const fakeServer = {
        timeout(req: Request, ms: number) {
          timeoutCalledWith = [req, ms];
        },
      };

      const req = new Request("http://localhost/api/jobs/20260910T093000Z-a1b2c3/events");
      const res = await handle(req, "/api/jobs/20260910T093000Z-a1b2c3/events", null, fakeServer as any);

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");
      expect(res.headers.get("Cache-Control")).toBe("no-cache, no-transform");
      expect(res.headers.get("Connection")).toBe("keep-alive");
      expect(res.headers.get("X-Accel-Buffering")).toBe("no");
      expect(timeoutCalledWith).not.toBeNull();
      expect(timeoutCalledWith![1]).toBe(0);
    } finally {
      stagerService.getJob = origGetJob;
    }
  });

  it("serves SSE when Accept: text/event-stream is sent to /api/jobs/:id", async () => {
    const origGetJob = stagerService.getJob;
    stagerService.getJob = async (id: string) => ({
      ok: true,
      data: { job: mockJob({ id, state: "done" }), log: "done" },
    });

    try {
      const req = new Request("http://localhost/api/jobs/20260910T093000Z-a1b2c3", {
        headers: { Accept: "text/event-stream" },
      });
      const res = await handle(req, "/api/jobs/20260910T093000Z-a1b2c3");
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    } finally {
      stagerService.getJob = origGetJob;
    }
  });

  it("emits initial event and closes immediately when job is already done", async () => {
    const origGetJob = stagerService.getJob;
    stagerService.getJob = async (id: string) => ({
      ok: true,
      data: { job: mockJob({ id, state: "done", step: "" }), log: "All done!" },
    });

    try {
      const req = new Request("http://localhost/api/jobs/20260910T093000Z-a1b2c3/events");
      const res = await handle(req, "/api/jobs/20260910T093000Z-a1b2c3/events");
      expect(res.body).not.toBeNull();

      const reader = res.body!.getReader();
      const chunk1 = await reader.read();
      expect(chunk1.done).toBe(false);
      const text1 = toText(chunk1.value);
      expect(text1).toContain("data: ");
      const parsed = JSON.parse(text1.replace(/^data:\s*/, "").trim());
      expect(parsed.job.state).toBe("done");
      expect(parsed.log).toBe("All done!");

      const chunk2 = await reader.read();
      expect(chunk2.done).toBe(true);
    } finally {
      stagerService.getJob = origGetJob;
    }
  });

  it("streams job updates and keepalives until job completes", async () => {
    const origGetJob = stagerService.getJob;
    let pollCount = 0;
    stagerService.getJob = async (id: string) => {
      pollCount++;
      if (pollCount === 1) {
        return {
          ok: true,
          data: { job: mockJob({ id, state: "running", step: "Copying files" }), log: "start\n" },
        };
      }
      if (pollCount === 2) {
        // unchanged tick -> keepalive
        return {
          ok: true,
          data: { job: mockJob({ id, state: "running", step: "Copying files" }), log: "start\n" },
        };
      }
      if (pollCount === 3) {
        // step update
        return {
          ok: true,
          data: { job: mockJob({ id, state: "running", step: "Importing DB" }), log: "start\ndb\n" },
        };
      }
      // done
      return {
        ok: true,
        data: { job: mockJob({ id, state: "done", step: "" }), log: "start\ndb\ndone\n" },
      };
    };

    try {
      const req = new Request("http://localhost/api/jobs/20260910T093000Z-a1b2c3/events");
      const res = await handle(req, "/api/jobs/20260910T093000Z-a1b2c3/events");
      const reader = res.body!.getReader();

      // Chunk 1: initial event
      const c1 = await reader.read();
      expect(c1.done).toBe(false);
      const d1 = JSON.parse(toText(c1.value).replace(/^data:\s*/, "").trim());
      expect(d1.job.step).toBe("Copying files");

      // Wait for tick 1 (keepalive)
      const c2 = await reader.read();
      expect(c2.done).toBe(false);
      expect(toText(c2.value)).toContain(": keepalive\n\n");

      // Wait for tick 2 (step change)
      const c3 = await reader.read();
      expect(c3.done).toBe(false);
      const d3 = JSON.parse(toText(c3.value).replace(/^data:\s*/, "").trim());
      expect(d3.job.step).toBe("Importing DB");

      // Wait for tick 3 (done)
      const c4 = await reader.read();
      expect(c4.done).toBe(false);
      const d4 = JSON.parse(toText(c4.value).replace(/^data:\s*/, "").trim());
      expect(d4.job.state).toBe("done");

      // Stream should close now
      const c5 = await reader.read();
      expect(c5.done).toBe(true);
    } finally {
      stagerService.getJob = origGetJob;
    }
  });

  it("handles client disconnect cancel without errors", async () => {
    const origGetJob = stagerService.getJob;
    stagerService.getJob = async (id: string) => ({
      ok: true,
      data: { job: mockJob({ id, state: "running", step: "Copying files" }), log: "running..." },
    });

    try {
      const req = new Request("http://localhost/api/jobs/20260910T093000Z-a1b2c3/events");
      const res = await handle(req, "/api/jobs/20260910T093000Z-a1b2c3/events");
      const reader = res.body!.getReader();
      const c1 = await reader.read();
      expect(c1.done).toBe(false);

      // Cancel reader (simulates browser closing the connection)
      await reader.cancel();
      expect(true).toBe(true);
    } finally {
      stagerService.getJob = origGetJob;
    }
  });

  it("the shared watcher uses EventSource with a polling fallback", () => {
    // The watcher is shared with every other addon that runs jobs; the stager's
    // own script only starts it.
    expect(JOB_WATCH_JS).toContain("EventSource");
    expect(JOB_WATCH_JS).toContain("/events");
    expect(JOB_WATCH_JS).toContain("pollJob");
    expect(CLIENT_JS).toContain("watchJob(");
  });

  it("both halves of the page script pass quote balance checks", () => {
    for (const line of `${JOB_WATCH_JS}\n${CLIENT_JS}`.split("\n")) {
      const quotes = (line.match(/'/g) || []).length;
      expect(quotes % 2 === 1, `odd number of single quotes in: ${line}`).toBe(false);
    }
  });
});
