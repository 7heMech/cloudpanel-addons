import { minifyAssetsPlugin } from "./browser-assets";

// One binary: the CLI and every addon's manager, selected at runtime by
// `clp-addons serve`, sharing one copy of the Bun runtime. recon showed avx2 on
// the target CPU, so the standard glibc x64 target applies, not the baseline.
// VERSION, set by the release workflow, is the version the binary reports.

const version = process.env.VERSION;

await Bun.build({
  entrypoints: ["cli/index.ts"],
  compile: { target: "bun-linux-x64", outfile: "dist/clp-addons-linux-x64" },
  bytecode: true,
  minify: true,
  format: "esm",
  define: version ? { "process.env.CLP_ADDONS_VERSION": JSON.stringify(version) } : {},
  plugins: [await minifyAssetsPlugin()],
  throw: true,
});
