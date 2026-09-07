// The HTML shell every addon's manager app renders into.
//
// Here rather than in an addon because it is chrome, not content: the palette,
// the table and badge classes, the card and dialog styling. The Instatic addon
// owned all of it while it was the only addon, which meant a second addon's
// choices were either "copy 60 lines of CSS" or "look like a different
// product". An addon supplies its brand, its nav, its own script and any extra
// rules; everything else is shared.

import { esc } from "./app-http";

export const BASE_STYLE = `
:root {
  --bg: #0b1120; --panel: #131c2e; --border: #24314b; --text: #e6ecf7;
  --muted: #8fa0bf; --accent: #38bdf8; --ok: #34d399; --warn: #fbbf24; --bad: #f87171;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: var(--accent); }
header { border-bottom: 1px solid var(--border); padding: 1rem 1.5rem;
  display: flex; align-items: center; gap: 1rem; }
header h1 { font-size: 1.05rem; margin: 0; font-weight: 600; }
header .spacer { flex: 1; }
main { max-width: 1080px; margin: 0 auto; padding: 1.5rem; }
.card { background: var(--panel); border: 1px solid var(--border);
  border-radius: 10px; padding: 1.25rem; margin-bottom: 1.25rem; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; }
.stat .label { color: var(--muted); font-size: 0.75rem; text-transform: uppercase;
  letter-spacing: 0.06em; }
.stat .value { font-size: 1.6rem; font-weight: 600; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--muted); padding: 0 0.6rem 0.6rem; font-weight: 600; }
td { padding: 0.75rem 0.6rem; border-top: 1px solid var(--border); vertical-align: middle; }
.mono { font-family: var(--mono); font-size: 0.85rem; }
.badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 999px;
  font-size: 0.72rem; font-family: var(--mono); border: 1px solid var(--border); }
.state-running { color: var(--ok); border-color: var(--ok); }
.state-exited, .state-created, .state-paused { color: var(--warn); border-color: var(--warn); }
.state-absent, .state-unknown { color: var(--bad); border-color: var(--bad); }
.btn { background: transparent; color: var(--text); border: 1px solid var(--border);
  border-radius: 6px; padding: 0.35rem 0.7rem; font-size: 0.8rem; cursor: pointer; }
.btn:hover { border-color: var(--accent); color: var(--accent); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: #06121f; font-weight: 600; }
.btn-danger:hover { border-color: var(--bad); color: var(--bad); }
.actions { display: flex; gap: 0.35rem; flex-wrap: wrap; }
label { display: block; margin: 1rem 0 0.35rem; font-size: 0.8rem; color: var(--muted); }
input, select { width: 100%; background: #0d1526; color: var(--text);
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
pre { background: #05090f; border: 1px solid var(--border); border-radius: 6px;
  padding: 0.8rem; overflow: auto; max-height: 55vh; font-size: 0.78rem; }
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
  const res = await fetch(path, opts);
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
  nav: { href: string; label: string }[];
  /** Rules appended after BASE_STYLE, for anything only this addon draws. */
  css?: string;
  /** The addon's own script. BASE_CLIENT_JS is prepended. */
  script: string;
}

export function renderLayout(title: string, content: string, chrome: Chrome): string {
  const nav = chrome.nav
    .map((n) => `  <a href="${esc(n.href)}">${esc(n.label)}</a>`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${BASE_STYLE}${chrome.css ?? ""}</style>
</head>
<body>
<header>
  <h1>${esc(chrome.brand)}</h1>
  <span class="spacer"></span>
${nav}
</header>
<main>${content}</main>
<script>${BASE_CLIENT_JS}${chrome.script}</script>
</body>
</html>`;
}
