import { mkdirSync, writeFileSync } from "node:fs";
import { minifyAssetsPlugin } from "./browser-assets";
import { CLOUDPANEL_RANGE, CLOUDPANEL_RANGE_ASSET } from "../lib/cloudpanel-version";
import { CLI_ARTIFACT } from "../lib/paths";

// aot compiles only for the platform the build runs on, so this builds for the
// host and releases build each architecture on its own runner. recon showed
// avx2 on the x64 target CPU, so the standard glibc x64 target applies, not
// the baseline.
// VERSION, set by the release workflow, is the version the binary reports.

const version = process.env.VERSION;
const TARGETS = { x64: "bun-linux-x64", arm64: "bun-linux-arm64" } as const;
const target = TARGETS[process.arch as keyof typeof TARGETS];

await Bun.build({
  entrypoints: ["cli/index.ts"],
  compile: {
    target,
    outfile: `dist/${CLI_ARTIFACT}`,
    aot: true,
    trim: true,
    functionSource: false,
  },
  minify: true,
  format: "esm",
  define: version ? { "process.env.CLP_ADDONS_VERSION": JSON.stringify(version) } : {},
  plugins: [await minifyAssetsPlugin()],
  throw: true,
});

// The CloudPanel versions this release supports, published beside the binary
// so `clp-addons update` can warn about a release before downloading it.
mkdirSync("dist", { recursive: true });
writeFileSync(`dist/${CLOUDPANEL_RANGE_ASSET}`, `${JSON.stringify(CLOUDPANEL_RANGE)}\n`);
