import { esc } from "../../../lib/app-http";
import { renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import { applicationLabel, certificateLabel, SELF_SIGNED_CERTIFICATE } from "../action";
import type { PanelTweaks, PanelTweaksState, TweakSiteView } from "../action";

const BASE = mountPath("panel-tweaks");

// Cards, switches, badges, the fleet table and its narrow-screen layout are in
// lib/app-ui; only the two rows this page alone draws are here.
const STYLE = `
.tweak-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px;
  padding: 22px 0; border-top: 1px solid var(--row-border); }
.tweak-list > .tweak-row:first-child { padding-top: 0; border-top: 0; }
.tweak-list > .tweak-row:last-child { padding-bottom: 0; }
.tweak-row h3 { margin: 0 0 6px; font-size: 16px; }
.tweak-row p { margin: 0; color: var(--muted); font-size: 14px; }
.tweak-row .switch { margin-top: 4px; }
.scan-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
.scan-row p { margin: 0; }
.size-cell { font-variant-numeric: tabular-nums; white-space: nowrap; }
@media (max-width: 600px) {
  .tweak-row { flex-wrap: wrap; }
}
`;

const SCRIPT = `
async function setTweak(input) {
  const key = input.dataset.tweak;
  const wanted = input.checked;
  clearNotice();
  busy(true);
  try {
    const reply = await call('/api/tweaks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: wanted }),
    });
    reloadWith('Saved.', 'ok');
  } catch (error) {
    input.checked = !wanted;
    busy(false);
    notify(error.message, 'error');
  }
}

async function measureNow(button) {
  clearNotice();
  busy(true);
  notify('Measuring every site. This reads the whole disk, so it can take a while.', 'warn');
  try {
    const reply = await call('/api/scan', { method: 'POST' });
    const data = reply.data || {};
    const skipped = data.skipped ? ', ' + data.skipped + ' skipped' : '';
    reloadWith(data.measured + (data.measured === 1 ? ' site measured' : ' sites measured') + skipped + '.', 'ok');
  } catch (error) {
    busy(false);
    notify(error.message, 'error');
  }
}

const FLASH_KEY = 'clp-panel-tweaks-flash';

function reloadWith(message, kind) {
  try { sessionStorage.setItem(FLASH_KEY, JSON.stringify({ message: message, kind: kind })); } catch (e) {}
  location.reload();
}

(function showCarriedFlash() {
  let carried = null;
  try {
    carried = sessionStorage.getItem(FLASH_KEY);
    if (carried) sessionStorage.removeItem(FLASH_KEY);
  } catch (e) { return; }
  if (!carried) return;
  try {
    const flash = JSON.parse(carried);
    notify(flash.message, flash.kind);
  } catch (e) {}
})();
`;

export function layout(
  title: string,
  content: string,
  updateNotice?: { current: string; latest: string } | null,
): string {
  return renderLayout(title, content, {
    brand: "Panel UI tweaks",
    base: BASE,
    nav: [],
    css: STYLE,
    script: SCRIPT,
    updateNotice,
  });
}

interface TweakCopy {
  key: keyof PanelTweaks;
  title: string;
  description: string;
}

/**
 * What each switch does, said in terms of what the operator will see change.
 * The order is the order of cost: the Sites page, then the rest of the panel,
 * then the whole disk.
 */
const COPY: TweakCopy[] = [
  {
    key: "sitesTable",
    title: "Search, sort and extra columns on Sites",
    description: "Adds a site count beside the Sites heading, a search box and application filter, sortable columns, and columns for SSL, runtime, size, creation date, Cloudflare-only and Varnish. The Columns button beside the search picks which are shown, the panel's own Site user and Type included; the choice is the browser's, and a phone keeps a shorter set than a desktop.",
  },
  {
    key: "sitesMobile",
    title: "Sites list as cards on a phone",
    description: "On a narrow screen the Sites table becomes one card per site: the hostname on the first line, the type beside it when that column is on, and the rest of the columns labelled beneath. Off, the table scrolls sideways as CloudPanel drew it.",
  },
  {
    key: "actionMenu",
    title: "Row actions in a menu",
    description: "Collects the links in the Sites table's last column — Manage, and whatever other addons put there — behind a single button on each row.",
  },
  {
    key: "panelMobile",
    title: "CloudPanel's own pages on a phone",
    description: "The panel's header wraps onto a second row instead of putting the Admin Area link and the avatar off the side, and the Dashboard's charts fit the screen instead of running past it.",
  },
  {
    key: "deviceTheme",
    title: "Device theme on first visit",
    description: "On the first visit to the CloudPanel login page, the theme follows the device's light or dark preference. After that CloudPanel's own switch owns it.",
  },
  {
    key: "diskUsage",
    title: "Measured site sizes",
    description: "Adds a size column filled by a sweep that runs with the fifteen-minute repair. The sweep reads every site's home directory and its databases, at the lowest I/O priority.",
  },
];

function switchRow(copy: TweakCopy, on: boolean): string {
  return `
      <div class="tweak-row">
        <div>
          <h3>${esc(copy.title)}</h3>
          <p>${esc(copy.description)}</p>
        </div>
        <label class="switch" title="${esc(copy.title)}">
          <input type="checkbox" data-tweak="${esc(copy.key)}" onchange="setTweak(this)"${on ? " checked" : ""}
            aria-label="${esc(copy.title)}">
          <span></span>
        </label>
      </div>`;
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function humanBytes(bytes: number): string {
  let size = Number.isFinite(bytes) ? bytes : 0;
  let unit = 0;
  while (size >= 1024 && unit < UNITS.length - 1) {
    size /= 1024;
    unit++;
  }
  if (unit === 0) return `${Math.round(size)} B`;
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${UNITS[unit]}`;
}

/** How long ago something happened, in the words a status line would use. */
export function sinceText(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "never";
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function certificateCell(site: TweakSiteView): string {
  if (!site.certificate) return '<span class="badge state-absent">None</span>';
  const label = certificateLabel(site.certificate.type);
  // The certificate CloudPanel gives every new site. Naming it without a
  // countdown keeps the column about which sites a browser actually trusts.
  if (site.certificate.type === SELF_SIGNED_CERTIFICATE) return `<span class="badge">${esc(label)}</span>`;
  const expires = Date.parse(site.certificate.expiresAt.replace(" ", "T") + "Z");
  if (!Number.isFinite(expires)) return `<span class="badge state-done">${esc(label)}</span>`;
  const days = Math.floor((expires - Date.now()) / 86400000);
  const state = days < 0 ? "state-failed" : days < 14 ? "state-exited" : "state-done";
  const note = days < 0 ? "expired" : `${days}d left`;
  return `<span class="badge ${state}">${esc(label)} · ${esc(note)}</span>`;
}

function diskCell(site: TweakSiteView, on: boolean): string {
  if (!on) return '<span class="hint">off</span>';
  if (!site.disk) return '<span class="hint">not measured</span>';
  const total = site.disk.bytes + site.disk.databaseBytes;
  const detail = site.disk.databaseBytes
    ? `files ${humanBytes(site.disk.bytes)}, databases ${humanBytes(site.disk.databaseBytes)}`
    : `files ${humanBytes(site.disk.bytes)}`;
  return `<span title="${esc(detail)}">${esc(humanBytes(total))}</span>`;
}

function siteRow(site: TweakSiteView, tweaks: PanelTweaks): string {
  return `
              <tr>
                <td class="site-cell">${esc(site.domain)}</td>
                <td class="type-cell">${esc(applicationLabel(site.application, site.type))}</td>
                <td data-label="Runtime">${site.runtime ? esc(site.runtime) : '<span class="hint">—</span>'}</td>
                <td data-label="SSL">${certificateCell(site)}</td>
                <td class="size-cell" data-label="Size">${diskCell(site, tweaks.diskUsage)}</td>
              </tr>`;
}

function sitesCard(state: PanelTweaksState): string {
  if (state.sites.length === 0) {
    return `
    <div class="card card-table">
      <div class="card-header"><h2>Sites</h2></div>
      <div class="empty">CloudPanel has no sites yet.</div>
    </div>`;
  }
  return `
    <div class="card card-table">
      <div class="card-header">
        <h2>Sites</h2>
        <span class="toolbar-note">${state.sites.length} site${state.sites.length === 1 ? "" : "s"}</span>
      </div>
      <div class="table-scroll">
        <table class="fleet-table">
          <thead>
            <tr>
              <th>Domain</th>
              <th>Application</th>
              <th>Runtime</th>
              <th>SSL</th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody>${state.sites.map((site) => siteRow(site, state.tweaks)).join("")}
          </tbody>
        </table>
      </div>
    </div>`;
}

function diskCard(state: PanelTweaksState): string {
  if (!state.tweaks.diskUsage) return "";
  const measured = state.sites.filter((site) => site.disk).length;
  return `
    <div class="card">
      <div class="card-header"><h2>Measured sizes</h2></div>
      <div class="scan-row">
        <p>${measured === 0
          ? "Nothing measured yet. The first sweep runs with the next repair, within fifteen minutes."
          : `${measured} of ${state.sites.length} site${state.sites.length === 1 ? "" : "s"} measured, ${esc(sinceText(state.diskMeasuredAt))}.`}</p>
        <button class="btn" type="button" onclick="measureNow(this)">Measure now</button>
      </div>
    </div>`;
}

export function dashboardView(state: PanelTweaksState): string {
  return `
    <div class="page-heading">
      <div>
        <h1>Panel UI tweaks</h1>
        <p>Additions to CloudPanel's own pages. Each one can be switched off on its own.</p>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><h2>What it adds</h2></div>
      <div class="tweak-list">${COPY.map((copy) => switchRow(copy, state.tweaks[copy.key])).join("")}
      </div>
    </div>${diskCard(state)}${sitesCard(state)}`;
}
