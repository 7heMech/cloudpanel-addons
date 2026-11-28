// Writes the project's landing page, served at https://clp.7he.dev/, from
// the addon catalog, the supported CloudPanel range and the repository name, so
// the page lists what the code ships.
//
//   bun run site [--out <dir>]    (default dist/site)
//
// It also writes dist/usage-allowlist.json, the addon and action names the
// Worker accepts in a usage report.
//
// The screenshots are docs/screenshots/site/*.png: `bun run preview:shot` pages,
// cropped below the panel header so CloudPanel's logo is not on the page.
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADDONS, ADDON_NAMES } from "../addons/catalog";
import { CLOUDPANEL_RANGE, describeRange } from "../lib/cloudpanel-version";
import { REPO } from "../lib/paths";
import { countedActions } from "../lib/usage-actions";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const outFlag = process.argv.indexOf("--out");
const out = outFlag > 0 ? process.argv[outFlag + 1]! : join(repo, "dist/site");
const shots = join(repo, "docs/screenshots/site");

const GITHUB = `https://github.com/${REPO}`;
const INSTALL = "curl -fsSL https://clp.7he.dev/install.sh | bash";
const NETCUP_CODE = "36nc17643227740";

const esc = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function docsUrl(docs: string): string {
  if (/^https?:\/\//.test(docs)) return docs;
  if (!existsSync(join(repo, docs))) throw new Error(`addon docs ${docs} does not exist`);
  return `${GITHUB}/blob/main/${docs}`;
}

const archNames: Record<string, string> = { x64: "x86-64", arm64: "64-bit Arm" };

const addonRows = ADDON_NAMES.map((name) => {
  const addon = ADDONS[name]!;
  const title = addon.docs ? `<a href="${esc(docsUrl(addon.docs))}">${esc(addon.title)}</a>` : esc(addon.title);
  const only = addon.supportedArches ? ` <small>${addon.supportedArches.map((arch) => archNames[arch] ?? arch).join(", ")} only</small>` : "";
  return `      <li><b>${title}</b>${only} <span>${esc(addon.description)}</span></li>`;
}).join("\n");

const figures: { file: string; width: number; height: number; caption: string }[] = [
  { file: "hardening.png", width: 1200, height: 910, caption: "System Tweaks: each fix to CloudPanel has a switch and says whether it holds on this server." },
  { file: "firewall.png", width: 1280, height: 870, caption: "Firewall: Cloudflare only for every site, and for each new one." },
  { file: "netcup.png", width: 1200, height: 450, caption: "Firewall on a netcup server: netcup's own firewall admits only Cloudflare." },
  { file: "addons.png", width: 1280, height: 900, caption: "The Addons tab: switch each addon on or off." },
];

const figureHtml = figures.map((figure) => `      <figure>
        <img src="img/${figure.file}" width="${figure.width}" height="${figure.height}" loading="lazy" alt="${esc(figure.caption)}">
        <figcaption>${esc(figure.caption)}</figcaption>
      </figure>`).join("\n");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Addons for CloudPanel | 7he.dev</title>
<meta name="description" content="Unofficial, open-source security fixes and extra features for CloudPanel ${esc(describeRange(CLOUDPANEL_RANGE))}, installed with one command.">
<link rel="canonical" href="https://clp.7he.dev/">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#141110">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  @font-face {
    font-family: "Kudryashev Display";
    src: url("https://cdn.ren.ss/fonts/Kudryashev%20Display%20Contr%20Sans.otf?v=bb281d41") format("opentype");
    font-display: swap;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --page: #141110; --ink: #f3ece4; --muted: #a89c92; --line: #342c27;
    --coral: #e2624a; --panel: #1c1714;
    --display: "Kudryashev Display", "Onest", system-ui, sans-serif;
    --pad: clamp(16px, 4vw, 56px);
  }
  html { background: var(--page); -webkit-text-size-adjust: 100%; }
  body { color: var(--ink); font-family: "Onest", system-ui, sans-serif; font-size: 1.0625rem; line-height: 1.55; -webkit-font-smoothing: antialiased; }
  a { color: var(--ink); text-decoration: underline 1px var(--coral); text-underline-offset: 0.2em; }
  a:hover { text-decoration-thickness: 2px; }
  a:focus-visible, button:focus-visible { outline: 2px solid var(--ink); outline-offset: 4px; border-radius: 2px; }
  .wrap { max-width: 960px; margin: 0 auto; padding: 0 var(--pad); }
  header.bar { display: flex; justify-content: space-between; align-items: baseline; padding: 28px 0; }
  header.bar ul { display: flex; gap: 24px; list-style: none; }
  .wordmark { font-family: var(--display); font-size: 1.4rem; text-decoration: none; }
  h1, h2 { font-family: var(--display); font-weight: 400; line-height: 1.1; }
  h1 { font-size: clamp(2.4rem, 7vw, 4.2rem); margin: 48px 0 20px; }
  h2 { font-size: clamp(1.7rem, 4vw, 2.3rem); margin: 72px 0 20px; }
  p + p { margin-top: 12px; }
  .lead { font-size: 1.2rem; max-width: 40em; }
  .nb { white-space: nowrap; }
  .muted, small, figcaption { color: var(--muted); }
  ul.fixes { list-style: none; margin-top: 24px; display: grid; gap: 10px; }
  ul.fixes li { padding-left: 22px; position: relative; max-width: 44em; }
  ul.fixes li::before { content: ""; position: absolute; left: 0; top: 0.6em; width: 8px; height: 8px; border-radius: 50%; background: var(--coral); }
  .install { display: flex; gap: 8px; align-items: stretch; margin: 16px 0 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
  .install code { flex: 1; padding: 14px 16px; overflow-wrap: anywhere; font: 0.95rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .install button { flex: none; background: none; color: var(--ink); border: 0; border-left: 1px solid var(--line); padding: 0 16px; font: inherit; font-size: 0.9rem; cursor: pointer; }
  .install button:hover { color: var(--coral); }
  .shots { display: grid; gap: 40px; }
  figure img { display: block; width: 100%; height: auto; border-radius: 8px; border: 1px solid var(--line); }
  figcaption { margin-top: 10px; font-size: 0.95rem; }
  ul.addons { list-style: none; border-top: 1px solid var(--line); }
  ul.addons li { padding: 14px 0; border-bottom: 1px solid var(--line); }
  ul.addons b { font-weight: 600; margin-right: 6px; }
  ul.addons span { color: var(--muted); }
  footer { margin: 96px 0 48px; padding-top: 24px; border-top: 1px solid var(--line); display: grid; gap: 12px; font-size: 0.95rem; }
  footer .links { display: flex; flex-wrap: wrap; gap: 24px; }
  @media (max-width: 560px) { .install { flex-direction: column; } .install button { border-left: 0; border-top: 1px solid var(--line); padding: 10px; } }
</style>
</head>
<body>
<div class="wrap">
  <header class="bar">
    <a href="https://7he.dev/" class="wordmark">7he.dev</a>
    <ul>
      <li><a href="${GITHUB}" rel="noopener noreferrer">GitHub</a></li>
      <li><a href="https://7he.dev/blog/">Blog</a></li>
    </ul>
  </header>

  <main>
    <h1>Addons for CloudPanel</h1>
    <p class="lead">CloudPanel lets a panel account or a site's own Unix user reach root in more than one way. The System Tweaks addon closes the ones below, Firewall locks the server to Cloudflare, and ${ADDON_NAMES.length - 2} more addons add what the panel leaves out. They are unofficial and open source.</p>
    <ul class="fixes">
      <li>Panel accounts can no longer write nginx config through site settings, which covers the <a href="https://seclists.org/fulldisclosure/2026/Oct/14">CloudPanel 2.5.4-3 disclosure</a> and <span class="nb">CVE-2024-44765</span>.</li>
      <li>A site's Unix user can no longer reach root through CloudPanel's <code>clpctl</code> sudo wrapper.</li>
      <li>The File Manager, which runs as root, stays inside the site's home, and its writes run as the site's user.</li>
      <li>The panel gets its own certificate instead of the key every CloudPanel install shares (<span class="nb">CVE-2023-0391</span>).</li>
      <li>fail2ban blocks password guessing on the panel, and on SSH if you switch it on.</li>
      <li>Visitors can no longer forge their IP with <code>X-Real-IP</code> or <code>CF-Connecting-IP</code>.</li>
      <li>Firewall can admit only Cloudflare to the sites and the panel, in nginx and in a Hetzner or netcup firewall, and put Cloudflare Access in front of the panel.</li>
      <li>CloudPanel's daily upload of every domain and panel user's email stops.</li>
    </ul>
    <p class="muted" style="margin-top:20px">Each fix, its limits and what CloudPanel still has to fix itself: <a href="${GITHUB}/blob/main/SECURITY.md">security model and hardening</a>.</p>

    <h2>Install</h2>
    <p>Log in to a CloudPanel ${esc(describeRange(CLOUDPANEL_RANGE))} server as root and run:</p>
    <div class="install"><code id="install">${esc(INSTALL)}</code><button type="button" data-copy="install">Copy</button></div>
    <p class="muted">The installer checks the download's SHA-256 checksum, and updates also check GitHub's build provenance. Then open the new Addons tab in CloudPanel and switch on the addons you want. <a href="${GITHUB}#install">Requirements</a>.</p>

    <h2>What it looks like</h2>
    <div class="shots">
${figureHtml}
    </div>
    <p class="muted" style="margin-top:16px">Screenshots use made-up sites.</p>

    <h2>Addons</h2>
    <ul class="addons">
${addonRows}
    </ul>
  </main>

  <footer>
    <div class="links">
      <a href="${GITHUB}" rel="noopener noreferrer">Source on GitHub</a>
      <a href="${GITHUB}/releases" rel="noopener noreferrer">Releases</a>
      <a href="https://7he.dev/blog/">Blog</a>
    </div>
    <p>I run these addons on a netcup server. If you sign up at netcup, code <code>${NETCUP_CODE}</code> takes €5 off, and I get a credit.</p>
    <p class="muted">Unofficial. Not affiliated with or endorsed by CloudPanel. Apache-2.0.</p>
  </footer>
</div>
<script>
  for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(document.getElementById(button.dataset.copy).textContent);
        button.textContent = "Copied";
      } catch { button.textContent = "Select and copy"; }
      setTimeout(() => { button.textContent = "Copy"; }, 2000);
    });
  }
</script>
</body>
</html>
`;

mkdirSync(join(out, "img"), { recursive: true });
writeFileSync(join(out, "index.html"), html);
for (const figure of figures) if (!existsSync(join(shots, figure.file))) throw new Error(`missing screenshot ${figure.file}`);
for (const file of readdirSync(shots)) copyFileSync(join(shots, file), join(out, "img", file));
// The names worker/main.ts bundles: a report may carry only these.
writeFileSync(join(repo, "dist/usage-allowlist.json"), `${JSON.stringify({ addons: [...ADDON_NAMES], actions: countedActions() }, null, 2)}\n`);
console.log(join(out, "index.html"));
