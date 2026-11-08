// The Addons page itself: the card list, and the two client functions that act
// on a card. Disabling an addon is a decision, and it asks for one the way
// every other addon does -- through the shared dialog the shell ships, not the
// browser's confirm() in a box this project does not style.
import { beforeAll, describe, expect, test } from "bun:test";
import { indexPage } from "../manager/views";

let page = "";
let empty = "";

beforeAll(async () => {
  page = await indexPage(["instatic"]).text();
  empty = await indexPage([]).text();
});

/** A client function's declaration as the page ships it, to run on its own. */
function fnSource(name: string): string {
  const named = page.indexOf(`function ${name}(`);
  if (named === -1) return "";
  const at = page.slice(named - 6, named) === "async " ? named - 6 : named;
  return page.slice(at, page.indexOf("\n}", at) + 2);
}

describe("the card list", () => {
  test("renders a card naming the addon and its mount", () => {
    expect(page).toInclude("addon-row");
    expect(page).toInclude("Instatic");
    expect(page).toInclude("/addons/instatic");
    expect(page).toInclude('aria-label="Open Instatic CMS">Open</a>');
  });

  // The badge used to be markup rather than state, so every addon read as
  // running whether or not anything was.
  test("does not hardcode a Live badge", () => {
    expect(page).not.toInclude("badge state-running");
    expect(page).not.toInclude("Live");
  });

  test("says so when there is nothing to list", () => {
    expect(empty).toInclude("No addons are currently available.");
  });
});

describe("acting on a card", () => {
  test("the page carries the shared dialog and notice holder", () => {
    expect(page).toInclude('<dialog id="clp-confirm"');
    expect(page).toInclude('id="clp-flash"');
  });

  type Calls = { name: string; args: unknown[] }[];
  /**
   * The manager's own card functions, run against stand-ins for the shared
   * shell. confirm() and alert() throw: the shell keeps both as what it
   * degrades to, and these functions are not to reach for either.
   */
  const cardFunctions = (stubs: Record<string, unknown> = {}) => {
    const calls: Calls = [];
    const record = (name: string, reply?: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
      calls.push({ name, args });
      return reply?.(...args);
    };
    const globals: Record<string, unknown> = {
      confirmAction: record("confirmAction", async () => true),
      clearNotice: record("clearNotice"),
      busy: record("busy"),
      call: record("call", async () => ({ ok: true, data: { jobId: "job-1" } })),
      showJob: record("showJob"),
      watchJob: record("watchJob"),
      notify: record("notify"),
      managerJobFinished: () => {},
      confirm: () => { throw new Error("confirm() was called"); },
      alert: () => { throw new Error("alert() was called"); },
      CLP_ROOT: { querySelectorAll: () => [], querySelector: () => null },
      document: { createElement: () => ({ setAttribute() {} }) },
      ...stubs,
    };
    const names = ["managerJobCard", "describeManagerJob", "startManagerJob", "disableAddon"];
    const source = names.map(fnSource).join("\n");
    const fns = new Function(...Object.keys(globals), `${source}\nreturn { ${names.join(", ")} };`)(...Object.values(globals));
    return { ...fns, calls, named: (name: string) => calls.filter((item) => item.name === name) };
  };

  test("disabling asks through the shared dialog what it does and does not do", async () => {
    const page = cardFunctions();
    await page.disableAddon("instatic", "Instatic CMS", null);
    const [dialog] = page.named("confirmAction");
    const options = dialog!.args[0] as { title: string; details: string[]; confirmLabel: string; danger: boolean };
    expect(options.title).toBe("Disable Instatic CMS?");
    expect(options.confirmLabel).toBe("Disable");
    expect(options.danger).toBe(true);
    expect(options.details.join(" ")).toContain("its data is kept");
    expect(page.named("call").map((item) => item.args[0])).toEqual(["/api/addons/instatic/disable"]);
  });

  test("a declined dialog starts nothing", async () => {
    const page = cardFunctions({ confirmAction: async () => false });
    await page.disableAddon("instatic", "Instatic CMS", null);
    expect(page.calls).toEqual([]);
  });

  test("a failed manager job reports in the page, not through alert()", async () => {
    const page = cardFunctions({ call: async () => { throw new Error("the manager is restarting"); } });
    await page.startManagerJob("/api/addons/git/enable", "Enabling git", null, "git");
    expect(page.named("notify").map((item) => item.args)).toEqual([["the manager is restarting", "error"]]);
    expect(page.named("busy").map((item) => item.args[0])).toEqual([true, false]);
    expect(page.named("watchJob")).toEqual([]);
  });

  test("a job already running is named by its own record, never by the click", async () => {
    const clicked = { closest: () => ({ clicked: true }) };
    const page = cardFunctions({
      call: async () => ({ ok: true, data: { jobId: "job-1", existing: true, job: { kind: "update" } } }),
    });
    await page.startManagerJob("/api/addons/git/disable", "Disabling git", clicked, "git");
    const [shown] = page.named("showJob");
    expect(shown!.args[0]).toBe("Updating clp-addons");
    expect(shown!.args[1]).not.toEqual({ clicked: true });
    expect(page.named("watchJob")[0]!.args[1]).toBe(shown!.args[1]);
  });

  test("a job whose card is not on the page gets one above the cards", () => {
    const inserted: unknown[][] = [];
    const heading = { nextSibling: { first: "card" }, parentNode: { insertBefore: (...args: unknown[]) => inserted.push(args) } };
    const page = cardFunctions({
      CLP_ROOT: { querySelectorAll: () => [], querySelector: (selector: string) => selector === ".page-heading" ? heading : null },
      document: { createElement: () => ({ attributes: {} as Record<string, string>, setAttribute(name: string, value: string) { this.attributes[name] = value; } }) },
    });
    const card = page.managerJobCard(null, "update", true);
    expect(card.attributes["data-manager-job-card"]).toBe("update");
    expect(inserted).toEqual([[card, heading.nextSibling]]);
  });
});

test("only a successful manager update reloads its replaced script", async () => {
  for (const [kind, state, reloads] of [["enable", "done", 0], ["disable", "done", 0], ["update", "failed", 0], ["update", "done", 1]] as const) {
    let navigations = 0;
    let repaints = 0;
    const notices: string[] = [];
    const run = new Function("location", "repaintPage", "notify", "findAddons",
      `${fnSource("managerJobFinished")}\nreturn managerJobFinished;`)(
      { reload() { navigations++; } }, async () => { repaints++; return true; }, (message: string) => notices.push(message), () => {},
    );
    await run({ kind, state, addon: "git", error: "download failed" });
    expect(navigations).toBe(reloads);
    expect(repaints).toBe(reloads ? 0 : 1);
    if (!reloads) expect(notices[0]).toContain(state === "failed" ? "download failed" : "git");
  }
});
