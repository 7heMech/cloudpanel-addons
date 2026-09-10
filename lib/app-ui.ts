// The HTML shell every addon's manager app renders into.
//
// Here rather than in an addon because it is chrome, not content: the palette,
// the table and badge classes, the card and dialog styling. The Instatic addon
// owned all of it while it was the only addon, which meant a second addon's
// choices were either "copy 60 lines of CSS" or "look like a different
// product". An addon supplies its brand, contextual nav, its own script and
// any extra rules; everything else is shared.

import { esc, escJs } from "./app-http";

export const BASE_STYLE = `
:root {
  color-scheme: light;
  --clp-addon-font-family: var(--bs-body-font-family, "Helvetica Neue", "Segoe UI", Helvetica, Arial, sans-serif);
  --clp-addon-font-size: var(--bs-body-font-size, 16px);
  --clp-addon-header-height: 75px;
  --clp-addon-header-font-size: var(--bs-body-font-size, 16px);
  --clp-addon-header-font-weight: 700;
  --clp-addon-header-padding: 20px;
  --clp-addon-page-bg: #f9fafb;
  --clp-addon-panel-bg: #ffffff;
  --clp-addon-header-bg: #ffffff;
  --clp-addon-header-border: #e2e2e2;
  --clp-addon-input-bg: #ffffff;
  --clp-addon-border: #e2e2e2;
  --clp-addon-brand-border: #eaeaea;
  --clp-addon-text: #212529;
  --clp-addon-muted: #6c757d;
  --clp-addon-header-link: #aaaaaa;
  --clp-addon-brand-text: #3c3c3c;
  --clp-addon-accent: #0078d4;
  --clp-addon-disabled: #838383;
  --clp-addon-btn-bg: transparent;
  --clp-addon-btn-text: var(--clp-addon-text);
  --clp-addon-header-active-bg: transparent;
  --clp-addon-header-hover-bg: transparent;
  --clp-addon-logo: #0078d4;
  --clp-addon-wordmark-accent: #0078d4;
  --clp-addon-header-shadow: 0 2px 2px 0 hsl(0deg 0% 93% / 50%);
  --on-accent: #fff; --bg: var(--clp-addon-page-bg); --panel: var(--clp-addon-panel-bg);
  --border: var(--clp-addon-border); --text: var(--clp-addon-text); --muted: var(--clp-addon-muted);
  --accent: var(--clp-addon-accent); --ok: #23774b; --warn: #936319; --bad: #bc3636;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --clp-addon-page-bg: var(--clp-bg-primary, #0e1217);
    --clp-addon-panel-bg: var(--clp-bg-secondary, #1c1f26);
    --clp-addon-header-bg: var(--clp-bg-tertiary, #25282f);
    --clp-addon-header-border: #a8b3cf80;
    --clp-addon-input-bg: var(--clp-bg-input, #20242c);
    --clp-addon-border: var(--clp-border-color, #a8b3cf33);
    --clp-addon-text: var(--clp-text, #ffffff);
    --clp-addon-muted: var(--clp-text-secondary, #9b9b9b);
    --clp-addon-accent: var(--clp-text-hover, #0078d4);
    --clp-addon-btn-bg: var(--clp-color-btn-bg, #21262d);
    --clp-addon-btn-text: var(--clp-color-btn-text, #c9d1d9);
    --clp-addon-brand-border: var(--clp-border-color, #a8b3cf33);
    --clp-addon-header-link: var(--clp-text, #ffffff);
    --clp-addon-brand-text: var(--clp-text, #ffffff);
    --clp-addon-header-active-bg: transparent;
    --clp-addon-header-hover-bg: transparent;
    --clp-addon-logo: var(--clp-text-hover, #0078d4);
    --clp-addon-wordmark-accent: #ffffff;
    --clp-addon-header-shadow: none;
    --on-accent: #fff; --bg: var(--clp-addon-page-bg); --panel: var(--clp-addon-panel-bg);
    --border: var(--clp-addon-border); --text: var(--clp-addon-text); --muted: var(--clp-addon-muted);
    --accent: var(--clp-addon-accent); --ok: #81c9a0; --warn: #e5bc76; --bad: #ef9999;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--clp-addon-font-family);
  font-size: var(--clp-addon-font-size); line-height: 1.5; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
h2 { font-size: 1.5rem; letter-spacing: -0.025em; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.clp-addon-header { width: 100%; height: var(--clp-addon-header-height); background: var(--clp-addon-header-bg);
  border-bottom: 1px solid var(--clp-addon-header-border); box-shadow: var(--clp-addon-header-shadow);
  padding: 0; overflow-x: auto; scrollbar-width: thin; }
.clp-addon-header-inner { width: max-content; min-width: 100%; height: 100%; margin: 0;
  display: flex; align-items: stretch; }
.clp-addon-header a { font-family: var(--clp-addon-font-family); font-size: var(--clp-addon-header-font-size); }
.clp-addon-brand { flex: 0 0 235px; min-width: 235px; display: inline-flex; align-items: flex-start;
  height: 100%; margin-right: 20px; padding: 20px 0 0 20px;
  color: var(--clp-addon-brand-text); border-right: 1px solid var(--clp-addon-brand-border);
  white-space: nowrap; }
.clp-addon-brand:hover { color: var(--clp-addon-brand-text); text-decoration: none; }
.clp-addon-logo { display: block; width: 155px; height: 31px; flex: 0 0 155px; }
.clp-addon-logo img { display: block; width: 155px; height: 31px; }
.clp-addon-primary-nav { display: block; flex: 0 0 auto; min-width: max-content;
  height: 100%; line-height: var(--clp-addon-header-height); white-space: nowrap; }
.clp-addon-primary-link { display: inline; height: var(--clp-addon-header-height);
  margin-left: 10px; color: var(--clp-addon-header-link); padding: 0 15px; font-weight: var(--clp-addon-header-font-weight);
  line-height: var(--clp-addon-header-height); white-space: nowrap; }
.clp-addon-primary-link:hover { color: var(--clp-addon-accent); text-decoration: none; }
.clp-addon-primary-link.is-active { color: var(--clp-addon-text); background: var(--clp-addon-header-active-bg);
  font-weight: var(--clp-addon-header-font-weight); }
.clp-addon-context { min-width: 0; margin-left: auto; display: flex; align-items: center; gap: 0.85rem;
  padding: 0 var(--clp-addon-header-padding); }
.clp-addon-context-divider { width: 1px; align-self: stretch; background: var(--clp-addon-border); opacity: 0.7; }
.clp-addon-context nav { display: flex; align-items: center; gap: 0.25rem; min-width: 0; }
.clp-addon-nav-link { color: var(--clp-addon-header-link); padding: 0.45rem 0.65rem; border-radius: 6px; white-space: nowrap; }
.clp-addon-nav-link:hover { color: var(--clp-addon-accent); background: var(--clp-addon-header-hover-bg); text-decoration: none; }
main { max-width: 1080px; margin: 0 auto; padding: 2rem 1.5rem; }
.card { background: var(--panel); border: 1px solid var(--border);
  border-radius: 8px; padding: 1.5rem; margin-bottom: 1.25rem; overflow-x: auto; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; }
.stat .label { color: var(--muted); font-size: 0.75rem; text-transform: uppercase;
  letter-spacing: 0.025em; }
.stat .value { font-size: 1.6rem; font-weight: 600; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.025em;
  color: var(--muted); padding: 0 0.6rem 0.6rem; font-weight: 600; }
td { padding: 0.75rem 0.6rem; border-top: 1px solid var(--border); vertical-align: middle; }
.mono { font-family: var(--mono); font-size: 0.85rem; }
.badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 999px;
  font-size: 0.72rem; font-family: var(--mono); border: 1px solid var(--border); }
.state-running { color: var(--ok); border-color: var(--ok); }
.state-exited, .state-created, .state-paused { color: var(--warn); border-color: var(--warn); }
.state-absent, .state-unknown { color: var(--bad); border-color: var(--bad); }
.btn { background: var(--clp-addon-btn-bg); color: var(--clp-addon-btn-text); border: 1px solid var(--border);
  border-radius: 6px; padding: 0.35rem 0.7rem; font-size: 0.8rem; cursor: pointer; }
.btn:hover { border-color: var(--accent); color: var(--accent); }
.btn:disabled { color: var(--clp-addon-disabled); opacity: 0.5; cursor: not-allowed; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
.btn-primary:hover { color: var(--on-accent); filter: brightness(0.95); text-decoration: none; }
.btn-danger:hover { border-color: var(--bad); color: var(--bad); }
.actions { display: flex; gap: 0.35rem; flex-wrap: wrap; }
label { display: block; margin: 1rem 0 0.35rem; font-size: 0.8rem; color: var(--muted); }
input, select { width: 100%; background: var(--clp-addon-input-bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 6px; padding: 0.55rem 0.7rem; font-size: 0.9rem; }
input:read-only { color: var(--muted); }
.hint { color: var(--muted); font-size: 0.78rem; margin-top: 0.3rem; }
.alert { border: 1px solid var(--bad); color: var(--bad); background: rgba(248,113,113,0.08);
  border-radius: 8px; padding: 0.7rem 0.9rem; margin-bottom: 1rem; font-size: 0.88rem; }
.notice { border: 1px solid var(--warn); color: var(--warn); background: rgba(251,191,36,0.08);
  border-radius: 8px; padding: 0.7rem 0.9rem; margin-bottom: 1rem; font-size: 0.88rem; }
.empty { color: var(--muted); text-align: center; padding: 2rem 0; }
dialog { background: var(--panel); color: var(--text); border: 1px solid var(--border);
  border-radius: 10px; padding: 1.25rem; max-width: 720px; width: 92%; }
dialog::backdrop { background: rgba(3,7,18,0.72); }
pre { background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
  padding: 0.8rem; overflow: auto; max-height: 55vh; font-size: 0.78rem; }
.page-heading { display:flex; align-items:center; justify-content:space-between; gap:1rem; margin-bottom:1.5rem; }
.page-heading h2 { margin:0; }
.page-heading p { margin:0.25rem 0 0; color:var(--muted); font-size:0.88rem; }
.row-actions { min-width:130px; }
.row-actions summary { cursor:pointer; width:fit-content; }
.row-actions[open] summary { margin-bottom:0.6rem; }
@media (max-width: 640px) {
  main { padding: 1rem; }
  .card { padding: 1rem; }
  td, th { min-width: 100px; }
}

`;

/**
 * The client-side helpers every addon page needs: read the CSRF cookie, echo it
 * back on a mutation, and disable the page while one is in flight.
 *
 * Concatenated into the addon's own script, and subject to the same rule: this
 * is a TypeScript template literal, so a backslash written here is consumed
 * once before the browser sees it. Escapes meant for the browser must be
 * doubled, and tools/test-app.ts asserts they were.
 */
export const BASE_CLIENT_JS = `
// The CSRF cookie is readable by this page on purpose; echoing it back in a
// header is what proves the request came from here and not another origin.
function csrf() {
  const m = document.cookie.match(/(?:^|;\\s*)clp_addons_csrf=([^;]+)/);
  return m ? m[1] : '';
}

async function call(path, options) {
  const opts = Object.assign({ headers: {} }, options || {});
  opts.headers = Object.assign({ 'X-CLP-Addons-CSRF': csrf() }, opts.headers);
  // Every addon is served under a path on one hostname, so a bare '/api/...'
  // would reach the router rather than this addon. CLP_BASE is emitted into the
  // page by renderLayout; prefixing here fixes every caller at once.
  const res = await fetch(CLP_BASE + path, opts);
  let body = null;
  try { body = await res.json(); } catch (e) { /* non-JSON error page */ }
  if (!res.ok || !body || body.ok === false) {
    throw new Error((body && body.error) || ('request failed with ' + res.status));
  }
  return body;
}

function busy(on) {
  document.querySelectorAll('button').forEach(function (b) { b.disabled = on; });
  document.body.style.cursor = on ? 'progress' : '';
}
`;

export interface Chrome {
  /** Product name in the header, e.g. "Instatic". */
  brand: string;
  /** Where this addon is mounted, e.g. "/addons/instatic". */
  base: string;
  /** Contextual links for this addon's manager, beside the global shell nav. */
  nav: { href: string; label: string }[];
  /** Rules appended after BASE_STYLE, for anything only this addon draws. */
  css?: string;
  /** The addon's own script. BASE_CLIENT_JS is prepended. */
  script: string;
  /** Optional update notice if a newer clp-addons release is available. */
  updateNotice?: { current: string; latest: string } | null;
}

export function renderLayout(title: string, content: string, chrome: Chrome): string {
  const isAddonsRoute = chrome.base === "/addons" || chrome.base.startsWith("/addons/");
  const primaryNav = [
    { href: "/dashboard", label: "Dashboard", active: false },
    { href: "/", label: "Sites", active: false },
    { href: "/addons/", label: "Addons", title: "All addons", active: isAddonsRoute },
  ]
    .map((n) => {
      const active = n.active ? ' aria-current="page"' : "";
      const titleAttr = n.title ? ` title="${esc(n.title)}"` : "";
      return `      <a class="clp-addon-primary-link${n.active ? " is-active" : ""}" href="${esc(n.href)}"${active}${titleAttr}>${esc(n.label)}</a>`;
    })
    .join("\n");
  const contextualNav = chrome.nav
    .map((n) => `        <a class="clp-addon-nav-link" href="${esc(n.href)}">${esc(n.label)}</a>`)
    .join("\n");
  const contextualHeader = contextualNav
    ? `    <div class="clp-addon-context">
      <span class="clp-addon-context-divider" aria-hidden="true"></span>
      <nav aria-label="${esc(chrome.brand)} navigation">
${contextualNav}
      </nav>
    </div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${BASE_STYLE}${chrome.css ?? ""}</style>
</head>
<body>
<header class="clp-addon-header">
  <div class="clp-addon-header-inner">
    <a class="clp-addon-brand" href="${esc("/")}" aria-label="${esc("CloudPanel home")}">
      <picture class="clp-addon-logo">
        <source media="(prefers-color-scheme: dark)" srcset="/assets/images/logo-dark.svg">
        <img src="/assets/images/logo.svg" alt="CloudPanel" width="155" height="31">
      </picture>
    </a>
    <nav class="clp-addon-primary-nav" aria-label="${esc("CloudPanel navigation")}">
${primaryNav}
    </nav>
${contextualHeader}
  </div>
</header>
<main>${chrome.updateNotice ? `  <div class="notice update-banner" style="display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:1.5rem;background:rgba(59,130,246,0.08);border:1px solid var(--accent);color:var(--text);border-radius:8px;padding:0.75rem 1rem;">
    <div><strong>Update available:</strong> clp-addons <code>v${esc(chrome.updateNotice.latest)}</code> is available (running v${esc(chrome.updateNotice.current)}).</div>
    <div><span class="mono" style="background:var(--panel);padding:0.25rem 0.5rem;border-radius:4px;border:1px solid var(--border);font-size:0.8rem;">clp-addons update</span></div>
  </div>\n` : ""}${content}</main>
<script>const CLP_BASE = "${escJs(chrome.base)}";
${BASE_CLIENT_JS}${chrome.script}</script>
</body>
</html>`;
}
