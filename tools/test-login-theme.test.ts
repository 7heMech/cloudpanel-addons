import { expect, test } from "bun:test";
import { LOGIN_THEME_TARGETS } from "../addons/login-theme/inject/targets";

test("login theme injects device preference detection into the login layout", () => {
  const target = LOGIN_THEME_TARGETS[0]!;
  expect(target.template).toBe("Frontend/Login/layout.html.twig");
  expect(target.anchorBefore).toBe("{% block stylesheets %}");

  const snippet = target.snippet("/addons/login-theme");
  expect(snippet).toContain("prefers-color-scheme: dark");
  expect(snippet).toContain('classList.toggle("dark", dark)');
  expect(snippet).toContain('style.colorScheme = dark ? "dark" : "light"');
  expect(snippet).toContain('addEventListener("change", onDeviceChange)');

  const rendered = `${snippet}${target.anchorBefore}`;
  expect(rendered.indexOf("prefers-color-scheme: dark")).toBeLessThan(rendered.indexOf(target.anchorBefore!));
});

function runSnippet(cookie: string, deviceDark: boolean, protocol = "http:"): { dark: boolean; cookies: string[] } {
  const target = LOGIN_THEME_TARGETS[0]!;
  const snippet = target.snippet("/addons/login-theme");
  const body = snippet.replace(/^\s*<script>/, "").replace(/<\/script>\s*$/, "");
  const classes = new Set<string>();
  const writes: string[] = [];
  let currentCookie = cookie;
  const document = {
    get cookie() { return currentCookie; },
    set cookie(value: string) {
      writes.push(value);
      const pair = value.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq !== -1) currentCookie = `${pair.slice(0, eq)}=${pair.slice(eq + 1)}`;
    },
    documentElement: {
      classList: {
        toggle(name: string, enabled: boolean) {
          if (enabled) classes.add(name);
          else classes.delete(name);
        },
      },
      style: {} as Record<string, string>,
    },
  };
  const listeners: Record<string, () => void> = {};
  const media = {
    matches: deviceDark,
    addEventListener: (event: string, fn: () => void) => { listeners[event] = fn; },
    addListener: (fn: () => void) => { listeners["change"] = fn; },
  };
  const window = { matchMedia: () => media, location: { protocol } };
  new Function("document", "window", body)(document, window);
  return { dark: classes.has("dark"), cookies: writes };
}

test("login theme uses the device default when nothing is saved", () => {
  expect(runSnippet("", true).dark).toBe(true);
  expect(runSnippet("", false).dark).toBe(false);
});

test("login theme lets a saved choice win over the device", () => {
  expect(runSnippet("theme=dark", false).dark).toBe(true);
  expect(runSnippet("theme=light", true).dark).toBe(false);
});

test("login theme persists a dark device default as the native setting", () => {
  const first = runSnippet("", true);
  expect(first.dark).toBe(true);
  expect(first.cookies.some((c) => c.startsWith("theme=dark"))).toBe(true);
  const light = runSnippet("", false);
  expect(light.dark).toBe(false);
  expect(light.cookies.length).toBe(0);
});

test("login theme persists with the panel's flags so its toggle can clear it", () => {
  const http = runSnippet("", true, "http:");
  const httpCookie = http.cookies.find((c) => c.startsWith("theme=dark")) ?? "";
  expect(httpCookie).toContain("Path=/");
  expect(httpCookie).toContain("Max-Age=");
  expect(httpCookie.includes("Secure")).toBe(false);
  const https = runSnippet("", true, "https:");
  const httpsCookie = https.cookies.find((c) => c.startsWith("theme=dark")) ?? "";
  expect(httpsCookie).toContain("Path=/");
  expect(httpsCookie).toContain("Secure");
});
