// Server-rendered HTML. Every interpolated value goes through esc() or escJs():
// domains, job steps and wrapper notes all originate outside this process, and
// the page is served to an operator whose session can create CloudPanel sites.

import { esc } from "../../../lib/app-http";
import { renderLayout } from "../../../lib/app-ui";
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
.state-queued { color: var(--muted); border-color: var(--border); }
.state-running { color: var(--accent); border-color: var(--accent); }
.state-done { color: var(--ok); border-color: var(--ok); }
.state-failed { color: var(--bad); border-color: var(--bad); }
.notes { margin: 0; padding-left: 1.1rem; }
.notes li { margin: 0.35rem 0; font-size: 0.88rem; color: var(--muted); }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 0.4rem 1rem; align-items: baseline; }
.kv dt { color: var(--muted); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; }
.kv dd { margin: 0; font-family: var(--mono); font-size: 0.85rem; word-break: break-all; }
.secret { border: 1px dashed var(--warn); border-radius: 8px; padding: 0.8rem 1rem; }
.step { color: var(--muted); font-size: 0.85rem; }
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
  busy(true);
  try {
    const body = await call('/api/clones', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: source, target: target, tls: tls }),
    });
    location.href = CLP_BASE + '/jobs/' + encodeURIComponent(body.data.job);
  } catch (e) {
    busy(false);
    alert('Could not start the clone: ' + e.message);
  }
  return false;
}

// Poll while the job is in flight, then reload once so the finished record is
// rendered by the server rather than assembled twice, here and there.
function watchJob(id) {
  let stopped = false;
  async function tick() {
    if (stopped) return;
    try {
      const body = await call('/api/jobs/' + encodeURIComponent(id));
      const job = body.data.job;
      document.getElementById('job-state').textContent = job.state;
      document.getElementById('job-state').className = 'badge state-' + job.state;
      document.getElementById('job-step').textContent = job.step || '';
      const pre = document.getElementById('job-log');
      if (pre) {
        pre.textContent = body.data.log || '(no output yet)';
        pre.scrollTop = pre.scrollHeight;
      }
      if (job.state === 'done' || job.state === 'failed') {
        stopped = true;
        location.reload();
        return;
      }
    } catch (e) {
      // A failed poll is not a failed clone. Keep trying: the job runs in its
      // own systemd unit and does not care whether this page can reach it.
    }
    setTimeout(tick, 2000);
  }
  setTimeout(tick, 1500);
}

// Wired here rather than from an inline <script> inside the page body: the
// shell puts this script after <main>, so a call written next to the markup
// would run before any of these functions exist.
document.addEventListener('DOMContentLoaded', function () {
  if (document.getElementById('target')) previewTarget();
  const watch = document.getElementById('job-watch');
  if (watch) watchJob(watch.getAttribute('data-job'));
});
`;

export function layout(title: string, content: string): string {
  return renderLayout(title, content, {
    brand: "Stager",
    base: BASE,
    nav: [
      { href: `${BASE}/`, label: "Clones" },
      { href: `${BASE}/new`, label: "New staging site" },
    ],
    css: STYLE,
    script: CLIENT_JS,
  });
}

function stateClass(state: string): string {
  const known = ["queued", "running", "done", "failed"];
  return known.includes(state) ? `state-${state}` : "state-failed";
}

function when(iso: string): string {
  return iso ? iso.replace("T", " ").replace("Z", " UTC") : "—";
}

export function jobsView(jobs: JobView[]): string {
  const active = jobs.filter((j) => j.state === "queued" || j.state === "running").length;
  const rows = jobs
    .map(
      (j) => `
        <tr>
          <td><a href="${BASE}/jobs/${esc(j.id)}" class="mono">${esc(j.target)}</a></td>
          <td class="mono">${esc(j.source)}</td>
          <td><span class="badge ${stateClass(j.state)}">${esc(j.state)}</span></td>
          <td class="step">${esc(j.state === "done" ? "" : j.step)}</td>
          <td class="mono">${esc(when(j.createdAt))}</td>
        </tr>`
    )
    .join("");

  return `
    <div class="card">
      <div class="stats">
        <div class="stat"><div class="label">Clones on record</div><div class="value">${jobs.length}</div></div>
        <div class="stat"><div class="label">In flight</div><div class="value">${active}</div></div>
      </div>
    </div>
    <div class="card">
      <div class="actions" style="justify-content: flex-end; margin-bottom: 0.75rem;">
        <a class="btn btn-primary" href="${BASE}/new">New staging site</a>
      </div>
      ${
        jobs.length === 0
          ? `<div class="empty">No clones yet. Start one from a site's Staging tab in CloudPanel, or with the button above.</div>`
          : `<table>
        <thead><tr><th>Staging site</th><th>Cloned from</th><th>State</th><th>Step</th><th>Started</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
      }
    </div>`;
}

export function newCloneView(source: SiteDetail | null, sites: SiteSummary[], error?: string): string {
  if (!source) {
    const options = sites
      .map((s) => `<li><a href="${BASE}/new?source=${encodeURIComponent(s.domain)}" class="mono">${esc(s.domain)}</a>
        <span class="hint" style="display:inline">PHP ${esc(s.phpVersion)} · ${esc(s.application || "Generic")}</span></li>`)
      .join("");
    return `
      ${error ? `<div class="alert">${esc(error)}</div>` : ""}
      <div class="card">
        <h2 style="margin-top:0;font-size:1rem;">Which site should be cloned?</h2>
        ${
          sites.length === 0
            ? `<div class="empty">No PHP sites found in CloudPanel.</div>`
            : `<ul class="notes">${options}</ul>`
        }
      </div>`;
  }

  const sizeNote = source.sizeMb > 0 ? `${source.sizeMb} MB of files` : "size unknown";
  const dbNote = source.database ? `database ${esc(source.database)}` : "no database";

  return `
    ${error ? `<div class="alert">${esc(error)}</div>` : ""}
    <div class="card">
      <h2 style="margin-top:0;font-size:1rem;">Clone ${esc(source.domain)}</h2>
      <dl class="kv">
        <dt>Source</dt><dd>${esc(source.domain)}</dd>
        <dt>PHP</dt><dd>${esc(source.phpVersion)}</dd>
        <dt>Template</dt><dd>${esc(source.application)}</dd>
        <dt>Contents</dt><dd>${esc(sizeNote)}, ${dbNote}</dd>
      </dl>
      <p class="hint">The clone is created with the same PHP version and the same vhost template.
        Any hand edits to the source's vhost are reported afterwards rather than copied.</p>
    </div>
    <div class="card">
      <input type="hidden" id="source-domain" value="${esc(source.domain)}">
      <label for="target">Staging hostname</label>
      <input id="target" autocomplete="off" placeholder="stg" oninput="previewTarget()">
      <div class="hint" id="target-preview">A label such as stg becomes stg.${esc(source.domain)}</div>

      <label for="tls" style="display:flex;align-items:center;gap:0.5rem;margin-top:1.25rem;">
        <input type="checkbox" id="tls" style="width:auto;">
        <span>Request a Let's Encrypt certificate when the clone finishes</span>
      </label>
      <div class="hint">Only tick this once the hostname's DNS points at this server, or the request fails
        and you issue it later from Site → SSL/TLS.</div>

      <div class="actions" style="margin-top:1.5rem;justify-content:flex-end;">
        <button class="btn btn-primary" onclick="return startClone()">Create staging site</button>
      </div>
    </div>`;
}

export function jobView(job: JobView, logText: string): string {
  const finished = job.state === "done" || job.state === "failed";
  const result = job.result;

  const notes = result?.notes?.length
    ? `<div class="card">
        <h2 style="margin-top:0;font-size:1rem;">Worth knowing</h2>
        <ul class="notes">${result.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
      </div>`
    : "";

  const credentials = result?.database
    ? `<div class="card secret">
        <h2 style="margin-top:0;font-size:1rem;">Staging database</h2>
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

  const site = result
    ? `<div class="card">
        <dl class="kv">
          <dt>Staging site</dt><dd><a href="https://${esc(job.target)}" target="_blank" rel="noopener">${esc(job.target)}</a></dd>
          <dt>Site user</dt><dd>${esc(result.siteUser)}</dd>
          <dt>PHP</dt><dd>${esc(result.phpVersion)}</dd>
          <dt>Template</dt><dd>${esc(result.vhostTemplate)}</dd>
          <dt>Vhost</dt><dd>${result.vhostCarried
            ? "copied from the source"
            : `the stock ${esc(result.vhostTemplate)} template`}</dd>
        </dl>
        <p class="hint">The site user's password was generated and not kept. Set one in Site → SSH/FTP if you
          need SFTP access.</p>
      </div>`
    : "";

  return `
    <div class="card">
      <div style="display:flex;align-items:center;gap:0.75rem;">
        <span class="mono">${esc(job.source)}</span>
        <span class="hint" style="margin:0;">→</span>
        <span class="mono">${esc(job.target)}</span>
        <span class="spacer" style="flex:1;"></span>
        <span class="badge ${stateClass(job.state)}" id="job-state">${esc(job.state)}</span>
      </div>
      <div class="step" id="job-step" style="margin-top:0.5rem;">${esc(finished ? "" : job.step)}</div>
      ${job.error ? `<div class="alert" style="margin-top:0.75rem;">${esc(job.error)}</div>` : ""}
      <dl class="kv" style="margin-top:1rem;">
        <dt>Started</dt><dd>${esc(when(job.startedAt || job.createdAt))}</dd>
        <dt>Finished</dt><dd>${esc(when(job.finishedAt))}</dd>
      </dl>
    </div>
    ${site}
    ${credentials}
    ${notes}
    <div class="card">
      <h2 style="margin-top:0;font-size:1rem;">Log</h2>
      <pre id="job-log">${esc(logText || "(no output yet)")}</pre>
    </div>
    ${finished ? "" : `<div id="job-watch" data-job="${esc(job.id)}" hidden></div>`}`;
}
