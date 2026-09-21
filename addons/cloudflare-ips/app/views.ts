import { esc } from "../../../lib/app-http";
import { renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import { siteTypeLabel } from "../../../lib/site-context";
import type { CloudflareState } from "./service";

const BASE = mountPath("cloudflare-ips");

// Switches, the toolbar, the confirmation dialog and the inline notice come
// from lib/app-ui so this addon looks like the rest of the manager.
const STYLE = `
.fleet-card, .policy-card { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
.fleet-card h2, .policy-card h2 { margin: 0 0 8px; }
.fleet-card p, .policy-card p { margin: 0; }
.fleet-card .actions { flex-shrink: 0; }
.toolbar-actions { margin-left: auto; }
.cloudflare-site-table .mobile-site-type { display: none; }
.cloudflare-site-table tbody tr { cursor: pointer; transition: background-color .15s, box-shadow .15s; }
.cloudflare-site-table tbody tr:hover { background: rgb(38 125 221 / 6%); }
.cloudflare-site-table tbody tr[aria-selected="true"] { background: rgb(38 125 221 / 12%); box-shadow: inset 4px 0 var(--primary); }
.cloudflare-site-table tbody tr:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }
@media (max-width: 700px) {
  .fleet-card, .policy-card { flex-direction: column; }
}
@media (max-width: 760px) {
  .cloudflare-site-table tbody tr { flex-wrap: nowrap; align-items: center; }
  .toolbar-actions { flex: 1 1 100%; margin-left: 0; }
  .toolbar-actions .btn { flex: 1 1 calc(50% - 6px); padding-right:10px; padding-left:10px; white-space:nowrap; }
  .fleet-table.cloudflare-site-table td.site-select { display: none; }
  .cloudflare-site-table td.site-cell { display: flex; align-items: center; flex: 1 1 auto; min-width: 0; }
  .cloudflare-site-table td.action-cell { width: auto; flex: 0 0 auto; margin-left: auto; display: flex; align-items: center; justify-content: flex-end; }
  .cloudflare-site-table td.action-cell::before { display: none; }
  .cloudflare-site-table td.type-cell { display: none; }
  .cloudflare-site-table .site-copy { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; width: 100%; min-width: 0; }
  .cloudflare-site-table .site-name { display: block; overflow-wrap: anywhere; }
  .cloudflare-site-table .mobile-site-type { display: block;
    padding: 1px 4px; border: 1px solid var(--border); border-radius: 3px; color: var(--muted);
    font-size: 10px; font-weight: 400; line-height: 1.1; white-space: nowrap; }
}
`;

export const CLIENT_JS = `
function siteRows() {
  return Array.from(document.querySelectorAll('tr[data-domain]'));
}

function rowState(row) {
  return {
    domain: row.dataset.domain,
    enabled: row.dataset.enabled === 'true',
    excluded: row.dataset.excluded === 'true',
    selected: Boolean(row.querySelector('.site-checkbox') && row.querySelector('.site-checkbox').checked),
  };
}

function selectedRows() {
  return siteRows().filter(function (row) {
    const box = row.querySelector('.site-checkbox');
    return box && box.checked;
  });
}

function automaticOn() {
  const policy = document.getElementById('automatic-policy');
  return Boolean(policy && policy.checked);
}

function plural(count, word) {
  return count + ' ' + word + (count === 1 ? '' : 's');
}

function paintSummary() {
  const rowElements = siteRows();
  rowElements.forEach(function (row) {
    const box = row.querySelector('.site-checkbox');
    row.tabIndex = 0;
    row.setAttribute('aria-selected', String(Boolean(box && box.checked)));
  });
  const rows = rowElements.map(rowState);
  const on = rows.filter(function (row) { return row.enabled; }).length;
  const summary = document.getElementById('cf-summary');
  if (summary) {
    summary.textContent = rows.length === 0
      ? 'No sites found in CloudPanel.'
      : on + ' of ' + plural(rows.length, 'site') + ' allow Cloudflare only.';
  }
  const selected = selectedRows().length;
  const note = document.getElementById('cf-selection');
  if (note) note.textContent = selected === 0 ? 'No sites selected' : selected + ' of ' + rows.length + ' selected';
  ['enable-selected', 'disable-selected'].forEach(function (id) {
    const button = document.getElementById(id);
    if (button) button.disabled = selected === 0;
  });
  ['enable-all', 'disable-all'].forEach(function (id) {
    const button = document.getElementById(id);
    if (button) button.disabled = rows.length === 0;
  });
  const all = document.getElementById('select-all');
  if (all) {
    all.checked = rows.length > 0 && selected === rows.length;
    all.indeterminate = selected > 0 && selected < rows.length;
  }
  const allBtn = document.getElementById('select-all-btn');
  if (allBtn) {
    allBtn.disabled = rows.length === 0;
    allBtn.textContent = rows.length > 0 && selected === rows.length ? 'Deselect all' : 'Select all';
  }
}

function selectAllSites(checked) {
  document.querySelectorAll('.site-checkbox').forEach(function (box) { box.checked = checked; });
  paintSummary();
}

function toggleAllSites() {
  const rows = siteRows();
  selectAllSites(selectedRows().length < rows.length);
}

function toggleSiteSelection(event, row) {
  const target = event.target;
  if (target && target !== row && target.closest && target.closest('input, button, a, label, select, textarea')) return;
  if (event.type === 'keydown') {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
  }
  const box = row.querySelector('.site-checkbox');
  if (!box || box.disabled) return;
  box.checked = !box.checked;
  paintSummary();
}

// Repaint from the server's answer rather than from what was asked for: the
// row that failed, the row somebody else changed and the exception bookkeeping
// all come back in the same reply.
function applyState(state) {
  const rows = new Map(siteRows().map(function (row) { return [row.dataset.domain, row]; }));
  const domains = (state.sites || []).map(function (site) { return site.domain; });
  if (domains.length !== rows.size || domains.some(function (domain) { return !rows.has(domain); })) {
    // The inventory itself moved; only a reload can draw rows that are not here.
    location.reload();
    return;
  }
  state.sites.forEach(function (site) {
    const row = rows.get(site.domain);
    row.dataset.enabled = String(site.enabled);
    row.dataset.excluded = String(site.excludedFromAutomatic);
    const input = row.querySelector('.site-switch');
    if (input) input.checked = site.enabled;
  });
  const policy = document.getElementById('automatic-policy');
  if (policy) policy.checked = Boolean(state.autoEnableNewSites);
  paintSummary();
}

/** The state the server holds now, or why it could not be read. */
async function readState() {
  try {
    return { ok: true, data: (await call('/api/sites')).data };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// Reading the new state is part of the change, not something after it: the
// controls stay disabled until it is in hand, so a second click cannot start a
// change whose reply arrives first and paints the older state over the newer
// one. Painting waits for busy() to release, because busy() restores every
// control to what it was disabled as, which would undo what the paint decided.
async function setDomains(domains, enabled) {
  if (!domains.length) return false;
  clearNotice();
  busy(true);
  let failure = '';
  let state;
  try {
    await call('/api/sites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domains: domains, enabled: enabled }),
    });
  } catch (error) {
    failure = error.message;
  }
  try {
    state = await readState();
  } finally {
    busy(false);
  }
  if (state.ok) applyState(state.data);
  if (failure) {
    notify('Could not update the Cloudflare setting: ' + failure, 'error');
    return false;
  }
  const done = plural(domains.length, 'site') + (enabled ? ' now allow' : ' no longer allow') + ' Cloudflare traffic only.';
  // The change landed; what is on screen is what could not be refreshed, and
  // saying only that it worked would hide rows that are no longer true.
  notify(state.ok ? done : done + ' The page may be out of date: ' + state.error, state.ok ? 'ok' : 'warn');
  return true;
}

/** What an operation actually changes, counted from what is on screen. */
function planFor(rows, enabled) {
  const flagChanges = rows.filter(function (row) { return row.enabled !== enabled; });
  // Turning a site on clears its automatic exception; turning one off adds one.
  const exceptionChanges = rows.filter(function (row) { return enabled ? row.excluded : !row.excluded; });
  return { rows: rows, flagChanges: flagChanges, exceptionChanges: exceptionChanges };
}

function planDetails(plan, enabled) {
  const details = [];
  const off = plan.flagChanges.length;
  // The request rewrites the automatic exception list as well as the site flag,
  // so a site already on the wanted setting is not always a no-op. Say which
  // part of the change each count refers to.
  const later = automaticOn() ? '.' : ' if automatic enabling is turned on later.';
  if (enabled) {
    details.push(off === 0
      ? 'Every site here is already on.'
      : plural(off, 'site') + ' currently off ' + (off === 1 ? 'is' : 'are') + ' turned on.');
    if (plan.exceptionChanges.length) {
      details.push(plural(plan.exceptionChanges.length, 'site') + ' stop' + (plan.exceptionChanges.length === 1 ? 's' : '') +
        ' being excluded from automatic enabling' + later);
    }
  } else {
    details.push(off === 0
      ? 'Every site here is already off.'
      : plural(off, 'site') + ' currently on ' + (off === 1 ? 'is' : 'are') + ' turned off.');
    if (plan.exceptionChanges.length) {
      details.push(plural(plan.exceptionChanges.length, 'site') + ' become' + (plan.exceptionChanges.length === 1 ? 's' : '') +
        ' excluded from automatic enabling' + later);
    }
  }
  details.push('These choices replace what is set now and are not restored afterwards.');
  return details;
}

async function runBulk(rows, enabled, scope) {
  const plan = planFor(rows, enabled);
  if (plan.flagChanges.length === 0 && plan.exceptionChanges.length === 0) {
    notify(scope === 'all'
      ? 'Every site is already ' + (enabled ? 'on' : 'off') + '; nothing to change.'
      : 'The selected sites are already ' + (enabled ? 'on' : 'off') + '; nothing to change.', 'ok');
    return;
  }
  const subject = scope === 'all'
    ? 'all ' + plural(rows.length, 'site')
    : 'the ' + plural(rows.length, 'selected site');
  const accepted = await confirmAction({
    title: enabled
      ? 'Allow Cloudflare traffic only for ' + subject + '?'
      : 'Stop restricting ' + subject + ' to Cloudflare?',
    text: enabled
      ? 'Visitors reaching these sites from outside Cloudflare are blocked.'
      : 'These sites accept traffic from any address again.',
    details: planDetails(plan, enabled),
    confirmLabel: enabled ? 'Enable' : 'Disable',
    danger: !enabled,
  });
  if (!accepted) return;
  await setDomains(rows.map(function (row) { return row.domain; }), enabled);
}

function setAllSites(enabled) {
  runBulk(siteRows().map(rowState), enabled, 'all');
}

function setSelectedSites(enabled) {
  const rows = siteRows().map(rowState).filter(function (row) { return row.selected; });
  if (!rows.length) {
    notify('Select at least one site first.', 'warn');
    return;
  }
  runBulk(rows, enabled, 'selection');
}

// A single row is the common correction after a fleet-wide change, so it acts
// at once rather than behind a confirmation.
async function setOne(input) {
  const row = input.closest('tr[data-domain]');
  if (!row) return;
  await setDomains([row.dataset.domain], input.checked);
}

async function setAutomatic(input) {
  const enabled = input.checked;
  clearNotice();
  busy(true);
  let failure = '';
  let state;
  try {
    await call('/api/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enabled }),
    });
  } catch (error) {
    failure = error.message;
  }
  try {
    state = await readState();
  } finally {
    busy(false);
  }
  if (state.ok) applyState(state.data);
  if (failure) {
    notify('Could not update the automatic policy: ' + failure, 'error');
    return;
  }
  const done = enabled
    ? 'New sites will allow Cloudflare only. Existing sites are unchanged.'
    : 'New sites are left alone. Existing sites are unchanged.';
  notify(state.ok ? done : done + ' The page may be out of date: ' + state.error, state.ok ? 'ok' : 'warn');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paintSummary);
else paintSummary();
`;

export function layout(title: string, content: string, updateNotice?: { current: string; latest: string } | null): string {
  return renderLayout(title, content, {
    brand: "Cloudflare IP Access",
    base: BASE,
    nav: [],
    css: STYLE,
    script: CLIENT_JS,
    updateNotice,
  });
}

export function dashboardView(state: CloudflareState): string {
  const enabled = state.sites.filter((site) => site.enabled).length;
  const total = state.sites.length;
  const rows = state.sites.map((site) => `
    <tr data-domain="${esc(site.domain)}" data-enabled="${site.enabled}" data-excluded="${site.excludedFromAutomatic}" tabindex="0" aria-selected="false" onclick="toggleSiteSelection(event, this)" onkeydown="toggleSiteSelection(event, this)">
      <td class="site-select"><input class="site-checkbox" type="checkbox" onchange="paintSummary()" aria-label="Select ${esc(site.domain)}"></td>
      <td class="site-cell"><span class="site-copy"><span class="mobile-site-type">${esc(siteTypeLabel(site.type))}</span><span class="site-name">${esc(site.domain)}</span></span></td>
      <td class="type-cell">${esc(siteTypeLabel(site.type))}</td>
      <td class="action-cell" data-label="Cloudflare only">
        <label class="switch"><input class="site-switch" type="checkbox" aria-label="Cloudflare-only access for ${esc(site.domain)}" ${site.enabled ? "checked" : ""} onchange="setOne(this)"><span></span></label>
      </td>
    </tr>`).join("");

  return `
    <div class="page-heading">
      <div><h1>Cloudflare IP access</h1><p>Control CloudPanel's “Allow traffic from Cloudflare only” setting for every site.</p></div>
    </div>
    <div class="card fleet-card">
      <div>
        <h2>All sites</h2>
        <p id="cf-summary">${total === 0 ? "No sites found in CloudPanel." : `${enabled} of ${total} ${total === 1 ? "site" : "sites"} allow Cloudflare only.`}</p>
        <p class="hint">A one-time change to the sites that exist now.</p>
      </div>
      <div class="actions">
        <button class="btn btn-primary" id="enable-all" type="button" ${total === 0 ? "disabled" : ""} onclick="setAllSites(true)">Enable all sites</button>
        <button class="btn" id="disable-all" type="button" ${total === 0 ? "disabled" : ""} onclick="setAllSites(false)">Disable all sites</button>
      </div>
    </div>
    <div class="card policy-card">
      <div>
        <h2>Enable on new sites</h2>
        <p>Apply the setting automatically within about one minute after a site is created.</p>
      </div>
      <label class="switch"><input id="automatic-policy" type="checkbox" aria-label="Enable Cloudflare-only access on new sites" ${state.autoEnableNewSites ? "checked" : ""} onchange="setAutomatic(this)"><span></span></label>
    </div>
    <div class="card card-table">
      ${total === 0
        ? '<div class="empty">No sites found in CloudPanel.</div>'
        : `<div class="card-header toolbar">
            <h2>Sites</h2>
            <span class="toolbar-note" id="cf-selection">No sites selected</span>
            <button class="btn mobile-select-all" id="select-all-btn" type="button" onclick="toggleAllSites()">Select all</button>
            <div class="actions toolbar-actions">
              <button class="btn" id="enable-selected" type="button" disabled onclick="setSelectedSites(true)">Enable selected</button>
              <button class="btn" id="disable-selected" type="button" disabled onclick="setSelectedSites(false)">Disable selected</button>
            </div>
          </div>
          <table class="fleet-table cloudflare-site-table">
            <thead><tr>
              <th scope="col" class="site-select"><input id="select-all" type="checkbox" onchange="selectAllSites(this.checked)" aria-label="Select all sites"></th>
              <th scope="col">Site</th><th scope="col">Type</th><th scope="col" class="action-cell">Cloudflare only</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>`}
    </div>`;
}
