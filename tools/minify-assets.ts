import type { BunPlugin } from "bun";
import { resolve } from "node:path";

// The browser scripts and stylesheets the code imports as text, minified as the
// binary is built. Names are kept: page markup and other scripts call the
// scripts' top-level functions by name.

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

/** Every stylesheet in one pass, by absolute path. */
export async function minifyStyles(paths: string[]): Promise<Map<string, string>> {
  const minified = new Map<string, string>();
  if (!paths.length) return minified;
  const root = process.cwd();
  const result = await Bun.build({ entrypoints: paths, minify: true, root, throw: true });
  for (const output of result.outputs) {
    const path = resolve(root, output.path);
    if (!paths.includes(path)) throw new Error(`no source for ${output.path}`);
    minified.set(path, twigSafe(await Bun.file(path).text(), await output.text()));
  }
  return minified;
}

/**
 * Hands the bundler minified text for every `.client.js` and `.css`. Stylesheets
 * are minified before the build starts, since a build inside a build's loader
 * never finishes.
 */
export async function minifyAssetsPlugin(): Promise<BunPlugin> {
  const styles = await minifyStyles([...new Bun.Glob("{cli,lib,manager,addons}/**/*.css").scanSync({ absolute: true })]);
  return {
    name: "minify-assets",
    setup(build) {
      build.onLoad({ filter: /\.client\.js$/ }, async ({ path }) => ({ contents: minifyScript(await Bun.file(path).text()), loader: "text" }));
      build.onLoad({ filter: /\.css$/ }, ({ path }) => {
        const contents = styles.get(path);
        if (contents === undefined) throw new Error(`${path} was not minified before the build`);
        return { contents, loader: "text" };
      });
    },
  };
}
