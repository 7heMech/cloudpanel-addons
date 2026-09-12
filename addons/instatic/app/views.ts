// Server-rendered HTML. Every interpolated value goes through esc() or escJs():
// instance domains and container states originate outside this process, and the
// page is served to an authenticated operator whose session can create and
// delete sites.

import { esc, escJs } from "../../../lib/app-http";
import { JOB_STYLE, JOB_WATCH_JS, renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";

/**
 * Where this addon is served. One CloudPanel site carries every addon, so every
 * link this file emits is relative to a mount rather than to the site root.
 * A constant rather than a per-request value: the mount is fixed by the addon's
 * name, so a link that forgets it is a bug at build time, not a routing choice.
 */
const BASE = mountPath("instatic");
import type { InstanceView, InstaticJobView } from "./service";
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
let currentLogDomain = '';
let currentLogPort = '';
let currentLogMode = 'container';

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

async function takeSnapshot(domain) {
  busy(true);
  try {
    const res = await call('/api/instances/' + encodeURIComponent(domain) + '/snapshot', { method: 'POST' });
    busy(false);
    const snap = res && res.data && res.data.snapshot;
    const snapFile = snap ? snap.split('/').pop() : '';
    document.getElementById('snapshot-title').textContent = 'Snapshot Created \\u2014 ' + domain;
    document.getElementById('snapshot-file').textContent = snapFile || 'Snapshot archive created';
    document.getElementById('snapshot-path').textContent = snap || '(stored in instance snapshots directory)';
    document.getElementById('snapshot-dialog').showModal();
  } catch (e) {
    busy(false);
    alert('Snapshot failed: ' + e.message);
  }
}

async function fetchLogContent() {
  const pre = document.getElementById('logs-body');
  pre.textContent = 'Loading\\u2026';
  try {
    if (currentLogMode === 'creation') {
      const body = await call('/api/instances/' + encodeURIComponent(currentLogDomain) + '/creation-log');
      pre.textContent = (body && body.data && body.data.log) || '(no creation log recorded)';
    } else {
      const body = await call('/api/instances/' + encodeURIComponent(currentLogDomain) + '/logs');
      pre.textContent = (body && body.data && body.data.logs) || '(no output)';
    }
  } catch (e) {
    pre.textContent = 'Could not fetch logs: ' + e.message;
  }
}

function switchLogs(mode) {
  currentLogMode = mode;
  const btnC = document.getElementById('btn-container-logs');
  const btnCr = document.getElementById('btn-creation-logs');
  if (btnC && btnCr) {
    if (mode === 'creation') {
      btnCr.classList.add('btn-primary');
      btnC.classList.remove('btn-primary');
    } else {
      btnC.classList.add('btn-primary');
      btnCr.classList.remove('btn-primary');
    }
  }
  fetchLogContent();
}

async function showLogs(domain, port) {
  currentLogDomain = domain;
  currentLogPort = port;
  currentLogMode = 'container';
  const dlg = document.getElementById('logs-dialog');
  const portInfo = document.getElementById('logs-port-info');
  document.getElementById('logs-title').textContent = 'Logs \\u2014 ' + domain;
  if (portInfo) {
    portInfo.textContent = port ? 'Container listens on internal port 3001, mapped from host 127.0.0.1:' + port + ' for CloudPanel reverse proxy.' : '';
  }
  const btnC = document.getElementById('btn-container-logs');
  const btnCr = document.getElementById('btn-creation-logs');
  if (btnC && btnCr) {
    btnC.classList.add('btn-primary');
    btnCr.classList.remove('btn-primary');
  }
  dlg.showModal();
  fetchLogContent();
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
    'Update failed \\u2014 rolled back to ' + ((body && body.data && body.data.restoredTag) || 'the previous version');
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
  const tls = document.getElementById('tls').checked;
  busy(true);
  try {
    const res = await call('/api/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: domain, tag: tag, tls: tls })
    });
    if (res && res.data && res.data.job) {
      location.href = CLP_BASE + '/jobs/' + encodeURIComponent(res.data.job);
    } else {
      location.href = CLP_BASE + '/';
    }
  } catch (e) {
    busy(false);
    alert('Create failed: ' + e.message);
  }
  return false;
}

function initInstatic() {
  const watch = document.getElementById('job-watch');
  if (watch && watch.dataset.job) {
    watchJob(watch.dataset.job);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initInstatic);
} else {
  initInstatic();
}
`;

export function layout(
  title: string,
  content: string,
  updateNotice?: { current: string; latest: string } | null
): string {
  return renderLayout(title, content, {
    brand: "Instatic",
    base: BASE,
    nav: [
      { href: `${BASE}/`, label: "Instances" },
      { href: `${BASE}/new`, label: "New site" },
    ],
    css: STYLE + JOB_STYLE,
    script: JOB_WATCH_JS + CLIENT_JS,
    updateNotice,
  });
}

function stateClass(state: string): string {
  const known = ["running", "exited", "created", "paused", "absent", "unknown", "queued", "done", "failed"];
  return known.includes(state) ? `state-${state}` : "state-unknown";
}

export function isInstanceMissing(
  instance: InstanceView,
  snapshotAge: number,
  panelSites: SanitizedSite[],
  snapshotTakenAt?: string
): boolean {
  if (instance.panelSite === false) return true;
  if (instance.panelSite === true) return false;
  if (snapshotAge > 3600) return false;
  if (snapshotTakenAt) {
    const taken = Date.parse(snapshotTakenAt);
    const created = Date.parse(instance.createdAt);
    if (!Number.isNaN(taken) && !Number.isNaN(created) && created >= taken) {
      return false;
    }
  }
  return !panelSites.some((s) => s.domain === instance.domain);
}

export function dashboardView(
  instances: InstanceView[],
  nextPort: number,
  snapshotAge: number,
  panelSites: SanitizedSite[] = [],
  available: AvailableTags = { tags: [], source: "fallback", latest: null },
  snapshotTakenAt = ""
): string {
  const running = instances.filter((i) => i.state === "running").length;

  // Only a list that actually came from the registry may claim an instance is
  // behind. The offline fallback is one hardcoded version, and badging every
  // instance against it would invent updates that do not exist.
  const latest = available.source === "fallback" ? null : available.latest;
  const behind = (tag: string) => latest !== null && isNewerThan(latest, tag);
  const outdated = instances.filter((i) => behind(i.tag)).length;

  const rows = instances
    .map((i) => {
      const missing = isInstanceMissing(i, snapshotAge, panelSites, snapshotTakenAt);
      return `<tr>
  <td>
    ${
      missing
        ? `<span class="mono">${esc(i.domain)}</span>`
        : `<a href="https://${esc(i.domain)}" target="_blank" rel="noreferrer noopener">${esc(i.domain)}</a>`
    }
    ${missing ? '<div class="hint">CloudPanel site deleted. Delete here to archive and clean up the instance.</div>' : ''}
  </td>
  <td class="mono">127.0.0.1:${esc(i.port)}</td>
  <td>
    <span class="badge">${esc(i.tag)}</span>
    ${behind(i.tag) ? `<span class="badge behind" title="${esc(latest)} is available">${esc(latest)} available</span>` : ""}
  </td>
  <td>
    <span class="badge ${stateClass(i.state)}">${esc(i.state)}</span>
    ${missing ? '<span class="badge" style="color:var(--bad);border-color:var(--bad);margin-left:0.25rem;">deleted</span>' : ''}
  </td>
  <td class="action-cell"><details class="row-actions"><summary>Manage</summary><div class="actions">
    ${
      i.state === "running"
        ? `<button class="btn" onclick="act('${escJs(i.domain)}','stop')">Stop</button>`
        : `<button class="btn" onclick="act('${escJs(i.domain)}','start')">Start</button>`
    }
    <button class="btn" onclick="act('${escJs(i.domain)}','restart')">Restart</button>
    <button class="btn${behind(i.tag) ? " btn-update" : ""}" onclick="askUpdate('${escJs(i.domain)}','${escJs(i.tag)}')">Update</button>
    <button class="btn" onclick="takeSnapshot('${escJs(i.domain)}')" title="Create a backup snapshot of the SQLite database and instance data">Snapshot</button>
    <button class="btn" onclick="act('${escJs(i.domain)}','recreate')" title="Rebuild the recorded version, preserving data and enabling native backups for older instances">Recreate</button>
    <button class="btn" onclick="showLogs('${escJs(i.domain)}', '${escJs(String(i.port ?? ""))}')">Logs</button>
    <button class="btn btn-danger" onclick="askDelete('${escJs(i.domain)}')">Delete</button>
  </div></details></td>
</tr>`;
    })
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

  return `<div class="page-heading"><div><h1>Instatic sites</h1><p>Create and manage your Instatic instances.</p></div><a class="btn btn-primary" href="${BASE}/new">+ New site</a></div>${versionNotice}
<div class="card stats">
  <div class="stat"><div class="label">Instances</div><div class="value">${instances.length}</div></div>
  <div class="stat"><div class="label">Running</div><div class="value" style="color:var(--ok)">${running}</div></div>
  ${updatesTile}
</div>

<div class="card card-table">
  ${
    instances.length === 0
      ? `<div class="empty">No Instatic instances yet. <a href="${BASE}/new">Create one</a>.</div>`
      : `<table>
    <thead><tr><th scope="col">Site</th><th scope="col">Bound to</th><th scope="col">Version</th><th scope="col">State</th><th scope="col" class="action-cell">Actions</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`
  }
</div>

<details class="card site-inventory">
  <summary>
    All CloudPanel sites on this server (${panelSites.length})
  </summary>
  <p class="hint">Check whether a hostname is already in use before creating an instance.</p>
  <div class="table-scroll"><table>
    <thead><tr><th>Domain</th><th>Type</th><th>Site user</th></tr></thead>
    <tbody>${
      panelSites.length === 0
        ? `<tr><td colspan="3" class="empty">Snapshot is empty. Run <span class="mono">clp-addons repair</span> as root.</td></tr>`
        : panelSites
            .map((s) => `<tr><td>${esc(s.domain)}</td><td><span class="badge">${esc(s.type)}</span></td><td class="mono">${esc(s.user)}</td></tr>`)
            .join("")
    }</tbody>
  </table></div>
</details>

<dialog id="logs-dialog" aria-labelledby="logs-title">
  <div class="dialog-header"><h2 id="logs-title"></h2></div>
  <p class="hint" id="logs-port-info" style="margin: 0 0 12px;"></p>
  <div style="display:flex;gap:8px;margin-bottom:12px;">
    <button type="button" class="btn btn-sm btn-primary" id="btn-container-logs" onclick="switchLogs('container')">Container Logs</button>
    <button type="button" class="btn btn-sm" id="btn-creation-logs" onclick="switchLogs('creation')">Creation Log</button>
  </div>
  <pre id="logs-body"></pre>
  <div class="actions dialog-actions">
    <button class="btn" onclick="document.getElementById('logs-dialog').close()">Close</button>
  </div>
</dialog>

<dialog id="snapshot-dialog" aria-labelledby="snapshot-title">
  <div class="dialog-header"><h2 id="snapshot-title">Snapshot Created</h2></div>
  <p class="hint">A backup snapshot of the SQLite database and instance files was created successfully:</p>
  <div style="background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:12px 16px;margin-bottom:16px;">
    <div style="font-weight:600;margin-bottom:4px;" id="snapshot-file"></div>
    <div class="mono hint" id="snapshot-path" style="font-size:13px;word-break:break-all;"></div>
  </div>
  <p class="hint">Snapshots include a clean SQLite backup and instance data. They are stored under the instance's <span class="mono">snapshots/</span> directory and pruned to the 5 most recent versions for safe rollbacks.</p>
  <div class="actions dialog-actions">
    <button class="btn btn-primary" onclick="document.getElementById('snapshot-dialog').close()">Done</button>
  </div>
</dialog>

<dialog id="update-dialog" aria-labelledby="update-title">
  <div class="dialog-header"><h2 id="update-title">Update <span id="update-domain" class="mono"></span></h2></div>
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
  <div class="actions dialog-actions">
    <button class="btn" onclick="document.getElementById('update-dialog').close()">Cancel</button>
    <button class="btn btn-primary" onclick="confirmUpdate()">Update</button>
  </div>
</dialog>

<dialog id="delete-dialog" aria-labelledby="delete-title">
  <div class="dialog-header"><h2 id="delete-title">Delete <span id="delete-domain" class="mono"></span></h2></div>
  <p class="hint">This removes the container, the CloudPanel site, and the instance data.
    A final archive is written to <span class="mono">/var/backups/clp-addons/instatic</span> first.
    Type the domain to confirm.</p>
  <label for="delete-confirm">Confirm domain</label>
  <input id="delete-confirm" placeholder="type the domain" autocomplete="off">
  <div class="actions dialog-actions">
    <button class="btn" onclick="document.getElementById('delete-dialog').close()">Cancel</button>
    <button class="btn btn-danger" onclick="confirmDelete()">Delete</button>
  </div>
</dialog>`;
}

export function jobView(job: InstaticJobView, logText: string): string {
  const finished = job.state === "done" || job.state === "failed";

  const site = job.state === "done"
    ? `<div class="card">
        <div class="card-header"><h2>Instance Site</h2></div>
        <dl class="kv">
          <dt>Domain</dt><dd><a href="https://${esc(job.domain)}" target="_blank" rel="noreferrer noopener">${esc(job.domain)}</a></dd>
          <dt>Version</dt><dd>${esc(job.tag)}</dd>
          <dt>Proxy target</dt><dd class="mono">127.0.0.1:${esc(String(job.port))}</dd>
          <dt>TLS</dt><dd>${job.tls ? "Let's Encrypt certificate requested" : "Self-signed or custom SSL"}</dd>
        </dl>
        <p class="hint">Your Instatic instance is running. You can open its administration interface or view the site.</p>
        <div style="margin-top: 1rem; display: flex; gap: 0.5rem;">
          <a class="btn btn-primary" href="https://${esc(job.domain)}/admin" target="_blank" rel="noreferrer noopener">Open Admin</a>
          <a class="btn" href="https://${esc(job.domain)}" target="_blank" rel="noreferrer noopener">Visit Site</a>
        </div>
      </div>`
    : "";

  return `
    <div class="page-heading">
      <div>
        <h1>Instance creation</h1>
        <p>Creating Instatic instance for ${esc(job.domain)}.</p>
      </div>
      <a class="btn" href="${BASE}/">Back to instances</a>
    </div>
    <div class="card">
      <div class="card-header"><h2>Creation Status</h2></div>
      <div class="job-summary">
        <span class="job-domain">${esc(job.domain)}</span>
        <span class="badge ${stateClass(job.state)}" id="job-state">${esc(job.state)}</span>
      </div>
      <div class="step" id="job-step" style="margin-top:0.5rem;">${esc(finished ? (job.state === "done" ? "Instance created successfully" : "Creation failed") : job.step)}</div>
      ${job.error ? `<div class="alert" style="margin-top:0.75rem;">${esc(job.error)}</div>` : ""}
      <dl class="kv job-timing" style="margin-top:0.75rem;">
        <dt>Version</dt><dd>${esc(job.tag)}</dd>
        <dt>Port</dt><dd class="mono">127.0.0.1:${esc(String(job.port))}</dd>
        <dt>Started</dt><dd>${esc(job.startedAt || job.createdAt)}</dd>
        ${job.finishedAt ? `<dt>Finished</dt><dd>${esc(job.finishedAt)}</dd>` : ""}
      </dl>
    </div>
    ${site}
    <div class="card">
      <div class="card-header"><h2>Creation Log</h2></div>
      <pre id="job-log">${esc(logText || "(no output yet)")}</pre>
    </div>
    ${finished ? "" : `<div id="job-watch" data-job="${esc(job.id)}" hidden></div>`}`;
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

  return `<div class="form-page">
<div class="page-heading"><h1>New Instatic site</h1></div>
${notice}<div class="card">
  <p class="hint">Create an Instatic site with its own CloudPanel domain.
    Point the domain's DNS at this server before continuing.</p>

  <form onsubmit="return submitCreate(event)">
    <div class="form-grid">
      <div class="form-field form-field-full">
        <label for="domain" class="required">Domain Name</label>
        <input id="domain" placeholder="pages.example.com" autocomplete="off" required aria-describedby="domain-hint"
          pattern="[a-z0-9]([a-z0-9\\-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9\\-]{0,61}[a-z0-9])?)+">
        <div class="hint" id="domain-hint">Lowercase hostname. Must already resolve to this server.</div>
      </div>
      <div class="form-field">
        <label for="tag" class="required">Instatic Version</label>
        <select id="tag" required aria-describedby="tag-hint">${options}</select>
        <div class="hint" id="tag-hint">Versions are pinned. Review release changes before updating.</div>
      </div>
      <div class="form-field">
        <label for="port">Port</label>
        <input id="port" value="${esc(nextPort)}" readonly aria-describedby="port-hint">
        <div class="hint" id="port-hint">Host reverse proxy port (mapped to internal container port 3001). Accessible only from 127.0.0.1.</div>
      </div>
    </div>
    <div class="check-field">
      <label for="tls" class="check-label">
        <input type="checkbox" id="tls" aria-describedby="tls-hint">
        <span>Request a Let's Encrypt certificate immediately</span>
      </label>
      <div class="hint" id="tls-hint">The domain must resolve to this server. You can also issue a certificate later in Site → SSL/TLS.</div>
    </div>
    <div class="form-actions">
      <a class="btn btn-lg" href="${BASE}/">Cancel</a>
      <button type="submit" class="btn btn-primary btn-lg">Create site</button>
    </div>
  </form>
</div></div>`;
}
