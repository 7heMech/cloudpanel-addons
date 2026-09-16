import type { SanitizedSite } from "../../../lib/snapshot-reader";
// Server-rendered HTML. Every interpolated value goes through esc() or escJs():
// domains, job steps and the action binary's notes all originate outside this
// process, and
// the page is served to an operator whose session can create CloudPanel sites.

import { esc, escJs } from "../../../lib/app-http";
import { JOB_STYLE, JOB_WATCH_JS, renderFragment, renderLayout } from "../../../lib/app-ui";
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
import type { JobResult, JobView, PromoteResult, SiteDetail, SiteSummary } from "./service";

// Only what the shared shell does not carry.
const STYLE = `
.notes { margin: 0; padding-left: 1.1rem; }
.notes li { margin: 8px 0; font-size: 14px; color: var(--muted); }
.kv + .hint { margin: 20px 0 0; }
.secret .kv dd { font-family: var(--mono); font-size: 14px; }
.credential-fields { border-top: 1px solid var(--border); padding-top: 25px; margin-top: 25px; }
.credential-fields h2 { margin: 0 0 20px; }
.page-actions { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.page-actions > .btn { min-height: 50px; padding: 8px 30px; flex-shrink: 0; }
.danger-note { border-left: 3px solid var(--bad); padding-left: 14px; }
`;

/**
 * The pages' inline script.
 *
 * Exported so tools/test-app.ts can parse it. This is a TypeScript template
 * literal, which means every backslash in it is consumed once before the
 * browser ever sees it: a `\n` written here reaches the page as a real newline,
 * and inside a single-quoted JS string that is a SyntaxError which takes the
 * whole script down with it. Escapes meant for the browser must be doubled, and
 * the test asserts they were.
 */
export const CLIENT_JS = `
function expandTarget(value, source) {
  const t = String(value || '').trim().toLowerCase().replace(/\\.$/, '');
  if (!t) return '';
  return t.indexOf('.') === -1 ? t + '.' + source : t;
}

function previewTarget() {
  const input = document.getElementById('target');
  const source = document.getElementById('source-domain').value;
  const out = document.getElementById('target-preview');
  const full = expandTarget(input.value, source);
  out.textContent = full ? 'Will create ' + full : 'A label such as stg becomes stg.' + source;
}

async function startClone() {
  const source = document.getElementById('source-domain').value;
  const target = expandTarget(document.getElementById('target').value, source);
  const tls = document.getElementById('tls').checked;
  if (!target) { alert('Enter a hostname for the staging site.'); return false; }
  const payload = { source: source, target: target, tls: tls };
  // Present only when the source is an Instatic site. Read straight into the
  // request. The root job keeps it only until the source login succeeds.
  const email = document.getElementById('instatic-email');
  if (email) {
    const password = document.getElementById('instatic-password');
    const code = document.getElementById('instatic-mfa');
    if (!email.value || !password.value) {
      alert('Enter the source instance admin email and password.');
      return false;
    }
    payload.instaticEmail = email.value;
    payload.instaticPassword = password.value;
    if (code && code.value) payload.mfaCode = code.value;
  }
  busy(true);
  try {
    const body = await call('/api/clones', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    location.href = CLP_BASE + '/jobs/' + encodeURIComponent(body.data.job);
  } catch (e) {
    busy(false);
    alert('Could not start the clone: ' + e.message);
  }
  return false;
}

async function startPromote(job) {
  const fields = {};
  const ids = {
    instaticEmail: 'promote-src-email', instaticPassword: 'promote-src-password', mfaCode: 'promote-src-mfa',
    liveEmail: 'promote-dst-email', livePassword: 'promote-dst-password', liveMfaCode: 'promote-dst-mfa',
  };
  for (const key in ids) {
    const el = document.getElementById(ids[key]);
    if (el) fields[key] = el.value;
  }
  const needsCredentials = document.getElementById('promote-src-email');
  if (needsCredentials && (!fields.instaticEmail || !fields.instaticPassword || !fields.liveEmail || !fields.livePassword)) {
    alert('Enter the admin email and password for both instances.');
    return false;
  }
  const confirmField = document.getElementById('promote-confirm');
  const expected = confirmField.getAttribute('data-domain');
  if (confirmField.value.trim() !== expected) {
    alert('Type ' + expected + ' to confirm.');
    return false;
  }
  busy(true);
  try {
    const payload = { job: job };
    for (const key in fields) { if (fields[key]) payload[key] = fields[key]; }
    const body = await call('/api/promotions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    location.href = CLP_BASE + '/jobs/' + encodeURIComponent(body.data.job);
  } catch (e) {
    busy(false);
    alert('Could not start the promote: ' + e.message);
  }
  return false;
}

// Wired here rather than from an inline <script> inside the page body: the
// shell puts this script after <main>, so a call written next to the markup
// would run before any of these functions exist.
function initStager() {
  if (document.getElementById('target')) previewTarget();
  const watch = document.getElementById('job-watch');
  if (watch) watchJob(watch.getAttribute('data-job'));
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initStager);
} else {
  initStager();
}
`;

export function layout(
  title: string,
  content: string,
  updateNotice?: { current: string; latest: string } | null,
  site?: SiteContext,
): string {
  return renderLayout(title, content, {
    brand: "Stager",
    base: BASE,
    // A site-scoped page draws CloudPanel's own site tabs instead of this
    // addon's, so its own nav would be a second strip saying something else.
    nav: site ? [] : [
      { href: `${BASE}/`, label: "Clones" },
      { href: `${BASE}/new`, label: "New staging site" },
      { href: `${BASE}/promote`, label: "Promote to live" },
    ],
    css: STYLE + JOB_STYLE,
    script: JOB_WATCH_JS + CLIENT_JS,
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
    script: JOB_WATCH_JS + CLIENT_JS,
  });
}

function stateClass(state: string): string {
  const known = ["queued", "running", "done", "failed"];
  return known.includes(state) ? `state-${state}` : "state-failed";
}

function when(iso: string): string {
  return iso ? iso.replace("T", " ").replace("Z", " UTC") : "—";
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

export function jobsView(
  jobs: JobView[],
  snapshotAge = Infinity,
  panelSites: SanitizedSite[] = [],
  snapshotTakenAt = ""
): string {
  const active = jobs.filter((j) => j.state === "queued" || j.state === "running").length;
  const rows = jobs
    .map(
      (j) => {
        const missing = isSiteMissing(j, snapshotAge, panelSites, snapshotTakenAt);
        return `
        <tr>
          <td>
            <a href="${BASE}/jobs/${esc(j.id)}">${esc(j.target)}</a>
            ${j.kind === "promote" ? '<div class="hint">promoted to live</div>' : ""}
            ${missing ? '<div class="hint">CloudPanel site deleted</div>' : ""}
          </td>
          <td>${esc(j.source)}</td>
          <td>${esc(j.result ? typeLabel(j.result.siteType) : "—")}</td>
          <td>
            <span class="badge ${stateClass(j.state)}">${esc(j.state)}</span>
            ${missing ? '<span class="badge" style="color:var(--bad);border-color:var(--bad);margin-left:0.25rem;">deleted</span>' : ""}
          </td>
          <td class="step">${esc(j.state === "done" ? "" : j.step)}</td>
          <td class="step">${esc(when(j.createdAt))}</td>
        </tr>`;
      }
    )
    .join("");

  return `
    <div class="page-heading"><div><h1>Staging sites</h1><p>Clone a site to test changes before going live.</p></div><a class="btn btn-primary" href="${BASE}/new">+ New staging site</a></div>
    <div class="card">
      <div class="stats">
        <div class="stat"><div class="label">Clones on record</div><div class="value">${jobs.length}</div></div>
        <div class="stat"><div class="label">In flight</div><div class="value">${active}</div></div>
      </div>
    </div>
    <div class="card card-table">
      ${
        jobs.length === 0
          ? `<div class="empty">No clones yet. Start one from the Sites list in CloudPanel, or with the button above.</div>`
          : `<table>
        <thead><tr><th scope="col">Site</th><th scope="col">From</th><th scope="col">Type</th><th scope="col">State</th><th scope="col">Step</th><th scope="col">Started</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
      }
    </div>`;
}

/**
 * Staging as it looks from one site's own page in CloudPanel.
 *
 * Two questions, because a site can be either end of a clone and occasionally
 * both: what has been staged *from* this site, and whether this site *is* a
 * staging copy that can go back to the site it came from. The fleet view at
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
  const clonesFrom = jobs.filter((j) => j.kind !== "promote" && j.source === domain);
  // The clone that produced this site, if it is one. Newest first, because a
  // site cloned twice is the second clone.
  const cloneOf = jobs
    .filter((j) => j.kind !== "promote" && j.target === domain && j.state === "done" && j.result)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const promotes = jobs.filter((j) => j.kind === "promote" && j.target === domain);

  const row = (j: JobView): string => {
    const missing = isSiteMissing(j, snapshotAge, panelSites, snapshotTakenAt);
    return `
        <tr>
          <td>
            <a href="${BASE}/jobs/${esc(j.id)}">${esc(j.target)}</a>
            ${missing ? '<div class="hint">CloudPanel site deleted</div>' : ""}
          </td>
          <td><span class="badge ${stateClass(j.state)}">${esc(j.state)}</span></td>
          <td class="step">${esc(j.state === "done" ? "" : j.step)}</td>
          <td class="step">${esc(when(j.createdAt))}</td>
        </tr>`;
  };

  const cloneAction = clonable
    ? `<a class="btn btn-primary" href="${BASE}/new?source=${encodeURIComponent(domain)}">+ New staging site</a>`
    : "";
  const staged = `
    <div class="page-heading">
      <div>
        <h1>Staging</h1>
        <p>Copies of ${esc(domain)} you can change without touching what visitors see.</p>
      </div>
      ${cloneAction}
    </div>
    <div class="card card-table">
      ${
        clonesFrom.length === 0
          ? `<div class="empty">${
              clonable
                ? `No staging copies of ${esc(domain)} yet.`
                : `A ${esc(domain)} site cannot be cloned, so it has no staging copies.`
            }</div>`
          : `<table>
        <thead><tr><th scope="col">Staging site</th><th scope="col">State</th><th scope="col">Step</th><th scope="col">Started</th></tr></thead>
        <tbody>${clonesFrom.map(row).join("")}</tbody>
      </table>`
      }
    </div>`;

  // Only when this site is itself a finished clone: promoting is the return leg
  // of a clone, so without that record there is no live site to return to.
  const promoteSection = cloneOf
    ? `
    <div class="addon-section">
      <h2>Promote to live</h2>
      <div class="card">
        <p>${esc(domain)} was cloned from <strong>${esc(cloneOf.source)}</strong>. Promoting moves its files onto that site.</p>
        ${
          promotes.length > 0
            ? `<p class="hint">Last promoted ${esc(when(promotes.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!.createdAt))}.</p>`
            : ""
        }
        <div class="actions">
          <a class="btn btn-primary" href="${BASE}/promote?job=${encodeURIComponent(cloneOf.id)}">Promote to ${esc(cloneOf.source)}</a>
        </div>
      </div>
    </div>`
    : "";

  return staged + promoteSection;
}

/** How a site's `type` column reads to an operator. */
function typeLabel(t: string): string {
  if (t === "php") return "PHP";
  if (t === "static") return "Static";
  if (t === "reverse-proxy") return "Instatic";
  return t;
}

/** Renders either the source picker or the configuration form for a new clone. */
export function newCloneView(source: SiteDetail | null, sites: SiteSummary[], error?: string): string {
  if (!source) {
    const options = sites
      .map((s) => `<tr><td><a href="${BASE}/new?source=${encodeURIComponent(s.domain)}">${esc(s.domain)}</a></td>
        <td>${esc(typeLabel(s.siteType))}${s.phpVersion ? ` ${esc(s.phpVersion)}` : ""}</td>
        <td>${esc(s.application || "Generic")}</td>
        <td class="action-cell"><a href="${BASE}/new?source=${encodeURIComponent(s.domain)}">Clone</a></td></tr>`)
      .join("");
    return `
      <div class="page-heading"><div><h1>New staging site</h1><p>Choose the site you want to clone.</p></div></div>
      ${error ? `<div class="alert" role="alert">${esc(error)}</div>` : ""}
      <div class="card card-table">
        ${
          sites.length === 0
            ? `<div class="empty">No clonable sites found in CloudPanel.</div>`
            : `<table><thead><tr><th scope="col">Domain</th><th scope="col">Type</th><th scope="col">Application</th><th scope="col" class="action-cell">Action</th></tr></thead><tbody>${options}</tbody></table>`
        }
      </div>`;
  }

  const sizeNote = source.sizeMb > 0 ? `${source.sizeMb} MB of files` : "size unknown";
  const dbNote = source.database ? `database ${esc(source.database)}` : "no database";
  const isInstatic = source.siteType === "reverse-proxy";

  // Only for an Instatic source, because only there is there a second
  // application to sign into. The password is the source instance's own
  // administrator credential: it is posted once, reaches the action binary on
  // stdin, and is deleted the moment the export it exists for has finished.
  const instaticFields = isInstatic
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

  const carriedNote = isInstatic
    ? `The clone gets its own Instatic container, port and secret key, and the source's pages and media
       are copied across through Instatic's own site bundle. The source's nginx config is carried too.`
    : `The clone is created ${source.phpVersion ? "with the same PHP version and " : ""}with the source's
       own nginx config where that can be done safely; when it cannot, the job says why.`;

  return `
    <div class="form-page">
    <div class="page-heading"><h1>New staging site</h1></div>
    ${error ? `<div class="alert" role="alert">${esc(error)}</div>` : ""}
    <div class="card">
      <div class="card-header"><h2>Source site</h2></div>
      <dl class="kv">
        <dt>Source</dt><dd>${esc(source.domain)}</dd>
        <dt>Type</dt><dd>${esc(typeLabel(source.siteType))}</dd>
        ${source.phpVersion ? `<dt>PHP</dt><dd>${esc(source.phpVersion)}</dd>` : ""}
        <dt>Template</dt><dd>${esc(source.application)}</dd>
        <dt>Contents</dt><dd>${esc(sizeNote)}, ${dbNote}</dd>
      </dl>
      <p class="hint">${carriedNote}</p>
    </div>
    <div class="card">
      <div class="card-header"><h2>Staging site settings</h2></div>
      <form onsubmit="event.preventDefault(); startClone();">
      <input type="hidden" id="source-domain" value="${esc(source.domain)}">
      <label for="target" class="required">Staging hostname</label>
      <input id="target" required autocomplete="off" placeholder="stg" oninput="previewTarget()" aria-describedby="target-preview">
      <div class="hint" id="target-preview" aria-live="polite">A label such as stg becomes stg.${esc(source.domain)}</div>
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

/**
 * The clones that can be promoted.
 *
 * Driven from this addon's own clone records rather than from a free choice of
 * two sites: a promote is the return leg of a clone, and a record of the clone
 * is what says which live site a staging copy belongs to. Anything else would
 * be a general site-to-site copy, which is not what this is.
 */
export function promoteListView(jobs: JobView[]): string {
  const promotable = jobs.filter((j) => j.kind !== "promote" && j.state === "done");
  const rows = promotable
    .map((j) => `<tr>
      <td><a href="${BASE}/jobs/${esc(j.id)}">${esc(j.target)}</a></td>
      <td>${esc(j.source)}</td>
      <td>${esc(j.result ? typeLabel(j.result.siteType) : "—")}</td>
      <td>${esc(when(j.finishedAt || j.createdAt))}</td>
      <td class="action-cell"><a href="${BASE}/promote?job=${encodeURIComponent(j.id)}">Promote</a></td>
    </tr>`)
    .join("");

  return `
    <div class="page-heading"><div><h1>Promote to live</h1>
      <p>Put a staging site's files back onto the live site it was cloned from.</p></div></div>
    <div class="card">
      <p class="hint danger-note">A promote moves files and, for an Instatic site, content. The live database is
        never overwritten: it holds the orders, form entries, comments and accounts created on the live site since
        the staging copy was taken, and nothing in a promote can tell those apart from stale rows.</p>
    </div>
    <div class="card card-table">
      ${promotable.length === 0
        ? `<div class="empty">No finished clones to promote. Clone a site first; a promote is the return leg of a clone.</div>`
        : `<table><thead><tr><th scope="col">Staging site</th><th scope="col">Live site</th><th scope="col">Type</th><th scope="col">Cloned</th><th scope="col" class="action-cell">Action</th></tr></thead><tbody>${rows}</tbody></table>`}
    </div>`;
}

/** The confirmation for one promote: what moves, what does not, and type-to-confirm. */
export function promoteView(job: JobView, error?: string): string {
  const result = job.result as JobResult | null;
  const isInstatic = result?.siteType === "reverse-proxy";
  const staging = job.target;
  const live = job.source;

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
    ${error ? `<div class="alert" role="alert">${esc(error)}</div>` : ""}
    <div class="card">
      <div class="card-header"><h2>What this does</h2></div>
      <dl class="kv">
        <dt>Promote</dt><dd>${esc(staging)}</dd>
        <dt>Onto</dt><dd>${esc(live)}</dd>
        <dt>Type</dt><dd>${esc(typeLabel(result?.siteType ?? ""))}</dd>
      </dl>
      <ul class="notes">${whatMoves}</ul>
      <p class="hint danger-note">The live database is not overwritten. Everything created on ${esc(live)} since
        this clone was taken — orders, form submissions, comments, accounts — stays exactly as it is, and any
        content edited on ${esc(staging)} that lives in the database does not move.</p>
    </div>
    <div class="card">
      <div class="card-header"><h2>Confirm</h2></div>
      <form onsubmit="event.preventDefault(); startPromote('${escJs(job.id)}');">
      ${credentialFields}
      <label for="promote-confirm" class="required">Type ${esc(live)} to confirm</label>
      <input id="promote-confirm" required autocomplete="off" data-domain="${esc(live)}" placeholder="${esc(live)}">
      <div class="hint">${esc(live)} serves the replaced files from the moment the switch completes.</div>
      <div class="form-actions">
        <a class="btn btn-lg" href="${BASE}/promote">Back</a>
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
              ? `<span class="mono">${esc(job.target)}</span> <span class="hint" style="display:inline">(deleted from CloudPanel)</span>`
              : `<a href="https://${esc(job.target)}" target="_blank" rel="noopener">${esc(job.target)}</a>`
          }</dd>
          <dt>Type</dt><dd>${esc(typeLabel(result.siteType))}</dd>
          <dt>Site user</dt><dd>${esc(result.siteUser)}</dd>
          ${result.phpVersion ? `<dt>PHP</dt><dd>${esc(result.phpVersion)}</dd>` : ""}
          <dt>Template</dt><dd>${esc(result.vhostTemplate)}</dd>
          <dt>Vhost</dt><dd>${vhostNote}</dd>
        </dl>
        <p class="hint">${
          missing
            ? "This staging site has been deleted from CloudPanel."
            : "The site user's password was generated and not kept. Set one in Site → SSH/FTP if you need SFTP access."
        }</p>
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
        <p class="hint">The live database was not touched. It holds what this site's own visitors created
          since the staging copy was taken, and nothing in a promote can tell that apart from a stale row.</p>
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

  const promoteAction = !promote && job.state === "done"
    ? `<a class="btn" href="${BASE}/promote?job=${encodeURIComponent(job.id)}">Promote to live</a>`
    : "";

  return `
    <div class="page-heading"><h1>${promote ? "Promote details" : "Staging site details"}</h1>
      <div class="page-actions">${promoteAction}<a class="btn" href="${BASE}/">Back to staging sites</a></div></div>
    <div class="card">
      <div class="card-header"><h2>${promote ? "Promote status" : "Clone status"}</h2></div>
      <div class="job-summary">
        <span class="job-domain">${esc(job.source)}</span>
        <span class="hint" style="margin:0;">→</span>
        <span class="job-domain">${esc(job.target)}</span>
        <span class="badge ${stateClass(job.state)}" id="job-state">${esc(job.state)}</span>
        ${missing ? '<span class="badge" style="color:var(--bad);border-color:var(--bad);">site deleted</span>' : ""}
      </div>
      <div class="step" id="job-step" style="margin-top:0.5rem;">${esc(finished ? "" : job.step)}</div>
      ${missing ? '<div class="alert" style="margin-top:0.75rem;">This staging site has been deleted from CloudPanel.</div>' : ""}
      ${job.error ? `<div class="alert" style="margin-top:0.75rem;">${esc(job.error)}</div>` : ""}
      <dl class="kv job-timing">
        <dt>Started</dt><dd>${esc(when(job.startedAt || job.createdAt))}</dd>
        <dt>Finished</dt><dd>${esc(when(job.finishedAt))}</dd>
      </dl>
    </div>
    ${site}
    ${promotedSite}
    ${rollback}
    ${instatic}
    ${credentials}
    ${notes}
    <div class="card">
      <div class="card-header"><h2>Log</h2></div>
      <pre id="job-log">${esc(logText || "(no output yet)")}</pre>
    </div>
    ${finished ? "" : `<div id="job-watch" data-job="${esc(job.id)}" hidden></div>`}`;
}
