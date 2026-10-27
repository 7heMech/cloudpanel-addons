// The update notice the addon puts on CloudPanel's own header, and the one it
// puts on its own pages. Both read the same manager route, so what is pinned
// here is that a stale notice is cleared as readily as a fresh one is shown.
import { afterEach, describe, expect, test } from "bun:test";
import { renderLayout } from "../lib/app-ui";
import { headerTarget, headerUpdateScript } from "../lib/panel-nav";
import { isPrerelease } from "../lib/semver";
import { checkCliUpdate, isNewerVersion, resetUpdateCache } from "../lib/update-check";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetUpdateCache();
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
  const element = {
    querySelector: (selector: string) => selector === ".update-label" ? label : badge,
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
    renderLayout("Test", "<p>Hello</p>", { brand: "Test", base: "/test", nav: [], script: "", updateNotice });

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
    expect(snippet()).not.toInclude("0.9.3");
  });

  test("links to the manager under the Addons label", () => {
    expect(snippet()).toInclude(">Addons</a>");
    expect(snippet()).toInclude('href="https://addons.example.com/addons/"');
  });

  test("offers separate changelog and update links", () => {
    const snip = snippet();
    expect(snip).toInclude("https://addons.example.com/addons/update");
    expect(snip).toInclude('.href = "https://github.com/7heMech/cloudpanel-addons/releases/tag/v" + encodeURIComponent(latest)');
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

describe("which releases a box is told about", () => {
  // GitHub's "latest" is the newest release, and its list includes pre-releases.
  const github = (asked: string[]) => (async (url: string) => {
    asked.push(url);
    const body = url.endsWith("/releases/latest")
      ? { tag_name: "v2.0.0" }
      : [{ tag_name: "v2.0.0", draft: false }, { tag_name: "v2.1.0-rc.2", draft: false }, { tag_name: "v2.1.0-rc.3", draft: true }];
    return Response.json(body);
  }) as unknown as typeof fetch;

  test("a box running a pre-release is told about the newest one", async () => {
    expect(isPrerelease("2.1.0-rc.1")).toBe(true);
    const asked: string[] = [];
    globalThis.fetch = github(asked);
    expect(await checkCliUpdate("2.1.0-rc.1", "owner/repo")).toEqual({ current: "2.1.0-rc.1", latest: "2.1.0-rc.2", hasUpdate: true });
    expect(asked).toEqual(["https://api.github.com/repos/owner/repo/releases?per_page=100"]);
  });

  test("a box running a release is told about releases only", async () => {
    expect(isPrerelease("2.0.0")).toBe(false);
    expect(isPrerelease("2.0.0+build.5")).toBe(false);
    const asked: string[] = [];
    globalThis.fetch = github(asked);
    expect(await checkCliUpdate("1.5.2", "owner/repo")).toEqual({ current: "1.5.2", latest: "2.0.0", hasUpdate: true });
    expect(asked).toEqual(["https://api.github.com/repos/owner/repo/releases/latest"]);
  });
});
