import type { SanitizedSite } from "../../../lib/snapshot-reader";
// Server-rendered HTML. Every interpolated value goes through esc() or escJs():
// domains, job steps and the action binary's notes all originate outside this
// process, and
// the page is served to an operator whose session can create CloudPanel sites.

import { esc } from "../../../lib/app-http";
import {
  FLEET_FOOTER_HTML, FLEET_ROW_SELECTION_JS, JOB_STYLE, JOB_WATCH_JS, fleetFilterHtml, filterWord, valueFilters, jobStateClass, jobStateLabel, renderFragment, renderLayout,
  whenText,
} from "../../../lib/app-ui";
import type { EmbedFragment } from "../../../lib/shadow-embed";
import type { SiteContext } from "../../../lib/site-context";
import { mountPath } from "../../../lib/mount";

/**
 * Where this addon is served. One CloudPanel site carries every addon, so every
 * link this file emits is relative to a mount rather than to the site root.
 * A constant rather than a per-request value: the mount is fixed by the addon's
 * name, so a link that forgets it is a bug at build time, not a routing choice.
 */
const BASE = mountPath("stager");
import { expandTarget, promoteBlocked, type JobResult, type JobView, type PromoteResult, type SiteSummary } from "./service";

// Only what the shared shell does not carry.
import STYLE from "./views.css" with { type: "text" };

/**
 * The pages' inline script.
 *
 * Exported so tests/test-app.test.ts can parse it.
 */
import VIEWS_JS from "./views.client.js" with { type: "text" };
// One expandTarget for the route and the hostname preview.
const CLIENT_JS = `const expandTarget = ${expandTarget.toString()};\n${VIEWS_JS}`;
export { CLIENT_JS };

export function layout(
  title: string,
  content: string,
  updateNotice?: { current: string; latest: string } | null,
  site?: SiteContext,
): string {
  return renderLayout(title, content, {
    brand: "Stager",
    base: BASE,
    nav: [],
    css: STYLE + JOB_STYLE,
    script: `${FLEET_ROW_SELECTION_JS}\n${JOB_WATCH_JS}${CLIENT_JS}`,
    updateNotice,
    ...(site ? { site: { ...site, activeSlug: "stager" } } : {}),
  });
}

/**
 * The same page as `layout`, as a fragment for mounting inside CloudPanel's own
 * site page. No site context: the panel is already drawing it.
 */
export function fragment(title: string, content: string): EmbedFragment {
  return renderFragment(title, content, {
    brand: "Stager",
    base: BASE,
    nav: [],
    css: STYLE + JOB_STYLE,
    script: `${FLEET_ROW_SELECTION_JS}\n${JOB_WATCH_JS}${CLIENT_JS}`,
  });
}

function stateBadge(job: JobView, id = ""): string {
  return `<span class="badge ${jobStateClass(job.state)}"${id ? ` id="${id}"` : ""}>${esc(jobStateLabel(job.state))}</span>`;
}

export function isSiteMissing(
  job: JobView,
  snapshotAge: number,
  panelSites: SanitizedSite[],
  snapshotTakenAt?: string
): boolean {
  if (job.state !== "done") return false;
  if (job.panelSite === false) return true;
  if (job.panelSite === true) return false;
  if (snapshotAge > 3600) return false;
  if (snapshotTakenAt) {
    const taken = Date.parse(snapshotTakenAt);
    const finished = Date.parse(job.finishedAt || job.createdAt);
    if (!Number.isNaN(taken) && !Number.isNaN(finished) && finished >= taken) {
      return false;
    }
  }
  return !panelSites.some((s) => s.domain === job.target);
}

/** A finished clone whose two sites are both still there. */
function canPromote(job: JobView, missing: boolean): boolean {
  return !missing && !promoteBlocked(job);
}

function promoteHref(job: JobView): string {
  return `${BASE}/promote?job=${encodeURIComponent(job.id)}`;
}

export function jobsView(
  jobs: JobView[],
  snapshotAge = Infinity,
  panelSites: SanitizedSite[] = [],
  snapshotTakenAt = ""
): string {
  const rows = jobs
    .map((j) => {
      const missing = isSiteMissing(j, snapshotAge, panelSites, snapshotTakenAt);
      const active = j.state === "queued" || j.state === "running";
      return `
        <tr>
          <td class="site-cell">
            <a href="${BASE}/jobs/${esc(j.id)}">${esc(j.target)}</a>
            ${j.kind === "promote" ? '<div class="hint">promoted to live</div>' : ""}
          </td>
          <td class="wide-cell" data-label="From">${esc(j.source)}</td>
          <td class="type-cell">${esc(j.result ? typeLabel(j.result.siteType) : "—")}</td>
          <td data-label="State">
            ${stateBadge(j)}${missing ? ' <span class="badge state-deleted">deleted</span>' : ""}
            ${active && j.step ? `<div class="hint">${esc(j.step)}</div>` : ""}
          </td>
          <td class="step wide-cell" data-label="Started">${esc(whenText(j.createdAt))}</td>
          <td class="action-cell">${canPromote(j, missing) ? `<a href="${promoteHref(j)}">Promote</a>` : ""}</td>
        </tr>`;
    })
    .join("");

  return `
    <div class="page-heading"><div><h1>Staging sites</h1><p>Clone a site to test changes, then promote them to the live site.</p></div><a class="btn btn-primary" href="${BASE}/new">+ New staging site</a></div>
    <div class="card card-table">
      ${
        jobs.length === 0
          ? `<div class="empty">No clones yet. Start one with the button above, or from a site's Staging tab.</div>`
          : `<div class="table-scroll"><table class="fleet-table">
        <thead><tr><th scope="col">Site</th><th scope="col">From</th><th scope="col">Type</th><th scope="col">State</th><th scope="col">Started</th><th scope="col" class="action-cell" aria-label="Actions"></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`
      }
    </div>`;
}

/**
 * Staging as it looks from one site's own page in CloudPanel.
 *
 * Two questions, because a site can be either end of a clone and occasionally
 * both: whether this site *is* a staging copy that can go back to the site it
 * came from, and what has been staged *from* it. The fleet view at
 * `/addons/stager/` answers neither -- it lists every clone on the box, which
 * is the wrong altitude for a page reached from one site's tab strip.
 */
export function siteStagingView(
  domain: string,
  jobs: JobView[],
  clonable: boolean,
  snapshotAge = Infinity,
  panelSites: SanitizedSite[] = [],
  snapshotTakenAt = "",
): string {
  const newest = (a: JobView, b: JobView) => b.createdAt.localeCompare(a.createdAt);
  const clonesFrom = jobs.filter((j) => j.kind !== "promote" && j.source === domain);
  // The clone that produced this site, if it is one. Newest first, because a
  // site cloned twice is the second clone.
  const cloneOf = jobs
    .filter((j) => j.kind !== "promote" && j.target === domain && j.state === "done" && j.result)
    .sort(newest)[0];
  // A promote runs from the staging site, so this site is its source.
  const lastPromote = jobs.filter((j) => j.kind === "promote" && j.source === domain).sort(newest)[0];

  const row = (j: JobView): string => {
    const missing = isSiteMissing(j, snapshotAge, panelSites, snapshotTakenAt);
    return `
        <tr>
          <td class="site-cell wide-cell"><a href="${BASE}/jobs/${esc(j.id)}">${esc(j.target)}</a></td>
          <td data-label="State">
            ${stateBadge(j)}${missing ? ' <span class="badge state-deleted">deleted</span>' : ""}
            ${j.state === "queued" || j.state === "running" ? `<div class="hint">${esc(j.step)}</div>` : ""}
          </td>
          <td class="step wide-cell" data-label="Started">${esc(whenText(j.createdAt))}</td>
          <td class="action-cell">${canPromote(j, missing) ? `<a href="${promoteHref(j)}">Promote</a>` : ""}</td>
        </tr>`;
  };

  const cloneAction = clonable
    ? `<a class="btn${cloneOf ? "" : " btn-primary"}" href="${BASE}/new?source=${encodeURIComponent(domain)}">+ New staging site</a>`
    : "";
  const heading = `
    <div class="page-heading">
      <div>
        <h1>Staging</h1>
        <p>${cloneOf
          ? `${esc(domain)} is a staging copy of ${esc(cloneOf.source)}.`
          : `Copies of ${esc(domain)} you can change without touching what visitors see.`}</p>
      </div>
      ${cloneAction}
    </div>`;

  // Promoting is the return leg of a clone, so without that record there is no
  // live site to return to.
  let promote = "";
  if (cloneOf) {
    const blocked = promoteBlocked(cloneOf);
    const last = !lastPromote
      ? ""
      : lastPromote.state === "done"
        ? ` <a href="${BASE}/jobs/${esc(lastPromote.id)}">Last promoted</a> ${esc(whenText(lastPromote.createdAt))}.`
        : ` <a href="${BASE}/jobs/${esc(lastPromote.id)}">Last promote</a>: ${esc(jobStateLabel(lastPromote.state).toLowerCase())}, ${esc(whenText(lastPromote.createdAt))}.`;
    promote = `
    <div class="card split-card">
      <div>
        <h2>Promote to ${esc(cloneOf.source)}</h2>
        <p class="hint">${blocked ? esc(blocked) : `Moves ${esc(domain)}'s files onto ${esc(cloneOf.source)}.${last}`}</p>
      </div>
      ${blocked ? "" : `<a class="btn btn-primary" href="${promoteHref(cloneOf)}">Promote</a>`}
    </div>`;
  }

  const clones = clonesFrom.length > 0
    ? `<div class="card card-table">
      <div class="table-scroll"><table class="fleet-table">
        <thead><tr><th scope="col">Staging site</th><th scope="col">State</th><th scope="col">Started</th><th scope="col" class="action-cell" aria-label="Actions"></th></tr></thead>
        <tbody>${clonesFrom.map(row).join("")}</tbody>
      </table></div>
    </div>`
    : cloneOf
      ? ""
      : `<div class="card card-table"><div class="empty">${
          clonable
            ? `No staging copies of ${esc(domain)} yet.`
            : `A ${esc(domain)} site cannot be cloned, so it has no staging copies.`
        }</div></div>`;

  return heading + promote + clones;
}

/** How a site's `type` column reads to an operator. */
function typeLabel(t: string): string {
  if (t === "php") return "PHP";
  if (t === "static") return "Static";
  if (t === "reverse-proxy") return "Instatic";
  return t;
}

/** One line on what is being cloned: `WordPress, PHP 8.2, 1 database`. */
function sourceSummary(site: SiteSummary): string {
  if (site.siteType === "reverse-proxy") return "Instatic site. Its pages and media go to a new instance of its own.";
  const parts = [site.application || "Generic", site.phpVersion ? `PHP ${site.phpVersion}` : typeLabel(site.siteType)];
  if (site.siteType !== "static") parts.push(site.databases ? `${site.databases} database${site.databases === 1 ? "" : "s"}` : "no database");
  return parts.join(", ");
}

/** Renders either the source picker or the configuration form for a new clone. */
export function newCloneView(source: SiteSummary | null, sites: SiteSummary[], error?: string): string {
  if (!source) {
    const options = sites
      .map((s) => `<tr data-domain="${esc(s.domain)}" data-find="${esc(`${s.domain} ${s.application}`)}" data-show="${filterWord("type", typeLabel(s.siteType))} ${filterWord("app", s.application || "Generic")}">
        <td class="site-cell"><a href="${BASE}/new?source=${encodeURIComponent(s.domain)}">${esc(s.domain)}</a></td>
        <td class="type-cell">${esc(typeLabel(s.siteType))}${s.phpVersion ? ` ${esc(s.phpVersion)}` : ""}</td>
        <td data-label="Application">${esc(s.application || "Generic")}</td>
        <td class="action-cell"><a href="${BASE}/new?source=${encodeURIComponent(s.domain)}">Clone</a></td></tr>`)
      .join("");
    return `
      <div class="page-heading"><div><h1>New staging site</h1><p>Choose the site you want to clone.</p></div>
        <a class="btn" href="${BASE}/">Back</a></div>
      ${error ? `<div class="alert" role="alert">${esc(error)}</div>` : ""}
      <div class="card card-table">
        ${
          sites.length === 0
            ? `<div class="empty">No clonable sites found in CloudPanel.</div>`
            : `${fleetFilterHtml({
              count: sites.length,
              filters: [
                ...valueFilters("Type", "type", sites.map((s) => typeLabel(s.siteType))),
                ...valueFilters("Application", "app", sites.map((s) => s.application || "Generic")),
              ],
              summary: `${sites.length} sites`,
            })}
              <div class="table-scroll"><table class="fleet-table"><thead><tr><th scope="col" data-sort="domain">Domain</th><th scope="col" data-sort="type">Type</th><th scope="col" data-sort="application">Application</th><th scope="col" class="action-cell" aria-label="Actions"></th></tr></thead><tbody>${options}</tbody></table></div>
              ${FLEET_FOOTER_HTML}`
        }
      </div>`;
  }

  // Only for an Instatic source, because only there is there a second
  // application to sign into. The password is the source instance's own
  // administrator credential: it is posted once, reaches the action binary on
  // stdin, and is deleted the moment the export it exists for has finished.
  const instaticFields = source.siteType === "reverse-proxy"
    ? `
      <div class="credential-fields">
        <h2>Source Instatic account</h2>
        <div class="form-grid">
          <div class="form-field">
            <label for="instatic-email" class="required">Admin email</label>
            <input id="instatic-email" type="email" required autocomplete="off" placeholder="you@example.com">
          </div>
          <div class="form-field">
            <label for="instatic-password" class="required">Password</label>
            <input id="instatic-password" type="password" required autocomplete="new-password">
          </div>
          <div class="form-field">
            <label for="instatic-mfa">Authentication code</label>
            <input id="instatic-mfa" autocomplete="off" inputmode="numeric" placeholder="123456" aria-describedby="mfa-hint">
            <div class="hint" id="mfa-hint">Required only if MFA is enabled.</div>
          </div>
        </div>
        <div class="hint">Used by the local clone job to export the source's content, then removed after authentication.
          The clone gets its own owner, secret key, and container.</div>
      </div>`
    : "";

  return `
    <div class="form-page">
    <div class="page-heading"><h1>New staging site</h1></div>
    ${error ? `<div class="alert" role="alert">${esc(error)}</div>` : ""}
    <div class="card">
      <div class="card-header"><div><h2>Clone ${esc(source.domain)}</h2><p class="hint">${esc(sourceSummary(source))}</p></div></div>
      <form onsubmit="event.preventDefault(); startClone();">
      <input type="hidden" id="source-domain" value="${esc(source.domain)}">
      <label for="target" class="required">Staging hostname</label>
      <input id="target" required autocomplete="off" value="stg" oninput="previewTarget()" aria-describedby="target-preview">
      <div class="hint" id="target-preview" aria-live="polite">Will create ${esc(expandTarget("stg", source.domain))}</div>
      ${instaticFields}

      <div class="check-field">
      <label for="tls" class="check-label">
        <input type="checkbox" id="tls" aria-describedby="tls-hint">
        <span>Request a Let's Encrypt certificate when the clone finishes</span>
      </label>
      <div class="hint" id="tls-hint">Select this only after the hostname resolves to this server.
        You can issue the certificate later from Site → SSL/TLS.</div>
      </div>

      <div class="form-actions">
        <a class="btn btn-lg" href="${BASE}/new">Back</a>
        <button class="btn btn-primary btn-lg" type="submit">Create staging site</button>
      </div>
      </form>
    </div></div>`;
}

/** The confirmation for one promote: what moves, what does not, and the credentials it needs. */
export function promoteView(job: JobView, error?: string): string {
  const result = job.result as JobResult | null;
  const isInstatic = result?.siteType === "reverse-proxy";
  const staging = job.target;
  const live = job.source;

  if (error) {
    return `
    <div class="form-page">
    <div class="page-heading"><h1>Promote to live</h1><a class="btn" href="${BASE}/">Back</a></div>
    <div class="alert" role="alert">${esc(error)}</div>
    </div>`;
  }

  const credentialFields = isInstatic
    ? `
      <div class="credential-fields">
        <h2>Staging Instatic account</h2>
        <div class="form-grid">
          <div class="form-field">
            <label for="promote-src-email" class="required">Admin email</label>
            <input id="promote-src-email" type="email" required autocomplete="off" placeholder="you@example.com">
          </div>
          <div class="form-field">
            <label for="promote-src-password" class="required">Password</label>
            <input id="promote-src-password" type="password" required autocomplete="new-password">
          </div>
          <div class="form-field">
            <label for="promote-src-mfa">Authentication code</label>
            <input id="promote-src-mfa" autocomplete="off" inputmode="numeric" placeholder="123456">
          </div>
        </div>
      </div>
      <div class="credential-fields">
        <h2>Live Instatic account</h2>
        <div class="form-grid">
          <div class="form-field">
            <label for="promote-dst-email" class="required">Admin email</label>
            <input id="promote-dst-email" type="email" required autocomplete="off" placeholder="you@example.com">
          </div>
          <div class="form-field">
            <label for="promote-dst-password" class="required">Password</label>
            <input id="promote-dst-password" type="password" required autocomplete="new-password">
          </div>
          <div class="form-field">
            <label for="promote-dst-mfa">Authentication code</label>
            <input id="promote-dst-mfa" autocomplete="off" inputmode="numeric" placeholder="123456">
          </div>
        </div>
        <div class="hint">Both are used once, by the local promote job, and removed as soon as each sign-in
          has succeeded. Neither is stored.</div>
      </div>`
    : "";

  const whatMoves = isInstatic
    ? `<li>${esc(staging)}'s pages and media replace ${esc(live)}'s, through Instatic's own site bundle.
        ${esc(live)}'s current content is exported first and kept with this job.</li>
       <li>${esc(live)} keeps its own users, secret key and integration secrets. Publish it once afterwards.</li>`
    : `<li>${esc(staging)}'s document root replaces ${esc(live)}'s, in one move once the whole copy is ready.</li>
       <li>${esc(live)} keeps its own <span class="mono">wp-config.php</span>, <span class="mono">.env</span>
         and <span class="mono">wp-content/uploads</span>. The staging copy's are discarded before anything is
         switched over, so the live site is never pointed at the staging database.</li>
       <li>The live database is dumped first and the replaced document root is kept for 14 days.</li>`;

  return `
    <div class="form-page">
    <div class="page-heading"><h1>Promote to live</h1></div>
    <div class="card">
      <div class="card-header"><h2>${esc(staging)} → ${esc(live)}</h2></div>
      <ul class="notes">${whatMoves}</ul>
      <p class="hint danger-note">The live database is not overwritten. Everything created on ${esc(live)} since
        this clone was taken — orders, form submissions, comments, accounts — stays exactly as it is, and any
        content edited on ${esc(staging)} that lives in the database does not move.</p>
      <form onsubmit="event.preventDefault(); startPromote(this);" data-job="${esc(job.id)}" data-staging="${esc(staging)}" data-live="${esc(live)}">
      ${credentialFields}
      <div class="form-actions">
        <a class="btn btn-lg" href="${BASE}/">Back</a>
        <button class="btn btn-primary btn-lg" type="submit">Promote to live</button>
      </div>
      </form>
    </div></div>`;
}

/** Renders a clone job's progress, result, credentials, and reconciliation state. */
export function jobView(
  job: JobView,
  logText: string,
  snapshotAge = Infinity,
  panelSites: SanitizedSite[] = [],
  snapshotTakenAt = ""
): string {
  const finished = job.state === "done" || job.state === "failed";
  const promote = job.kind === "promote";
  // The two job kinds record different things, and the record is what says
  // which. Nothing below reads a field the other kind never writes.
  const result = promote ? null : (job.result as JobResult | null);
  const promoted = promote ? (job.result as PromoteResult | null) : null;
  const missing = promote ? false : isSiteMissing(job, snapshotAge, panelSites, snapshotTakenAt);

  // What the operator still has to do, so it sits right under the status.
  const notes = job.result?.notes?.length
    ? `<div class="card">
        <div class="card-header"><h2>${promote ? "Promote notes" : "Clone notes"}</h2></div>
        <ul class="notes">${job.result!.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
      </div>`
    : "";

  const credentials = result?.database
    ? `<div class="card secret">
        <div class="card-header"><h2>Staging database</h2></div>
        <dl class="kv">
          <dt>Name</dt><dd>${esc(result.database.name)}</dd>
          <dt>User</dt><dd>${esc(result.database.user)}</dd>
          <dt>Password</dt><dd>${esc(result.database.password)}</dd>
          <dt>Copied from</dt><dd>${esc(result.database.source)}</dd>
        </dl>
        <p class="hint">Already written into the clone's own configuration file. Shown because it is the one
          credential the panel cannot show you again, and this record is deleted after 14 days.</p>
      </div>`
    : "";

  // Named for the mechanism, because the two are not equivalent: `template`
  // means CloudPanel rendered and wrote everything, `rendered` means this addon
  // wrote the clone's panel record and its vhost file itself, which is the only
  // route for a site type clpctl gives no --vhostTemplate option.
  const vhostNote = !result
    ? ""
    : result.vhostCarried
      ? result.vhostCarriedBy === "template"
        ? "copied from the source, through CloudPanel's own vhost template"
        : "copied from the source, written into the panel and rendered"
      : `the stock ${esc(result.vhostTemplate)} vhost`;

  const site = result
    ? `<div class="card">
        <div class="card-header"><h2>Staging site</h2></div>
        <dl class="kv">
          <dt>Staging site</dt><dd>${
            missing
              ? `<span class="mono">${esc(job.target)}</span>`
              : `<a href="https://${esc(job.target)}" target="_blank" rel="noopener">${esc(job.target)}</a>`
          }</dd>
          <dt>Type</dt><dd>${esc(typeLabel(result.siteType))}</dd>
          <dt>Site user</dt><dd>${esc(result.siteUser)}</dd>
          ${result.phpVersion ? `<dt>PHP</dt><dd>${esc(result.phpVersion)}</dd>` : ""}
          <dt>Template</dt><dd>${esc(result.vhostTemplate)}</dd>
          <dt>Vhost</dt><dd>${vhostNote}</dd>
        </dl>
        ${missing ? "" : `<p class="hint">The site user's password was generated and not kept. Set one in Site → SSH/FTP if you need SFTP access.</p>`}
      </div>`
    : "";

  // The clone's Instatic owner. Kept beside the staging database password and
  // for the same reason: it is minted by the job, it is the only way into the
  // clone's admin, and nothing can show it again once this record expires.
  const instatic = result?.instatic
    ? `<div class="card secret">
        <div class="card-header"><h2>Staging Instatic instance</h2></div>
        <dl class="kv">
          <!-- esc() even though the action binary emits this as a JSON number and
               validatePort bounds it: every other value on this page is
               escaped, and the one that is not is the one nobody re-checks
               after the type it was declared with changes. -->
          <dt>Port</dt><dd>127.0.0.1:${esc(String(result.instatic.port))}</dd>
          <dt>Version</dt><dd>${esc(result.instatic.tag)}</dd>
          <dt>Owner</dt><dd>${esc(result.instatic.email)}</dd>
          <dt>Password</dt><dd>${esc(result.instatic.password)}</dd>
        </dl>
        <p class="hint">A new owner on a new instance with a secret key of its own — the source's users and
          secrets are deliberately not part of a site bundle. This record is deleted after 14 days.</p>
      </div>`
    : "";

  const promotedSite = promoted
    ? `<div class="card">
        <div class="card-header"><h2>Live site</h2></div>
        <dl class="kv">
          <dt>Live site</dt><dd><a href="https://${esc(job.target)}" target="_blank" rel="noopener">${esc(job.target)}</a></dd>
          <dt>Promoted from</dt><dd>${esc(job.source)}</dd>
          <dt>Type</dt><dd>${esc(typeLabel(promoted.siteType))}</dd>
          <dt>Site user</dt><dd>${esc(promoted.siteUser)}</dd>
          ${promoted.preserved.length
            ? `<dt>Kept from the live site</dt><dd>${promoted.preserved.map((path) => `<span class="mono">${esc(path)}</span>`).join(", ")}</dd>`
            : ""}
        </dl>
      </div>`
    : "";

  const rollback = promoted && (promoted.previousRoot || promoted.databaseBackup || promoted.contentBackup)
    ? `<div class="card">
        <div class="card-header"><h2>What was kept to go back</h2></div>
        <dl class="kv">
          ${promoted.previousRoot ? `<dt>Replaced files</dt><dd class="mono">${esc(promoted.previousRoot)}</dd>` : ""}
          ${promoted.databaseBackup ? `<dt>Database dump</dt><dd class="mono">${esc(promoted.databaseBackup)}</dd>` : ""}
          ${promoted.contentBackup ? `<dt>Content export</dt><dd class="mono">${esc(promoted.contentBackup)}</dd>` : ""}
        </dl>
        <p class="hint">Removed with this job's record after 14 days. The paths kept from the live site were moved
          onto the promoted release rather than copied, so they are not in the replaced copy.</p>
      </div>`
    : "";

  const promoteAction = !promote && canPromote(job, missing)
    ? `<a class="btn" href="${promoteHref(job)}">Promote to live</a>`
    : "";

  return `
    <div class="page-heading"><h1>${promote ? "Promote details" : "Staging site details"}</h1>
      <div class="page-actions">${promoteAction}<a class="btn" href="${BASE}/">Back to staging sites</a></div></div>
    <div class="card">
      <div class="card-header"><h2>${promote ? "Promote status" : "Clone status"}</h2></div>
      <div class="job-summary">
        <span class="job-domain">${esc(job.source)}</span>
        <span class="hint job-arrow">→</span>
        <span class="job-domain">${esc(job.target)}</span>
        ${stateBadge(job, "job-state")}
      </div>
      <div class="step job-step" id="job-step">${esc(finished ? "" : job.step)}</div>
      ${missing ? '<div class="alert job-alert">This staging site has been deleted from CloudPanel.</div>' : ""}
      ${job.error ? `<div class="alert job-alert">${esc(job.error)}</div>` : ""}
      <dl class="kv job-timing">
        <dt>Started</dt><dd>${esc(whenText(job.startedAt || job.createdAt))}</dd>
        <dt>Finished</dt><dd>${esc(whenText(job.finishedAt))}</dd>
      </dl>
    </div>
    ${notes}
    ${site}
    ${promotedSite}
    ${rollback}
    ${instatic}
    ${credentials}
    <div class="card">
      <div class="card-header"><h2>Log</h2></div>
      <pre id="job-log">${esc(logText || "(no output yet)")}</pre>
    </div>
    ${finished ? "" : `<div id="job-watch" data-job="${esc(job.id)}" hidden></div>`}`;
}
