import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { fetchVerified } from "../cli/release";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("a download reports its progress in tens", async () => {
  const bytes = new Uint8Array(1000).fill(7);
  const sum = createHash("sha256").update(bytes).digest("hex");
  globalThis.fetch = (async (url: string) => url.endsWith("SHA256SUMS")
    ? new Response(`${sum}  clp-addons-linux-x64\n`)
    : new Response(new ReadableStream({
      start(controller) {
        for (let at = 0; at < bytes.length; at += 250) controller.enqueue(bytes.slice(at, at + 250));
        controller.close();
      },
    }), { headers: { "content-length": String(bytes.length) } })) as unknown as typeof fetch;
  const steps: string[] = [];
  const release = { tag: "v2.0.0", assets: new Map([["SHA256SUMS", "https://example.invalid/SHA256SUMS"], ["clp-addons-linux-x64", "https://example.invalid/bin"]]) };
  const [artifact] = await fetchVerified(release, ["clp-addons-linux-x64"], (step) => steps.push(step));
  expect(artifact!.bytes.equals(Buffer.from(bytes))).toBe(true);
  expect(steps).toEqual([
    "fetching checksums for v2.0.0",
    "downloading clp-addons-linux-x64",
    "downloading clp-addons-linux-x64: 20%",
    "downloading clp-addons-linux-x64: 50%",
    "downloading clp-addons-linux-x64: 70%",
    "downloading clp-addons-linux-x64: 100%",
  ]);
});
