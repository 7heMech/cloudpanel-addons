import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_TWEAKS } from "../addons/panel-tweaks/action";
import { sitesSnippet } from "../addons/panel-tweaks/inject/targets";
import { BASE_CLIENT_JS } from "../lib/app-ui";
import { SELECT_WIDTH_JS } from "../lib/select-width";
import { minifyScript } from "../tools/browser-assets";

type Fake = { style: Record<string, string>; options: { label: string }[]; attrs: Record<string, string> };

function run(appearance: string, labels: string[], boxSizing = "border-box") {
  const select: Fake & Record<string, unknown> = {
    style: {}, options: labels.map((label) => ({ label })), attrs: {},
    getAttribute(name: string) { return this.attrs[name] ?? null; },
    setAttribute(name: string, value: string) { this.attrs[name] = value; },
    removeAttribute(name: string) { delete this.attrs[name]; },
  };
  let layouts = 0;
  Object.defineProperty(select, "offsetWidth", { get() { layouts++; return 100; } });
  const computed = { appearance, boxSizing, fontStyle: "normal", fontWeight: "400", fontSize: "16px", fontFamily: "sans-serif",
    paddingLeft: "16px", paddingRight: "40px", borderLeftWidth: "1px", borderRightWidth: "1px" };
  const document = { createElement: () => ({ getContext: () => ({ font: "", measureText: (text: string) => ({ width: text.length * 8 }) }) }) };
  const hold = new Function("getComputedStyle", "document", `${SELECT_WIDTH_JS}\nreturn clpHoldSelectWidth;`)(() => computed, document);
  hold(select);
  return { minWidth: select.style.minWidth, layouts, select, hold, computed };
}

test("a select drawn like the menus is held at its widest option, padding and border included, without a layout", () => {
  const { minWidth, layouts } = run("base-select", ["All applications", "Static", "WordPress"]);
  // 16 characters at 8px, then 16 + 40 of padding and 2 of border.
  expect(minWidth).toBe("min(186px, 100vw - 32px)");
  expect(layouts).toBe(0);
  expect(run("base-select", ["All applications"], "content-box").minWidth).toBe("min(128px, 100vw - 32px)");
});

test("a native select is left alone, and one held before is let go", () => {
  expect(run("none", ["All applications", "Static"]).minWidth).toBeUndefined();
  const held = run("base-select", ["All applications", "Static"]);
  held.computed.appearance = "none";
  held.hold(held.select);
  expect(held.select.style.minWidth).toBe("");
});

test("the addons' page script and the Sites page script each carry the one copy", () => {
  const sites = sitesSnippet("/addons/panel-tweaks", { ...DEFAULT_TWEAKS, sitesTable: true });
  for (const script of [BASE_CLIENT_JS, sites]) {
    expect(script.split("function clpHoldSelectWidth(").length).toBe(2);
  }
});

test("the helper is joined to each script, not spliced in at a marker the build's minifier would strip", () => {
  for (const path of ["lib/assets/app-ui.client.js", "addons/panel-tweaks/inject/sites.client.js"]) {
    const source = readFileSync(path, "utf8");
    expect(source).toContain("clpHoldSelectWidths(");
    expect(source).not.toContain("function clpHoldSelectWidths(");
    expect(minifyScript(source)).toContain("clpHoldSelectWidths(");
  }
  // The Sites script runs whole: the helper, then the page's own function, in one scope.
  const sites = sitesSnippet("/addons/panel-tweaks", { ...DEFAULT_TWEAKS, sitesTable: true });
  const script = sites.slice(sites.lastIndexOf("<script>") + 8, sites.lastIndexOf("</script>"));
  expect(() => new Function(script)).not.toThrow();
  expect(script.indexOf("function clpHoldSelectWidths(")).toBeLessThan(script.indexOf("clpHoldSelectWidths(picker"));
});
