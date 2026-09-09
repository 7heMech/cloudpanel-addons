// Server-rendered HTML. Every interpolated value goes through esc() or escJs():
// instance domains and container states originate outside this process, and the
// page is served to an authenticated operator whose session can create and
// delete sites.

import { esc, escJs } from "../../../lib/app-http";
import { renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";

/**
 * Where this addon is served. One CloudPanel site carries every addon, so every
 * link this file emits is relative to a mount rather than to the site root.
 * A constant rather than a per-request value: the mount is fixed by the addon's
 * name, so a link that forgets it is a bug at build time, not a routing choice.
 */
const BASE = mountPath("instatic");
import type { InstanceView } from "./service";
import { isNewerThan, type AvailableTags } from "./tags";
import type { SanitizedSite } from "../../../lib/snapshot-reader";

// Only what the shared shell does not carry. Everything else -- the palette,
// the cards, the table, the badges -- lives in lib/app-ui.ts, so a second addon
// does not have to choose between copying it and looking like another product.
const STYLE = `
.behind { color: var(--warn); border-color: var(--warn); margin-left: 0.35rem; }
.btn-update { border-color: var(--warn); color: var(--warn); }
`;

/**
 * The dashboard's inline script.
 *
 * Exported only so tools/test-views.ts can parse it. This is a TypeScript
 * template literal, which means every backslash in it is consumed once before
 * the browser ever sees it: a `\n` written here reaches the page as a real
 * newline, and inside a single-quoted JS string that is a SyntaxError which
 * takes the whole script -- every button on the page -- down with it. Escapes
 * meant for the browser must be doubled, and the test asserts they were.
 */
export const CLIENT_JS = `
async function act(domain, verb) {
  busy(true);
  try {
    await call('/api/instances/' + encodeURIComponent(domain) + '/' + verb, { method: 'POST' });
    location.reload();
  } catch (e) {
    busy(false);
    alert(verb + ' failed: ' + e.message);
  }
}

async function showLogs(domain) {
  const dlg = document.getElementById('logs-dialog');
  const pre = document.getElementById('logs-body');
  document.getElementById('logs-title').textContent = 'Logs \\u2014 ' + domain;
  pre.textContent = 'Loading\\u2026';
  dlg.showModal();
  try {
    const body = await call('/api/instances/' + encodeURIComponent(domain) + '/logs');
    pre.textContent = (body.data && body.data.logs) || '(no output)';
  } catch (e) {
    pre.textContent = 'Could not fetch logs: ' + e.message;
  }
}

let pendingUpdate = null;
function askUpdate(domain, current) {
  pendingUpdate = domain;
  document.getElementById('update-domain').textContent = domain;
  document.getElementById('update-current').textContent = current;

  // The version to update to is picked from the list the registry actually
  // reports, not typed from memory. Typing it meant knowing a release had
  // happened, and nothing on this page ever said so.
  const sel = document.getElementById('update-tag');
  let chosen = '';
  for (let i = 0; i < sel.options.length; i++) {
    const opt = sel.options[i];
    const isCurrent = opt.value === current;
    opt.disabled = isCurrent;
    opt.textContent = opt.dataset.label + (isCurrent ? ' (running now)' : '');
    if (!isCurrent && !chosen) chosen = opt.value;
  }
  // Options are newest first, so the first enabled one is the newest on offer.
  sel.value = chosen || current;
  document.getElementById('update-dialog').showModal();
}

async function confirmUpdate() {
  const tag = document.getElementById('update-tag').value.trim();
  if (!/^\\d+\\.\\d+\\.\\d+$/.test(tag)) { alert('Enter an exact version, for example 0.0.18'); return; }
  document.getElementById('update-dialog').close();
  busy(true);
  const res = await fetch(CLP_BASE + '/api/instances/' + encodeURIComponent(pendingUpdate) + '/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CLP-Addons-CSRF': csrf() },
    body: JSON.stringify({ tag: tag })
  });
  let body = null;
  try { body = await res.json(); } catch (e) {}
  if (res.ok && body && body.ok !== false) { location.reload(); return; }

  busy(false);
  // A rolled-back update is the case where the container logs are the whole
  // story, so show them rather than just the failure line.
  const logs = body && body.data && body.data.logs;
  document.getElementById('logs-title').textContent =
    'Update failed \u2014 rolled back to ' + ((body && body.data && body.data.restoredTag) || 'the previous version');
  document.getElementById('logs-body').textContent =
    ((body && body.error) || 'update failed') + (logs ? '\\n\\n--- container logs ---\\n' + logs : '');
  document.getElementById('logs-dialog').showModal();
}

let pendingDelete = null;
function askDelete(domain) {
  pendingDelete = domain;
  document.getElementById('delete-domain').textContent = domain;
  document.getElementById('delete-confirm').value = '';
  document.getElementById('delete-dialog').showModal();
}

async function confirmDelete() {
  const typed = document.getElementById('delete-confirm').value.trim();
  if (typed !== pendingDelete) { alert('Type the domain exactly to confirm.'); return; }
  document.getElementById('delete-dialog').close();
  busy(true);
  try {
    await call('/api/instances/' + encodeURIComponent(pendingDelete) + '/delete', { method: 'POST' });
    location.href = CLP_BASE + '/';
  } catch (e) {
    busy(false);
    alert('Delete failed: ' + e.message);
  }
}

async function submitCreate(ev) {
  ev.preventDefault();
  const domain = document.getElementById('domain').value.trim().toLowerCase();
  const tag = document.getElementById('tag').value;
  const status = document.getElementById('create-status');
  busy(true);
  status.textContent = 'Creating the site, pulling ' + tag + ' and waiting for a health check. This can take a couple of minutes\\u2026';
  try {
    await call('/api/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: domain, tag: tag })
    });
    location.href = CLP_BASE + '/';
  } catch (e) {
    busy(false);
    status.textContent = '';
    alert('Create failed: ' + e.message);
  }
  return false;
}
`;

export function layout(title: string, content: string): string {
  return renderLayout(title, content, {
    brand: "Instatic",
    base: BASE,
    nav: [
      { href: `${BASE}/`, label: "Instances" },
      { href: `${BASE}/new`, label: "New site" },
    ],
    css: STYLE,
    script: CLIENT_JS,
  });
}

function stateClass(state: string): string {
  const known = ["running", "exited", "created", "paused", "absent", "unknown"];
  return known.includes(state) ? `state-${state}` : "state-unknown";
}

export function dashboardView(
  instances: InstanceView[],
  nextPort: number,
  snapshotAge: number,
  panelSites: SanitizedSite[] = [],
  available: AvailableTags = { tags: [], source: "fallback", latest: null }
): string {
  const running = instances.filter((i) => i.state === "running").length;

  // Only a list that actually came from the registry may claim an instance is
  // behind. The offline fallback is one hardcoded version, and badging every
  // instance against it would invent updates that do not exist.
  const latest = available.source === "fallback" ? null : available.latest;
  const behind = (tag: string) => latest !== null && isNewerThan(latest, tag);
  const outdated = instances.filter((i) => behind(i.tag)).length;

  // A stale snapshot means the port list the allocator is working from may no
  // longer match the panel. Say so rather than quietly allocating against it.
  const staleNotice =
    snapshotAge > 3600
      ? `<div class="notice">The panel snapshot is ${Math.floor(snapshotAge / 60)} minutes old.
         Run <span class="mono">clp-addons repair</span> as root to refresh it before creating a site.</div>`
      : "";

  const rows = instances
    .map(
      (i) => `<tr>
  <td>
    <a href="https://${esc(i.domain)}" target="_blank" rel="noreferrer noopener">${esc(i.domain)}</a>
    ${snapshotAge <= 3600 && !panelSites.some((s) => s.domain === i.domain) ? '<div class="hint">CloudPanel site missing. Delete here to archive and clean up the instance.</div>' : ''}
  </td>
  <td class="mono">127.0.0.1:${esc(i.port)}</td>
  <td>
    <span class="badge">${esc(i.tag)}</span>
    ${behind(i.tag) ? `<span class="badge behind" title="${esc(latest)} is available">${esc(latest)} available</span>` : ""}
  </td>
  <td><span class="badge ${stateClass(i.state)}">${esc(i.state)}</span></td>
  <td><details class="row-actions"><summary class="btn">Manage</summary><div class="actions">
    ${
      i.state === "running"
        ? `<button class="btn" onclick="act('${escJs(i.domain)}','stop')">Stop</button>`
        : `<button class="btn" onclick="act('${escJs(i.domain)}','start')">Start</button>`
    }
    <button class="btn" onclick="act('${escJs(i.domain)}','restart')">Restart</button>
    <button class="btn${behind(i.tag) ? " btn-update" : ""}" onclick="askUpdate('${escJs(i.domain)}','${escJs(i.tag)}')">Update</button>
    <button class="btn" onclick="act('${escJs(i.domain)}','snapshot')">Snapshot</button>
    <button class="btn" onclick="act('${escJs(i.domain)}','recreate')" title="Rebuild the container from the recorded version without touching the data">Recreate</button>
    <button class="btn" onclick="showLogs('${escJs(i.domain)}')">Logs</button>
    <button class="btn btn-danger" onclick="askDelete('${escJs(i.domain)}')">Delete</button>
  </div></details></td>
</tr>`
    )
    .join("\n");

  // Auto-update is off by default because Instatic is 0.0.x, which only works as
  // a policy if something tells the operator a release happened. Nothing did:
  // the version list was fetched for the New Site page and never for this one,
  // so the only way to learn about 0.0.19 was to go and look at the registry.
  const versionNotice =
    available.source === "fallback"
      ? `<div class="notice">Could not reach ghcr.io, so this page cannot tell which instances are
         behind. The versions offered below are a last-resort list, not the registry's.</div>`
      : available.source === "cache"
        ? `<div class="notice">ghcr.io is unreachable right now; version information is from the
           last successful check and may be out of date.</div>`
        : "";

  const updatesTile =
    latest === null
      ? ""
      : `<div class="stat">
    <div class="label">Updates available</div>
    <div class="value" style="color:${outdated > 0 ? "var(--warn)" : "var(--muted)"}">${outdated}</div>
    <div class="hint">latest is ${esc(latest)}</div>
  </div>`;

  return `<div class="page-heading"><div><h2>Instatic sites</h2><p>Create and manage your Instatic instances.</p></div><a class="btn btn-primary" href="${BASE}/new">New site</a></div>${staleNotice}${versionNotice}
<div class="card stats">
  <div class="stat"><div class="label">Instances</div><div class="value">${instances.length}</div></div>
  <div class="stat"><div class="label">Running</div><div class="value" style="color:var(--ok)">${running}</div></div>
  ${updatesTile}
</div>

<div class="card">
  ${
    instances.length === 0
      ? `<div class="empty">No Instatic instances yet. <a href="${BASE}/new">Create one</a>.</div>`
      : `<table>
    <thead><tr><th>Site</th><th>Bound to</th><th>Version</th><th>State</th><th>Actions</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`
  }
</div>

<details class="card">
  <summary style="cursor:pointer;color:var(--muted)">
    All CloudPanel sites on this server (${panelSites.length})
  </summary>
  <p class="hint">Check whether a hostname is already in use before creating an instance.</p>
  <table style="margin-top:0.75rem">
    <thead><tr><th>Domain</th><th>Type</th><th>Site user</th></tr></thead>
    <tbody>${
      panelSites.length === 0
        ? `<tr><td colspan="3" class="empty">Snapshot is empty. Run <span class="mono">clp-addons repair</span> as root.</td></tr>`
        : panelSites
            .map((s) => `<tr><td>${esc(s.domain)}</td><td><span class="badge">${esc(s.type)}</span></td><td class="mono">${esc(s.user)}</td></tr>`)
            .join("")
    }</tbody>
  </table>
</details>

<dialog id="logs-dialog">
  <h3 id="logs-title" style="margin-top:0"></h3>
  <pre id="logs-body"></pre>
  <div class="actions" style="justify-content:flex-end">
    <button class="btn" onclick="document.getElementById('logs-dialog').close()">Close</button>
  </div>
</dialog>

<dialog id="update-dialog">
  <h3 style="margin-top:0">Update <span id="update-domain" class="mono"></span></h3>
  <p class="hint">Currently running <span id="update-current" class="mono"></span>.
    A snapshot is taken first; if the new version fails its health check the instance is rolled
    back to the current tag automatically.</p>
  <label for="update-tag">Target version</label>
  <select id="update-tag">${
    (available.tags.length > 0 ? available.tags : instances.map((i) => i.tag))
      .map((t, idx) =>
        `<option value="${esc(t)}" data-label="${esc(t)}${idx === 0 ? " (latest)" : ""}">${esc(t)}${idx === 0 ? " (latest)" : ""}</option>`
      )
      .join("")
  }</select>
  <div class="actions" style="justify-content:flex-end;margin-top:1rem">
    <button class="btn" onclick="document.getElementById('update-dialog').close()">Cancel</button>
    <button class="btn btn-primary" onclick="confirmUpdate()">Update</button>
  </div>
</dialog>

<dialog id="delete-dialog">
  <h3 style="margin-top:0">Delete <span id="delete-domain" class="mono"></span></h3>
  <p class="hint">This removes the container, the CloudPanel site, and the instance data.
    A final archive is written to <span class="mono">/var/backups/clp-addons/instatic</span> first.
    Type the domain to confirm.</p>
  <input id="delete-confirm" placeholder="type the domain" autocomplete="off">
  <div class="actions" style="justify-content:flex-end;margin-top:1rem">
    <button class="btn" onclick="document.getElementById('delete-dialog').close()">Cancel</button>
    <button class="btn btn-danger" onclick="confirmDelete()">Delete</button>
  </div>
</dialog>`;
}

export function newInstanceView(nextPort: number, available: AvailableTags): string {
  const options = available.tags.map((t, idx) =>
    `<option value="${esc(t)}"${idx === 0 ? " selected" : ""}>${esc(t)}${idx === 0 ? " (latest)" : ""}</option>`
  ).join("");

  const notice =
    available.source === "registry"
      ? ""
      : `<div class="notice">Could not reach ghcr.io${
          available.source === "cache" ? " right now, so this list is from the last successful check" : ""
        }. ${
          available.source === "fallback"
            ? "The list below is a hardcoded last resort and may be missing newer releases."
            : ""
        }</div>`;

  return `${notice}<div class="card">
  <h2 style="margin-top:0;font-size:1.1rem">New Instatic site</h2>
  <p class="hint">Creates a CloudPanel reverse-proxy site, starts a pinned Instatic container bound
    to 127.0.0.1, and verifies the page is served through nginx before recording the instance.
    Point DNS at this server first, or the health check will not pass.</p>

  <form onsubmit="return submitCreate(event)">
    <label for="domain">Domain</label>
    <input id="domain" placeholder="pages.example.com" autocomplete="off" required
      pattern="[a-z0-9]([a-z0-9\\-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9\\-]{0,61}[a-z0-9])?)+">
    <div class="hint">Lowercase hostname. Must already resolve to this server.</div>

    <label for="tag">Instatic version</label>
    <select id="tag" required>${options}</select>
    <div class="hint">Pinned exactly. Instatic is pre-1.0, so treat every bump as potentially breaking.</div>

    <label for="port">Port</label>
    <input id="port" value="${esc(nextPort)}" readonly>
    <div class="hint">Allocated from the reserved range and bound to 127.0.0.1 only.
      Changing an instance's port later is a manual edit in the panel's vhost editor.</div>

    <div class="actions" style="margin-top:1.25rem">
      <button type="submit" class="btn btn-primary">Create site</button>
      <a class="btn" href="${BASE}/">Cancel</a>
    </div>
    <div class="hint" id="create-status" style="margin-top:0.75rem"></div>
  </form>
</div>`;
}
