// The release mirror at cp.7he.dev: what the release workflow keeps there, and
// that install and update read it first and fall back to GitHub.
import { afterEach, describe, expect, test } from "bun:test";
import { MIRROR_URL, parseMirrorIndex, planMirror, type MirroredRelease } from "../lib/release-mirror";
import { resolveRelease } from "../cli/release";
import { checkCliUpdate, resetUpdateCache } from "../lib/update-check";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetUpdateCache();
});

const ASSETS = ["SHA256SUMS", "clp-addons-linux-x64"];
const indexOf = (...tags: string[]) => tags.reduce<MirroredRelease[]>((index, tag) => planMirror(index, tag, ASSETS).index, []);

describe("planMirror", () => {
  test("lists releases newest first with mirror URLs", () => {
    const plan = planMirror(indexOf("v2.1.0", "v2.2.0-rc.1"), "v2.2.0", ASSETS);
    expect(plan.index.map((release) => release.tag_name)).toEqual(["v2.2.0", "v2.2.0-rc.1", "v2.1.0"]);
    expect(plan.index[0]!.assets[1]!.browser_download_url).toBe(`${MIRROR_URL}/releases/v2.2.0/clp-addons-linux-x64`);
    expect(plan.index[1]!.prerelease).toBe(true);
    expect(plan.latest).toBe(true);
  });

  test("a prerelease or an older release does not become latest", () => {
    expect(planMirror(indexOf("v2.1.0"), "v2.2.0-rc.1", ASSETS).latest).toBe(false);
    expect(planMirror(indexOf("v2.2.0"), "v2.1.1", ASSETS).latest).toBe(false);
  });

  test("keeps the newest releases and the newest stable one, and drops the rest", () => {
    const plan = planMirror(indexOf("v2.0.0", "v2.1.0-rc.1", "v2.1.0-rc.2"), "v2.1.0-rc.3", ASSETS, 2);
    expect(plan.index.map((release) => release.tag_name)).toEqual(["v2.1.0-rc.3", "v2.1.0-rc.2", "v2.0.0"]);
    expect(plan.dropped.map((release) => release.tag_name)).toEqual(["v2.1.0-rc.1"]);
  });

  test("republishing a tag replaces its entry", () => {
    expect(planMirror(indexOf("v2.1.0"), "v2.1.0", ["SHA256SUMS"]).index).toHaveLength(1);
  });

  test("refuses a tag that is not a release", () => {
    expect(() => planMirror([], "main", ASSETS)).toThrow();
  });
});

test("parseMirrorIndex refuses anything that is not a release list", () => {
  expect(parseMirrorIndex({ tag_name: "v1.0.0" })).toBeNull();
  expect(parseMirrorIndex([{ tag_name: "v1.0.0", prerelease: false, assets: [{ name: 1 }] }])).toBeNull();
  expect(parseMirrorIndex(indexOf("v1.0.0"))).toHaveLength(1);
});

describe("resolveRelease", () => {
  const githubRelease = (tag: string) => ({
    tag_name: tag, draft: false, prerelease: false,
    assets: [{ name: "SHA256SUMS", browser_download_url: `https://github.com/x/releases/download/${tag}/SHA256SUMS` }],
  });
  const github = (asked: string[]) => (async (url: string) => {
    asked.push(url);
    return Response.json(githubRelease(url.endsWith("/latest") ? "v2.0.0" : url.split("/").at(-1)!));
  }) as unknown as typeof fetch;

  test("reads the mirror and asks GitHub nothing", async () => {
    const asked: string[] = [];
    globalThis.fetch = github(asked);
    const release = await resolveRelease(undefined, false, async () => indexOf("v2.1.0", "v2.2.0-rc.1"));
    expect(release.tag).toBe("v2.1.0");
    expect(release.assets.get("SHA256SUMS")).toBe(`${MIRROR_URL}/releases/v2.1.0/SHA256SUMS`);
    expect(asked).toEqual([]);
    expect((await resolveRelease(undefined, true, async () => indexOf("v2.1.0", "v2.2.0-rc.1"))).tag).toBe("v2.2.0-rc.1");
  });

  test("asks GitHub when the mirror cannot be read", async () => {
    const asked: string[] = [];
    globalThis.fetch = github(asked);
    expect((await resolveRelease(undefined, false, async () => null)).tag).toBe("v2.0.0");
    expect(asked).toHaveLength(1);
  });

  test("asks GitHub for a tag the mirror no longer keeps", async () => {
    const asked: string[] = [];
    globalThis.fetch = github(asked);
    const release = await resolveRelease("v1.0.0", false, async () => indexOf("v2.1.0"));
    expect(release.tag).toBe("v1.0.0");
    expect(release.assets.get("SHA256SUMS")).toStartWith("https://github.com/");
  });
});

describe("checkCliUpdate", () => {
  test("reads the mirror for this repository", async () => {
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(url);
      return Response.json(indexOf("v2.1.0", "v2.2.0-rc.1"));
    }) as unknown as typeof fetch;
    expect(await checkCliUpdate("2.0.0")).toEqual({ current: "2.0.0", latest: "2.1.0", hasUpdate: true });
    expect(asked).toEqual([`${MIRROR_URL}/releases.json`]);
  });

  test("falls back to GitHub when the mirror fails", async () => {
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(url);
      return url.startsWith(MIRROR_URL) ? new Response("", { status: 503 }) : Response.json({ tag_name: "v2.1.0" });
    }) as unknown as typeof fetch;
    expect(await checkCliUpdate("2.0.0")).toEqual({ current: "2.0.0", latest: "2.1.0", hasUpdate: true });
    expect(asked).toEqual([`${MIRROR_URL}/releases.json`, "https://api.github.com/repos/7heMech/cloudpanel-addons/releases/latest"]);
  });
});
