import type { SanitizedSite } from "../../../lib/snapshot-reader";
// Server-rendered HTML. Every interpolated value goes through esc() or escJs():
// domains, job steps and the action binary's notes all originate outside this
// process, and
// the page is served to an operator whose session can create CloudPanel sites.

import { esc } from "../../../lib/app-http";
import { JOB_STYLE, JOB_WATCH_JS, renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";

/**
 * Where this addon is served. One CloudPanel site carries every addon, so every
 * link this file emits is relative to a mount rather than to the site root.
 * A constant rather than a per-request value: the mount is fixed by the addon's
 * name, so a link that forgets it is a bug at build time, not a routing choice.
 */
const BASE = mountPath("stager");
import type { JobView, SiteDetail, SiteSummary } from "./service";

// Only what the shared shell does not carry.
const STYLE = `
.notes { margin: 0; padding-left: 1.1rem; }
.notes li { margin: 8px 0; font-size: 14px; color: var(--muted); }
.kv + .hint { margin: 20px 0 0; }
.secret .kv dd { font-family: var(--mono); font-size: 14px; }
.credential-fields { border-top: 1px solid var(--border); padding-top: 25px; margin-top: 25px; }
.credential-fields h2 { margin: 0 0 20px; }
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
  // request and never stored anywhere, because the password belongs to the
  // administrator of another running application.
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
  updateNotice?: { current: string; latest: string } | null
): string {
  return renderLayout(title, content, {
    brand: "Stager",
    base: BASE,
    nav: [
      { href: `${BASE}/`, label: "Clones" },
      { href: `${BASE}/new`, label: "New staging site" },
    ],
    css: STYLE + JOB_STYLE,
    script: JOB_WATCH_JS + CLIENT_JS,
    updateNotice,
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
        <thead><tr><th scope="col">Staging site</th><th scope="col">Cloned from</th><th scope="col">Type</th><th scope="col">State</th><th scope="col">Step</th><th scope="col">Started</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
      }
    </div>`;
}

/** How a site's `type` column reads to an operator. */
function typeLabel(t: string): string {
  if (t === "php") return "PHP";
  if (t === "static") return "Static";
  if (t === "reverse-proxy") return "Instatic";
  return t;
}

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
        <h2>Source Instatic Account</h2>
        <div class="form-grid">
          <div class="form-field">
            <label for="instatic-email" class="required">Admin Email</label>
            <input id="instatic-email" type="email" required autocomplete="off" placeholder="you@example.com">
          </div>
          <div class="form-field">
            <label for="instatic-password" class="required">Password</label>
            <input id="instatic-password" type="password" required autocomplete="new-password">
          </div>
          <div class="form-field">
            <label for="instatic-mfa">Authentication Code</label>
            <input id="instatic-mfa" autocomplete="off" inputmode="numeric" placeholder="123456" aria-describedby="mfa-hint">
            <div class="hint" id="mfa-hint">Required only if MFA is enabled.</div>
          </div>
        </div>
        <div class="hint">Used once, to export the source's content through Instatic's own site bundle.
          It is never stored: the clone gets an owner, a secret key and a container of its own.</div>
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
      <div class="card-header"><h2>Source Site</h2></div>
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
      <div class="card-header"><h2>Staging Site Settings</h2></div>
      <form onsubmit="event.preventDefault(); startClone();">
      <input type="hidden" id="source-domain" value="${esc(source.domain)}">
      <label for="target" class="required">Staging Hostname</label>
      <input id="target" required autocomplete="off" placeholder="stg" oninput="previewTarget()" aria-describedby="target-preview">
      <div class="hint" id="target-preview" aria-live="polite">A label such as stg becomes stg.${esc(source.domain)}</div>
      ${instaticFields}

      <div class="check-field">
      <label for="tls" class="check-label">
        <input type="checkbox" id="tls" aria-describedby="tls-hint">
        <span>Request a Let's Encrypt certificate when the clone finishes</span>
      </label>
      <div class="hint" id="tls-hint">Only tick this once the hostname's DNS points at this server, or the request fails
        and you issue it later from Site → SSL/TLS.</div>
      </div>

      <div class="form-actions">
        <a class="btn btn-lg" href="${BASE}/new">Back</a>
        <button class="btn btn-primary btn-lg" type="submit">Create staging site</button>
      </div>
      </form>
    </div></div>`;
}

export function jobView(
  job: JobView,
  logText: string,
  snapshotAge = Infinity,
  panelSites: SanitizedSite[] = [],
  snapshotTakenAt = ""
): string {
  const finished = job.state === "done" || job.state === "failed";
  const result = job.result;
  const missing = isSiteMissing(job, snapshotAge, panelSites, snapshotTakenAt);

  const notes = result?.notes?.length
    ? `<div class="card">
        <div class="card-header"><h2>Clone Notes</h2></div>
        <ul class="notes">${result.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
      </div>`
    : "";

  const credentials = result?.database
    ? `<div class="card secret">
        <div class="card-header"><h2>Staging Database</h2></div>
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
        <div class="card-header"><h2>Staging Site</h2></div>
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
        <div class="card-header"><h2>Staging Instatic Instance</h2></div>
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

  return `
    <div class="page-heading"><h1>Staging site details</h1><a class="btn" href="${BASE}/">Back to staging sites</a></div>
    <div class="card">
      <div class="card-header"><h2>Clone Status</h2></div>
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
    ${instatic}
    ${credentials}
    ${notes}
    <div class="card">
      <div class="card-header"><h2>Log</h2></div>
      <pre id="job-log">${esc(logText || "(no output yet)")}</pre>
    </div>
    ${finished ? "" : `<div id="job-watch" data-job="${esc(job.id)}" hidden></div>`}`;
}
