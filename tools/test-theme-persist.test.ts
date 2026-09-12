import { expect, test } from "bun:test";
import { THEME_PERSIST_SCRIPT } from "../lib/panel-nav";
import { headerTarget, adminHeaderTarget } from "../lib/panel-nav";
import { BASE_CLIENT_JS } from "../lib/app-ui";

test("addon toggle persists with matching set/clear flags", () => {
  expect(BASE_CLIENT_JS).toContain("themeCookieFlags");
  expect(BASE_CLIENT_JS).toContain("Max-Age=15552000");
});

test("theme persist script parses", () => {
  new Function(THEME_PERSIST_SCRIPT);
});

test("panel header injections carry the theme persist script", () => {
  for (const target of [headerTarget("1.1.1"), adminHeaderTarget("1.1.1")]) {
    const snippet = target.snippet("/addons/");
    expect(snippet).toContain("theme-switch");
    expect(snippet).toContain("Max-Age=0");
  }
});

interface Harness {
  writes: string[];
  click: (() => void) | null;
  timeouts: (() => void)[];
  setDark: (dark: boolean) => void;
  isDark: () => boolean;
}

function runPersist(cookie: string, dark: boolean, protocol = "https:", pathname = "/"): Harness {
  const writes: string[] = [];
  let currentCookie = cookie;
  const classes = new Set<string>(dark ? ["dark"] : []);
  let click: (() => void) | null = null;
  const timeouts: (() => void)[] = [];
  // The injection sits above the toggle in the header, so at parse time the
  // button does not exist yet; it appears by DOMContentLoaded.
  let parsed = false;
  let ready: (() => void) | null = null;
  const document = {
    readyState: "loading",
    addEventListener: (event: string, fn: () => void) => { if (event === "DOMContentLoaded") ready = fn; },
    get cookie() { return currentCookie; },
    set cookie(value: string) { writes.push(value); },
    documentElement: {
      classList: {
        contains: (name: string) => classes.has(name),
        toggle(name: string, enabled: boolean) {
          if (enabled) classes.add(name);
          else classes.delete(name);
        },
      },
    },
    getElementById: (id: string) =>
      id === "theme-switch" && parsed
        ? { addEventListener: (_event: string, fn: () => void) => { click = fn; } }
        : null,
  };
  const window = {
    location: { protocol, pathname },
    setTimeout: (fn: () => void) => { timeouts.push(fn); return 0; },
  };
  new Function("document", "window", THEME_PERSIST_SCRIPT)(document, window);
  expect(click, "no binding at parse time").toBe(null);
  parsed = true;
  ready!();
  return {
    writes,
    click,
    timeouts,
    setDark: (value: boolean) => {
      if (value) classes.add("dark");
      else classes.delete("dark");
    },
    isDark: () => classes.has("dark"),
  };
}

test("a visible dark cookie is re-persisted with matching flags", () => {
  const h = runPersist("theme=dark", true);
  expect(h.click !== null).toBe(true);
  const rewrite = h.writes.find((c) => c.startsWith("theme=dark")) ?? "";
  expect(rewrite).toContain("Path=/");
  expect(rewrite).toContain("Max-Age=");
  expect(rewrite).toContain("Secure");
});

test("no saved cookie means no writes on load", () => {
  const h = runPersist("", false);
  expect(h.writes.length).toBe(0);
});

test("toggling to light expires the cookie with the Secure flag", () => {
  const h = runPersist("theme=dark", true);
  h.click!();
  // The panel flips the class synchronously in its own handler; emulate that,
  // then let our deferred mirror read the outcome.
  h.setDark(false);
  for (const tick of h.timeouts) tick();
  const clear = h.writes.find((c) => c.startsWith("theme=") && c.includes("Max-Age=0")) ?? "";
  expect(clear).toContain("Path=/");
  expect(clear).toContain("Secure");
});

test("toggling to dark persists it globally", () => {
  const h = runPersist("", false);
  const before = h.writes.length;
  h.click!();
  h.setDark(true);
  for (const tick of h.timeouts) tick();
  const set = h.writes.slice(before).find((c) => c.startsWith("theme=dark")) ?? "";
  expect(set).toContain("Path=/");
  expect(set).toContain("Secure");
});

test("plain http omits the Secure flag", () => {
  const h = runPersist("theme=dark", true, "http:");
  const rewrite = h.writes.find((c) => c.startsWith("theme=dark")) ?? "";
  expect(rewrite.includes("Secure")).toBe(false);
  h.click!();
  h.setDark(false);
  for (const tick of h.timeouts) tick();
  const clear = h.writes.find((c) => c.startsWith("theme=") && c.includes("Max-Age=0")) ?? "";
  expect(clear.includes("Secure")).toBe(false);
});

test("ambiguous duplicate cookies are left alone on load", () => {
  const h = runPersist("theme=dark; theme=light", true);
  expect(h.writes.length).toBe(0);
});
