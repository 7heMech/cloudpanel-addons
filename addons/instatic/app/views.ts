import type { InstanceRecord } from "./db";

export function layout(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} | CloudPanel Addons</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #111827;
      --card-border: #1f2937;
      --text: #f9fafb;
      --text-muted: #9ca3af;
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --accent: #38bdf8;
      --danger: #ef4444;
      --danger-hover: #dc2626;
      --success: #10b981;
      --warning: #f59e0b;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.5;
      padding-bottom: 60px;
    }
    header {
      background: var(--card-bg);
      border-bottom: 1px solid var(--card-border);
      padding: 16px 32px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      font-weight: 700;
      font-size: 1.15rem;
      text-decoration: none;
      color: var(--text);
    }
    .brand-badge {
      background: #1e293b;
      color: var(--accent);
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 0.75rem;
      text-transform: uppercase;
      font-weight: 600;
      border: 1px solid #334155;
    }
    nav { display: flex; gap: 16px; align-items: center; }
    nav a {
      color: var(--text-muted);
      text-decoration: none;
      font-size: 0.95rem;
      font-weight: 500;
      transition: color 0.15s;
    }
    nav a:hover, nav a.active { color: var(--text); }
    .container {
      max-width: 1200px;
      margin: 40px auto;
      padding: 0 24px;
    }
    .page-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 32px;
    }
    .page-title h1 { font-size: 1.75rem; font-weight: 700; }
    .page-title p { color: var(--text-muted); font-size: 0.95rem; margin-top: 4px; }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: var(--primary);
      color: white;
      padding: 10px 18px;
      border-radius: 8px;
      text-decoration: none;
      font-weight: 600;
      font-size: 0.9rem;
      border: none;
      cursor: pointer;
      transition: background 0.15s;
    }
    .btn:hover { background: var(--primary-hover); }
    .btn-sm { padding: 6px 12px; font-size: 0.8rem; border-radius: 6px; }
    .btn-outline {
      background: transparent;
      border: 1px solid var(--card-border);
      color: var(--text);
    }
    .btn-outline:hover { background: #1e293b; }
    .btn-danger { background: var(--danger); }
    .btn-danger:hover { background: var(--danger-hover); }
    .grid-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 20px;
      margin-bottom: 32px;
    }
    .stat-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 20px;
    }
    .stat-card .label { font-size: 0.85rem; color: var(--text-muted); text-transform: uppercase; font-weight: 600; }
    .stat-card .value { font-size: 1.85rem; font-weight: 700; margin-top: 8px; color: var(--text); }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      overflow: hidden;
    }
    table { width: 100%; border-collapse: collapse; text-align: left; }
    th {
      background: #161f30;
      padding: 14px 20px;
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      border-bottom: 1px solid var(--card-border);
    }
    td {
      padding: 16px 20px;
      border-bottom: 1px solid var(--card-border);
      font-size: 0.9rem;
    }
    tr:last-child td { border-bottom: none; }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 0.8rem;
      padding: 4px 10px;
      border-radius: 9999px;
      font-weight: 600;
    }
    .status-badge.running { background: rgba(16, 185, 129, 0.15); color: #34d399; }
    .status-badge.stopped { background: rgba(239, 68, 68, 0.15); color: #f87171; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
    .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .tag-badge {
      font-family: var(--font-mono);
      background: #1e293b;
      padding: 2px 8px;
      border-radius: 6px;
      color: var(--accent);
      font-size: 0.8rem;
    }
    .form-group { margin-bottom: 20px; }
    label { display: block; font-size: 0.85rem; font-weight: 600; color: var(--text); margin-bottom: 8px; }
    input, select {
      width: 100%;
      padding: 10px 14px;
      background: #0d1321;
      border: 1px solid var(--card-border);
      border-radius: 8px;
      color: var(--text);
      font-size: 0.95rem;
    }
    input:focus, select:focus { outline: none; border-color: var(--primary); }
    .help-text { font-size: 0.8rem; color: var(--text-muted); margin-top: 6px; }
    .modal {
      display: none;
      position: fixed;
      top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.7);
      backdrop-filter: blur(4px);
      z-index: 100;
      justify-content: center;
      align-items: center;
    }
    .modal-content {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      width: 90%;
      max-width: 600px;
      padding: 24px;
      max-height: 80vh;
      overflow-y: auto;
    }
    .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .modal-header h3 { font-size: 1.25rem; }
    pre.log-box {
      background: #070a12;
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 16px;
      font-family: var(--font-mono);
      font-size: 0.8rem;
      color: #93c5fd;
      max-height: 400px;
      overflow-y: auto;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <header>
    <a href="/instatic" class="brand">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 8h10M7 12h10M7 16h6"/></svg>
      CloudPanel Addons <span class="brand-badge">Instatic</span>
    </a>
    <nav>
      <a href="/instatic">Instances</a>
      <a href="/instatic/new" class="btn btn-sm">+ New Instance</a>
      <a href="https://127.0.0.1:8443" target="_blank">Back to Panel</a>
    </nav>
  </header>
  <main class="container">
    ${content}
  </main>
</body>
</html>`;
}

export function dashboardView(instances: InstanceRecord[], nextPort: number): string {
  const runningCount = instances.filter(i => i.status === "running").length;

  const rows = instances.length === 0
    ? `<tr><td colspan="6" style="text-align:center; padding: 40px; color: var(--text-muted);">No Instatic instances found. Click "+ New Instance" to launch your first site.</td></tr>`
    : instances.map(i => `
      <tr>
        <td>
          <a href="https://${i.domain}" target="_blank" style="color: var(--accent); font-weight: 600; text-decoration: none;">
            ${i.domain} ↗
          </a>
          <div style="font-size: 0.75rem; color: var(--text-muted);">${i.container_name}</div>
        </td>
        <td><span style="font-family: var(--font-mono); color: #cbd5e1;">127.0.0.1:${i.port}</span></td>
        <td><span class="tag-badge">v${i.tag}</span></td>
        <td>
          <span class="status-badge ${i.status}">
            <span class="status-dot"></span>
            ${i.status.toUpperCase()}
          </span>
        </td>
        <td style="color: var(--text-muted); font-size: 0.8rem;">
          ${new Date(i.created_at).toLocaleDateString()}
        </td>
        <td>
          <div class="actions">
            ${i.status === "running"
              ? `<button class="btn btn-outline btn-sm" onclick="action('${i.domain}', 'stop')">Stop</button>`
              : `<button class="btn btn-outline btn-sm" onclick="action('${i.domain}', 'start')">Start</button>`
            }
            <button class="btn btn-outline btn-sm" onclick="action('${i.domain}', 'restart')">Restart</button>
            <button class="btn btn-outline btn-sm" onclick="openUpdateModal('${i.domain}', '${i.tag}')">Update</button>
            <button class="btn btn-outline btn-sm" onclick="openLogsModal('${i.domain}')">Logs</button>
            <button class="btn btn-outline btn-sm" onclick="action('${i.domain}', 'snapshot')">Snapshot</button>
            <button class="btn btn-danger btn-sm" onclick="openDeleteModal('${i.domain}')">Delete</button>
          </div>
        </td>
      </tr>
    `).join("");

  return `
    <div class="page-header">
      <div class="page-title">
        <h1>Instatic CMS Sites</h1>
        <p>Managed container instances running behind CloudPanel Reverse Proxy.</p>
      </div>
      <a href="/instatic/new" class="btn">+ Create Instatic Site</a>
    </div>

    <div class="grid-stats">
      <div class="stat-card">
        <div class="label">Total Instances</div>
        <div class="value">${instances.length}</div>
      </div>
      <div class="stat-card">
        <div class="label">Running Containers</div>
        <div class="value" style="color: #34d399;">${runningCount}</div>
      </div>
      <div class="stat-card">
        <div class="label">Next Available Port</div>
        <div class="value" style="font-family: var(--font-mono); font-size: 1.5rem;">${nextPort}</div>
      </div>
    </div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Domain & Container</th>
            <th>Binding Port</th>
            <th>Image Version</th>
            <th>Status</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>

    <!-- Modals -->
    <div id="logsModal" class="modal">
      <div class="modal-content" style="max-width: 800px;">
        <div class="modal-header">
          <h3 id="logsTitle">Container Logs</h3>
          <button class="btn btn-outline btn-sm" onclick="closeModal('logsModal')">✕</button>
        </div>
        <pre id="logContent" class="log-box">Loading logs...</pre>
      </div>
    </div>

    <div id="updateModal" class="modal">
      <div class="modal-content">
        <div class="modal-header">
          <h3>Update Instatic Version</h3>
          <button class="btn btn-outline btn-sm" onclick="closeModal('updateModal')">✕</button>
        </div>
        <p style="color: var(--text-muted); font-size: 0.85rem; margin-bottom: 16px;">
          Updates create an automatic database snapshot, pull the target tag, restart with health checks, and roll back if unready.
        </p>
        <form id="updateForm" onsubmit="submitUpdate(event)">
          <input type="hidden" id="updateDomain" name="domain">
          <div class="form-group">
            <label>Target Tag</label>
            <select id="updateTag" name="tag">
              <option value="0.0.18">0.0.18 (Latest Verified)</option>
              <option value="0.0.17">0.0.17</option>
              <option value="0.0.16">0.0.16</option>
            </select>
          </div>
          <div style="display: flex; justify-content: flex-end; gap: 8px;">
            <button type="button" class="btn btn-outline" onclick="closeModal('updateModal')">Cancel</button>
            <button type="submit" class="btn" id="updateSubmitBtn">Apply Update</button>
          </div>
        </form>
      </div>
    </div>

    <div id="deleteModal" class="modal">
      <div class="modal-content">
        <div class="modal-header">
          <h3 style="color: var(--danger);">Delete Instance</h3>
          <button class="btn btn-outline btn-sm" onclick="closeModal('deleteModal')">✕</button>
        </div>
        <p style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 16px;">
          This will archive an emergency backup to <code>/var/backups/clp-addons/instatic/</code>, delete the Docker container, and delete the CloudPanel site.
        </p>
        <p style="font-size: 0.85rem; margin-bottom: 8px;">Type domain name <b id="confirmTarget" style="color: var(--danger);"></b> to confirm:</p>
        <input type="text" id="confirmInput" placeholder="domain.com" style="margin-bottom: 16px;">
        <div style="display: flex; justify-content: flex-end; gap: 8px;">
          <button class="btn btn-outline" onclick="closeModal('deleteModal')">Cancel</button>
          <button class="btn btn-danger" id="deleteSubmitBtn" onclick="submitDelete()">Delete Instance</button>
        </div>
      </div>
    </div>

    <script>
      function closeModal(id) { document.getElementById(id).style.display = 'none'; }
      function openModal(id) { document.getElementById(id).style.display = 'flex'; }

      async function action(domain, verb) {
        if (!confirm('Perform ' + verb + ' on ' + domain + '?')) return;
        const res = await fetch('/api/instances/' + domain + '/' + verb, { method: 'POST' });
        const json = await res.json();
        if (json.ok) {
          window.location.reload();
        } else {
          alert('Error: ' + (json.error || 'Action failed'));
        }
      }

      async function openLogsModal(domain) {
        document.getElementById('logsTitle').innerText = 'Logs: ' + domain;
        document.getElementById('logContent').innerText = 'Fetching logs...';
        openModal('logsModal');
        const res = await fetch('/api/instances/' + domain + '/logs');
        const text = await res.text();
        document.getElementById('logContent').innerText = text;
      }

      function openUpdateModal(domain, currentTag) {
        document.getElementById('updateDomain').value = domain;
        openModal('updateModal');
      }

      async function submitUpdate(e) {
        e.preventDefault();
        const domain = document.getElementById('updateDomain').value;
        const tag = document.getElementById('updateTag').value;
        const btn = document.getElementById('updateSubmitBtn');
        btn.disabled = true;
        btn.innerText = 'Updating & Health Checking...';

        try {
          const res = await fetch('/api/instances/' + domain + '/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag })
          });
          const json = await res.json();
          if (json.ok) {
            alert('Instance updated successfully to ' + tag);
            window.location.reload();
          } else {
            alert('Update Failed: ' + json.error);
            btn.disabled = false;
            btn.innerText = 'Apply Update';
          }
        } catch (err) {
          alert('Update error: ' + err.message);
          btn.disabled = false;
          btn.innerText = 'Apply Update';
        }
      }

      let activeDeleteDomain = '';
      function openDeleteModal(domain) {
        activeDeleteDomain = domain;
        document.getElementById('confirmTarget').innerText = domain;
        document.getElementById('confirmInput').value = '';
        openModal('deleteModal');
      }

      async function submitDelete() {
        const input = document.getElementById('confirmInput').value.trim();
        if (input !== activeDeleteDomain) {
          alert('Domain confirmation does not match');
          return;
        }
        const btn = document.getElementById('deleteSubmitBtn');
        btn.disabled = true;
        btn.innerText = 'Deleting...';

        const res = await fetch('/api/instances/' + activeDeleteDomain + '/delete', { method: 'POST' });
        const json = await res.json();
        if (json.ok) {
          window.location.reload();
        } else {
          alert('Delete failed: ' + json.error);
          btn.disabled = false;
          btn.innerText = 'Delete Instance';
        }
      }
    </script>
  `;
}

export function newInstanceView(nextPort: number, tags: string[]): string {
  const tagOptions = tags.map(t => `<option value="${t}">${t}${t === "0.0.18" ? " (Recommended)" : ""}</option>`).join("");

  return `
    <div class="page-header">
      <div class="page-title">
        <h1>Create Instatic Site</h1>
        <p>Launches an isolated Docker container and configures CloudPanel Reverse Proxy.</p>
      </div>
    </div>

    <div class="card" style="max-width: 680px; padding: 32px;">
      <form id="createForm" onsubmit="submitCreate(event)">
        <div class="form-group">
          <label for="domain">Domain Name</label>
          <input type="text" id="domain" name="domain" placeholder="cms.example.com" required
                 pattern="^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$">
          <div class="help-text">Lowercase domain format only. CloudPanel reverse proxy will route traffic here.</div>
        </div>

        <div class="form-group">
          <label for="tag">Instatic Image Version</label>
          <select id="tag" name="tag">
            ${tagOptions}
          </select>
          <div class="help-text">Specific pinned tag from ghcr.io/corebunch/instatic. :latest is forbidden.</div>
        </div>

        <div class="form-group">
          <label for="port">Internal Port Allocation</label>
          <input type="number" id="port" name="port" value="${nextPort}" readonly style="background: #1e293b; cursor: not-allowed;">
          <div class="help-text">Automatically allocated from reserved block 39000..39999. Bound only to 127.0.0.1.</div>
        </div>

        <div class="form-group">
          <label for="siteUser">Site User (Optional)</label>
          <input type="text" id="siteUser" name="siteUser" placeholder="Auto-generated if left blank">
          <div class="help-text">Linux user created by CloudPanel to isolate site permissions.</div>
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 12px; margin-top: 32px;">
          <a href="/instatic" class="btn btn-outline">Cancel</a>
          <button type="submit" class="btn" id="submitBtn">Launch Instatic Site</button>
        </div>
      </form>
    </div>

    <script>
      async function submitCreate(e) {
        e.preventDefault();
        const btn = document.getElementById('submitBtn');
        const domain = document.getElementById('domain').value.trim();
        const tag = document.getElementById('tag').value;
        const siteUser = document.getElementById('siteUser').value.trim();

        btn.disabled = true;
        btn.innerText = 'Creating CloudPanel Site & Booting Container...';

        try {
          const res = await fetch('/api/instances', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain, tag, siteUser: siteUser || undefined })
          });
          const json = await res.json();
          if (json.ok) {
            alert('Instatic site created and running for ' + domain + '!');
            window.location.href = '/instatic';
          } else {
            alert('Creation Error: ' + (json.error || 'Failed to create instance'));
            btn.disabled = false;
            btn.innerText = 'Launch Instatic Site';
          }
        } catch (err) {
          alert('Request failed: ' + err.message);
          btn.disabled = false;
          btn.innerText = 'Launch Instatic Site';
        }
      }
    </script>
  `;
}
