import { expect, test } from "bun:test";
import { minifyScript, minifyStyles, twigSafe } from "../tools/minify-assets";

const glob = (pattern: string) => [...new Bun.Glob(pattern).scanSync({ absolute: true })].sort();
const scripts = glob("{cli,lib,manager,addons}/**/*.client.js");
const styles = glob("{cli,lib,manager,addons}/**/*.css");
const count = (text: string, word: string) => text.split(word).length - 1;
const TWIG_OPENER = /\{[{%#]/;

test("the build finds the browser assets", () => {
  expect(scripts.length).toBeGreaterThan(30);
  expect(styles.length).toBeGreaterThan(30);
});

test("minified scripts keep their top-level names and stay valid Twig text", async () => {
  for (const path of scripts) {
    const source = await Bun.file(path).text();
    const minified = minifyScript(source);
    expect(() => minifyScript(minified)).not.toThrow();
    const names = [...source.matchAll(/^(?:async )?function (\w+)|^(?:const|let|var|class) (\w+)/gm)].map((m) => m[1] ?? m[2]);
    for (const name of names) expect({ path, declared: new RegExp(`(function|const|let|var|class) ${name}\\b`).test(minified) }).toEqual({ path, declared: true });
    // Placeholders the injection code swaps for a URL.
    expect({ path, ADDON_URL: count(minified, "ADDON_URL") }).toEqual({ path, ADDON_URL: count(source, "ADDON_URL") });
    expect({ path, twig: TWIG_OPENER.test(minified) }).toEqual({ path, twig: false });
    expect(minified.length).toBeLessThanOrEqual(source.length);
  }
});

test("minified stylesheets keep their placeholders and stay valid Twig text", async () => {
  const minified = await minifyStyles(styles);
  for (const path of styles) {
    const source = await Bun.file(path).text();
    const out = minified.get(path)!;
    expect({ path, empty: out.trim() === "" }).toEqual({ path, empty: source.trim() === "" });
    expect({ path, ROW_MENU_CLASS: count(out, "ROW_MENU_CLASS") }).toEqual({ path, ROW_MENU_CLASS: count(source, "ROW_MENU_CLASS") });
    expect({ path, twig: TWIG_OPENER.test(out) }).toEqual({ path, twig: false });
  }
});

test("no code depends on a comment the minifier strips", async () => {
  for (const path of glob("{cli,lib,manager,addons}/**/*.ts")) {
    expect({ path, splitsOnComment: /\.split\(\s*["'`]\/\*/.test(await Bun.file(path).text()) }).toEqual({ path, splitsOnComment: false });
  }
});

test("a Twig opener is broken by a space, or the source is kept when it has its own", () => {
  expect(twigSafe("if (a) { { b(); } }", "if(a){{b()}}")).toBe("if(a){ {b()}}");
  expect(twigSafe("@media (x) { #a { b: c } }", "@media (x){#a{b:c}}")).toBe("@media (x){ #a{b:c}}");
  expect(twigSafe("const t = '{{ name }}';", "const t='{{ name }}'")).toBe("const t = '{{ name }}';");
});
