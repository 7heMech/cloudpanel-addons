import { expect, test } from "bun:test";
import { LOGIN_THEME_TARGETS } from "../addons/login-theme/inject/targets";

test("login theme injects device preference detection into the login wrapper", () => {
  const target = LOGIN_THEME_TARGETS[0]!;
  expect(target.template).toBe("Frontend/Security/login.html.twig");
  expect(target.anchorBefore).toBe('<div class="login-container">');

  const snippet = target.snippet("/addons/login-theme");
  expect(snippet).toContain("prefers-color-scheme: dark");
  expect(snippet).toContain('classList.toggle("dark", media.matches)');
  expect(snippet).toContain('style.colorScheme = media.matches ? "dark" : "light"');
  expect(snippet).toContain('addEventListener("change", syncDeviceTheme)');

  const rendered = `${snippet}${target.anchorBefore}`;
  expect(rendered.indexOf("prefers-color-scheme: dark")).toBeLessThan(rendered.indexOf(target.anchorBefore!));
});
