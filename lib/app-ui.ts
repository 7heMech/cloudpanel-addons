// The HTML shell every addon's manager app renders into.
//
// Here rather than in an addon because it is chrome, not content: the palette,
// the table and badge classes, the card and dialog styling. The Instatic addon
// owned all of it while it was the only addon, which meant a second addon's
// choices were either "copy 60 lines of CSS" or "look like a different
// product". An addon supplies its brand, contextual nav, its own script and
// any extra rules; everything else is shared.

import { esc, escJs } from "./app-http";
import { shadowStyle, type EmbedFragment } from "./shadow-embed";
import { SITE_CONTEXT_STYLE, siteInfoHtml, siteTabs, type SiteContext } from "./site-context";
import { UPDATE_STYLE, updateNoticeHtml } from "./update-ui";

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
button, input, select, textarea { font: inherit; }
a { color: var(--link); text-decoration: none; }
a:hover { color: var(--accent); text-decoration: underline; }
h1, h2, h3 { color: var(--heading); line-height: 1.2; font-weight: 600; }
h1 { font-size: 30px; }
h2, h3 { font-size: 18px; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
[hidden] { display: none !important; }
.clp-addon-header { width: 100%; background: var(--header-bg); border-bottom: 1px solid var(--border);
  box-shadow: var(--header-shadow); }
.clp-addon-header-inner { display: flex; flex-wrap: wrap; align-items: stretch; min-height: 74px; }
/* CloudPanel top-aligns its logo (.header .logo { padding: 20px 0 0 20px }) rather than
   centring it, so centring here sits the logo ~1.5px lower than the panel's own header. */
.clp-addon-brand { flex: 0 0 235px; display: flex; align-items: flex-start; padding: 20px 0 0 20px;
  margin-right: 20px; border-right: 1px solid var(--row-border); }
.clp-addon-logo { display: block; width: 155px; height: 31px; }
.clp-addon-logo-dark { display: none; }
html.dark .clp-addon-logo-light { display: none; }
html.dark .clp-addon-logo-dark { display: block; }
.clp-addon-primary-nav { display: flex; flex-shrink: 0; align-items: stretch; gap: 14px; }
.clp-addon-primary-link { display: flex; align-items: center; padding: 0 15px; margin-left: 0;
  color: var(--header-link); font-size: 16px; font-weight: 700; white-space: nowrap; }
.clp-addon-primary-nav .clp-addon-primary-link:first-child { margin-left: 10px; }
.clp-addon-primary-link:hover { color: var(--accent); text-decoration: none; }
.clp-addon-primary-link.is-active { color: var(--text); }
.clp-addon-header-tools { display: flex; margin-left: auto; }
.clp-addon-header-inner > #clp-addons-update-notice { margin: 0 20px 0 auto; }
.clp-addon-header-inner > #clp-addons-update-notice + .clp-addon-header-tools { margin-left: 0; }
.clp-addon-theme { border: 0; border-left: 1px solid var(--row-border); background: transparent;
  color: var(--header-link); width: 70px; cursor: pointer; display: grid; place-items: center; }
.clp-addon-theme:hover { color: var(--accent); }
.clp-addon-theme svg { width: 20px; height: 20px; }
.clp-addon-theme .sun { display: none; }
html.dark .clp-addon-theme .sun { display: block; }
html.dark .clp-addon-theme .moon { display: none; }
main { width: 100%; max-width: 1200px; margin: 0 auto; padding: 25px 12px 40px; flex: 1; min-width: 0; }
/* The strip scrolls when the tabs outgrow it, but never shows a bar: overflow-x
   alone also turns overflow-y into auto, and a 16px overflow at desktop width
   drew a scrollbar that ate 10px of the strip's height. The active tab is
   revealed on load and focus reveals the rest, so nothing becomes unreachable. */
.clp-addon-tabs { display: flex; overflow-x: auto; overflow-y: hidden; padding: 0 20px;
  margin-bottom: 30px; background: var(--panel); border: 1px solid var(--border);
  scrollbar-width: none; }
.clp-addon-tabs::-webkit-scrollbar { display: none; }
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
.card-table > .card-header { margin: 0; padding: 25px 32px; }
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
.site-select { width: 42px; text-align: center; }
.site-select input { width: 18px; height: 18px; margin: 0; accent-color: var(--primary); }
.site-cell { font-weight: 600; overflow-wrap: anywhere; }
.site-cell a, .site-cell .hint { overflow-wrap: anywhere; font-weight: 400; }
.site-cell a { font-weight: 600; }
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
input:not([type="checkbox"]):not([type="hidden"]), select, textarea { width: 100%; background: var(--input-bg); color: var(--text);
  border: 1px solid var(--input-border); border-radius: 4px; padding: 8px 16px; font-size: 16px; min-height: 42px; }
select {
  appearance: none; -webkit-appearance: none; -moz-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2716%27 height=%2716%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%2394a3b8%27 stroke-width=%272%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Cpath d=%27m6 9 6 6 6-6%27/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 14px center;
  background-size: 16px 16px; padding-right: 40px; cursor: pointer;
}
input::placeholder, textarea::placeholder { color: var(--muted); opacity: 1; }
input:read-only:not([type="checkbox"]) { background: var(--readonly-bg); }
input:focus, select:focus, textarea:focus { border-color: #86b7fe; box-shadow: 0 0 0 3px rgb(38 125 221 / 15%); outline: 0; }
.check-field { margin-top: 24px; }
.check-label { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; }
input[type="checkbox"] { width: 16px; height: 16px; flex: 0 0 16px; margin: 4px 0 0; accent-color: var(--primary); }
.hint { color: var(--muted); font-size: 14px; font-weight: 400; margin-top: 5px; overflow-wrap: anywhere; }
p.hint { margin: 0 0 20px; }
.alert, .notice { border: 1px solid currentColor; border-radius: 4px; padding: 15px 20px; margin-bottom: 20px; font-size: 14px; }
.alert { color: var(--bad); background: rgba(248,113,113,0.08); }
.notice { color: var(--warn); background: rgba(251,191,36,0.08); }
.empty { color: var(--muted); padding: 25px; }
.card > .empty { padding: 0; }
.card-table > .empty { padding: 25px; }
dialog { background: var(--panel); color: var(--text); border: 1px solid var(--border);
  border-radius: 5px; padding: 30px; max-width: 720px; width: calc(100% - 32px); max-height: calc(100vh - 40px); overflow: auto; }
/* The visual viewport, so a phone's collapsing address bar cannot push the
   buttons under it. Ignored where dvh is unknown, which leaves the line above. */
dialog { max-height: calc(100dvh - 40px); }
dialog::backdrop { background: rgba(0,0,0,0.5); }
.dialog-header { margin: -30px -30px 25px; padding: 25px 30px; border-bottom: 1px solid var(--border); }
.dialog-header h2 { margin: 0; overflow-wrap: anywhere; }
.dialog-actions { justify-content: flex-end; margin: 25px -30px -30px; padding: 25px 30px; border-top: 1px solid var(--border); }
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
/* The on/off control every addon uses. The checkbox keeps its role, its label
   and the keyboard; the span is only paint, so focus and state stay real. */
.switch { position: relative; display: inline-flex; width: 50px; height: 28px; margin: 0; flex: none; }
.switch input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
.switch span { width: 100%; border-radius: 99px; background: var(--border); transition: background-color .15s; pointer-events: none; }
.switch span::after { content: ""; display: block; width: 22px; height: 22px; margin: 3px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 4px rgb(0 0 0 / 25%); transition: transform .15s; }
.switch input:checked + span { background: var(--primary); }
.switch input:checked + span::after { transform: translateX(22px); }
.switch input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 3px; }
.switch input:disabled { cursor: not-allowed; }
.switch input:disabled + span { opacity: .5; }
/* For a switch whose "on" state is the disruptive one, such as maintenance. */
.switch-danger input:checked + span { background: var(--bad); }
/* Both are labels, so both inherit the gap a field label leaves above its
   input. Nothing sits under a switch, and that margin is what pushes it off
   the centre line of the buttons or cell text it is aligned with. */
.switch-field { display: inline-flex; align-items: center; gap: 10px; margin: 0; font-size: 14px; font-weight: 600; }
.switch-field .switch-state { min-width: 26px; }
.switch-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.toolbar .toolbar-end { margin-left: auto; }
.toolbar-note { color: var(--muted); font-size: 14px; font-weight: 400; }
.alert-ok { color: var(--ok); background: rgb(35 119 75 / 8%); }
#clp-flash { margin-bottom: 20px; }
#clp-confirm-details { margin: 12px 0 0; padding-left: 20px; color: var(--muted); font-size: 14px; }
#clp-confirm-text { margin: 0; overflow-wrap: anywhere; }
@media (max-width: 1100px) {
  .clp-addon-header-inner > #clp-addons-update-notice { order: 3; flex: 1 0 100%; margin: 0;
    padding: 10px 20px; justify-content: flex-end; border-top: 1px solid var(--border); }
  .clp-addon-header-inner > #clp-addons-update-notice + .clp-addon-header-tools { margin-left: auto; }
}
@media (max-width: 760px) {
  .clp-addon-header-inner { flex-wrap: wrap; }
  .clp-addon-brand { flex-basis: auto; border: 0; margin: 0; min-height: 64px;
    align-items: center; padding: 0 20px; }
  .clp-addon-header-tools { order: 1; }
  .clp-addon-primary-nav { order: 2; width: 100%; overflow-x: auto; border-top: 1px solid var(--border); padding: 0 5px; gap: 0; }
  .clp-addon-primary-link { min-height: 48px; }
  .clp-addon-header-inner > #clp-addons-update-notice { justify-content: center; padding: 10px 16px; }
  main { padding: 20px 12px 30px; }
  .clp-addon-tabs { padding: 0 5px; margin-bottom: 24px; }
  .page-heading { flex-wrap: wrap; }
  .page-heading h1 { font-size: 26px; }
  .card { padding: 20px; }
  .card-header { margin: -20px -20px 20px; padding: 20px; }
  .card-table { padding: 0; }
  .card-table > .card-header { margin: 0; padding: 20px; }
  .addon-card .card-header { width: calc(100% + 40px); }
  .form-grid, .addon-grid { grid-template-columns: minmax(0, 1fr); }
  th, td { padding: 16px 20px; }
  /* A phone has no room for five or six columns. The row becomes a block with
     the domain on a line of its own, and every other cell names its column. */
  .fleet-table, .fleet-table tbody, .fleet-table tr, .fleet-table td { display: block; }
  .fleet-table thead { display: none; }
  .fleet-table tr { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 14px 12px;
    padding: 16px 20px; border-top: 1px solid var(--row-border); }
  .fleet-table td { border: 0; padding: 0; max-width: none; text-align: left; white-space: normal; }
  /* Keep the checkbox column a known size so the domain starts beside it, even
     when a panel stylesheet gives table cells an unexpected intrinsic width. */
  .fleet-table td.site-select { display: flex; flex: 0 0 42px; width: 42px; justify-content: center; }
  /* The domain takes the first line, with what the site is as a tag beside it. */
  .fleet-table td.site-cell { flex: 1 1 calc(100% - 160px); min-width: 55%; font-size: 16px; }
  .fleet-table td.type-cell { flex: 0 1 auto; max-width: 40%; margin: 2px 0 0 auto; padding: 3px 8px;
    border: 1px solid var(--border); border-radius: 4px; color: var(--muted);
    font-size: 12px; line-height: 1.25; white-space: nowrap; }
  /* Half the row each, whatever they hold: a cell that widens with its content
     reflowed the whole row, so switching a site into maintenance -- where the
     status badge grows by half its width -- moved every cell under it. */
  .fleet-table td[data-label] { flex: 1 1 calc(50% - 6px); min-width: 0; }
  .fleet-table td.wide-cell { flex-basis: 100%; }
  /* Two buttons do not fit half a phone's width, and a badge wider than its
     half would reach into the cell beside it. */
  .fleet-table td.action-cell:has(.btn) { flex-basis: 100%; }
  .fleet-table td .badge { white-space: normal; }
  .fleet-table td[data-label]::before { content: attr(data-label); display: block; margin-bottom: 4px;
    color: var(--table-heading); font-size: 12px; font-weight: 700; text-transform: uppercase; }
  .stats { gap: 20px; }
  /* A phone has no width to give away: the frame tightens and the buttons take
     the row, so a long label wraps inside a button rather than off the edge. */
  dialog { padding: 20px; width: calc(100% - 20px); max-height: calc(100vh - 20px); }
  dialog { max-height: calc(100dvh - 20px); }
  .dialog-header { margin: -20px -20px 20px; padding: 16px 20px; }
  .dialog-header h2 { font-size: 20px; }
  .dialog-actions { margin: 20px -20px -20px; padding: 16px 20px; }
  .dialog-actions .btn { flex: 1 1 auto; }
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
// Where the elements of this page live: the document on a standalone addon
// page, and a shadow root on a page mounted into a CloudPanel site page, so
// that Bootstrap in the panel cannot reach this markup and these rules cannot
// reach the panel. Element lookups go through this; document APIs do not.
const CLP_ROOT = typeof CLP_MOUNT === 'undefined' ? document : CLP_MOUNT;

function syncTheme() {
  const dark = /(?:^|;\\s*)theme=dark(?:;|$)/.test(document.cookie);
  document.documentElement.classList.toggle('dark', dark);
  const button = CLP_ROOT.getElementById('theme-switch');
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
// Only the addon's own tabs: a site strip reproduces CloudPanel's navigation,
// whose active entry the server already knows and most of whose routes this
// page could never match.
const navLinks = Array.from(CLP_ROOT.querySelectorAll('[data-auto-active] .clp-addon-nav-link'));
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

// Remember what was already unavailable. Restoring every control to "enabled"
// handed back the switch of a site whose status could not be read and the bulk
// buttons of an empty selection.
function busy(on) {
  CLP_ROOT.querySelectorAll('button, input[type="checkbox"]').forEach(function (el) {
    if (on) {
      if (el.dataset.clpHeld === undefined) el.dataset.clpHeld = el.disabled ? '1' : '0';
      el.disabled = true;
    } else if (el.dataset.clpHeld !== undefined) {
      el.disabled = el.dataset.clpHeld === '1';
      delete el.dataset.clpHeld;
    }
  });
  document.body.style.cursor = on ? 'progress' : '';
}

// Feedback in the page rather than in a modal the browser owns: an addon that
// reports a failed toggle with alert() loses the row it was talking about.
let clpFlashTimer = 0;
function notify(message, kind) {
  const holder = CLP_ROOT.getElementById('clp-flash');
  if (!holder) {
    if (kind === 'error') alert(message);
    return;
  }
  clearTimeout(clpFlashTimer);
  holder.textContent = message;
  holder.className = kind === 'error' ? 'alert' : kind === 'warn' ? 'notice' : 'alert alert-ok';
  holder.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  holder.hidden = false;
  if (kind !== 'error') clpFlashTimer = setTimeout(function () { holder.hidden = true; }, 6000);
}

function clearNotice() {
  const holder = CLP_ROOT.getElementById('clp-flash');
  if (holder) holder.hidden = true;
}

/**
 * The shared confirmation. Takes {title, text, details, confirmLabel, danger}
 * and resolves true only if the operator accepted. Every value is written with
 * textContent, so a domain name in the summary stays a domain name.
 */
function confirmAction(options) {
  const opts = options || {};
  const dialog = CLP_ROOT.getElementById('clp-confirm');
  if (!dialog || typeof dialog.showModal !== 'function') {
    return Promise.resolve(confirm([opts.title, opts.text].concat(opts.details || []).filter(Boolean).join('\\n\\n')));
  }
  dialog.querySelector('#clp-confirm-title').textContent = opts.title || 'Are you sure?';
  dialog.querySelector('#clp-confirm-text').textContent = opts.text || '';
  const list = dialog.querySelector('#clp-confirm-details');
  list.textContent = '';
  (opts.details || []).forEach(function (item) {
    const entry = document.createElement('li');
    entry.textContent = item;
    list.appendChild(entry);
  });
  list.hidden = list.childElementCount === 0;
  const accept = dialog.querySelector('#clp-confirm-accept');
  accept.textContent = opts.confirmLabel || 'Continue';
  accept.className = opts.danger ? 'btn btn-danger' : 'btn btn-primary';
  return new Promise(function (resolve) {
    function onClose() {
      dialog.removeEventListener('close', onClose);
      accept.removeEventListener('click', onAccept);
      resolve(dialog.returnValue === 'accept');
    }
    function onAccept() { dialog.close('accept'); }
    dialog.addEventListener('close', onClose);
    accept.addEventListener('click', onAccept);
    dialog.returnValue = '';
    dialog.showModal();
  });
}

// A strip wider than its container scrolls; keep the tab the page is on and the
// tab the keyboard has reached in view. 'nearest' scrolls the strip, not the page.
(function () {
  const strip = CLP_ROOT.querySelector('.clp-addon-tabs');
  if (!strip) return;
  function reveal(el) {
    if (el && strip.scrollWidth > strip.clientWidth) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  reveal(strip.querySelector('[aria-current="page"]'));
  strip.addEventListener('focusin', function (event) { reveal(event.target); });
})();
`;

/**
 * Styling for a job's progress page, used by every addon that runs work in the
 * background. Appended after BASE_STYLE by the addon that needs it, so the
 * state colours here override the container-state palette above only on the
 * pages that draw a job.
 */
export const JOB_STYLE = `
.kv { display: grid; grid-template-columns: minmax(110px, 180px) minmax(0, 1fr); gap: 12px 25px; align-items: baseline; margin: 0; }
.kv dt { color: var(--muted); font-size: 14px; }
.kv dd { margin: 0; overflow-wrap: anywhere; }
.state-queued { color: var(--muted); border-color: var(--border); }
.state-running { color: var(--accent); border-color: var(--accent); }
.state-done { color: var(--ok); border-color: var(--ok); }
.state-failed { color: var(--bad); border-color: var(--bad); }
.step { color: var(--muted); font-size: 14px; }
.job-summary { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.job-summary .job-domain { overflow-wrap: anywhere; min-width: 0; }
.job-summary #job-state { margin-left: auto; }
.job-timing { margin-top: 25px; }
@media (max-width: 760px) {
  .kv { grid-template-columns: minmax(80px, 100px) minmax(0, 1fr); gap: 12px; }
}
`;

/**
 * The client half of the job progress page: paint an update, and follow a job
 * until it reaches a state that will not change again.
 *
 * Appended to an addon's own script, which calls `watchJob(id)` once the page
 * announces a job to follow. A caller can pass a containing element as the
 * second argument when a page has more than one job surface; the manager uses
 * that to keep updates in the card whose action started the job. The markup
 * contract is four ids -- `job-state`, `job-step`, `job-log` and a hidden
 * `job-watch` carrying `data-job` -- and an addon that draws only some of them
 * still works: each element is optional.
 *
 * EventSource with a polling fallback rather than polling alone, because a log
 * that appears a second after the line was written reads as a live console,
 * and one that appears five seconds later reads as a hung page. The fallback
 * covers a proxy that will not stream and a browser without EventSource.
 */
export const JOB_WATCH_JS = `
function jobElement(root, id) {
  const scope = root || CLP_ROOT;
  return scope.querySelector ? scope.querySelector('#' + id) : CLP_ROOT.getElementById(id);
}

function updateJobUI(job, log, root) {
  if (!job) return false;
  const state = jobElement(root, 'job-state');
  if (state) {
    state.textContent = job.state || '';
    state.className = 'badge state-' + (job.state || 'unknown');
  }
  const step = jobElement(root, 'job-step');
  if (step) step.textContent = job.step || '';
  const pre = jobElement(root, 'job-log');
  if (pre && log !== undefined) {
    pre.textContent = log || '(no output yet)';
    pre.scrollTop = pre.scrollHeight;
  }
  return job.state === 'done' || job.state === 'failed';
}

function showJobReconnecting(root) {
  const state = jobElement(root, 'job-state');
  if (state) {
    state.textContent = 'reconnecting';
    state.className = 'badge state-queued';
  }
  const step = jobElement(root, 'job-step');
  if (step) step.textContent = 'The manager is restarting; waiting for it to come back…';
}

// The server sends {job, log}; tolerate the {data:{...}} envelope too, because
// the polling fallback reads the JSON reply from that same route.
function jobPayload(raw) {
  const body = raw && raw.data ? raw.data : raw;
  return body || {};
}

function watchJob(id, root) {
  let finished = false;
  // Reloading rather than patching the page: a finished job turns the progress
  // view into a result view, and the server already knows how to draw that.
  const done = function (close) {
    if (finished) return true;
    finished = true;
    if (close) close();
    location.reload();
    return true;
  };

  if (typeof EventSource !== 'undefined') {
    const es = new EventSource(CLP_BASE + '/api/jobs/' + encodeURIComponent(id) + '/events');
    es.onmessage = function (ev) {
      if (finished) return;
      try {
        const payload = jobPayload(JSON.parse(ev.data));
        if (updateJobUI(payload.job, payload.log, root)) done(function () { es.close(); });
      } catch (e) {}
    };
    es.addEventListener('restarting', function () {
      if (!finished) showJobReconnecting(root);
    });
    // The session went away under the stream. Reloading lands on the gate,
    // which sends the browser to the login page.
    es.addEventListener('unauthorized', function () {
      es.close();
      location.reload();
    });
    es.onerror = function () {
      if (finished) return;
      es.close();
      showJobReconnecting(root);
      waitForManager(id, done, root);
    };
    return;
  }
  pollJob(id, done, root);
}

function waitForManager(id, done, root) {
  let stopped = false;
  async function tick() {
    if (stopped) return;
    try {
      const res = await fetch(CLP_BASE + '/health', {
        cache: 'no-store',
        headers: { 'Accept': 'application/json' },
      });
      // A session that lapsed during the restart is redirected to the login
      // page, which fetch follows and reports as a perfectly good 200. Waiting
      // for it would spin here forever; reloading lands on the gate instead.
      if (res.redirected) {
        stopped = true;
        location.reload();
        return;
      }
      const body = res.ok ? await res.json().catch(function () { return null; }) : null;
      if (body && body.ok === true) {
        stopped = true;
        pollJob(id, done, root);
        return;
      }
    } catch (e) {}
    setTimeout(tick, 1000);
  }
  tick();
}

function pollJob(id, done, root) {
  let stopped = false;
  async function tick() {
    if (stopped) return;
    try {
      const payload = jobPayload(await call('/api/jobs/' + encodeURIComponent(id)));
      if (updateJobUI(payload.job, payload.log, root)) {
        stopped = true;
        done(null);
        return;
      }
    } catch (e) {}
    setTimeout(tick, 2000);
  }
  tick();
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
  /** Optional header controls if a newer clp-addons release is available. */
  updateNotice?: { current: string; latest: string } | null;
  /**
   * Draw CloudPanel's site information and site tab strip instead of this
   * addon's own tabs, for a page reached from that strip. `activeSlug` is the
   * tab this page is; see lib/site-context for the list.
   */
  site?: SiteContext & { activeSlug: string };
}

/** The inline notice holder every page carries, above its content. */
const FLASH_HTML = '<div id="clp-flash" hidden></div>';

/** The one confirmation dialog every page carries. */
const CONFIRM_HTML = `<dialog id="clp-confirm" aria-labelledby="clp-confirm-title">
  <div class="dialog-header"><h2 id="clp-confirm-title">Are you sure?</h2></div>
  <p id="clp-confirm-text"></p>
  <ul id="clp-confirm-details" hidden></ul>
  <form method="dialog" class="actions dialog-actions">
    <button class="btn" value="cancel" type="submit">Cancel</button>
    <button class="btn btn-primary" id="clp-confirm-accept" type="button">Continue</button>
  </form>
</dialog>`;

/**
 * The same page as `renderLayout`, without a document around it, for mounting
 * into CloudPanel's own site page.
 *
 * No header, no footer, no site strip: the panel is already drawing those. The
 * stylesheet is rewritten for a shadow root, and the script is handed back
 * unrun so the loader can give it the root its lookups are relative to.
 */
export function renderFragment(title: string, content: string, chrome: Chrome): EmbedFragment {
  return {
    ok: true,
    title,
    css: shadowStyle(`${BASE_STYLE}${chrome.css ?? ""}`),
    html: `${FLASH_HTML}${content}${CONFIRM_HTML}`,
    script: `const CLP_BASE = "${escJs(chrome.base)}";\n${BASE_CLIENT_JS}${chrome.script}`,
  };
}

export function renderLayout(title: string, content: string, chrome: Chrome): string {
  const isAddonsRoute = chrome.base === "/addons" || chrome.base.startsWith("/addons/");
  // A site-scoped page belongs to the site, so it highlights Sites; it is not
  // somewhere else in the panel just because an addon renders it.
  const primaryNav = [
    { href: "/dashboard", label: "Dashboard", active: false },
    { href: "/", label: "Sites", active: Boolean(chrome.site) },
    { href: "/addons/", label: "Addons", title: "All addons", active: isAddonsRoute && !chrome.site },
  ]
    .map((n) => {
      const active = n.active ? ' aria-current="page"' : "";
      const titleAttr = n.title ? ` title="${esc(n.title)}"` : "";
      return `      <a class="clp-addon-primary-link${n.active ? " is-active" : ""}" href="${esc(n.href)}"${active}${titleAttr}>${esc(n.label)}</a>`;
    })
    .join("\n");
  const siteHeader = chrome.site
    ? `      ${siteInfoHtml(chrome.site)}
      <nav class="clp-addon-tabs" aria-label="Site navigation">
${siteTabs(chrome.site, chrome.site.activeSlug)
  .map((tab) => `        <a class="clp-addon-nav-link" href="${esc(tab.href)}"${tab.active ? ' aria-current="page"' : ""}>${esc(tab.label)}</a>`)
  .join("\n")}
      </nav>`
    : "";
  const contextualNav = chrome.nav
    .map((n) => `        <a class="clp-addon-nav-link" href="${esc(n.href)}">${esc(n.label)}</a>`)
    .join("\n");
  const contextualHeader = chrome.site || !contextualNav
    ? siteHeader
    : `      <nav class="clp-addon-tabs" data-auto-active aria-label="${esc(chrome.brand)} navigation">
${contextualNav}
      </nav>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<script>${THEME_INIT_JS}</script>
<style>${BASE_STYLE}${SITE_CONTEXT_STYLE}${UPDATE_STYLE}${chrome.css ?? ""}</style>
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
    ${chrome.updateNotice ? updateNoticeHtml(chrome.updateNotice.latest) : ""}
    <div class="clp-addon-header-tools">
      <button class="clp-addon-theme" id="theme-switch" type="button" onclick="toggleTheme()" aria-label="Switch to dark mode" aria-pressed="false">
        <svg class="moon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.9 13.1A9 9 0 0 1 10.9 3.1 9 9 0 1 0 20.9 13.1Z"/></svg>
        <svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 1v3m0 16v3M1 12h3m16 0h3M4.2 4.2l2.1 2.1m11.4 11.4 2.1 2.1M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>
      </button>
    </div>
  </div>
</header>
<main>${contextualHeader}${FLASH_HTML}${content}</main>
${CONFIRM_HTML}
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
