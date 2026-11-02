import { expect, test } from "bun:test";
import { bundleStyles, minifyScript, twigSafe } from "../tools/browser-assets";
import DNS_STYLE from "../addons/dns/app/views.css" with { type: "text" };

const glob = (pattern: string) => [...new Bun.Glob(pattern).scanSync({ absolute: true })].sort();
const scripts = glob("{cli,lib,manager,addons}/**/*.client.js");
const styles = glob("{cli,lib,manager,addons}/**/*.css");
const count = (text: string, word: string) => text.split(word).length - 1;
const TWIG_OPENER = /\{[{%#]/;
// Words the code swaps into an asset's text, found where it swaps them.
const placeholders = async () => {
  const words = new Set<string>();
  for (const path of glob("{cli,lib,manager,addons}/**/*.ts")) {
    for (const m of (await Bun.file(path).text()).matchAll(/\.(?:split|replace|replaceAll)\("([A-Z][A-Z0-9_]+)"/g)) words.add(m[1]!);
  }
  return [...words];
};
const counts = (text: string, words: string[]) => Object.fromEntries(words.map((word) => [word, count(text, word)]));

test("the build finds the browser assets", () => {
  expect(scripts.length).toBeGreaterThan(30);
  expect(styles.length).toBeGreaterThan(30);
});

test("the code swaps placeholders into assets", async () => {
  expect(await placeholders()).toEqual(expect.arrayContaining(["ADDON_URL", "NOTICE_HTML", "EMBED_MARKER", "ROW_MENU_CLASS"]));
});

test("minified scripts keep their top-level names and stay valid Twig text", async () => {
  const words = await placeholders();
  for (const path of scripts) {
    const source = await Bun.file(path).text();
    const minified = minifyScript(source);
    expect(() => minifyScript(minified)).not.toThrow();
    const names = [...source.matchAll(/^(?:async )?function (\w+)|^(?:const|let|var|class) (\w+)/gm)].map((m) => m[1] ?? m[2]);
    for (const name of names) expect({ path, declared: new RegExp(`(function|const|let|var|class) ${name}\\b`).test(minified) }).toEqual({ path, declared: true });
    expect({ path, ...counts(minified, words) }).toEqual({ path, ...counts(source, words) });
    expect({ path, twig: TWIG_OPENER.test(minified) }).toEqual({ path, twig: false });
    expect(minified.length).toBeLessThanOrEqual(source.length);
  }
});

test("minified stylesheets keep their placeholders and stay valid Twig text", async () => {
  const minified = await bundleStyles(styles, true);
  const words = await placeholders();
  for (const path of styles) {
    const source = await Bun.file(path).text();
    const out = minified.get(path)!;
    expect({ path, empty: out.trim() === "" }).toEqual({ path, empty: source.trim() === "" });
    expect({ path, ...counts(out, words) }).toEqual({ path, ...counts(source, words) });
    expect({ path, twig: TWIG_OPENER.test(out) }).toEqual({ path, twig: false });
  }
});

test("a stylesheet's @import is inlined at runtime and in the build", async () => {
  expect(DNS_STYLE).not.toContain("@import");
  expect(DNS_STYLE).toContain('.fleet-table tbody tr[aria-selected="true"]');
  for (const [path, text] of await bundleStyles(styles, true)) expect({ path, imports: text.includes("@import") }).toEqual({ path, imports: false });
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
