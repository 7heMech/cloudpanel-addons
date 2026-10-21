import { expect, test } from "bun:test";
import { JOB_WATCH_JS } from "../lib/app-ui";

function client(options: { redirected?: boolean; failed?: boolean } = {}) {
  const streams: Stream[] = [];
  class Stream {
    onmessage?: (event: { data: string }) => void;
    listeners = new Map<string, () => void>();
    closed = false;
    constructor() { streams.push(this); }
    addEventListener(name: string, handler: () => void) { this.listeners.set(name, handler); }
    close() { this.closed = true; }
  }
  const result = { reloads: 0, html: "", notices: [] as string[], busy: true, fetches: 0 };
  const holder = { querySelector: () => null };
  const api = new Function("CLP_BASE", "CLP_ROOT", "EventSource", "location", "fetch", "DOMParser", "repaintView", "notify", "busy",
    `${JOB_WATCH_JS}\nreturn { watchJob, repaintPage };`)(
    "/addons/stager", { querySelector: () => null, getElementById: () => holder }, Stream,
    { href: "https://panel.test/addons/stager/jobs/example", reload() { result.reloads++; } },
    async () => {
      result.fetches++;
      if (options.failed) throw new Error("offline");
      return { redirected: options.redirected, ok: true, text: async () => "server document" };
    },
    class { parseFromString() { return { getElementById: () => ({ innerHTML: "server result" }) }; } },
    (_holder: unknown, html: string) => { result.html = html; },
    (message: string) => { result.notices.push(message); },
    (busy: boolean) => { result.busy = busy; },
  );
  return { ...api, streams, result };
}

test("a terminal job repaints once even after repeated events and initialization", async () => {
  const page = client();
  page.watchJob("example");
  page.watchJob("example");
  expect(page.streams.length).toBe(1);
  const stream = page.streams[0]!;
  const event = { data: JSON.stringify({ job: { state: "done", step: "" }, log: "done" }) };
  stream.onmessage!(event);
  stream.onmessage!(event);
  await Bun.sleep(0);
  expect(stream.closed).toBe(true);
  expect(page.result.fetches).toBe(1);
  expect(page.result.html).toBe("server result");
  expect(page.result.reloads).toBe(0);
  expect(page.result.busy).toBe(false);
  expect(page.result.notices).toEqual(["Job completed."]);
});

test("failed jobs repaint their result and report the error", async () => {
  const page = client();
  await page.repaintPage({ state: "failed", error: "copy failed" });
  expect(page.result.html).toBe("server result");
  expect(page.result.notices).toEqual(["Job failed: copy failed"]);
});

test("a failed result fetch retains the view and restores controls", async () => {
  const page = client({ failed: true });
  expect(await page.repaintPage()).toBe(false);
  expect(page.result.html).toBe("");
  expect(page.result.reloads).toBe(0);
  expect(page.result.busy).toBe(false);
  expect(page.result.notices[0]).toContain("offline");
});

test("a lapsed session reloads into the login gate", async () => {
  const page = client({ redirected: true });
  expect(await page.repaintPage()).toBe(false);
  expect(page.result.reloads).toBe(1);
  expect(page.result.html).toBe("");
});
