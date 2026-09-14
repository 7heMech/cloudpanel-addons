import { esc } from "../../../lib/app-http";
import { renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { CloudflareState } from "./service";

const BASE = mountPath("cloudflare-ips");

const STYLE = `
.bulk-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.site-select { width: 42px; text-align: center; }
.site-select input, .site-toggle input { width: 18px; height: 18px; margin: 0; }
.site-toggle { display: inline-flex; align-items: center; gap: 9px; font-weight: 600; }
.site-toggle input { accent-color: var(--primary); }
.policy-card { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
.policy-card h2 { margin: 0 0 8px; }
.policy-card p { margin: 0; }
.policy-switch { display: inline-flex; align-items: center; gap: 10px; white-space: nowrap; font-weight: 600; }
.policy-switch input { width: 20px; height: 20px; accent-color: var(--primary); }
.status-on { color: var(--ok); }
.status-off { color: var(--muted); }
@media (max-width: 600px) {
  .policy-card { flex-direction: column; }
}
`;

export const CLIENT_JS = `
function selectedDomains() {
  return Array.from(document.querySelectorAll('.site-checkbox:checked')).map(function (box) {
    return box.getAttribute('data-domain');
  }).filter(Boolean);
}

function syncSelectAll() {
  const boxes = Array.from(document.querySelectorAll('.site-checkbox'));
  const all = document.getElementById('select-all');
  if (!all) return;
  const selected = boxes.filter(function (box) { return box.checked; }).length;
  all.checked = boxes.length > 0 && selected === boxes.length;
  all.indeterminate = selected > 0 && selected < boxes.length;
}

function selectAllSites(checked) {
  document.querySelectorAll('.site-checkbox').forEach(function (box) { box.checked = checked; });
  syncSelectAll();
}

async function setDomains(domains, enabled) {
  if (!domains.length) { alert('Select at least one site.'); return false; }
  busy(true);
  try {
    await call('/api/sites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domains: domains, enabled: enabled }),
    });
    location.reload();
    return true;
  } catch (error) {
    busy(false);
    alert('Could not update the Cloudflare setting: ' + error.message);
    return false;
  }
}

function setSelected(enabled) {
  setDomains(selectedDomains(), enabled);
}

async function setOne(input) {
  const domain = input.getAttribute('data-domain');
  const enabled = input.checked;
  input.disabled = true;
  if (!await setDomains(domain ? [domain] : [], enabled)) {
    input.checked = !enabled;
    input.disabled = false;
  }
}

async function setAutomatic(input) {
  input.disabled = true;
  busy(true);
  try {
    await call('/api/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: input.checked }),
    });
    location.reload();
  } catch (error) {
    input.checked = !input.checked;
    input.disabled = false;
    busy(false);
    alert('Could not update the automatic policy: ' + error.message);
  }
}
`;

function typeLabel(type: string): string {
  if (type === "php") return "PHP";
  if (type === "static") return "Static";
  if (type === "reverse-proxy") return "Reverse proxy";
  if (type === "nodejs") return "Node.js";
  if (type === "python") return "Python";
  return type;
}

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
  const rows = state.sites.map((site) => `
    <tr>
      <td class="site-select"><input class="site-checkbox" type="checkbox" data-domain="${esc(site.domain)}" onchange="syncSelectAll()" aria-label="Select ${esc(site.domain)}"></td>
      <td><strong>${esc(site.domain)}</strong>${site.excludedFromAutomatic && state.autoEnableNewSites
        ? '<div class="hint">Excluded from automatic enabling</div>' : ""}</td>
      <td>${esc(typeLabel(site.type))}</td>
      <td>
        <label class="site-toggle ${site.enabled ? "status-on" : "status-off"}">
          <input type="checkbox" data-domain="${esc(site.domain)}" ${site.enabled ? "checked" : ""} onchange="setOne(this)">
          <span>${site.enabled ? "On" : "Off"}</span>
        </label>
      </td>
    </tr>`).join("");

  return `
    <div class="page-heading">
      <div><h1>Cloudflare IP access</h1><p>Control CloudPanel's “Allow traffic from Cloudflare only” setting for every site.</p></div>
    </div>
    <div class="card">
      <div class="stats">
        <div class="stat"><div class="label">Sites</div><div class="value">${state.sites.length}</div></div>
        <div class="stat"><div class="label">Cloudflare only</div><div class="value">${enabled}</div></div>
      </div>
    </div>
    <div class="card policy-card">
      <div>
        <h2>Enable on new sites</h2>
        <p>Apply the setting automatically within about one minute after a site is created.</p>
        <p class="hint">Existing sites stay unchanged. A site you turn off here remains excluded.</p>
      </div>
      <label class="policy-switch">
        <input id="automatic-policy" type="checkbox" ${state.autoEnableNewSites ? "checked" : ""} onchange="setAutomatic(this)">
        <span>${state.autoEnableNewSites ? "On" : "Off"}</span>
      </label>
    </div>
    <div class="card card-table">
      ${state.sites.length === 0
        ? '<div class="empty">No sites found in CloudPanel.</div>'
        : `<div class="card-header bulk-actions">
            <button class="btn btn-primary" type="button" onclick="setSelected(true)">Enable selected</button>
            <button class="btn" type="button" onclick="setSelected(false)">Disable selected</button>
          </div>
          <table>
            <thead><tr>
              <th scope="col" class="site-select"><input id="select-all" type="checkbox" onchange="selectAllSites(this.checked)" aria-label="Select all sites"></th>
              <th scope="col">Site</th><th scope="col">Type</th><th scope="col">Cloudflare only</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>`}
    </div>`;
}
