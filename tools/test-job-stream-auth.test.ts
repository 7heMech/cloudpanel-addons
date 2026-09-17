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

test("a stream whose session went away closes instead of sending more", async () => {
  authorized = false;
  const res = await jobEventStream({
    id: "20260910T093000Z-a1b2c3",
    req: new Request("https://panel.example/addons/stager/api/jobs/x/events"),
    getJob,
    recheckTicks: 1,
  });
  const frames = await readFrames(res, 2);
  expect(frames[0]).toContain('"step":"Copying files"');
  expect(frames[1]).toStartWith("event: unauthorized");
});

test("a stream whose session is still good keeps streaming", async () => {
  authorized = true;
  const res = await jobEventStream({
    id: "20260910T093000Z-a1b2c3",
    req: new Request("https://panel.example/addons/stager/api/jobs/x/events"),
    getJob,
    recheckTicks: 1,
  });
  const frames = await readFrames(res, 2);
  expect(frames[1]).not.toContain("unauthorized");
});
