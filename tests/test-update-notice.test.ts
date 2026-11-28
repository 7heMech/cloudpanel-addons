// The update notice the addon puts on CloudPanel's own header, and the one it
// puts on its own pages. Both read the same manager route, so what is pinned
// here is that a stale notice is cleared as readily as a fresh one is shown.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderLayout } from "../lib/app-ui";
import { CLI_VERSION } from "../lib/version";
import { headerTarget, headerUpdateScript } from "../lib/panel-nav";
import { isPrerelease } from "../lib/semver";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECK_URL, checkRequest, isNewerVersion, parseCheckAnswer, readSavedAnswer, runDailyCheck, savedUpdate, type UsageReport,
} from "../lib/update-check";
import { FORGET_URL } from "../lib/usage-share";
import contract from "./fixtures/check-contract.json";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("native header follows the manager's update state and clears a restored stale notice", async () => {
  const listeners: Record<string, (event?: { persisted?: boolean }) => void> = {};
  type UpdateInfo = { current: string; latest: string; hasUpdate: boolean };
  type FakeResponse = { ok: boolean; json: () => Promise<{ ok: true; data: UpdateInfo }> };
  let info: UpdateInfo = { current: "1.0.0", latest: "1.1.0", hasUpdate: true };
  let notice: any = null;
  let fetchedUrl = "";
  let fetchCount = 0;
  let failure: "http" | "network" | null = null;
  let holdNext = false;
  let releaseHeld: ((response: FakeResponse) => void) | null = null;
  const label = { textContent: "" };
  const badge = { title: "" };
  const changelog = { href: "" };
  const element = {
    querySelector: (selector: string) => ({ ".update-label": label, ".clp-addon-update-badge": badge, ".clp-addon-changelog-link": changelog })[selector],
    remove: () => { notice = null; },
  };
  const classes = new Set<string>();
  const header = {
    querySelector: () => ({ insertAdjacentElement: (_where: string, inserted: unknown) => { notice = inserted; } }),
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
    },
  };
  const document = {
    readyState: "complete",
    getElementById: () => notice,
    querySelector: () => header,
    createElement: () => ({ innerHTML: "", firstElementChild: element }),
  };
  const window = { addEventListener: (name: string, listener: (event?: { persisted?: boolean }) => void) => { listeners[name] = listener; } };
  const responseFor = (data: UpdateInfo): FakeResponse => ({
    ok: true,
    json: async () => ({ ok: true, data }),
  });
  const fetch = async (url: string) => {
    fetchedUrl = url;
    fetchCount++;
    if (holdNext) {
      holdNext = false;
      return new Promise<FakeResponse>((resolve) => { releaseHeld = resolve; });
    }
    if (failure === "network") throw new Error("manager unavailable");
    if (failure === "http") return { ok: false, json: async () => ({ ok: true, data: info }) };
    return responseFor(info);
  };

  new Function("window", "document", "fetch", headerUpdateScript())(window, document, fetch);
  await Bun.sleep(0);
  expect(fetchedUrl).toBe("/addons/api/update");
  expect(label.textContent).toBe("Addons · v1.1.0 available");
  expect(badge.title).toBe("clp-addons v1.1.0 available");
  expect(changelog.href).toBe("https://github.com/7heMech/cloudpanel-addons/releases/tag/v1.1.0");
  expect(classes.has("clp-addons-has-update")).toBe(true);

  info = { current: "1.1.0", latest: "1.1.0", hasUpdate: false };
  listeners.focus!();
  await Bun.sleep(0);
  expect(notice).toBeNull();
  expect(classes.has("clp-addons-has-update")).toBe(false);

  for (const mode of ["http", "network"] as const) {
    info = { current: "1.0.0", latest: "1.1.0", hasUpdate: true };
    listeners.focus!();
    await Bun.sleep(0);
    expect(notice).not.toBeNull();

    failure = mode;
    listeners.focus!();
    await Bun.sleep(0);
    expect(notice).toBeNull();
    expect(classes.has("clp-addons-has-update")).toBe(false);
    failure = null;
  }

  listeners.focus!();
  await Bun.sleep(0);
  expect(notice).not.toBeNull();

  const beforeQueuedCheck = fetchCount;
  holdNext = true;
  listeners.pageshow!({ persisted: true });
  info = { current: "1.1.0", latest: "1.1.0", hasUpdate: false };
  listeners.focus!();
  expect(releaseHeld).not.toBeNull();
  releaseHeld!(responseFor({ current: "1.0.0", latest: "1.1.0", hasUpdate: true }));
  await Bun.sleep(0);
  await Bun.sleep(0);
  expect(fetchCount).toBe(beforeQueuedCheck + 2);
  expect(notice).toBeNull();
  expect(classes.has("clp-addons-has-update")).toBe(false);
});

describe("version comparison", () => {
  for (const [newer, older, expected] of [
    ["0.9.4", "0.9.3", true],
    ["v0.9.4", "0.9.3", true],
    ["1.0.0", "0.9.3", true],
    ["0.10.0", "0.9.9", true],
    ["0.9.3", "0.9.3", false],
    ["0.9.2", "0.9.3", false],
    // A box on a release candidate is offered the release, and never an older one.
    ["2.0.0", "2.0.0-rc.1", true],
    ["2.0.0-rc.2", "2.0.0-rc.1", true],
    ["2.0.0-rc.10", "2.0.0-rc.9", true],
    ["2.0.0-rc.1", "2.0.0-beta.2", true],
    ["2.0.0-rc.1", "2.0.0", false],
    ["2.0.0-rc.1", "2.0.0-rc.1", false],
    ["1.5.2", "2.0.0-rc.1", false],
    ["2.0.0+build.5", "2.0.0", false],
  ] as const) {
    test(`${newer} is ${expected ? "" : "not "}newer than ${older}`, () => {
      expect(isNewerVersion(newer, older)).toBe(expected);
    });
  }
});

describe("the addon's own layout", () => {
  const layout = (updateNotice?: { current: string; latest: string }) =>
    renderLayout("Test", "<p>Hello</p>", { base: "/test", script: "", updateNotice });

  test("renders no update banner without a notice", () => {
    expect(layout()).not.toInclude('class="notice update-banner"');
  });

  test("identifies the Addons release in its header", () => {
    const html = layout({ current: "0.9.3", latest: "0.9.4" });
    const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    expect(header).toInclude("Addons \u00b7 v0.9.4 available");
    expect(header).toInclude('href="/addons/update"');
    expect(header).toInclude('href="https://github.com/7heMech/cloudpanel-addons/releases/tag/v0.9.4"');
    // The header carries it; a second banner in the content would repeat it.
    expect(html).not.toInclude('class="notice update-banner"');
  });
});

describe("the snippet injected into CloudPanel's header", () => {
  const snippet = () => headerTarget().snippet("https://addons.example.com/addons/");

  test("carries the badge style and the update check", () => {
    const snip = snippet();
    expect(snip).toInclude("clp-addon-update-badge");
    expect(snip).toInclude("window.__clpAddonsUpdateInit");
    expect(snip).toInclude("https://addons.example.com/addons/api/update");
  });

  // The snippet is baked into a Twig template the panel caches, so a version
  // in it would outlive the release it names.
  test("embeds no version of its own", () => {
    expect(snippet()).not.toInclude(CLI_VERSION);
  });

  test("links to the manager under the Addons label", () => {
    expect(snippet()).toInclude(">Addons</a>");
    expect(snippet()).toInclude('href="https://addons.example.com/addons/"');
  });

  test("offers an update link beside the changelog", () => {
    expect(snippet()).toInclude("https://addons.example.com/addons/update");
  });

  test("keeps narrow-screen navigation above the update row", () => {
    const snip = snippet();
    expect(snip).toInclude("@media (max-width: 960px)");
    expect(snip).toInclude(".header.clp-addons-has-update .nav-link-container,");
    expect(snip).toInclude("order: 2; flex: 1 0 100%");
    expect(snip).toInclude(".header #clp-addons-update-notice { order: 3");
  });

  // The panel renders this header for every signed-in user, so the guard is
  // what keeps an administrative link off a site manager's page.
  test("wraps style, link and update script in the native admin guard", () => {
    const snip = snippet();
    const start = snip.indexOf("{% if is_granted('ROLE_ADMIN') %}");
    const end = snip.indexOf("{% endif %}");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    for (const needle of ["<style>", 'class="clp-addon-nav"', "window.__clpAddonsUpdateInit"]) {
      const at = snip.indexOf(needle);
      expect(at > start && at < end, needle).toBe(true);
    }
  });
});

describe("the daily update check", () => {
  const uid = process.getuid!();
  let dir: string;
  let file: string;
  let lockFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clp-update-check-"));
    file = join(dir, "update-check.json");
    lockFile = join(dir, "update-check.lock");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };
  const recorder = (answer: (url: string) => Response | Promise<Response>) => {
    const calls: Call[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null, headers: (init?.headers ?? {}) as Record<string, string> });
      return answer(url);
    }) as unknown as typeof fetch;
    return { calls, fetcher };
  };
  const day1 = new Date("2026-11-28T00:05:00Z");
  const opts = (extra: Record<string, unknown> = {}) => ({ file, uid, lockFile, arch: "x64", ...extra });

  test("sends only version, channel and arch, and saves the Worker's answer world-readable", async () => {
    const { calls, fetcher } = recorder(() => Response.json({ latest: "2.2.0", update: true, urgent: false, usage: "none" }));
    const saved = await runDailyCheck(opts({ version: "2.1.0", now: day1, fetch: fetcher }));
    expect(calls).toEqual([{
      url: CHECK_URL,
      method: "POST",
      body: { version: "2.1.0", channel: "stable", arch: "x64" },
      headers: { "Content-Type": "application/json", "User-Agent": "clp-addons/2.1.0" },
    }]);
    expect(saved).toMatchObject({ day: "2026-11-28", version: "2.1.0", latest: "2.2.0", update: true, source: "worker" });
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(savedUpdate("2.1.0", file, uid)).toEqual({ current: "2.1.0", latest: "2.2.0", hasUpdate: true });
  });

  test("asks once per UTC day, at once for a new version, and an hour after reaching nothing", async () => {
    let fail = false;
    const { calls, fetcher } = recorder(() => fail ? new Response("down", { status: 502 }) : Response.json({ latest: "2.2.0", update: true, urgent: false, usage: "none" }));
    await runDailyCheck(opts({ version: "2.1.0", now: day1, fetch: fetcher }));
    expect(await runDailyCheck(opts({ version: "2.1.0", now: new Date("2026-11-28T23:59:00Z"), fetch: fetcher }))).toBeNull();
    expect(calls).toHaveLength(1);
    await runDailyCheck(opts({ version: "2.2.0", now: new Date("2026-11-28T23:59:00Z"), fetch: fetcher }));
    expect(calls).toHaveLength(2);
    expect(savedUpdate("2.2.0", file, uid)?.hasUpdate).toBe(false);

    fail = true;
    const day2 = new Date("2026-11-29T00:05:00Z");
    const failed = await runDailyCheck(opts({ version: "2.2.0", now: day2, fetch: fetcher }));
    expect(calls.map((call) => call.url)).toEqual([CHECK_URL, CHECK_URL, CHECK_URL, "https://api.github.com/repos/7heMech/cloudpanel-addons/releases/latest"]);
    expect(failed).toMatchObject({ day: "2026-11-28", latest: "2.2.0", failedAt: day2.toISOString() });
    expect(await runDailyCheck(opts({ version: "2.2.0", now: new Date("2026-11-29T00:50:00Z"), fetch: fetcher }))).toBeNull();
    fail = false;
    expect(await runDailyCheck(opts({ version: "2.2.0", now: new Date("2026-11-29T01:06:00Z"), fetch: fetcher }))).toMatchObject({ day: "2026-11-29", failedAt: null });
  });

  test("a pre-release asks on the prerelease channel; urgent is kept while the update is pending", async () => {
    const { calls, fetcher } = recorder(() => Response.json({ latest: "2.2.0-rc.4", update: true, urgent: true, usage: "none" }));
    await runDailyCheck(opts({ version: "v2.2.0-rc.3", now: day1, fetch: fetcher }));
    expect(calls[0]!.body).toEqual({ version: "2.2.0-rc.3", channel: "prerelease", arch: "x64" });
    expect(savedUpdate("2.2.0-rc.3", file, uid)).toEqual({ current: "2.2.0-rc.3", latest: "2.2.0-rc.4", hasUpdate: true, urgent: true });
    expect(savedUpdate("2.2.0-rc.4", file, uid)).toEqual({ current: "2.2.0-rc.4", latest: "2.2.0-rc.4", hasUpdate: false });
  });

  test("a held-back answer is honoured", async () => {
    const { fetcher } = recorder(() => Response.json({ latest: "2.1.0", update: false, urgent: false, usage: "none" }));
    await runDailyCheck(opts({ version: "2.1.0", now: day1, fetch: fetcher }));
    expect(savedUpdate("2.1.0", file, uid)?.hasUpdate).toBe(false);
  });

  test("worker failures fall back to GitHub; another repo asks GitHub only and never sends usage", async () => {
    const failures: (() => Response | Promise<Response>)[] = [
      () => { throw new Error("unreachable"); },
      () => new Response("bad", { status: 502 }),
      () => new Response("{not json", { status: 200 }),
      () => Response.json({ latest: "2.0", update: true, urgent: false }),
      () => Response.json({ latest: "2.2.0", update: "yes", urgent: false }),
    ];
    for (const failWorker of failures) {
      rmSync(file, { force: true });
      const { calls, fetcher } = recorder((url) => url === CHECK_URL ? failWorker() : Response.json({ tag_name: "v2.2.0" }));
      expect(await runDailyCheck(opts({ version: "2.1.0", now: day1, fetch: fetcher }))).toMatchObject({ latest: "2.2.0", update: true, source: "github" });
      expect(calls.map((call) => call.url)).toEqual([CHECK_URL, "https://api.github.com/repos/7heMech/cloudpanel-addons/releases/latest"]);
    }

    rmSync(file, { force: true });
    let asked = false;
    const { calls, fetcher } = recorder(() => Response.json([{ tag_name: "v2.2.0-rc.2", draft: false }, { tag_name: "v2.2.0-rc.3", draft: true }]));
    await runDailyCheck(opts({ version: "2.2.0-rc.1", repo: "owner/repo", now: day1, fetch: fetcher, usage: () => { asked = true; return null; } }));
    expect(calls.map((call) => call.url)).toEqual(["https://api.github.com/repos/owner/repo/releases?per_page=100"]);
    expect(asked).toBe(false);
    expect(readSavedAnswer(file, uid)).toMatchObject({ latest: "2.2.0-rc.2", source: "github" });
  });

  test("the opt-in part rides along, and only a saved answer settles the counts", async () => {
    const usage: UsageReport = { id: "0123456789abcdef0123456789abcdef", cloudpanel: "2.5.4", addons: ["dns"], activity: { dns: { list: 2 } } };
    for (const [reply, settles] of [["saved", true], ["refused", false]] as const) {
      rmSync(file, { force: true });
      const settled: UsageReport[] = [];
      const { calls, fetcher } = recorder(() => Response.json({ latest: "2.1.0", update: false, urgent: false, usage: reply }));
      await runDailyCheck(opts({ version: "2.1.0", now: day1, fetch: fetcher, usage: () => usage, onUsageSaved: (sent: UsageReport) => settled.push(sent) }));
      expect(calls[0]!.body).toEqual({ version: "2.1.0", channel: "stable", arch: "x64", usage });
      expect(settled).toEqual(settles ? [usage] : []);
    }
  });

  test("the answer must be root's and not writable by others, and a dev build never asks", async () => {
    writeFileSync(file, JSON.stringify({ day: "2026-11-28", version: "2.1.0", latest: "9.9.9", update: true }));
    chmodSync(file, 0o666);
    expect(savedUpdate("2.1.0", file, uid)).toBeNull();
    const { calls, fetcher } = recorder(() => Response.json({}));
    expect(await runDailyCheck(opts({ version: "0.0.0-dev", fetch: fetcher }))).toBeNull();
    expect(calls).toEqual([]);
  });

  test("sends and parses the contract worker/index.ts is tested against (tests/fixtures/check-contract.json)", async () => {
    const { usage } = contract.requestWithUsage;
    expect(checkRequest("2.1.0", "x64")).toEqual(contract.request as never);
    expect(checkRequest("2.1.0", "x64", usage)).toEqual(contract.requestWithUsage as never);
    expect(parseCheckAnswer(contract.answer)).toEqual(contract.answer as never);
    expect(parseCheckAnswer(contract.answerWithUsage)).toEqual(contract.answerWithUsage as never);
    const { calls, fetcher } = recorder(() => Response.json(contract.answerWithUsage));
    let settled = false;
    await runDailyCheck(opts({ version: "2.1.0", now: day1, fetch: fetcher, usage: () => usage, onUsageSaved: () => { settled = true; } }));
    expect(calls[0]!.body).toEqual(contract.requestWithUsage);
    expect(settled).toBe(true);
    expect(FORGET_URL).toBe("https://clp.7he.dev/forget");
  });

  test("request and answer shapes", () => {
    expect(checkRequest("v2.2.0-rc.3", "arm64")).toEqual({ version: "2.2.0-rc.3", channel: "prerelease", arch: "arm64" });
    expect(parseCheckAnswer({ latest: "2.2.0", update: true, urgent: false, usage: "saved", extra: 1 })).toEqual({ latest: "2.2.0", update: true, urgent: false, usage: "saved" });
    expect(parseCheckAnswer({ latest: "2.2.0", update: true, urgent: false })).toEqual({ latest: "2.2.0", update: true, urgent: false, usage: "none" });
    expect(parseCheckAnswer({ latest: "v2.2.0", update: true, urgent: false })).toBeNull();
    expect(parseCheckAnswer([])).toBeNull();
  });
});
