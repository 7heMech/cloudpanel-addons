// Server-rendered HTML. Every interpolated value goes through esc() or escJs():
// instance domains and container states originate outside this process, and the
// page is served to an authenticated operator whose session can create and
// delete sites.

import { esc, escJs } from "../../../lib/app-http";
import {
  FLEET_FOOTER_HTML, FLEET_ROW_SELECTION_JS, JOB_STYLE, JOB_WATCH_JS, fleetFilterHtml, fleetRowSelectionStyle, jobStateClass, jobStateLabel,
  renderLayout, whenText,
} from "../../../lib/app-ui";
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

// Only what the shared shell does not carry. Everything else -- the palette,
// the cards, the table, the badges -- lives in lib/app-ui.ts, so a second addon
// does not have to choose between copying it and looking like another product.
import STYLE from "./views.css" with { type: "text" };

/**
 * The dashboard's inline script.
 *
 * Exported only so tests/test-app.test.ts can parse it.
 */
import CLIENT_JS from "./views.client.js" with { type: "text" };
export { CLIENT_JS };

/** Renders Instatic content inside the shared addon manager chrome. */
export function layout(
  title: string,
  content: string,
  updateNotice?: { current: string; latest: string } | null,
  admin = true,
): string {
  return renderLayout(title, content, {
    brand: "Instatic CMS",
    base: BASE,
    nav: [],
    css: STYLE + JOB_STYLE + fleetRowSelectionStyle("instatic-table"),
    script: JOB_WATCH_JS + FLEET_ROW_SELECTION_JS + CLIENT_JS,
    updateNotice,
    admin,
  });
}

function stateClass(state: string): string {
  const known = ["running", "exited", "created", "paused", "absent", "unknown"];
  return known.includes(state) ? `state-${state}` : "state-unknown";
}

/** The newest job for each domain. */
function newestJobs(jobs: InstaticJobView[]): Map<string, InstaticJobView> {
  const newest = new Map<string, InstaticJobView>();
  for (const job of jobs) {
    const seen = newest.get(job.domain);
    if (!seen || job.createdAt > seen.createdAt) newest.set(job.domain, job);
  }
  return newest;
}

const active = (job: InstaticJobView | undefined) => job?.state === "queued" || job?.state === "running";

/**
 * Creations still worth a row of their own: the newest job for each domain
 * while it is queued or running, or failed with no instance to show for it.
 * An update shows on its instance's row instead.
 */
export function pendingCreations(jobs: InstaticJobView[], instances: InstanceView[]): InstaticJobView[] {
  return [...newestJobs(jobs).values()]
    .filter((job) => job.kind !== "update")
    .filter((job) => active(job) || (job.state === "failed" && !instances.some((i) => i.domain === job.domain)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const STATE_LABELS: Record<string, string> = { running: "Running", exited: "Stopped", created: "Created", paused: "Paused" };

/** Renders the Instatic dashboard: creations in progress, then every instance. */
export function dashboardView(
  instances: InstanceView[],
  available: AvailableTags = { tags: [], source: "fallback", latest: null },
  jobs: InstaticJobView[] = [],
): string {
  // Only a list that actually came from the registry may claim an instance is
  // behind. The offline fallback is one hardcoded version, and badging every
  // instance against it would invent updates that do not exist.
  const latest = available.source === "fallback" ? null : available.latest;
  // An instance whose site is gone is only ever deleted, so it is never behind.
  const behindOf = (i: InstanceView) => i.panelSite !== false && latest !== null && isNewerThan(latest, i.tag);
  const outdated = instances.filter(behindOf).length;
  const creations = pendingCreations(jobs, instances);
  const newest = newestJobs(jobs);
  const working = jobs.some(active);

  const jobRows = creations.map((job) => `<tr>
  <td class="site-select"></td>
  <td class="site-cell wide-cell"><a href="${BASE}/jobs/${esc(job.id)}">${esc(job.domain)}</a></td>
  <td data-label="Version"><span class="badge">${esc(job.tag)}</span></td>
  <td data-label="State">
    <span class="badge ${jobStateClass(job.state)}">${esc(jobStateLabel(job.state))}</span>
    ${job.state === "failed" ? "" : `<div class="hint">${esc(job.step)}</div>`}
  </td>
  <td class="action-cell"><a href="${BASE}/jobs/${esc(job.id)}">View</a></td>
</tr>`).join("\n");

  const rows = instances
    .map((i) => {
      const missing = i.panelSite === false;
      const behind = behindOf(i);
      const d = escJs(i.domain);
      const job = newest.get(i.domain);
      const updating = job?.kind === "update" && active(job) ? job : null;
      // A failed update left the instance on its old version; say so until another update replaces the record.
      const failedUpdate = job?.kind === "update" && job.state === "failed" && job.tag !== i.tag ? job : null;
      const update = updating ? ""
        : latest === null ? `<button class="btn" disabled title="Can't reach ghcr.io">Update</button>`
        : behind ? `<button class="btn btn-update" onclick="askUpdate('${d}','${escJs(i.tag)}')">Update</button>` : "";
      const actions = missing
        ? `<button class="btn" onclick="showLogs('${d}', '${escJs(String(i.port ?? ""))}')">Logs</button>
    <button class="btn btn-danger" onclick="askDelete('${d}')">Delete</button>`
        : `<a class="btn" href="https://${esc(i.domain)}/admin" target="_blank" rel="noreferrer noopener">Open admin</a>
    <a class="btn" href="https://${esc(i.domain)}" target="_blank" rel="noreferrer noopener">Visit site</a>
    ${
      i.state === "running"
        ? `<button class="btn" onclick="askStop('${d}')">Stop</button>`
        : `<button class="btn" onclick="act('${d}','start')">Start</button>`
    }
    <button class="btn" onclick="act('${d}','restart')">Restart</button>
    <button class="btn" onclick="takeSnapshot('${d}')" title="Create a backup snapshot of the SQLite database and instance data">Snapshot</button>
    <button class="btn" onclick="act('${d}','recreate')" title="Rebuild the recorded version, preserving data and enabling native backups for older instances">Recreate</button>
    <button class="btn" onclick="showLogs('${d}', '${escJs(String(i.port ?? ""))}')">Logs</button>
    <button class="btn btn-danger" onclick="askDelete('${d}')">Delete</button>`;
      const state = missing
        ? '<span class="badge state-absent" title="The CloudPanel site was deleted; Delete archives and removes the instance">Deleted</span>'
        : updating
          ? `<span class="badge state-running">Updating</span><div class="hint">${esc(updating.step)} · <a href="${BASE}/jobs/${esc(updating.id)}">Log</a></div>`
          : `<span class="badge ${stateClass(i.state)}">${esc(STATE_LABELS[i.state] ?? i.state)}</span>${failedUpdate
            ? `<div class="hint tone-bad">Update to ${esc(failedUpdate.tag)} failed · <a href="${BASE}/jobs/${esc(failedUpdate.id)}">Log</a></div>` : ""}`;
      return `<tr data-domain="${esc(i.domain)}" data-find="${esc(i.domain)}" data-tag="${esc(i.tag)}"${behind ? " data-behind" : ""} tabindex="0" aria-selected="false" onclick="toggleSiteSelection(event, this)" onkeydown="toggleSiteSelection(event, this)">
  <td class="site-select"><input class="site-checkbox" type="checkbox" onchange="paintFleetSelection()" aria-label="Select ${esc(i.domain)}"${missing || updating ? " disabled" : ""}></td>
  <td class="site-cell">${missing ? `<span class="mono">${esc(i.domain)}</span>` : esc(i.domain)}</td>
  <td data-label="Version">
    <span class="badge">${esc(i.tag)}</span>
    ${behind ? `<span class="badge behind" title="${esc(latest)} is available">${esc(latest)} available</span>` : ""}
  </td>
  <td data-label="State">${state}</td>
  <td class="action-cell wide-cell" data-label="Actions"><div class="instatic-row-actions">${update}<details id="instance-actions-${esc(i.domain)}" class="row-actions"><summary>Manage</summary><div class="actions">
    ${actions}
  </div></details></div></td>
</tr>`;
    })
    .join("\n");

  // Auto-update is off by default because Instatic is 0.0.x, which only works as
  // a policy if something tells the operator a release happened.
  const versionNotice =
    available.source === "fallback"
      ? `<div class="notice">Can't reach ghcr.io, so updates cannot be checked or installed.</div>`
      : available.source === "cache"
        ? `<div class="notice">ghcr.io is unreachable right now; version information is from the
           last successful check and may be out of date.</div>`
        : "";
  const updatesLine = outdated > 0
    ? `<div class="notice" role="status">${outdated} update${outdated === 1 ? "" : "s"} available (latest ${esc(latest)})</div>`
    : "";

  return `<div class="page-heading"><div><h1>Instatic sites</h1><p>Host and manage static sites on CloudPanel.</p></div><a class="btn btn-primary" href="${BASE}/new">+ New site</a></div>${versionNotice}${updatesLine}

<div class="card card-table" id="instatic-sites"${working ? " data-working" : ""}>
  ${
    instances.length === 0 && creations.length === 0
      ? `<div class="empty">No Instatic instances yet. <a href="${BASE}/new">Create one</a>.</div>`
      : `<div class="card-header toolbar">
    <h2>Sites</h2>
    <span class="toolbar-note" id="site-selection">No sites selected</span>
    <button class="btn mobile-select-all" id="select-all-btn" type="button" onclick="toggleAllSites()">Select all</button>
    <div class="toolbar-end actions bulk-actions">
      ${latest === null ? "" : `<button class="btn" type="button" data-needs-selection disabled onclick="bulkInstatic('update', '${escJs(latest)}')" title="Update the selected sites to ${esc(latest)}">Update to ${esc(latest)}</button>`}
      <button class="btn" type="button" data-needs-selection disabled onclick="bulkInstatic('restart')">Restart</button>
    </div>
  </div>
  ${fleetFilterHtml({ count: instances.length, summary: `${instances.length} sites` })}
  <div class="table-scroll"><table class="fleet-table instatic-table">
    <thead><tr><th scope="col" class="site-select"><input id="select-all" type="checkbox" onchange="selectAllSites(this.checked)" aria-label="Select all sites"></th><th scope="col">Site</th><th scope="col">Version</th><th scope="col">State</th><th scope="col" class="action-cell">Actions</th></tr></thead>
    <tbody>${jobRows}${rows}</tbody>
  </table></div>
  ${FLEET_FOOTER_HTML}`
  }
</div>

<dialog id="logs-dialog" aria-labelledby="logs-title">
  <div class="dialog-header"><h2 id="logs-title"></h2></div>
  <p class="hint logs-port" id="logs-port-info"></p>
  <pre id="logs-body"></pre>
  <div class="actions dialog-actions">
    <button class="btn" onclick="document.getElementById('logs-dialog').close()">Close</button>
  </div>
</dialog>

<dialog id="snapshot-dialog" aria-labelledby="snapshot-title">
  <div class="dialog-header"><h2 id="snapshot-title">Snapshot created</h2></div>
  <p class="hint">The database and instance files were saved to:</p>
  <div class="snapshot-box">
    <div class="snapshot-file" id="snapshot-file"></div>
    <div class="mono hint snapshot-path" id="snapshot-path"></div>
  </div>
  <p class="hint">Snapshots include a clean SQLite backup and instance data. Only the five most recent snapshots are kept.</p>
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
    (latest === null ? [] : available.tags)
      .map((t, idx) => `<option value="${esc(t)}">${esc(t)}${idx === 0 ? " (latest)" : ""}</option>`)
      .join("")
  }</select>
  <div class="actions dialog-actions">
    <button class="btn" onclick="document.getElementById('update-dialog').close()">Cancel</button>
    <button class="btn btn-primary" onclick="confirmUpdate()">Update</button>
  </div>
</dialog>`;
}

/** What the job page says about the site's certificate. */
function certificateText(job: InstaticJobView): string {
  if (job.certificate === "issued") return "Let's Encrypt certificate issued";
  if (job.certificate === "failed") return "Let's Encrypt request failed";
  if (job.certificate === "none") return "Not requested";
  // Records from before the outcome was kept.
  return job.tls ? "Let's Encrypt certificate requested" : "Self-signed or custom SSL";
}

/** Renders the progress and result of an Instatic creation or update job: one status card and the log. */
export function jobView(job: InstaticJobView, logText: string): string {
  const finished = job.state === "done" || job.state === "failed";
  const done = job.state === "done";
  const update = job.kind === "update";
  const certificateWarning = done && job.certificate === "failed"
    ? `<div class="notice job-alert">No certificate yet. Point DNS at this server and issue one under Site → SSL/TLS.</div>`
    : "";
  const links = done && update
    ? `<div class="actions job-links"><a class="btn btn-primary" href="${BASE}/">Back to sites</a>
          <a class="btn" href="https://${esc(job.domain)}" target="_blank" rel="noreferrer noopener">Visit site</a></div>`
    : done
    ? `<div class="actions job-links">
          <a class="btn btn-primary" href="https://${esc(job.domain)}/admin" target="_blank" rel="noreferrer noopener">Open admin</a>
          <a class="btn" href="https://${esc(job.domain)}" target="_blank" rel="noreferrer noopener">Visit site</a>
        </div>`
    : "";

  return `
    <div class="page-heading">
      <div>
        <h1>${update ? "Update" : "New Instatic site"}</h1>
        <p>${update
    ? `${esc(job.domain)} from ${esc(job.fromTag ?? "its version")} to ${esc(job.tag)}. A failed update puts the previous version back.`
    : `Creating an Instatic site at ${esc(job.domain)}.`}</p>
      </div>
      <a class="btn" href="${BASE}/">Back to sites</a>
    </div>
    <div class="card">
      <div class="card-header"><h2>${esc(job.domain)}</h2><span class="badge ${jobStateClass(job.state)}" id="job-state">${esc(jobStateLabel(job.state))}</span></div>
      <div class="step job-step" id="job-step">${esc(finished ? "" : job.step)}</div>
      ${job.error ? `<div class="alert job-alert">${esc(job.error)}</div>` : ""}
      ${certificateWarning}
      <dl class="kv job-timing">
        <dt>Domain</dt><dd>${done ? `<a href="https://${esc(job.domain)}" target="_blank" rel="noreferrer noopener">${esc(job.domain)}</a>` : esc(job.domain)}</dd>
        <dt>Version</dt><dd>${esc(job.tag)}</dd>
        <dt>Port</dt><dd class="mono">127.0.0.1:${esc(String(job.port))}</dd>
        ${done && !update ? `<dt>Certificate</dt><dd>${esc(certificateText(job))}</dd>` : ""}
        <dt>Started</dt><dd>${esc(whenText(job.startedAt || job.createdAt))}</dd>
        ${job.finishedAt ? `<dt>Finished</dt><dd>${esc(whenText(job.finishedAt))}</dd>` : ""}
      </dl>
      ${links}
    </div>
    <div class="card">
      <div class="card-header"><h2>Log</h2></div>
      <pre id="job-log">${esc(logText || "(no output yet)")}</pre>
    </div>
    ${finished ? "" : `<div id="job-watch" data-job="${esc(job.id)}" hidden></div>`}`;
}

/** Renders the new-site form with the available versions. */
export function newInstanceView(available: AvailableTags): string {
  // A fallback list is a guess, so nothing in it is called the latest.
  const options = available.tags.map((t, idx) =>
    `<option value="${esc(t)}"${idx === 0 ? " selected" : ""}>${esc(t)}${idx === 0 && available.source !== "fallback" ? " (latest)" : ""}</option>`
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
  <form onsubmit="return submitCreate(event)">
    <div class="form-grid">
      <div class="form-field form-field-full">
        <label for="domain" class="required">Domain name</label>
        <input id="domain" placeholder="pages.example.com" autocomplete="off" autocapitalize="off" spellcheck="false" required
          oninput="this.value = this.value.toLowerCase()">
      </div>
      <div class="form-field form-field-full">
        <label for="tag" class="required">Instatic version</label>
        <select id="tag" required aria-describedby="tag-hint">${options}</select>
        <div class="hint" id="tag-hint">Versions are pinned. Review release changes before updating.</div>
      </div>
    </div>
    <div class="check-field">
      <label for="tls" class="check-label">
        <input type="checkbox" id="tls" aria-describedby="tls-hint">
        <span>Request a Let's Encrypt certificate</span>
      </label>
      <div class="hint" id="tls-hint">Works once the domain resolves to this server; otherwise issue one later in Site → SSL/TLS.</div>
    </div>
    <div class="form-actions">
      <a class="btn btn-lg" href="${BASE}/">Cancel</a>
      <button type="submit" class="btn btn-primary btn-lg">Create site</button>
    </div>
  </form>
</div></div>`;
}
