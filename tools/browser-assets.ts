import type { BunPlugin } from "bun";
import { resolve } from "node:path";

// The browser scripts and stylesheets the code imports as text. A stylesheet's
// `@import`s are inlined everywhere; the binary's build also minifies both.
// Script names are kept: page markup and other scripts call the scripts'
// top-level functions by name.

const ROOT = resolve(import.meta.dir, "..");
const transpiler = new Bun.Transpiler({ loader: "js", minifyWhitespace: true });

/** Most of these land in CloudPanel's Twig templates, where `{{`, `{%` and `{#` open a tag. */
const TWIG_OPENER = /\{(?=[{%#])/;

/**
 * Minifying only joins code, so in a source without Twig openers every one in the
 * output is between tokens, where a space changes nothing. A source with one keeps
 * its text as written.
 */
export function twigSafe(source: string, minified: string): string {
  if (TWIG_OPENER.test(source)) return source;
  return minified.replace(new RegExp(TWIG_OPENER, "g"), "{ ");
}

export function minifyScript(source: string): string {
  return twigSafe(source, transpiler.transformSync(source));
}

export function stylesheetPaths(): string[] {
  return [...new Bun.Glob("{cli,lib,manager,addons}/**/*.css").scanSync({ cwd: ROOT, absolute: true })];
}

/** Every stylesheet bundled by Bun, by absolute path, in one pass. */
export async function bundleStyles(paths: string[], minify: boolean): Promise<Map<string, string>> {
  const bundled = new Map<string, string>();
  if (!paths.length) return bundled;
  const result = await Bun.build({ entrypoints: paths, minify, root: ROOT, throw: true });
  for (const output of result.outputs) {
    const path = resolve(ROOT, output.path);
    if (!paths.includes(path)) throw new Error(`no source for ${output.path}`);
    const text = await output.text();
    bundled.set(path, minify ? twigSafe(await Bun.file(path).text(), text) : text);
  }
  return bundled;
}

/**
 * The binary's build: every `.client.js` minified and every `.css` bundled and
 * minified. Stylesheets are done before the build starts, since a build inside a
 * build's loader never finishes.
 */
export async function minifyAssetsPlugin(): Promise<BunPlugin> {
  const styles = await bundleStyles(stylesheetPaths(), true);
  return {
    name: "minify-assets",
    setup(build) {
      build.onLoad({ filter: /\.client\.js$/ }, async ({ path }) => ({ contents: minifyScript(await Bun.file(path).text()), loader: "text" }));
      build.onLoad({ filter: /\.css$/ }, ({ path }) => {
        const contents = styles.get(path);
        if (contents === undefined) throw new Error(`${path} was not bundled before the build`);
        return { contents, loader: "text" };
      });
    },
  };
}
