import { resolve } from "node:path";
import { ROOT, stylesheetPaths } from "./browser-assets";

// Preloaded by bunfig.toml for `bun run` and `bun test`: a stylesheet is bundled
// by Bun as in the binary, `@import`s inlined, only not minified, when first
// imported. Files a plugin loads are not watched, so the module also imports
// each source it was built from as a file, which `bun --watch` does watch.

let known: Set<string> | undefined;

Bun.plugin({
  name: "dev-assets",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, async ({ path }) => {
      known ??= new Set(stylesheetPaths());
      if (!known.has(path)) throw new Error(`${path} is outside the stylesheets tools/browser-assets.ts bundles`);
      const result = await Bun.build({ entrypoints: [path], root: ROOT, metafile: true, throw: true });
      const sources = Object.keys(result.metafile!.inputs).map((input) => resolve(input));
      const watched = sources.map((source) => `import ${JSON.stringify(`${source}?watch`)} with { type: "file" };\n`).join("");
      return { contents: `${watched}export default ${JSON.stringify(await result.outputs[0]!.text())};`, loader: "js" };
    });
  },
});
