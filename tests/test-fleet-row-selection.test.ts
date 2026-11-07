import { expect, test } from "bun:test";
import { FLEET_ROW_SELECTION_JS } from "../lib/app-ui";

// A phone shows ten sites of a long list until Show all; Select all and the
// bulk actions still reach every site the search leaves, not only those ten.
test("on a phone, Select all reaches the sites past the ten-site cut and search still deselects", () => {
  const el = (over: Record<string, unknown> = {}) => ({ textContent: "", disabled: false, checked: false, indeterminate: false, hidden: false, ...over });
  const more = { ...el(), querySelector: () => el() };
  const find = el({ value: "" }) as ReturnType<typeof el> & { value: string };
  const byId: Record<string, unknown> = { "site-selection": el(), "select-all-btn": el(), "fleet-find": find, "fleet-more": more };
  const rows = Array.from({ length: 14 }, (_, index) => {
    const box = el();
    const attributes = new Map<string, string>();
    return {
      box,
      hidden: false,
      dataset: { domain: `site${index}.test` },
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      hasAttribute: (name: string) => attributes.has(name),
      toggleAttribute: (name: string, on: boolean) => { if (on) attributes.set(name, ""); else attributes.delete(name); },
      querySelector: (sel: string) => sel === ".site-checkbox" ? box : null,
    };
  });
  const root = {
    getElementById: (id: string) => byId[id] ?? null,
    querySelector: () => null,
    querySelectorAll: (sel: string) => sel === "tr[data-domain]" ? rows : [],
  };
  const window = { matchMedia: () => ({ matches: true, addEventListener: () => {} }) };
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const client = new Function("CLP_ROOT", "window", "plural", `${FLEET_ROW_SELECTION_JS}\nreturn { toggleAllSites, filterFleet, paintFleetSelection };`)(root, window, plural);

  expect(rows.filter((row) => row.hidden).length).toBe(4);
  expect(more.hidden).toBe(false);
  client.toggleAllSites();
  expect(rows.every((row) => row.box.checked)).toBe(true);
  expect((byId["site-selection"] as { textContent: string }).textContent).toBe("14 of 14 selected");

  find.value = "site1";
  client.filterFleet();
  // site1, site10 to site13 match; the rest leave the list and the selection.
  expect(rows.filter((row) => row.box.checked).map((row) => row.dataset.domain))
    .toEqual(["site1.test", "site10.test", "site11.test", "site12.test", "site13.test"]);

  // A site that cannot be selected does not keep Select all from turning into Deselect all.
  rows[13]!.box.disabled = true;
  rows[13]!.box.checked = false;
  client.paintFleetSelection();
  expect((byId["site-selection"] as { textContent: string }).textContent).toBe("4 of 4 selected");
  client.toggleAllSites();
  expect(rows.some((row) => row.box.checked)).toBe(false);
});

test("a page without the Show all button shows every site on a phone", () => {
  const el = () => ({ textContent: "", disabled: false, checked: false, hidden: false });
  const byId: Record<string, unknown> = { "site-selection": el(), "fleet-find": { ...el(), value: "" } };
  const rows = Array.from({ length: 14 }, (_, index) => ({
    hidden: false,
    dataset: { domain: `site${index}.test` },
    setAttribute: () => {},
    hasAttribute: () => false,
    toggleAttribute: () => {},
    querySelector: () => el(),
  }));
  const root = {
    getElementById: (id: string) => byId[id] ?? null,
    querySelector: () => null,
    querySelectorAll: (sel: string) => sel === "tr[data-domain]" ? rows : [],
  };
  const window = { matchMedia: () => ({ matches: true, addEventListener: () => {} }) };
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  new Function("CLP_ROOT", "window", "plural", FLEET_ROW_SELECTION_JS)(root, window, plural);
  expect(rows.some((row) => row.hidden)).toBe(false);
});
