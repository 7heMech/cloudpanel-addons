// The Addons page itself: the card list, and the two client functions that act
// on a card. Disabling an addon is a decision, and it asks for one the way
// every other addon does -- through the shared dialog the shell ships, not the
// browser's confirm() in a box this project does not style.
import { beforeAll, describe, expect, test } from "bun:test";
import { indexPage } from "../cli/index";

let page = "";
let empty = "";

beforeAll(async () => {
  page = await indexPage(["instatic"]).text();
  empty = await indexPage([]).text();
});

/** A client function's body, so an assertion names one function and not the page. */
function fnBody(name: string): string {
  const at = page.indexOf(`function ${name}(`);
  return at === -1 ? "" : page.slice(at, page.indexOf("\n}", at));
}

describe("the card list", () => {
  test("renders a card naming the addon and its mount", () => {
    expect(page).toInclude("addon-card");
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

  // Scoped to the manager's own two functions: the shared shell keeps a
  // confirm() and an alert() of its own, as what it degrades to when a browser
  // has no <dialog> or a page has no notice holder, and those are not this.
  test("disabling goes through confirmAction, not confirm()", () => {
    const body = fnBody("disableAddon");
    expect(body).toInclude("confirmAction({");
    expect(body).not.toInclude("confirm(");
  });

  test("the dialog says what disabling does and does not do", () => {
    const body = fnBody("disableAddon");
    expect(body).toInclude("confirmLabel: 'Disable'");
    expect(body).toInclude("danger: true");
    expect(body).toInclude("its data is kept");
  });

  test("a declined dialog starts nothing", () => {
    expect(fnBody("disableAddon")).toInclude("if (!accepted) return;");
  });

  test("a failed manager job reports in the page, not through alert()", () => {
    const body = fnBody("startManagerJob");
    expect(body).toInclude("notify(err.message, 'error')");
    expect(body).not.toInclude("alert(");
  });

  test("a job already running is named by its own record, never by the click", () => {
    const body = fnBody("startManagerJob");
    expect(body).toInclude("showJob(existing ? describeManagerJob(running) : title");
    expect(body).not.toInclude("|| card");
  });

  test("a job whose card is not on the page gets one above the cards", () => {
    expect(fnBody("managerJobCard")).toInclude("insertBefore(card, heading.nextSibling)");
  });
});
