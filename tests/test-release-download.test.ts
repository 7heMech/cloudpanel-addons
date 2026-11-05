import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import { fetchVerified } from "../cli/release";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setSystemTime();
});

const release = { tag: "v2.0.0", assets: new Map([["SHA256SUMS", "https://example.invalid/SHA256SUMS"], ["clp-addons-linux-x64", "https://example.invalid/bin"]]) };

// Four 1 MB chunks, the clock moving `gapsMs[i]` before chunk i.
async function download(gapsMs: number[], sized = true) {
  const bytes = new Uint8Array(4_000_000).fill(7);
  const sum = createHash("sha256").update(bytes).digest("hex");
  let now = Date.parse("2026-01-01T00:00:00Z");
  setSystemTime(now);
  globalThis.fetch = (async (url: string) => {
    if (url.endsWith("SHA256SUMS")) return new Response(`${sum}  clp-addons-linux-x64\n`);
    let index = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (index === gapsMs.length) return controller.close();
        setSystemTime(now += gapsMs[index]!);
        controller.enqueue(bytes.slice(index * 1_000_000, ++index * 1_000_000));
      },
    }, { highWaterMark: 0 });
    return new Response(body, sized ? { headers: { "content-length": String(bytes.length) } } : {});
  }) as unknown as typeof fetch;
  const steps: string[] = [];
  const progress: string[] = [];
  const [artifact] = await fetchVerified(release, ["clp-addons-linux-x64"], (step) => steps.push(step),
    (line, done) => progress.push(`${line}${done ? " (done)" : ""}`));
  expect(artifact!.bytes.equals(Buffer.from(bytes))).toBe(true);
  expect(steps).toEqual(["fetching checksums for v2.0.0", "downloading clp-addons-linux-x64"]);
  return progress;
}

test("a download reports its progress about once a second, and as it ends", async () => {
  expect(await download([0, 1500, 400, 500])).toEqual([
    "downloading clp-addons-linux-x64: 50% (2.0 of 4.0 MB)",
    "downloading clp-addons-linux-x64: 100% (4.0 of 4.0 MB) (done)",
  ]);
});

test("a download of unknown size reports what has arrived", async () => {
  expect(await download([1000, 0, 0, 0], false)).toEqual([
    "downloading clp-addons-linux-x64: 1.0 MB",
    "downloading clp-addons-linux-x64: 4.0 MB (done)",
  ]);
});
