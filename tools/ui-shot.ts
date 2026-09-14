// Screenshots pages of the local UI preview (tools/preview-ui.ts) to PNG files so
// a change can be reviewed visually. Starts the preview server if it is not
// already running, and bootstraps a headless Chromium plus its shared libraries
// into ~/.cache on first run (no root required).
//
//   bun tools/ui-shot.ts /addons/ /addons/stager/ 'https://host:8443/addons/'
//
// Paths are resolved against the preview server; absolute URLs are used as given.
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Glob } from "bun";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 4100);
const outDir = process.env.OUT || "/tmp/clp-addons-ui";
const windowSize = process.env.SIZE || "1280,900";
const libDir = join(homedir(), ".cache/clp-addons/chrome-libs");
const previewUrl = `http://127.0.0.1:${port}/addons/`;

// Chromium's runtime libraries are missing on the machines this runs on and sudo
// needs a password, so the packages are unpacked into a private directory.
const runtimePackages = [
  "libasound2t64", "libatk1.0-0t64", "libatk-bridge2.0-0t64", "libatspi2.0-0t64",
  "libgbm1", "libnspr4", "libnss3", "libxcomposite1", "libxdamage1", "libxext6",
  "libxfixes3", "libxi6", "libxrandr2", "libxrender1", "libdrm2",
  "libwayland-server0", "libxshmfence1",
];

async function run(cmd: string[], options: { cwd?: string; quiet?: boolean } = {}): Promise<string> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: options.quiet ? "pipe" : "inherit",
    env: { ...process.env, LD_LIBRARY_PATH: libDir },
  });
  const stdout = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`${cmd[0]} failed: ${cmd.join(" ")}`);
  return stdout;
}

let sandboxless = false;

async function screenshot(chrome: string, url: string, file: string): Promise<void> {
  const args = ["--hide-scrollbars", `--window-size=${windowSize}`, `--screenshot=${file}`, url];
  const attempt = (extra: string[]) => run([chrome, ...extra, ...args], { quiet: true });
  if (sandboxless) return void (await attempt(["--no-sandbox"]));
  try {
    await attempt([]);
  } catch {
    // Distributions that restrict unprivileged user namespaces leave Chromium
    // with no usable sandbox. Only render pages you trust in that case.
    console.error("warning: Chromium has no usable sandbox here; rendering without it");
    sandboxless = true;
    await attempt(["--no-sandbox"]);
  }
}

function findChrome(): string | null {
  const pattern = ".cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell";
  const matches = [...new Glob(pattern).scanSync({ cwd: homedir(), absolute: true })].sort();
  return matches.at(-1) ?? null;
}

async function chromeBinary(): Promise<string> {
  const existing = findChrome();
  if (existing) return existing;
  await run(["bunx", "playwright", "install", "chromium-headless-shell"]);
  const installed = findChrome();
  if (!installed) throw new Error("no headless chromium found after installing it");
  return installed;
}

async function ensureRuntimeLibraries(chrome: string): Promise<void> {
  const linked = await run(["ldd", chrome], { quiet: true }).catch(() => "");
  if (!linked.includes("not found")) return;
  const temp = mkdtempSync("/tmp/clp-addons-chrome-libs-");
  try {
    mkdirSync(libDir, { recursive: true });
    await run(["apt-get", "download", ...runtimePackages], { cwd: temp });
    for (const deb of readdirSync(temp).filter((name) => name.endsWith(".deb"))) {
      await run(["dpkg-deb", "-x", join(temp, deb), join(temp, "unpacked")]);
    }
    // The soname entries are symlinks, which the loader needs as much as the
    // real files, so copy directory entries rather than globbing for files.
    for (const entry of readdirSync(join(temp, "unpacked"), { recursive: true, withFileTypes: true })) {
      if (!entry.name.includes(".so")) continue;
      const source = join(entry.parentPath, entry.name);
      const destination = join(libDir, entry.name);
      rmSync(destination, { force: true });
      // Soname symlinks point at a sibling, so relink by basename; copying them
      // would leave a link into the temporary unpack directory.
      if (entry.isSymbolicLink()) symlinkSync(basename(readlinkSync(source)), destination);
      else cpSync(source, destination);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function previewIsUp(): Promise<boolean> {
  return await fetch(previewUrl).then((r) => r.ok).catch(() => false);
}

async function ensurePreview(): Promise<void> {
  if (await previewIsUp()) return;
  Bun.spawn(["bun", join(repo, "tools/preview-ui.ts")], {
    env: { ...process.env, PORT: String(port) },
    stdout: "ignore",
    stderr: "ignore",
    // Outlive this process so the next run reuses the same server.
    stdin: "ignore",
  }).unref();
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await previewIsUp()) return;
    await Bun.sleep(250);
  }
  throw new Error(`the UI preview did not start on port ${port}`);
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("usage: bun tools/ui-shot.ts <path-or-url>...");
  process.exit(1);
}

const chrome = await chromeBinary();
await ensureRuntimeLibraries(chrome);
if (targets.some((target) => !/^https?:\/\//.test(target))) await ensurePreview();
mkdirSync(outDir, { recursive: true });

const taken = new Set<string>();
for (const target of targets) {
  const url = /^https?:\/\//.test(target) ? target : `http://127.0.0.1:${port}${target}`;
  // Two targets can normalize to the same name (`/a/b` and `/a?b`), so number
  // the repeats rather than overwriting the earlier screenshot.
  const name = target.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page";
  let unique = name;
  for (let n = 2; taken.has(unique); n++) unique = `${name}-${n}`;
  taken.add(unique);
  const file = join(outDir, `${unique}.png`);
  await screenshot(chrome, url, file);
  console.log(file);
}
