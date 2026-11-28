import { expect, test } from "bun:test";
import { type Deps, type Env, handle, INSTALL_URL, parseUsage, readCapped, SERVER, trimReleases } from "../worker/index";

function fakeCache() {
  const store = new Map<string, Response>();
  return {
    store,
    match: async (request: Request) => store.get(request.url)?.clone(),
    put: async (request: Request, response: Response) => void store.set(request.url, response.clone()),
  };
}

function setup(upstream: () => Response | Promise<Response> = () => Response.json([])) {
  const points: { indexes?: string[]; blobs?: string[]; doubles?: number[] }[] = [];
  const waiting: Promise<unknown>[] = [];
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const cache = fakeCache();
  const env: Env = {
    ASSETS: { fetch: async () => new Response("page") },
    USAGE: { writeDataPoint: (point) => void points.push(point) },
  };
  const deps: Deps = {
    cache,
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return upstream();
    }) as unknown as typeof fetch,
  };
  const ctx = { waitUntil: (promise: Promise<unknown>) => void waiting.push(promise) };
  const call = async (path: string, init?: RequestInit) => {
    const res = await handle(new Request(`https://clp.7he.dev${path}`, init), env, ctx, deps);
    await Promise.all(waiting);
    return res;
  };
  return { call, points, calls, cache, env };
}

const report = { version: "2.3.0", cloudpanel: "2.5.4", arch: "x64", addons: ["dns", "firewall"] };
const post = (body: unknown) => ({ method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

test("/install.sh redirects to the latest release's installer", async () => {
  const { call } = setup();
  const res = await call("/install.sh");
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe(INSTALL_URL);
  expect(INSTALL_URL).toBe("https://github.com/7heMech/cloudpanel-addons/releases/latest/download/install.sh");
  expect((await call("/install.sh", { method: "POST" })).status).toBe(405);
});

test("other paths fall through to the landing page", async () => {
  const { call } = setup();
  expect(await (await call("/")).text()).toBe("page");
  expect(await (await call("/img/firewall.png")).text()).toBe("page");
});

test("/usage writes one data point per addon plus one for the server", async () => {
  const { call, points } = setup();
  const res = await call("/usage", post(report));
  expect(res.status).toBe(204);
  expect(points.map((point) => point.blobs?.[0])).toEqual([SERVER, "dns", "firewall"]);
  expect(points[1]).toEqual({ indexes: ["dns"], blobs: ["dns", "2.3.0", "2.5.4", "x64"], doubles: [1] });
});

test("/usage accepts a server whose CloudPanel version is unknown", async () => {
  const { call, points } = setup();
  expect((await call("/usage", post({ ...report, cloudpanel: null, addons: [] }))).status).toBe(204);
  expect(points).toHaveLength(1);
  expect(points[0]!.blobs).toEqual([SERVER, "2.3.0", "", "x64"]);
});

test("/usage refuses anything but a well-formed four-field report", async () => {
  const { call, points } = setup();
  expect((await call("/usage")).status).toBe(405);
  expect((await call("/usage", post("not json"))).status).toBe(400);
  expect((await call("/usage", post([]))).status).toBe(400);
  for (const bad of [
    { ...report, version: "latest" },
    { ...report, arch: "x64; drop" },
    { ...report, addons: "dns" },
    { ...report, addons: ["DNS Tools"] },
    { ...report, addons: [SERVER] },
    { ...report, addons: Array.from({ length: 25 }, (_, i) => `addon-${i}`) },
    { ...report, cloudpanel: 5 },
  ]) {
    expect((await call("/usage", post(bad))).status).toBe(400);
  }
  expect((await call("/usage", post({ ...report, padding: "x".repeat(3000) }))).status).toBe(413);
  expect(points).toHaveLength(0);
});

test("/usage counts bytes, not characters, so a multibyte body over 2 KiB is refused", async () => {
  const { call, points } = setup();
  const padded = JSON.stringify({ ...report, padding: "é".repeat(1100) });
  expect(padded.length).toBeLessThan(2048);
  expect(new TextEncoder().encode(padded).byteLength).toBeGreaterThan(2048);
  expect((await call("/usage", post(padded))).status).toBe(413);
  expect(points).toHaveLength(0);
});

test("/usage stops reading a body without Content-Length once it passes 2 KiB", async () => {
  const { call, points } = setup();
  let pulled = 0;
  let cancelled = false;
  const chunk = new TextEncoder().encode("x".repeat(1024));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      if (pulled > 1000) controller.close();
      else controller.enqueue(chunk);
    },
    cancel() { cancelled = true; },
  });
  const res = await call("/usage", { method: "POST", body, duplex: "half" } as RequestInit);
  expect(res.status).toBe(413);
  expect(cancelled).toBe(true);
  expect(pulled).toBeLessThan(10);
  expect(points).toHaveLength(0);
});

test("readCapped returns the whole body when it fits", async () => {
  const bytes = await readCapped(new Request("https://x/", { method: "POST", body: "{}" }), 2048);
  expect(new TextDecoder().decode(bytes!)).toBe("{}");
});

test("parseUsage drops extra fields and repeated addons", () => {
  expect(parseUsage({ ...report, addons: ["dns", "dns"], domains: ["a.test"], ip: "1.2.3.4" })).toEqual({
    version: "2.3.0",
    cloudpanel: "2.5.4",
    arch: "x64",
    addons: ["dns"],
  });
  expect(parseUsage({ ...report, version: "2.3.0-rc.1" })?.version).toBe("2.3.0-rc.1");
});

test("trimReleases keeps only what the update check reads", () => {
  expect(trimReleases([{ tag_name: "v2.3.0", draft: false, prerelease: true, body: "notes", assets: [{}] }, { name: "no tag" }, null]))
    .toEqual([{ tag_name: "v2.3.0", draft: false, prerelease: true }]);
  expect(trimReleases({ message: "rate limited" })).toBeNull();
});

test("/releases.json proxies GitHub's list trimmed, and serves the next ask from cache", async () => {
  const { call, calls } = setup(() => Response.json([{ tag_name: "v2.2.0", draft: false, prerelease: false, body: "long" }]));
  const first = await call("/releases.json");
  expect(first.status).toBe(200);
  expect(first.headers.get("Cache-Control")).toBe("public, max-age=300");
  expect(await first.json()).toEqual([{ tag_name: "v2.2.0", draft: false, prerelease: false }]);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://api.github.com/repos/7heMech/cloudpanel-addons/releases?per_page=100");
  expect(calls[0]!.headers.Authorization).toBeUndefined();

  const second = await call("/releases.json");
  expect(await second.json()).toEqual([{ tag_name: "v2.2.0", draft: false, prerelease: false }]);
  expect(second.headers.get("Cache-Control")).toBe("public, max-age=300");
  expect(calls).toHaveLength(1);
});

test("/releases.json sends the GitHub token when one is set, and never leaks it", async () => {
  const { call, calls, env } = setup(() => Response.json([]));
  env.GITHUB_TOKEN = "ghp_secret";
  const res = await call("/releases.json");
  expect(calls[0]!.headers.Authorization).toBe("Bearer ghp_secret");
  expect(JSON.stringify([...res.headers])).not.toContain("ghp_secret");
});

test("/releases.json serves the last list when GitHub fails, and 502s when there is none", async () => {
  let answer: () => Response = () => Response.json([{ tag_name: "v2.2.0", draft: false, prerelease: false }]);
  const { call, cache } = setup(() => answer());
  expect((await call("/releases.json")).status).toBe(200);

  // Age the stored copy past its freshness, then break GitHub.
  const key = [...cache.store.keys()][0]!;
  const stored = cache.store.get(key)!;
  const aged = new Response(await stored.clone().text(), { headers: { ...Object.fromEntries(stored.headers), "X-Cached-At": "1" } });
  cache.store.set(key, aged);
  answer = () => new Response("rate limited", { status: 403 });
  const stale = await call("/releases.json");
  expect(stale.status).toBe(200);
  expect(await stale.json()).toEqual([{ tag_name: "v2.2.0", draft: false, prerelease: false }]);

  cache.store.clear();
  expect((await call("/releases.json")).status).toBe(502);
  answer = () => Response.json({ message: "not a list" });
  expect((await call("/releases.json")).status).toBe(502);
});
