import CLIENT_BODY from "./views.client.js" with { type: "text" };
import CSS from "./views.css" with { type: "text" };
import { esc } from "../../../lib/app-http";
import {
  FLEET_FOOTER_HTML, FLEET_ROW_SELECTION_JS, fleetFilterHtml, fleetRowSelectionStyle, JOB_PROGRESS_JS, JOB_PROGRESS_STYLE, jobProgressHtml, renderLayout, whenText,
} from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import { siteTypeLabel } from "../../../lib/site-context";
import type { ArchiveJobView, ArchiveState } from "../action";

const BASE = mountPath("archive");
const STYLE = `${JOB_PROGRESS_STYLE}${CSS}${fleetRowSelectionStyle("archive-site-table")}`;
const CLIENT = `${FLEET_ROW_SELECTION_JS}\n${JOB_PROGRESS_JS}\n${CLIENT_BODY}`;

export function layout(title: string, content: string, notice?: { current: string; latest: string } | null): string {
  return renderLayout(title, content, { brand: "Archive Sites", base: BASE, nav: [], css: STYLE, script: CLIENT, updateNotice: notice });
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

const runs = (type: string, application: string): string => application && !["Static", "ReverseProxy"].includes(application) ? application : siteTypeLabel(type);

const JOB_TITLES: Record<ArchiveJobView["task"], string> = { archive: "Archiving", restore: "Restoring", delete: "Deleting an archive" };
const DONE: Record<ArchiveJobView["task"], string> = { archive: "Archived", restore: "Restored", delete: "Deleted the archive of" };

function lastJob(job: ArchiveJobView | null): string {
  if (!job?.result && job?.state !== "failed") return "";
  const result = job.result;
  const name = (target: string) => target.replace(/--\d{8}T\d{6}Z$/, "");
  const lines = [
    ...result?.done.length ? [`${DONE[job.task]} ${result.done.map(name).join(", ")}.`] : [],
    ...result?.failed.map((entry) => `${name(entry.target)}: ${entry.error}`) ?? (job.error ? [job.error] : []),
    ...result?.notes ?? [],
  ];
  const tone = job.state === "failed" || result?.failed.length ? "alert" : result?.notes.length ? "notice" : "alert alert-ok";
  return `<div class="${tone} archive-last" role="status">${lines.map(esc).join("<br>")}</div>`;
}

function siteRow(site: ArchiveState["sites"][number]): string {
  return `<tr data-domain="${esc(site.domain)}" tabindex="0" aria-selected="false" onclick="toggleSiteSelection(event, this)" onkeydown="toggleSiteSelection(event, this)">
    <td class="site-select"><input class="site-checkbox" type="checkbox" onchange="paintFleetSelection()" aria-label="Select ${esc(site.domain)}"${site.blocked ? " disabled" : ""}></td>
    <td class="site-cell"><strong>${esc(site.domain)}</strong>${site.blocked ? `<span class="hint">${esc(site.blocked)}</span>` : ""}</td>
    <td class="type-cell">${esc(runs(site.type, site.application))}</td>
    <td data-label="Databases" class="numeric">${site.databases}</td>
  </tr>`;
}

function archiveRow(archive: ArchiveState["archives"][number]): string {
  const redirect = archive.redirect
    ? `<span class="hint">${archive.redirect.applied ? "Redirects" : "Redirect waits"} → ${esc(archive.redirect.target.replace(/^https?:\/\//, ""))}</span>` : "";
  return `<tr data-archive="${esc(archive.id)}">
    <td class="site-cell"><strong>${esc(archive.domain)}</strong>${redirect}</td>
    <td data-label="Archived">${esc(whenText(archive.archivedAt))}${archive.restoredAt ? `<span class="hint">Restored ${esc(whenText(archive.restoredAt))}</span>` : ""}</td>
    <td data-label="Runs">${esc(runs(archive.type, archive.application))}<span class="hint">${esc(archive.databases.length ? plural(archive.databases.length, "database") : "No database")}</span></td>
    <td data-label="Size" class="numeric">${esc(size(archive.bytes))}</td>
    <td data-label="Actions" class="action-cell"><div class="actions">
      <button class="btn" type="button" onclick="archiveRestore('${esc(archive.id)}')">Restore</button>
      <button class="btn btn-danger" type="button" onclick="archiveDelete('${esc(archive.id)}')">Delete</button>
    </div></td>
  </tr>`;
}

export function dashboardView(state: ArchiveState): string {
  return `<div id="archive-root">${dashboardContent(state)}</div>${dialog(state)}`;
}

/** Everything a job can change, repainted in place when it ends. */
export function dashboardContent(state: ArchiveState): string {
  const data = JSON.stringify(state).replaceAll("<", "\\u003c");
  const sites = state.sites.map(siteRow).join("");
  return `<script type="application/json" id="archive-state">${data}</script>
    <div class="page-heading"><div><h1>Archive Sites</h1>
      <p>Take a final backup of a site and delete it. Restore it from the archive whenever it is needed again.</p></div></div>
    ${state.job ? jobProgressHtml(state.job, JOB_TITLES[state.job.task]) : ""}${state.job ? "" : lastJob(state.lastJob)}
    <div class="card card-table">
      ${state.sites.length ? `<div class="card-header toolbar">
        <h2>Sites</h2>
        <span class="toolbar-note" id="site-selection">No sites selected</span>
        <button class="btn mobile-select-all" id="select-all-btn" type="button" onclick="toggleAllSites()">Select all</button>
        <button class="btn btn-danger toolbar-end" type="button" disabled data-needs-selection onclick="archiveOpen()"${state.job ? " data-busy" : ""}>Archive selected</button>
      </div>
      ${fleetFilterHtml({ count: state.sites.length, summary: plural(state.sites.length, "site") })}
      <div class="table-scroll"><table class="fleet-table archive-site-table"><thead><tr>
        <th class="site-select"><input id="select-all" type="checkbox" onchange="selectAllSites(this.checked)" aria-label="Select all sites"></th>
        <th>Site</th><th>Runs</th><th class="numeric">Databases</th>
      </tr></thead><tbody>${sites}</tbody></table></div>
      ${FLEET_FOOTER_HTML}` : '<div class="card-header"><h2>Sites</h2></div><div class="empty">CloudPanel has no sites to archive.</div>'}
    </div>
    <div class="card card-table"><div class="card-header"><div><h2>Archives</h2>
      <p class="hint">Each holds the site's home directory and databases, root-only on this server under /var/backups/clp-addons/archive.</p></div></div>
      ${state.archives.length ? `<div class="table-scroll"><table class="fleet-table archive-table"><thead><tr>
        <th>Site</th><th>Archived</th><th>Runs</th><th class="numeric">Size</th><th class="action-cell">Actions</th>
      </tr></thead><tbody>${state.archives.map(archiveRow).join("")}</tbody></table></div>` : '<div class="empty">No archives yet.</div>'}
    </div>`;
}

function dialog(state: ArchiveState): string {
  const redirect = state.dns ? `<label class="archive-switch-row"><span class="switch"><input type="checkbox" name="redirect" onchange="archiveSyncRedirect()"><span></span></span>
      <span><strong>Then redirect each domain</strong><span class="hint">DNS keeps its zone and mail records, and points its web names to the redirect.</span></span></label>
    <div class="form-grid" id="archive-redirect-fields" hidden>
      <div class="form-field"><label for="archive-target">Redirect to</label><input id="archive-target" name="target" type="url" placeholder="https://example.com" autocomplete="off" spellcheck="false"></div>
      <div class="form-field"><label for="archive-status">Status</label><select id="archive-status" name="status"><option value="301">301 Moved permanently</option><option value="302">302 Found (temporary)</option></select></div>
    </div>
    <label class="archive-switch-row" id="archive-keep-path" hidden><span class="switch"><input type="checkbox" name="keepPath" checked><span></span></span>
      <span><strong>Keep path</strong><span class="hint">/about on the old domain goes to /about on the target.</span></span></label>` : "";
  return `<dialog id="archive-dialog" aria-labelledby="archive-heading"><form id="archive-form" onsubmit="archiveStart(event)">
    <div class="dialog-header"><h2 id="archive-heading">Archive sites</h2></div>
    <p>Each site's home directory and databases are backed up and read back, then the site is deleted from CloudPanel.</p>
    <ul class="archive-list" id="archive-list"></ul>
    ${redirect}
    <div class="actions dialog-actions"><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button>
      <button class="btn btn-danger" type="submit" id="archive-submit">Archive and delete</button></div>
  </form></dialog>`;
}
