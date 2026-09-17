// A job stream is authorized when it opens and then runs until the job ends,
// and what it sends includes a clone's generated passwords. It rechecks.
import { expect, mock, test } from "bun:test";

let authorized = true;
const realSso = await import("../lib/sso-auth");
mock.module("../lib/sso-auth", () => ({ ...realSso, stillAuthorized: async () => authorized }));

const { jobEventStream } = await import("../lib/job-stream");

const running = { state: "running", step: "Copying files" };
const getJob = async () => ({ ok: true, data: { job: { ...running }, log: "working" } });

async function readFrames(res: Response, count: number): Promise<string[]> {
  const reader = res.body!.getReader();
  const frames: string[] = [];
  try {
    while (frames.length < count) {
      const { done, value } = await reader.read();
      if (done) break;
      frames.push(typeof value === "string" ? value : new TextDecoder().decode(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return frames;
}

function frameText(value: unknown): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value as Uint8Array);
}

test("a stream whose session went away closes instead of sending more", async () => {
  authorized = false;
  const res = await jobEventStream({
    id: "20260910T093000Z-a1b2c3",
    req: new Request("https://panel.example/addons/stager/api/jobs/x/events"),
    getJob,
    recheckMs: 10,
  });
  const frames = await readFrames(res, 2);
  expect(frames[0]).toContain('"step":"Copying files"');
  expect(frames[1]).toStartWith("event: unauthorized");
});

test("a watcher stream whose session went away closes instead of sending more", async () => {
  authorized = false;
  let watcherClosed = false;
  const res = await jobEventStream({
    id: "20260910T093000Z-a1b2c3",
    req: new Request("https://panel.example/addons/stager/api/jobs/x/events"),
    getJob,
    watchJob: (_id, _handlers) => ({ close: () => { watcherClosed = true; } }),
    recheckMs: 10,
  });
  const frames = await readFrames(res, 2);
  expect(frames[1]).toStartWith("event: unauthorized");
  expect(watcherClosed).toBe(true);
});

test("watcher snapshots become SSE frames and cancellation closes the watcher", async () => {
  authorized = true;
  let handlers: { onSnapshot: (snapshot: { job: typeof running; log: string }) => void; onClose: (error?: string) => void } | undefined;
  let watcherClosed = false;
  const res = await jobEventStream({
    id: "20260910T093000Z-a1b2c3",
    req: new Request("https://panel.example/addons/stager/api/jobs/x/events"),
    getJob,
    watchJob: (_id, next) => {
      handlers = next;
      return { close: () => { watcherClosed = true; } };
    },
  });
  const reader = res.body!.getReader();
  const first = await reader.read();
  expect(frameText(first.value)).toContain('"step":"Copying files"');

  handlers!.onSnapshot({ job: { ...running, step: "Importing" }, log: "working\nmore" });
  expect(frameText((await reader.read()).value)).toContain('"step":"Importing"');
  handlers!.onSnapshot({ job: { ...running, step: "Importing" }, log: "working\nmore" });
  expect(frameText((await reader.read()).value)).toBe(": keepalive\n\n");
  handlers!.onSnapshot({ job: { ...running, state: "done", step: "" }, log: "done" });
  expect(frameText((await reader.read()).value)).toContain('"state":"done"');
  expect((await reader.read()).done).toBe(true);
  expect(watcherClosed).toBe(true);

  const cancelled = await jobEventStream({
    id: "20260910T093000Z-a1b2c3",
    req: new Request("https://panel.example/addons/stager/api/jobs/x/events"),
    getJob,
    watchJob: () => ({ close: () => { watcherClosed = true; } }),
  });
  await cancelled.body!.cancel();
  expect(watcherClosed).toBe(true);
});
