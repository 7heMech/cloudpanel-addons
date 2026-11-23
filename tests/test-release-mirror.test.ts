// The release mirror at clp.7he.dev: what the release workflow keeps there, and
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
  const github = (asked: string[], status = 200) => (async (url: string) => {
    asked.push(url);
    if (status === 0) throw new TypeError("Network is unreachable");
    return status === 200 ? Response.json(githubRelease(url.endsWith("/latest") ? "v2.0.0" : url.split("/").at(-1)!)) : new Response("", { status });
  }) as unknown as typeof fetch;
  const mirror = (asked: string[]) => async () => { asked.push("mirror"); return indexOf("v2.1.0", "v2.2.0-rc.1"); };

  test("asks GitHub first and leaves the mirror alone", async () => {
    const asked: string[] = [];
    globalThis.fetch = github(asked);
    const release = await resolveRelease(undefined, false, mirror(asked));
    expect(release.tag).toBe("v2.0.0");
    expect(release.assets.get("SHA256SUMS")).toStartWith("https://github.com/");
    expect(asked).toEqual(["https://api.github.com/repos/7heMech/cloudpanel-addons/releases/latest"]);
  });

  for (const [why, status] of [["unreachable", 0], ["rate limited", 403], ["failing", 502]] as const) {
    test(`reads the mirror when GitHub is ${why}`, async () => {
      const asked: string[] = [];
      globalThis.fetch = github(asked, status);
      const release = await resolveRelease(undefined, false, mirror(asked));
      expect(release.tag).toBe("v2.1.0");
      expect(release.assets.get("SHA256SUMS")).toBe(`${MIRROR_URL}/releases/v2.1.0/SHA256SUMS`);
      expect(asked.at(-1)).toBe("mirror");
    });
  }

  test("a pre-release box gets the newest pre-release from the mirror", async () => {
    globalThis.fetch = github([], 0);
    expect((await resolveRelease(undefined, true, mirror([]))).tag).toBe("v2.2.0-rc.1");
  });
});

describe("checkCliUpdate", () => {
  test("asks GitHub first", async () => {
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(url);
      return Response.json({ tag_name: "v2.1.0" });
    }) as unknown as typeof fetch;
    expect(await checkCliUpdate("2.0.0")).toEqual({ current: "2.0.0", latest: "2.1.0", hasUpdate: true });
    expect(asked).toEqual(["https://api.github.com/repos/7heMech/cloudpanel-addons/releases/latest"]);
  });

  test("reads the mirror when GitHub cannot be reached", async () => {
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(url);
      if (!url.startsWith(MIRROR_URL)) throw new TypeError("Network is unreachable");
      return Response.json(indexOf("v2.1.0", "v2.2.0-rc.1"));
    }) as unknown as typeof fetch;
    expect(await checkCliUpdate("2.0.0")).toEqual({ current: "2.0.0", latest: "2.1.0", hasUpdate: true });
    expect(asked).toEqual(["https://api.github.com/repos/7heMech/cloudpanel-addons/releases/latest", `${MIRROR_URL}/releases.json`]);
  });

  test("another repository never reads the mirror", async () => {
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => { asked.push(url); return new Response("", { status: 503 }); }) as unknown as typeof fetch;
    expect(await checkCliUpdate("2.0.0", "owner/repo")).toBeNull();
    expect(asked).toEqual(["https://api.github.com/repos/owner/repo/releases/latest"]);
  });
});
