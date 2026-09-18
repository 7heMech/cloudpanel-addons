import { esc, escJs } from "../../../lib/app-http";
import { renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { RedirectView, RedirectsState } from "../action";

const BASE = mountPath("redirects");

// The table, the badges, the form fields and the inline notice come from
// lib/app-ui. Only the two things this page alone draws are here: a row that
// swaps its text for inputs, and the width that keeps a long URL from
// stretching the table.
const STYLE = `
/* Fixed column widths, because a row turns into a form in place: sized to the
   text, the columns moved as soon as an input took one, and every domain in the
   table re-wrapped around the row being edited. */
.fleet-table { table-layout: fixed; }
.fleet-table th:nth-child(1) { width: 24%; }
.fleet-table th:nth-child(2) { width: 28%; }
.fleet-table th:nth-child(3) { width: 13%; }
.fleet-table th:nth-child(4) { width: 15%; }
.redirect-target { overflow-wrap: break-word; }
.redirect-code-text { white-space: nowrap; }
.redirect-edit { display: flex; align-items: center; gap: 10px; white-space: nowrap; }
/* Two buttons at the end of a row, not stacked: the shared .actions wraps by
   default, and the row's last column is narrow enough to make it. */
.fleet-table .action-cell .actions { flex-wrap: nowrap; justify-content: flex-end; }
tr.is-editing .row-view { display: none; }
@media (max-width: 760px) {
  .fleet-table td.action-cell .actions .btn { flex: 1 1 calc(50% - 5px); }
}
`;

export const CLIENT_JS = `
function redirectRow(domain) {
  return CLP_ROOT.querySelector('tr[data-domain="' + domain + '"]');
}

function rowControl(row, selector) {
  return row.querySelector(selector);
}

/** An edit is a mode, so leaving it puts the row back to what the server said. */
function editRedirect(domain) {
  const row = redirectRow(domain);
  if (!row) return;
  rowControl(row, '.redirect-input').value = row.dataset.target;
  rowControl(row, '.redirect-code').value = row.dataset.code;
  rowControl(row, '.redirect-preserve').checked = row.dataset.preserve === 'true';
  row.classList.add('is-editing');
  row.querySelectorAll('.row-edit').forEach(function (part) { part.hidden = false; });
  rowControl(row, '.redirect-input').focus();
}

function cancelRedirect(domain) {
  const row = redirectRow(domain);
  if (!row) return;
  row.classList.remove('is-editing');
  row.querySelectorAll('.row-edit').forEach(function (part) { part.hidden = true; });
}

function codeLabel(code) {
  return code === '302' ? '302 temporary' : '301 permanent';
}

/** Repaints one row from the redirect the server reports for it. */
function paintRedirect(state, domain) {
  const redirect = (state.redirects || []).filter(function (item) { return item.domain === domain; })[0];
  const row = redirectRow(domain);
  if (!redirect || !row) {
    location.reload();
    return;
  }
  row.dataset.target = redirect.target;
  row.dataset.code = String(redirect.code);
  row.dataset.preserve = String(redirect.preservePath);
  rowControl(row, '.redirect-target-text').textContent = redirect.target;
  rowControl(row, '.redirect-path-text').textContent = redirect.preservePath ? 'Kept' : 'Dropped';
  rowControl(row, '.redirect-code-text').textContent = codeLabel(String(redirect.code));
  rowControl(row, '.redirect-repair').hidden = redirect.applied;
  cancelRedirect(domain);
}

async function saveRedirect(domain) {
  const row = redirectRow(domain);
  if (!row) return;
  const body = {
    domain: domain,
    target: rowControl(row, '.redirect-input').value.trim(),
    code: Number(rowControl(row, '.redirect-code').value),
    preservePath: rowControl(row, '.redirect-preserve').checked,
  };
  if (body.target === row.dataset.target && String(body.code) === row.dataset.code &&
      String(body.preservePath) === row.dataset.preserve) {
    cancelRedirect(domain);
    return;
  }
  clearNotice();
  busy(true);
  let state = null;
  let failure = '';
  try {
    state = (await call('/api/redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })).data;
  } catch (error) {
    failure = error.message;
  } finally {
    busy(false);
  }
  if (failure) {
    notify('Could not change the redirect: ' + failure, 'error');
    return;
  }
  paintRedirect(state, domain);
  notify(domain + ' now sends visitors to ' + body.target + '.', 'ok');
}

async function clearRedirect(domain) {
  const accepted = await confirmAction({
    title: 'Stop redirecting ' + domain + '?',
    text: 'The site serves its own empty directory again. The site itself is kept, so a new redirect can be set at any time.',
    confirmLabel: 'Stop redirecting',
    danger: true,
  });
  if (!accepted) return;
  clearNotice();
  busy(true);
  try {
    await call('/api/redirects/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: domain }),
    });
  } catch (error) {
    busy(false);
    notify('Could not stop the redirect: ' + error.message, 'error');
    return;
  }
  // A row leaves the table, so the server draws what is left.
  location.reload();
}

async function createRedirect() {
  const domain = CLP_ROOT.getElementById('new-domain').value.trim().toLowerCase();
  const target = CLP_ROOT.getElementById('new-target').value.trim();
  const code = Number(CLP_ROOT.getElementById('new-code').value);
  const preservePath = CLP_ROOT.getElementById('new-preserve').checked;
  clearNotice();
  if (!domain || !target) {
    notify('A domain and a target are both needed.', 'warn');
    return;
  }
  busy(true);
  try {
    await call('/api/redirects/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: domain, target: target, code: code, preservePath: preservePath }),
    });
  } catch (error) {
    busy(false);
    notify('Could not create the redirect site: ' + error.message, 'error');
    return;
  }
  location.reload();
}
`;

export function layout(title: string, content: string, updateNotice?: { current: string; latest: string } | null): string {
  return renderLayout(title, content, {
    brand: "Redirects",
    base: BASE,
    nav: [],
    css: STYLE,
    script: CLIENT_JS,
    updateNotice,
  });
}

function codeLabel(code: 301 | 302): string {
  return code === 302 ? "302 temporary" : "301 permanent";
}

/**
 * The row's select sits in a table column, so its options are the bare status
 * codes with the wording in their titles: "301 permanent" does not fit a cell
 * that also holds four other columns, and a clipped label is worse than a
 * short one the read view spells out directly above it.
 */
function codeOptions(selected: 301 | 302, short = false): string {
  return [301, 302].map((code) => {
    const label = codeLabel(code as 301 | 302);
    return `<option value="${code}"${code === selected ? " selected" : ""}${short ? ` title="${label}"` : ""}>${short ? code : label}</option>`;
  }).join("");
}

function row(redirect: RedirectView): string {
  const domain = esc(redirect.domain);
  return `
    <tr data-domain="${domain}" data-target="${esc(redirect.target)}" data-code="${redirect.code}" data-preserve="${redirect.preservePath}">
      <td class="site-cell">${domain}
        <div class="hint redirect-repair"${redirect.applied ? " hidden" : ""}>CloudPanel rewrote this vhost; repair puts the redirect back within fifteen minutes.</div>
      </td>
      <td class="wide-cell" data-label="Redirects to">
        <span class="row-view redirect-target redirect-target-text">${esc(redirect.target)}</span>
        <input class="row-edit redirect-input" type="url" inputmode="url" value="${esc(redirect.target)}" aria-label="Where ${domain} redirects to" hidden>
      </td>
      <td data-label="Response">
        <span class="row-view redirect-code-text">${esc(codeLabel(redirect.code))}</span>
        <select class="row-edit redirect-code" aria-label="Redirect response for ${domain}" hidden>${codeOptions(redirect.code, true)}</select>
      </td>
      <td data-label="Request path">
        <span class="row-view redirect-path-text">${redirect.preservePath ? "Kept" : "Dropped"}</span>
        <label class="row-edit redirect-edit" hidden>
          <input class="redirect-preserve" type="checkbox"${redirect.preservePath ? " checked" : ""} aria-label="Keep the request path for ${domain}">
          <span>Keep the path</span>
        </label>
      </td>
      <td class="action-cell">
        <div class="row-view actions">
          <button class="btn" type="button" onclick="editRedirect('${escJs(redirect.domain)}')">Edit</button>
          <button class="btn btn-danger" type="button" onclick="clearRedirect('${escJs(redirect.domain)}')">Clear</button>
        </div>
        <div class="row-edit actions" hidden>
          <button class="btn btn-primary" type="button" onclick="saveRedirect('${escJs(redirect.domain)}')">Save</button>
          <button class="btn" type="button" onclick="cancelRedirect('${escJs(redirect.domain)}')">Cancel</button>
        </div>
      </td>
    </tr>`;
}

export function fleetView(state: RedirectsState): string {
  const total = state.redirects.length;
  return `
    <div class="page-heading">
      <div><h1>Redirects</h1><p>CloudPanel sites whose only job is to send visitors somewhere else.</p></div>
    </div>
    <div class="card">
      <div class="card-header"><h2>New redirect</h2></div>
      <div class="form-grid">
        <div class="form-field">
          <label class="required" for="new-domain">Domain</label>
          <input id="new-domain" type="text" inputmode="url" autocapitalize="none" spellcheck="false" placeholder="old.example.com">
          <div class="hint">A static CloudPanel site is created for it, with a self-signed certificate to replace at your convenience.</div>
        </div>
        <div class="form-field">
          <label class="required" for="new-target">Redirects to</label>
          <input id="new-target" type="url" inputmode="url" autocapitalize="none" spellcheck="false" placeholder="https://www.example.com">
          <div class="hint">An absolute http:// or https:// URL.</div>
        </div>
        <div class="form-field">
          <label for="new-code">Response</label>
          <select id="new-code">${codeOptions(301)}</select>
          <div class="hint">301 is cached by browsers and search engines; 302 is not.</div>
        </div>
        <div class="form-field check-field">
          <label class="check-label" for="new-preserve">
            <input id="new-preserve" type="checkbox" checked>
            <span>Keep the request path<div class="hint">/pricing arrives at the target's /pricing rather than its front page.</div></span>
          </label>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary btn-lg" id="create-redirect" type="button" onclick="createRedirect()">Create redirect</button>
      </div>
    </div>
    <div class="card card-table">
      ${total === 0
        ? '<div class="empty">No redirect sites yet.</div>'
        : `<div class="card-header"><h2>${total} redirect${total === 1 ? "" : "s"}</h2></div>
          <table class="fleet-table">
            <thead><tr>
              <th scope="col">Site</th><th scope="col">Redirects to</th>
              <th scope="col">Response</th><th scope="col">Request path</th>
              <th scope="col" class="action-cell">Actions</th>
            </tr></thead>
            <tbody>${state.redirects.map(row).join("")}</tbody>
          </table>`}
    </div>`;
}

/** The read-only card CloudPanel's own site Settings tab carries. */
export function siteCardHtml(redirect: RedirectView): string {
  const rows: [string, string][] = [
    ["Redirects To", redirect.target],
    ["Response", codeLabel(redirect.code)],
    ["Request Path", redirect.preservePath ? "Kept" : "Dropped"],
  ];
  const cells = rows.map(([label, value]) =>
    `<div class="col-6 col-lg-4"><label class="col-form-label">${esc(label)}</label>
      <div class="clp-addon-readonly">${esc(value)}</div></div>`).join("");
  const drift = redirect.applied
    ? ""
    : `<div class="row"><div class="col"><div class="form-text">CloudPanel has rewritten this site's vhost since the redirect was set. The addon puts it back within fifteen minutes.</div></div></div>`;
  return `<div class="row">${cells}</div>${drift}`;
}
