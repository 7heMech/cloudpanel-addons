// Server-rendered HTML for the Git addon. Every interpolated value goes through
// esc(): remote URLs, branch names, commit subjects and a post-deploy command
// all come from outside this process and are drawn for an operator whose
// session can change any site on the box.

import { esc } from "../../../lib/app-http";
import { JOB_STYLE, JOB_WATCH_JS, renderFragment, renderLayout } from "../../../lib/app-ui";
import type { EmbedFragment } from "../../../lib/shadow-embed";
import type { SiteContext } from "../../../lib/site-context";
import { siteTypeLabel } from "../../../lib/site-context";
import { mountPath } from "../../../lib/mount";
import {
  MAX_BRANCH_LENGTH, MAX_DIRECTORY_LENGTH, MAX_POST_DEPLOY_LENGTH, MAX_REMOTE_LENGTH,
} from "../action";
import { gitHookPath } from "./hook";
import type { GitJobView, GitSiteStatus } from "./service";

const BASE = mountPath("git");

// Only what the shared shell does not carry.
const STYLE = `
.key-block { display: flex; gap: 12px; align-items: flex-start; }
.key-block pre { flex: 1 1 auto; margin: 0; max-height: 140px; white-space: pre-wrap; overflow-wrap: anywhere; }
.hook-curl { margin: 0 0 16px; white-space: pre-wrap; overflow-wrap: anywhere; }
.hook-delivery { margin-bottom: 8px; color: var(--text); }
.commit-subject { overflow-wrap: anywhere; }
.deploy-path { overflow-wrap: anywhere; }
.addon-section { margin-top: 30px; }
/* The domain is the column an operator scans; the commit is the one that grows
   without limit, so it is the one that gives way. */
.fleet-table td.site-cell, .fleet-table th.site-col { min-width: 210px; }
.fleet-table td.commit-cell { max-width: 320px; }
.addon-section h2 { margin: 0 0 16px; }
@media (max-width: 760px) {
  .key-block { flex-direction: column; }
  .key-block .btn { width: 100%; }
}
`;

/**
 * The pages' inline script.
 *
 * A TypeScript template literal: a backslash written here is consumed once
 * before the browser sees it, so escapes meant for the browser are doubled.
 * Element lookups go through CLP_ROOT, which is the shadow root when this page
 * is mounted inside CloudPanel's own site page.
 */
export const CLIENT_JS = `
function gitField(id) {
  const el = CLP_ROOT.getElementById(id);
  return el ? el.value.trim() : '';
}

async function saveGitConfig(domain) {
  const payload = {
    remote: gitField('git-remote'),
    branch: gitField('git-branch'),
    directory: gitField('git-directory'),
    postDeploy: gitField('git-post-deploy'),
  };
  if (!payload.remote || !payload.branch) {
    notify('Enter the repository URL and the branch to deploy.', 'error');
    return false;
  }
  busy(true);
  try {
    await call('/api/sites/' + encodeURIComponent(domain) + '/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    location.reload();
  } catch (e) {
    busy(false);
    notify('Could not save: ' + e.message, 'error');
  }
  return false;
}

async function forgetGitSite(domain) {
  const accepted = await confirmAction({
    title: 'Stop deploying this site?',
    text: 'The repository settings for ' + domain + ' are removed.',
    details: ['The checked-out files stay where they are.', 'The deploy key stays with the site user.'],
    confirmLabel: 'Stop deploying',
    danger: true,
  });
  if (!accepted) return;
  busy(true);
  try {
    await call('/api/sites/' + encodeURIComponent(domain) + '/config', { method: 'DELETE' });
    location.reload();
  } catch (e) {
    busy(false);
    notify('Could not remove the settings: ' + e.message, 'error');
  }
}

async function generateGitKey(domain, replace) {
  if (replace) {
    const accepted = await confirmAction({
      title: 'Replace the deploy key?',
      text: 'A new key is generated for ' + domain + '.',
      details: ['Deployments fail until the new public key is added to the repository.'],
      confirmLabel: 'Replace key',
      danger: true,
    });
    if (!accepted) return;
  }
  busy(true);
  try {
    await call('/api/sites/' + encodeURIComponent(domain) + '/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replace: replace === true }),
    });
    location.reload();
  } catch (e) {
    busy(false);
    notify('Could not generate the key: ' + e.message, 'error');
  }
}

function copyGitBlock(id, what) {
  const block = CLP_ROOT.getElementById(id);
  if (!block) return;
  const text = block.textContent || '';
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      function () { notify(what + ' copied.', 'ok'); },
      function () { notify('Select the ' + what.toLowerCase() + ' and copy it.', 'warn'); }
    );
    return;
  }
  // No clipboard API: select it so one keystroke finishes the job.
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(block);
  selection.removeAllRanges();
  selection.addRange(range);
  notify('Press Ctrl+C to copy the selection.', 'warn');
}

// A mode, not an action: no confirmation either way, and the switch goes back
// where it was if the change did not take.
async function setGitWebhook(domain, on) {
  busy(true);
  try {
    await call('/api/sites/' + encodeURIComponent(domain) + '/webhook',
      on ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' } : { method: 'DELETE' });
    location.reload();
  } catch (e) {
    busy(false);
    const box = CLP_ROOT.getElementById('git-webhook-toggle');
    if (box) box.checked = !on;
    notify('Could not change push to deploy: ' + e.message, 'error');
  }
}

async function rotateGitWebhook(domain) {
  const accepted = await confirmAction({
    title: 'Rotate the webhook URL?',
    text: 'A new URL is generated for ' + domain + '.',
    details: ['Deliveries fail until the new URL is pasted back into the repository.'],
    confirmLabel: 'Rotate URL',
    danger: true,
  });
  if (!accepted) return;
  busy(true);
  try {
    await call('/api/sites/' + encodeURIComponent(domain) + '/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replace: true }),
    });
    location.reload();
  } catch (e) {
    busy(false);
    notify('Could not rotate the URL: ' + e.message, 'error');
  }
}

async function deployGitSite(domain) {
  busy(true);
  clearNotice();
  try {
    const body = await call('/api/deployments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: domain }),
    });
    const card = CLP_ROOT.getElementById('git-job-card');
    if (!card) {
      location.reload();
      return;
    }
    // Watched where it was started rather than on a page of its own: this view
    // is mounted inside CloudPanel's site page, and navigating away from it
    // would leave the panel behind to show a log.
    card.hidden = false;
    busy(false);
    updateJobUI({ state: 'queued', step: 'queued' }, '', card);
    watchJob(body.data.job, card);
  } catch (e) {
    busy(false);
    notify('Could not start the deployment: ' + e.message, 'error');
  }
}

function gitSelected() {
  return Array.from(CLP_ROOT.querySelectorAll('.git-select:checked')).map(function (box) {
    return box.getAttribute('data-domain');
  });
}

function gitSelectionChanged() {
  const button = CLP_ROOT.getElementById('git-deploy-selected');
  if (button) button.disabled = gitSelected().length === 0;
}

function toggleGitAll(checked) {
  CLP_ROOT.querySelectorAll('.git-select').forEach(function (box) { box.checked = checked; });
  gitSelectionChanged();
}

// The fleet answer to "deploy these": one request per site, reported together,
// so a failure names the site it belongs to instead of stopping the rest.
async function deployGitSelected() {
  const domains = gitSelected();
  if (domains.length === 0) return;
  const accepted = await confirmAction({
    title: 'Deploy ' + domains.length + ' site' + (domains.length === 1 ? '' : 's') + '?',
    text: 'Each site fetches its configured branch and runs its post-deploy command.',
    details: domains,
    confirmLabel: 'Deploy',
  });
  if (!accepted) return;
  busy(true);
  const failed = [];
  for (const domain of domains) {
    try {
      await call('/api/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domain }),
      });
    } catch (e) {
      failed.push(domain + ': ' + e.message);
    }
  }
  busy(false);
  if (failed.length) notify('Some deployments did not start. ' + failed.join(' '), 'error');
  else notify('Started ' + domains.length + ' deployment' + (domains.length === 1 ? '' : 's') + '.', 'ok');
  setTimeout(function () { location.reload(); }, 1200);
}

// The path is completed to a URL by the browser, which knows exactly which
// address the operator reached the panel on -- including behind a proxy that
// rewrites Host, where the manager's own view of the address would be wrong.
function initGitWebhookUrl() {
  const block = CLP_ROOT.getElementById('git-webhook-url');
  if (!block) return;
  const url = location.origin + block.getAttribute('data-path');
  block.textContent = url;
  const curl = CLP_ROOT.getElementById('git-webhook-curl');
  if (curl) curl.textContent = 'curl -X POST ' + url;
}

function initGit() {
  initGitWebhookUrl();
  CLP_ROOT.querySelectorAll('.git-select').forEach(function (box) {
    box.addEventListener('change', gitSelectionChanged);
  });
  gitSelectionChanged();
  const watch = CLP_ROOT.getElementById('job-watch');
  if (watch) watchJob(watch.getAttribute('data-job'), CLP_ROOT.getElementById('git-job-card'));
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGit);
} else {
  initGit();
}
`;

// Built once: neither half of either pair changes between renders.
const PAGE_STYLE = STYLE + JOB_STYLE;
const PAGE_SCRIPT = JOB_WATCH_JS + CLIENT_JS;

export function layout(
  title: string,
  content: string,
  updateNotice?: { current: string; latest: string } | null,
  site?: SiteContext,
): string {
  return renderLayout(title, content, {
    brand: "Git Deploy",
    base: BASE,
    nav: [],
    css: PAGE_STYLE,
    script: PAGE_SCRIPT,
    updateNotice,
    ...(site ? { site: { ...site, activeSlug: "git" } } : {}),
  });
}

/** The same page as `layout`, as a fragment mounted in CloudPanel's site page. */
export function fragment(title: string, content: string): EmbedFragment {
  return renderFragment(title, content, {
    brand: "Git Deploy",
    base: BASE,
    nav: [],
    css: PAGE_STYLE,
    script: PAGE_SCRIPT,
  });
}

function stateClass(state: string): string {
  return ["queued", "running", "done", "failed"].includes(state) ? `state-${state}` : "state-failed";
}

function when(iso: string): string {
  return iso ? iso.replace("T", " ").replace("Z", " UTC") : "—";
}

/** How long ago, for a line an operator reads to see whether pushes arrive. */
function since(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return when(iso);
  const minutes = Math.round(Math.max(0, Date.now() - then) / 60_000);
  if (minutes < 1) return "just now";
  const plural = (value: number, unit: string): string => `${value} ${unit}${value === 1 ? "" : "s"} ago`;
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.round(minutes / 60);
  return hours < 24 ? plural(hours, "hour") : plural(Math.round(hours / 24), "day");
}

/**
 * What the last delivery did.
 *
 * The recorded outcome says what the delivery itself decided; when it started a
 * deployment that has since finished, that job is the better answer, because
 * "started a deployment" three minutes after the deployment failed is not what
 * the operator came to find out.
 */
function deliveryLine(site: GitSiteStatus): string {
  const webhook = site.config?.webhook;
  if (!webhook) return "";
  if (!webhook.lastDeliveryAt) return "No delivery yet.";
  const job = webhook.lastDeliveryJob && site.lastJob?.id === webhook.lastDeliveryJob ? site.lastJob : null;
  const what = !job ? webhook.lastDelivery
    : job.state === "done" ? `deployed ${job.result?.commit?.shortHash ?? site.config?.branch ?? "the branch"}`
    : job.state === "failed" ? "the deployment failed"
    : "deploying now";
  return `Last delivery: ${since(webhook.lastDeliveryAt)} — ${what}`;
}

function commitLine(site: GitSiteStatus): string {
  return site.commit ? `${site.commit.shortHash} ${site.commit.subject}` : "not deployed";
}

/** The job card: the last deployment's state, step and output. */
function jobCard(job: GitJobView | null, log = ""): string {
  const finished = !job || job.state === "done" || job.state === "failed";
  const hidden = job ? "" : " hidden";
  return `
    <div class="card" id="git-job-card"${hidden}>
      <div class="card-header"><h2>Last deployment</h2></div>
      <div class="job-summary">
        <span class="job-domain">${job ? esc(when(job.startedAt || job.createdAt)) : "—"}${
          job?.startedBy === "push" ? ' <span class="hint" style="display:inline;">started by a push</span>' : ""
        }</span>
        <span class="badge ${stateClass(job?.state ?? "queued")}" id="job-state">${esc(job?.state ?? "queued")}</span>
      </div>
      <div class="step" id="job-step" style="margin-top:0.5rem;">${esc(job && !finished ? job.step : "")}</div>
      ${job?.error ? `<div class="alert" style="margin-top:0.75rem;">${esc(job.error)}</div>` : ""}
      <details style="margin-top:20px;"${job && job.state === "failed" ? " open" : ""}>
        <summary>Output</summary>
        <pre id="job-log" style="margin-top:12px;">${esc(log || "(no output yet)")}</pre>
      </details>
      ${job && !finished ? `<div id="job-watch" data-job="${esc(job.id)}" hidden></div>` : ""}
    </div>`;
}

/**
 * The site-scoped page: what is deployed now, what is configured, the deploy
 * key, and the last deployment's log.
 */
export function siteView(site: GitSiteStatus, log: string): string {
  const config = site.config;
  const deployAction = site.configured
    ? `<button class="btn btn-primary" type="button" onclick="deployGitSite('${esc(site.domain)}')">Deploy now</button>`
    : "";

  const current = `
    <div class="card">
      <div class="card-header"><h2>Deployed now</h2></div>
      ${
        site.commit
          ? `<dl class="kv">
        <dt>Commit</dt><dd class="mono">${esc(site.commit.hash)}</dd>
        <dt>Message</dt><dd class="commit-subject">${esc(site.commit.subject)}</dd>
        <dt>Author</dt><dd>${esc(site.commit.author || "—")}</dd>
        <dt>Committed</dt><dd>${esc(site.commit.committedAt ? when(site.commit.committedAt) : "—")}</dd>
        <dt>Directory</dt><dd class="mono deploy-path">${esc(site.path)}</dd>
      </dl>`
          : `<div class="empty">Nothing has been deployed into ${esc(site.path || site.domain)} yet.</div>`
      }
    </div>`;

  const form = `
    <div class="addon-section">
      <h2>Repository</h2>
      <div class="card">
        <div class="form-grid">
          <div class="form-field form-field-full">
            <label class="required" for="git-remote">Repository URL</label>
            <input id="git-remote" type="text" maxlength="${MAX_REMOTE_LENGTH}" spellcheck="false" autocapitalize="off"
              placeholder="git@github.com:owner/repo.git" value="${esc(config?.remote ?? "")}">
            <div class="hint">An SSH URL uses this site's deploy key. An HTTPS URL works for a public repository.</div>
          </div>
          <div class="form-field">
            <label class="required" for="git-branch">Branch</label>
            <input id="git-branch" type="text" maxlength="${MAX_BRANCH_LENGTH}" spellcheck="false" autocapitalize="off"
              placeholder="main" value="${esc(config?.branch ?? "main")}">
          </div>
          <div class="form-field">
            <label for="git-directory">Subdirectory</label>
            <input id="git-directory" type="text" maxlength="${MAX_DIRECTORY_LENGTH}" spellcheck="false" autocapitalize="off"
              placeholder="(the site directory)" value="${esc(config?.directory ?? "")}">
            <div class="hint">Under /home/${esc(site.siteUser)}/htdocs/${esc(site.domain)}. Leave empty to deploy into it.</div>
          </div>
          <div class="form-field form-field-full">
            <label for="git-post-deploy">Post-deploy command</label>
            <input id="git-post-deploy" type="text" maxlength="${MAX_POST_DEPLOY_LENGTH}" spellcheck="false" autocapitalize="off"
              placeholder="composer install --no-dev" value="${esc(config?.postDeploy ?? "")}">
            <div class="hint">Run as ${esc(site.siteUser)} in the deployed directory after every deployment.</div>
          </div>
        </div>
        <div class="form-actions">
          ${
            site.configured
              ? `<button class="btn btn-danger" type="button" onclick="forgetGitSite('${esc(site.domain)}')">Stop deploying</button>`
              : ""
          }
          <button class="btn btn-primary" type="button" onclick="saveGitConfig('${esc(site.domain)}')">Save</button>
        </div>
      </div>
    </div>`;

  const key = `
    <div class="addon-section">
      <h2>Deploy key</h2>
      <div class="card">
        ${
          site.publicKey
            ? `<p class="hint">Add this public key to the repository as a deploy key. Its private half was generated
            as ${esc(site.siteUser)} and never leaves this server.</p>
        <div class="key-block">
          <pre id="git-public-key">${esc(site.publicKey)}</pre>
          <button class="btn" type="button" onclick="copyGitBlock('git-public-key', 'Deploy key')">Copy</button>
        </div>
        <div class="actions" style="margin-top:20px;">
          <button class="btn btn-danger" type="button" onclick="generateGitKey('${esc(site.domain)}', true)">Replace key</button>
        </div>`
            : `<p class="hint">A private repository needs a deploy key. It is generated as ${esc(site.siteUser)}
            in that account's own <span class="mono">.ssh</span> directory; only its public half is shown here.</p>
        <div class="actions">
          <button class="btn btn-primary" type="button" onclick="generateGitKey('${esc(site.domain)}', false)">Generate deploy key</button>
        </div>`
        }
      </div>
    </div>`;

  return `
    <div class="page-heading">
      <div>
        <h1>Git deploy</h1>
        <p>Fetch ${esc(site.domain)}'s files from a Git remote and run a command afterwards.</p>
      </div>
      ${deployAction}
    </div>
    ${current}
    ${form}
    ${key}
    ${webhookSection(site)}
    <div class="addon-section">${jobCard(site.lastJob, log)}</div>`;
}

/**
 * Push to deploy: a switch that mints the URL and a switch that invalidates it.
 *
 * The URL is the whole credential, so it is shown the way the deploy key is --
 * read-only with a Copy button -- and Rotate is the only control here that
 * confirms, because every delivery fails until the new URL is pasted back.
 */
function webhookSection(site: GitSiteStatus): string {
  const webhook = site.config?.webhook ?? null;
  const path = webhook ? gitHookPath(site.domain, webhook.token) : "";
  const branch = site.config?.branch ?? "the configured branch";
  const url = !webhook ? "" : `
        <div class="key-block" style="margin-top:20px;">
          <pre id="git-webhook-url" data-path="${esc(path)}">${esc(path)}</pre>
          <button class="btn" type="button" onclick="copyGitBlock('git-webhook-url', 'Webhook URL')">Copy</button>
        </div>
        <p class="hint">In GitHub: Settings → Webhooks → Add webhook, content type
          <span class="mono">application/json</span>. From anything else:</p>
        <pre class="hook-curl mono" id="git-webhook-curl">curl -X POST ${esc(path)}</pre>
        <div class="hint hook-delivery">${esc(deliveryLine(site))}</div>
        <p class="hint">Anyone who has this URL can deploy this site. Rotate it if it leaks.</p>
        <div class="actions">
          <button class="btn btn-danger" type="button" onclick="rotateGitWebhook('${esc(site.domain)}')">Rotate URL</button>
        </div>`;

  return `
    <div class="addon-section">
      <h2>Push to deploy</h2>
      <div class="card">
        <div class="switch-row">
          <p class="hint" style="margin:0;">${
            site.configured ? `A push to ${esc(branch)} deploys this site.` : "Save a repository above first."
          }</p>
          <label class="switch">
            <input id="git-webhook-toggle" type="checkbox"${webhook ? " checked" : ""}${site.configured ? "" : " disabled"}
              aria-label="Push to deploy for ${esc(site.domain)}"
              onchange="setGitWebhook('${esc(site.domain)}', this.checked)"><span></span>
          </label>
        </div>${url}
      </div>
    </div>`;
}

/** The fleet page: every site this addon deploys, and what it last deployed. */
export function fleetView(sites: GitSiteStatus[]): string {
  const running = (site: GitSiteStatus): boolean =>
    site.lastJob?.state === "queued" || site.lastJob?.state === "running";

  const row = (site: GitSiteStatus): string => {
    const job = site.lastJob;
    return `
      <tr>
        <td class="site-select">
          <input class="git-select" type="checkbox" data-domain="${esc(site.domain)}"
            aria-label="Select ${esc(site.domain)}"${site.configured ? "" : " disabled"}>
        </td>
        <td class="site-cell">
          <a href="${BASE}/?domain=${encodeURIComponent(site.domain)}">${esc(site.domain)}</a>
          <div class="hint">${esc(site.config?.remote ?? "settings unreadable")}</div>
        </td>
        <td class="type-cell">${esc(site.siteType ? siteTypeLabel(site.siteType) : "no CloudPanel site")}</td>
        <td data-label="Branch">${esc(site.config?.branch ?? "—")}</td>
        <td data-label="Commit" class="commit-cell wide-cell mono">${esc(commitLine(site))}</td>
        <td data-label="Last deployment">
          ${job ? `<span class="badge ${stateClass(job.state)}">${esc(job.state)}</span> ${esc(when(job.startedAt || job.createdAt))}` : "—"}
        </td>
        <td class="action-cell">
          <button class="btn" type="button" onclick="deployGitSite('${esc(site.domain)}')"${site.configured && !running(site) ? "" : " disabled"}>Deploy</button>
        </td>
      </tr>`;
  };

  const toolbar = sites.length === 0 ? "" : `
      <div class="card-header toolbar">
        <h2>Configured sites</h2>
        <span class="toolbar-note">${sites.length} site${sites.length === 1 ? "" : "s"}</span>
        <div class="toolbar-end actions">
          <button class="btn btn-primary" type="button" id="git-deploy-selected" onclick="deployGitSelected()" disabled>Deploy selected</button>
        </div>
      </div>`;

  return `
    <div class="page-heading">
      <div>
        <h1>Git deploy</h1>
        <p>Sites deployed from a Git remote, and what each of them last deployed.</p>
      </div>
    </div>
    <div class="card card-table">
      ${toolbar}
      ${
        sites.length === 0
          ? `<div class="empty">No site is configured yet. Open a site in CloudPanel and use its Git tab.</div>`
          : `<table class="fleet-table">
        <thead><tr>
          <th scope="col" class="site-select"><input type="checkbox" aria-label="Select every site" onchange="toggleGitAll(this.checked)"></th>
          <th scope="col" class="site-col">Site</th><th scope="col">Type</th><th scope="col">Branch</th>
          <th scope="col">Commit</th><th scope="col">Last deployment</th><th scope="col"></th>
        </tr></thead>
        <tbody>${sites.map(row).join("")}</tbody>
      </table>`
      }
    </div>`;
}
