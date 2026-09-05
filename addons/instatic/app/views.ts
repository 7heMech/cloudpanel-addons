// Server-rendered HTML. Every interpolated value goes through esc() or escJs():
// instance domains and container states originate outside this process, and the
// page is served to an authenticated operator whose session can create and
// delete sites.

import { esc, escJs } from "./http";
import type { InstanceView } from "./service";
import type { SanitizedSite } from "../../../lib/snapshot-reader";

const STYLE = `
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

const CLIENT_JS = `
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
  document.getElementById('update-tag').value = '';
  document.getElementById('update-dialog').showModal();
}

async function confirmUpdate() {
  const tag = document.getElementById('update-tag').value.trim();
  if (!/^\\d+\\.\\d+\\.\\d+$/.test(tag)) { alert('Enter an exact version, for example 0.0.18'); return; }
  document.getElementById('update-dialog').close();
  busy(true);
  const res = await fetch('/api/instances/' + encodeURIComponent(pendingUpdate) + '/update', {
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
    ((body && body.error) || 'update failed') + (logs ? '\n\n--- container logs ---\n' + logs : '');
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
    location.href = '/';
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
    location.href = '/';
  } catch (e) {
    busy(false);
    status.textContent = '';
    alert('Create failed: ' + e.message);
  }
  return false;
}
`;

export function layout(title: string, content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>Instatic</h1>
  <span class="spacer"></span>
  <a href="/">Instances</a>
  <a href="/new">New site</a>
</header>
<main>${content}</main>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}

function stateClass(state: string): string {
  const known = ["running", "exited", "created", "paused", "absent", "unknown"];
  return known.includes(state) ? `state-${state}` : "state-unknown";
}

export function dashboardView(
  instances: InstanceView[],
  nextPort: number,
  snapshotAge: number,
  panelSites: SanitizedSite[] = []
): string {
  const running = instances.filter((i) => i.state === "running").length;

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
    <div class="mono" style="color:var(--muted)">${esc(i.container_name)}</div>
  </td>
  <td class="mono">127.0.0.1:${esc(i.port)}</td>
  <td><span class="badge">${esc(i.tag)}</span></td>
  <td><span class="badge ${stateClass(i.state)}">${esc(i.state)}</span></td>
  <td class="actions">
    ${
      i.state === "running"
        ? `<button class="btn" onclick="act('${escJs(i.domain)}','stop')">Stop</button>`
        : `<button class="btn" onclick="act('${escJs(i.domain)}','start')">Start</button>`
    }
    <button class="btn" onclick="act('${escJs(i.domain)}','restart')">Restart</button>
    <button class="btn" onclick="askUpdate('${escJs(i.domain)}','${escJs(i.tag)}')">Update</button>
    <button class="btn" onclick="act('${escJs(i.domain)}','snapshot')">Snapshot</button>
    <button class="btn" onclick="showLogs('${escJs(i.domain)}')">Logs</button>
    <button class="btn btn-danger" onclick="askDelete('${escJs(i.domain)}')">Delete</button>
  </td>
</tr>`
    )
    .join("\n");

  return `${staleNotice}
<div class="card stats">
  <div class="stat"><div class="label">Instances</div><div class="value">${instances.length}</div></div>
  <div class="stat"><div class="label">Running</div><div class="value" style="color:var(--ok)">${running}</div></div>
  <div class="stat"><div class="label">Next port</div><div class="value mono">${esc(nextPort)}</div></div>
</div>

<div class="card">
  ${
    instances.length === 0
      ? `<div class="empty">No Instatic instances yet. <a href="/new">Create one</a>.</div>`
      : `<table>
    <thead><tr><th>Site</th><th>Bound to</th><th>Version</th><th>State</th><th>Actions</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`
  }
</div>

<details class="card">
  <summary style="cursor:pointer;color:var(--muted)">
    All CloudPanel sites on this server (${panelSites.length}) — from the sanitized snapshot
  </summary>
  <p class="hint">Read-only. Written by the privileged side; the manager never reads the panel
    database itself. Useful for checking a hostname is free before creating an instance.</p>
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
  <input id="update-tag" placeholder="0.0.18" autocomplete="off">
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

export function newInstanceView(nextPort: number, tags: string[]): string {
  const options = tags.map((t, idx) =>
    `<option value="${esc(t)}"${idx === 0 ? " selected" : ""}>${esc(t)}${idx === 0 ? " (latest)" : ""}</option>`
  ).join("");

  return `<div class="card">
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
      <a class="btn" href="/">Cancel</a>
    </div>
    <div class="hint" id="create-status" style="margin-top:0.75rem"></div>
  </form>
</div>`;
}
