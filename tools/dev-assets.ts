import { bundleStyles, stylesheetPaths } from "./browser-assets";

// Preloaded by bunfig.toml for `bun run` and `bun test`: stylesheets bundled by
// Bun as in the binary, `@import`s inlined, only not minified.

const styles = await bundleStyles(stylesheetPaths(), false);

Bun.plugin({
  name: "dev-assets",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, ({ path }) => {
      const text = styles.get(path);
      if (text === undefined) throw new Error(`${path} is outside the stylesheets tools/browser-assets.ts bundles`);
      return { exports: { default: text }, loader: "object" };
    });
  },
});
