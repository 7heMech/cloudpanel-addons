// The HTML shell every addon's manager app renders into.
//
// Here rather than in an addon because it is chrome, not content: the palette,
// the table and badge classes, the card and dialog styling. The Instatic addon
// owned all of it while it was the only addon, which meant a second addon's
// choices were either "copy 60 lines of CSS" or "look like a different
// product". An addon supplies its brand, contextual nav, its own script and
// any extra rules; everything else is shared.

import { esc, escJs } from "./app-http";

// Measured against CloudPanel 2.5.1's public demo: dashboard, sites, settings,
// certificates, logs and new-site forms. Keep these rules independent of the
// panel's private templates and versioned CSS bundles.
export const BASE_STYLE = `
:root {
  color-scheme: light;
  --clp-addon-font-family: "Helvetica Neue", "Segoe UI", Helvetica, Arial, sans-serif;
  --bg: #f9fafb; --panel: #fff; --surface: #fbfcfc;
  --border: #e2e2e2; --card-border: #00000020; --row-border: #eaeaea;
  --text: #212529; --heading: #2e2e2e; --muted: #6c757d; --table-heading: #9bacb6;
  --link: #3c3c3c; --accent: #0078d4; --primary: #267ddd; --primary-hover: #2e87eb;
  --header-bg: #fff; --header-link: #aaa; --tab-link: #666;
  --input-bg: #fff; --input-border: #ced4da; --readonly-bg: #e9ecef;
  --button-bg: #fff; --button-text: #777; --button-border: #d3d3d3; --button-hover: #e4e5e6;
  --ok: #23774b; --warn: #936319; --bad: #bc3636;
  --shadow: 0 2px 4px rgb(157 161 164 / 19%);
  --header-shadow: 0 2px 2px rgb(237 237 237 / 50%);
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
html.dark {
  color-scheme: dark;
  --bg: #0e1217; --panel: #1c1f26; --surface: #25282f;
  --border: #a8b3cf33; --card-border: #a8b3cf33; --row-border: #a8b3cf33;
  --text: #fff; --heading: #fff; --muted: #9b9b9b; --table-heading: #9bacb6;
  --link: #fff; --header-bg: #25282f; --header-link: #fff; --tab-link: #9b9b9b;
  --input-bg: #20242c; --input-border: #a8b3cf33; --readonly-bg: #0e1217;
  --button-bg: #21262d; --button-text: #c9d1d9; --button-border: #a8b3cf33; --button-hover: #1c1f26;
  --ok: #81c9a0; --warn: #e5bc76; --bad: #ef9999;
  --shadow: none; --header-shadow: none;
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: flex; flex-direction: column;
  background: var(--bg); color: var(--text); font-family: var(--clp-addon-font-family);
  font-size: 16px; line-height: 1.5; }
button, input, select { font: inherit; }
a { color: var(--link); text-decoration: none; }
a:hover { color: var(--accent); text-decoration: underline; }
h1, h2, h3 { color: var(--heading); line-height: 1.2; font-weight: 600; }
h1 { font-size: 30px; }
h2, h3 { font-size: 18px; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
[hidden] { display: none !important; }
.clp-addon-header { width: 100%; background: var(--header-bg); border-bottom: 1px solid var(--border);
  box-shadow: var(--header-shadow); }
.clp-addon-header-inner { display: flex; align-items: stretch; min-height: 74px; }
/* CloudPanel top-aligns its logo (.header .logo { padding: 20px 0 0 20px }) rather than
   centring it, so centring here sits the logo ~1.5px lower than the panel's own header. */
.clp-addon-brand { flex: 0 0 235px; display: flex; align-items: flex-start; padding: 20px 0 0 20px;
  margin-right: 20px; border-right: 1px solid var(--row-border); }
.clp-addon-logo { display: block; width: 155px; height: 31px; }
.clp-addon-logo-dark { display: none; }
html.dark .clp-addon-logo-light { display: none; }
html.dark .clp-addon-logo-dark { display: block; }
.clp-addon-primary-nav { display: flex; align-items: stretch; gap: 14px; }
.clp-addon-primary-link { display: flex; align-items: center; padding: 0 15px; margin-left: 0;
  color: var(--header-link); font-size: 16px; font-weight: 700; white-space: nowrap; }
.clp-addon-primary-nav .clp-addon-primary-link:first-child { margin-left: 10px; }
.clp-addon-primary-link:hover { color: var(--accent); text-decoration: none; }
.clp-addon-primary-link.is-active { color: var(--text); }
.clp-addon-header-tools { display: flex; margin-left: auto; }
.clp-addon-theme { border: 0; border-left: 1px solid var(--row-border); background: transparent;
  color: var(--header-link); width: 70px; cursor: pointer; display: grid; place-items: center; }
.clp-addon-theme:hover { color: var(--accent); }
.clp-addon-theme svg { width: 20px; height: 20px; }
.clp-addon-theme .sun { display: none; }
html.dark .clp-addon-theme .sun { display: block; }
html.dark .clp-addon-theme .moon { display: none; }
main { width: 100%; max-width: 1200px; margin: 0 auto; padding: 25px 24px 40px; flex: 1; min-width: 0; }
.clp-addon-tabs { display: flex; overflow-x: auto; padding: 0 20px; margin-bottom: 30px;
  background: var(--panel); border: 1px solid var(--border); scrollbar-width: thin; }
.clp-addon-nav-link { flex: 0 0 auto; color: var(--tab-link); padding: 20px 15px 17px;
  border-bottom: 3px solid transparent; white-space: nowrap; }
.clp-addon-nav-link:hover { color: var(--accent); text-decoration: none; }
.clp-addon-nav-link[aria-current="page"] { color: var(--text); border-bottom-color: var(--accent); }
.page-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 20px; }
.page-heading h1 { margin: 0; overflow-wrap: anywhere; }
.page-heading p { margin: 6px 0 0; color: var(--muted); font-size: 14px; }
.page-heading > .btn { flex-shrink: 0; }
.card { min-width: 0; background: var(--panel); border: 1px solid var(--card-border);
  border-radius: 4px; box-shadow: var(--shadow); padding: 25px; margin-bottom: 30px; }
.card-header { display: flex; align-items: center; justify-content: space-between; gap: 16px;
  font-size: 18px; font-weight: 600; line-height: 1.5; margin: -25px -25px 25px; padding: 25px;
  border-bottom: 1px solid var(--border); border-radius: 3px 3px 0 0; }
html.dark .card-header { background: var(--surface); }
.card-header h2 { margin: 0; }
.card-table { padding: 0; overflow-x: auto; }
.card-table > .card-header { margin: 0; }
.table-scroll { overflow-x: auto; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 30px; }
.stat .label { font-size: 18px; font-weight: 500; margin-bottom: 5px; }
.stat .value { font-size: 16px; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 14px; text-transform: uppercase; color: var(--table-heading);
  background: var(--surface); padding: 18px 32px; font-weight: 700; white-space: nowrap; }
td { padding: 18px 32px; border-top: 1px solid var(--row-border); vertical-align: middle; }
td a { color: var(--link); }
td a:hover { color: var(--accent); }
.action-cell { text-align: right; white-space: nowrap; }
.mono { font-family: var(--mono); font-size: 14px; }
.badge { display: inline-block; padding: 3px 7px; border-radius: 4px; font-size: 12px;
  line-height: 1.25; border: 1px solid var(--border); white-space: nowrap; }
.state-running, .state-done { color: var(--ok); border-color: currentColor; }
.state-exited, .state-created, .state-paused { color: var(--warn); border-color: currentColor; }
.state-absent, .state-unknown, .state-failed { color: var(--bad); border-color: currentColor; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; text-align: center;
  background: var(--button-bg); color: var(--button-text); border: 1px solid var(--button-border);
  border-radius: 4px; padding: 8px 20px; font-size: 14px; font-weight: 500; line-height: 1.5; cursor: pointer; }
.btn:hover { background: var(--button-hover); color: var(--button-text); text-decoration: none; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.btn-primary:hover { background: var(--primary-hover); border-color: var(--primary-hover); color: #fff; }
.btn-lg, .page-heading > .btn { min-height: 50px; padding: 8px 30px; }
.page-heading > .btn-primary { text-transform: uppercase; }
.btn-danger { color: var(--bad); border-color: var(--bad); }
.btn-danger:hover { background: var(--bad); color: var(--panel); }
.actions { display: flex; gap: 10px; flex-wrap: wrap; }
.form-actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 30px; }
.form-actions > .btn:only-child { margin-left: auto; }
.form-page { max-width: 770px; margin: 0 auto; }
.form-page > .page-heading { justify-content: center; text-align: center; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
.form-field { min-width: 0; }
.form-field-full { grid-column: 1 / -1; }
label { display: block; margin: 0 0 7px; color: var(--text); font-size: 16px; }
label.required::after { content: " *"; color: var(--accent); }
input:not([type="checkbox"]):not([type="hidden"]), select { width: 100%; background: var(--input-bg); color: var(--text);
  border: 1px solid var(--input-border); border-radius: 4px; padding: 8px 16px; font-size: 16px; min-height: 42px; }
input::placeholder { color: var(--muted); opacity: 1; }
input:read-only:not([type="checkbox"]) { background: var(--readonly-bg); }
input:focus, select:focus { border-color: #86b7fe; box-shadow: 0 0 0 3px rgb(38 125 221 / 15%); outline: 0; }
.check-field { margin-top: 24px; }
.check-label { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; }
input[type="checkbox"] { width: 16px; height: 16px; flex: 0 0 16px; margin: 4px 0 0; accent-color: var(--primary); }
.hint { color: var(--muted); font-size: 14px; margin-top: 5px; overflow-wrap: anywhere; }
p.hint { margin: 0 0 20px; }
.alert, .notice { border: 1px solid currentColor; border-radius: 4px; padding: 15px 20px; margin-bottom: 20px; font-size: 14px; }
.alert { color: var(--bad); background: rgba(248,113,113,0.08); }
.notice { color: var(--warn); background: rgba(251,191,36,0.08); }
.update-banner { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap;
  gap: 12px; color: var(--text); border-color: var(--accent); background: rgba(38,125,221,0.08); }
.update-banner code { overflow-wrap: anywhere; }
.empty { color: var(--muted); padding: 25px; }
.card > .empty { padding: 0; }
.card-table > .empty { padding: 25px; }
dialog { background: var(--panel); color: var(--text); border: 1px solid var(--border);
  border-radius: 5px; padding: 25px; max-width: 720px; width: calc(100% - 32px); max-height: calc(100vh - 40px); overflow: auto; }
dialog::backdrop { background: rgba(0,0,0,0.5); }
.dialog-header { margin: -25px -25px 25px; padding: 20px 25px; border-bottom: 1px solid var(--border); }
.dialog-header h2 { margin: 0; overflow-wrap: anywhere; }
.dialog-actions { justify-content: flex-end; margin: 25px -25px -25px; padding: 20px 25px; border-top: 1px solid var(--border); }
pre { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 16px;
  overflow: auto; max-height: 55vh; font-family: var(--mono); font-size: 13px; }
.row-actions { min-width: 100px; }
.row-actions summary { cursor: pointer; color: var(--link); list-style: none; }
.row-actions summary::-webkit-details-marker { display: none; }
.row-actions summary::after { content: ""; display: inline-block; margin: 0 0 3px 8px;
  border: 4px solid transparent; border-top-color: currentColor; transform: translateY(3px); }
.row-actions summary:hover { color: var(--accent); }
.row-actions[open] summary { margin-bottom: 12px; }
.row-actions .actions { max-width: 280px; justify-content: flex-end; margin-left: auto; }
.row-actions .btn { padding: 5px 10px; }
.site-inventory > summary { cursor: pointer; font-size: 18px; font-weight: 600; }
.site-inventory[open] > summary { margin-bottom: 16px; }
.addon-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 30px; }
.addon-card { display: flex; flex-direction: column; align-items: flex-start; }
.addon-card .card-header { width: calc(100% + 50px); align-self: stretch; }
.addon-card p { color: var(--muted); margin: 0 0 25px; }
.addon-card .btn { margin-top: auto; }
.clp-addon-footer { background: var(--panel); border-top: 1px solid var(--border); padding: 15px 20px;
  display: flex; justify-content: center; gap: 20px; flex-wrap: wrap; color: var(--muted); font-size: 14px; }
.clp-addon-footer a { color: var(--muted); }
@media (max-width: 760px) {
  .clp-addon-header-inner { flex-wrap: wrap; }
  .clp-addon-brand { flex-basis: auto; border: 0; margin: 0; min-height: 64px;
    align-items: center; padding: 0 20px; }
  .clp-addon-header-tools { order: 1; }
  .clp-addon-primary-nav { order: 2; width: 100%; overflow-x: auto; border-top: 1px solid var(--border); padding: 0 5px; gap: 0; }
  .clp-addon-primary-link { min-height: 48px; }
  main { padding: 20px 16px 30px; }
  .clp-addon-tabs { padding: 0 5px; margin-bottom: 24px; }
  .page-heading { flex-wrap: wrap; }
  .page-heading h1 { font-size: 26px; }
  .card { padding: 20px; }
  .card-header { margin: -20px -20px 20px; padding: 20px; }
  .card-table { padding: 0; }
  .addon-card .card-header { width: calc(100% + 40px); }
  .form-grid, .addon-grid { grid-template-columns: minmax(0, 1fr); }
  th, td { padding: 16px 20px; }
  .stats { gap: 20px; }
}
`;

// CloudPanel uses a session cookie named "theme"; absence means light. Read it
// before CSS is painted, so moving between the panel and an addon never flashes
// or silently switches to the operating system's preferred theme.
export const THEME_INIT_JS = `
try {
  document.documentElement.classList.toggle('dark', /(?:^|;\\s*)theme=dark(?:;|$)/.test(document.cookie));
} catch (e) {}
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
function syncTheme() {
  const dark = /(?:^|;\\s*)theme=dark(?:;|$)/.test(document.cookie);
  document.documentElement.classList.toggle('dark', dark);
  const button = document.getElementById('theme-switch');
  if (button) {
    button.setAttribute('aria-pressed', String(dark));
    button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  }
}
function toggleTheme() {
  const dark = !document.documentElement.classList.contains('dark');
  document.cookie = dark ? 'theme=dark; Path=/; SameSite=Lax' : 'theme=; Path=/; Max-Age=0; SameSite=Lax';
  syncTheme();
}
syncTheme();
window.addEventListener('pageshow', syncTheme);
window.addEventListener('focus', syncTheme);

// Use the longest matching route so /new takes precedence over the list tab.
const navLinks = Array.from(document.querySelectorAll('.clp-addon-nav-link'));
const activeLink = navLinks.filter(function (link) {
  const path = new URL(link.href).pathname.replace(/\\/$/, '');
  return location.pathname === path || location.pathname.indexOf(path + '/') === 0;
}).sort(function (a, b) { return b.href.length - a.href.length; })[0];
navLinks.forEach(function (link) {
  if (link === activeLink) link.setAttribute('aria-current', 'page');
  else link.removeAttribute('aria-current');
});

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
  /** Product name for the contextual navigation, e.g. "Instatic". */
  brand: string;
  /** Where this addon is mounted, e.g. "/addons/instatic". */
  base: string;
  /** Contextual tabs for this addon's manager, below the global shell nav. */
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
    ? `      <nav class="clp-addon-tabs" aria-label="${esc(chrome.brand)} navigation">
${contextualNav}
      </nav>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<script>${THEME_INIT_JS}</script>
<style>${BASE_STYLE}${chrome.css ?? ""}</style>
</head>
<body>
<header class="clp-addon-header">
  <div class="clp-addon-header-inner">
    <a class="clp-addon-brand" href="${esc("/")}" aria-label="${esc("CloudPanel home")}">
      <img class="clp-addon-logo clp-addon-logo-light" src="/assets/images/logo.svg" alt="CloudPanel" width="155" height="31">
      <img class="clp-addon-logo clp-addon-logo-dark" src="/assets/images/logo-dark.svg" alt="CloudPanel" width="155" height="31">
    </a>
    <nav class="clp-addon-primary-nav" aria-label="${esc("CloudPanel navigation")}">
${primaryNav}
    </nav>
    <div class="clp-addon-header-tools">
      <button class="clp-addon-theme" id="theme-switch" type="button" onclick="toggleTheme()" aria-label="Switch to dark mode" aria-pressed="false">
        <svg class="moon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.9 13.1A9 9 0 0 1 10.9 3.1 9 9 0 1 0 20.9 13.1Z"/></svg>
        <svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 1v3m0 16v3M1 12h3m16 0h3M4.2 4.2l2.1 2.1m11.4 11.4 2.1 2.1M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>
      </button>
    </div>
  </div>
</header>
<main>${contextualHeader}${chrome.updateNotice ? `  <div class="notice update-banner">
    <div><strong>Update available:</strong> clp-addons <code>v${esc(chrome.updateNotice.latest)}</code> is available (running v${esc(chrome.updateNotice.current)}).</div>
    <code>clp-addons update</code>
  </div>\n` : ""}${content}</main>
<footer class="clp-addon-footer">
  <a href="https://www.cloudpanel.io/blog/" target="_blank" rel="noopener noreferrer">Blog</a>
  <a href="https://www.cloudpanel.io/docs/v2/" target="_blank" rel="noopener noreferrer">Docs</a>
  <a href="https://github.com/7heMech/cloudpanel-addons/issues" target="_blank" rel="noopener noreferrer">Addon issues</a>
  <a href="https://www.cloudpanel.io/" target="_blank" rel="noopener noreferrer">CloudPanel</a>
</footer>
<script>const CLP_BASE = "${escJs(chrome.base)}";
${BASE_CLIENT_JS}${chrome.script}</script>
</body>
</html>`;
}
