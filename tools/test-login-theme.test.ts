import { expect, test } from "bun:test";
import { LOGIN_THEME_TARGETS } from "../addons/login-theme/inject/targets";

const target = LOGIN_THEME_TARGETS[0]!;

interface Run {
  /** Whether the script put the page into dark mode. */
  dark: boolean;
  /** Everything written to document.cookie, in order. */
  cookies: string[];
  /** The local storage the script left behind. */
  store: Map<string, string>;
}

/**
 * Run the injected script against a minimal stand-in for the login page, so the
 * assertions below are about what a browser would actually do with it.
 */
function run(options: {
  cookie?: string;
  deviceDark?: boolean;
  https?: boolean;
  store?: Map<string, string>;
  noStorage?: boolean;
}): Run {
  const body = target.snippet("/addons/login-theme").replace(/^\s*<script>/, "").replace(/<\/script>\s*$/, "");
  const cookies: string[] = [];
  const store = options.store ?? new Map<string, string>();
  const classes = new Set<string>();
  let jar = options.cookie ?? "";
  const document = {
    get cookie() { return jar; },
    set cookie(value: string) { cookies.push(value); jar = value.split(";")[0] ?? ""; },
    documentElement: { classList: { add: (name: string) => { classes.add(name); } } },
  };
  const localStorage = options.noStorage
    ? { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } }
    : { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  const window = { matchMedia: (query: string) => ({ matches: query.includes("dark") && options.deviceDark === true }) };
  const location = { protocol: options.https === false ? "http:" : "https:" };
  new Function("document", "window", "localStorage", "location", body)(document, window, localStorage, location);
  return { dark: classes.has("dark"), cookies, store };
}

test("the script is injected into the shared login layout, ahead of its stylesheets", () => {
  expect(target.template).toBe("Frontend/Login/layout.html.twig");
  expect(target.anchorBefore).toBe("{% block stylesheets %}");
  expect(target.required).toBe(true);
  const rendered = `${target.snippet("/addons/login-theme")}${target.anchorBefore}`;
  expect(rendered.indexOf("prefers-color-scheme: dark")).toBeLessThan(rendered.indexOf(target.anchorBefore!));
});

test("a dark device with no saved theme gets the panel's dark setting", () => {
  const result = run({ deviceDark: true });
  expect(result.dark).toBe(true);
  expect(result.cookies).toHaveLength(1);
  expect(result.cookies[0]).toStartWith("theme=dark;");
  expect(result.store.get("clp_addons_device_theme")).toBe("1");
});

test("a light device is left alone, matching the panel's cookie-less default", () => {
  const result = run({ deviceDark: false });
  expect(result.dark).toBe(false);
  expect(result.cookies).toHaveLength(0);
});

test("the cookie carries the same attributes as the panel's own theme switch", () => {
  const https = run({ deviceDark: true }).cookies[0] ?? "";
  expect(https).toContain("; path=/");
  expect(https).toContain("; secure");
  const expires = /expires=([^;]+)/.exec(https)?.[1] ?? "";
  const days = (Date.parse(expires) - Date.now()) / 864e5;
  expect(days).toBeGreaterThan(179);
  expect(days).toBeLessThan(181);
  // The panel hardcodes `secure: true`, which a browser drops over plain HTTP;
  // omitting it there is the only deviation, so the value actually sticks.
  expect(run({ deviceDark: true, https: false }).cookies[0] ?? "").not.toContain("secure");
});

test("a saved choice wins over the device preference", () => {
  // The panel renders html.dark from the cookie itself, so the script has
  // nothing left to do once one exists, whichever way the device leans.
  for (const cookie of ["theme=dark", "PHPSESSID=x; theme=dark; n=1", "theme="]) {
    for (const deviceDark of [true, false]) {
      const result = run({ cookie, deviceDark });
      expect(result.cookies).toHaveLength(0);
      expect(result.store.size).toBe(0);
    }
  }
});

test("switching to light survives a return to the login page on a dark device", () => {
  // Seeded on the first visit, then the panel's switch deleted the cookie for
  // light. Re-seeding here is what used to drag the user back into dark mode.
  const store = new Map([["clp_addons_device_theme", "1"]]);
  const result = run({ deviceDark: true, store });
  expect(result.dark).toBe(false);
  expect(result.cookies).toHaveLength(0);
});

test("unusable local storage leaves the panel's own default in place", () => {
  const result = run({ deviceDark: true, noStorage: true });
  expect(result.dark).toBe(false);
  expect(result.cookies).toHaveLength(0);
});
