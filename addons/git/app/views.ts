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
  MAX_BRANCH_LENGTH, MAX_DIRECTORY_LENGTH, MAX_POST_DEPLOY_LENGTH, MAX_REMOTE_LENGTH, usesDeployKey,
} from "../action";
import { gitHookPath } from "./hook";
import type { GitJobView, GitSiteStatus } from "./service";

const BASE = mountPath("git");

// Only what the shared shell does not carry.
const STYLE = `
.git-dashboard { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; margin-bottom: 24px; }
.git-dashboard > * { min-width: 0; grid-column: 1; }
.git-dashboard .card { margin-bottom: 0; }
.git-webhook { grid-column: 2; grid-row: 1; align-self: stretch; }
.git-webhook-on { grid-row: 1 / span var(--git-rows); align-self: start; }
.git-overview { border-top: 3px solid var(--accent); }
.git-eyebrow { color: var(--muted); font-size: 13px; font-weight: 600; margin-bottom: 14px; }
.git-commit { display: flex; align-items: flex-start; gap: 14px; }
.git-commit h2 { margin: 0 0 8px; font-size: 22px; line-height: 1.35; overflow-wrap: anywhere; }
.git-commit .badge { margin-top: 4px; flex-shrink: 0; font-family: var(--mono); }
.git-commit p { margin: 0; }
.git-meta { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr); gap: 24px;
  border-top: 1px solid var(--border); margin: 24px 0 0; padding-top: 20px; }
.git-meta dt { color: var(--muted); font-size: 13px; margin-bottom: 7px; }
.git-meta dd { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
.git-meta .hint { font-size: 12px; }
.git-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.git-section-heading h2 { margin: 0; }
.git-section-heading .switch { flex-shrink: 0; }
.git-disclosure > summary { display: flex; align-items: center; gap: 12px; cursor: pointer; list-style: none; }
.git-disclosure > summary::-webkit-details-marker { display: none; }
.git-disclosure > summary::after { content: ''; width: 7px; height: 7px; flex: 0 0 7px; margin-left: auto;
  border-right: 1.5px solid var(--muted); border-bottom: 1.5px solid var(--muted); transform: rotate(-45deg); }
.git-disclosure[open] > summary::after { transform: rotate(45deg); }
.git-disclosure > summary .git-summary-title { display: block; color: var(--heading); font-weight: 600; }
.git-disclosure[open] > summary { margin-bottom: 20px; }
.git-disclosure > summary .hint { display: block; margin-top: 5px; }
.git-advanced { margin-top: 24px; border-top: 1px solid var(--border); padding-top: 20px; }
.git-advanced > summary { font-size: 14px; }
.git-advanced .form-grid { grid-template-columns: minmax(0, 1fr); }
.git-danger { margin-top: 20px; padding-top: 20px; border-top: 1px solid var(--border); }
.git-setup { max-width: 760px; margin: 0 auto; }
.git-setup .form-grid { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }
.git-setup .form-field-full { grid-column: auto; }
.git-setup .git-advanced .form-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.git-setup-intro { margin-bottom: 24px; }
.git-setup-intro h2 { margin: 0 0 8px; }
.git-output { margin-top: 20px; }
.git-output summary { cursor: pointer; color: var(--muted); font-size: 14px; }
.git-output pre { margin: 12px 0 0; }
.git-webhook-setup { margin-top: 20px; padding-top: 20px; border-top: 1px solid var(--border); }
.git-webhook-setup > summary { font-size: 14px; font-weight: 600; }
.git-hook-steps { padding-left: 20px; margin: 16px 0; font-size: 14px; line-height: 1.6; }
.git-hook-steps li + li { margin-top: 6px; }
.git-hook-label { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.key-block pre { margin: 0; max-height: 140px; white-space: pre-wrap; overflow-wrap: anywhere; }
.key-block .actions { margin-top: 12px; }
.hook-curl { margin: 12px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.hook-delivery { font-size: 13px; color: var(--muted); }
.git-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; margin-bottom: 24px; }
.git-metric { margin: 0; padding: 20px 24px; }
.git-metric dt { font-size: 13px; color: var(--muted); }
.git-metric dd { font-size: 30px; font-weight: 600; margin: 10px 0 0; line-height: 1; }
.git-metric-active dd { color: var(--accent); }
.git-metric-alert dd { color: var(--bad); }
.git-fleet .toolbar { flex-wrap: wrap; }
.git-fleet th, .git-fleet td { padding: 18px 20px; }
.git-fleet .site-cell { min-width: 190px; }
.git-fleet .commit-cell { max-width: 260px; overflow-wrap: anywhere; }
.git-fleet .git-branch { max-width: 170px; overflow-wrap: anywhere; }
.git-fleet .hint { font-size: 13px; }
.git-fleet .commit-cell .mono { font-size: 13px; }
.git-empty { padding: 52px 24px; text-align: center; }
.git-empty h2 { margin: 0 0 10px; }
.git-empty p { margin: 0 0 22px; color: var(--muted); }
@media (max-width: 760px) {
  .git-dashboard { grid-template-columns: minmax(0, 1fr); }
  .git-webhook, .git-webhook-on { grid-column: 1; grid-row: auto; }
  .git-meta { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
  .git-meta > :first-child { grid-column: 1 / -1; }
  .git-commit { flex-direction: column; gap: 10px; }
  .git-metrics { gap: 10px; }
  .git-metric { padding: 16px 12px; }
  .git-metric dd { font-size: 26px; }
  .git-metric dt { font-size: 12px; min-height: 3em; }
  .git-fleet td { padding: 0; }
  .git-fleet td.site-cell, .git-fleet td.git-branch { min-width: 0; max-width: none; }
  .git-fleet td.git-branch { order: 1; }
  .git-fleet td[data-label="Last deployment"] { order: 2; }
  .git-fleet td.commit-cell { max-width: none; order: 3; }
  .git-fleet td.action-cell { order: 4; }
  .git-fleet td.action-cell .btn { width: 100%; }
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
    // is mounted inside the CloudPanel site page, and navigating away from it
    // would leave the panel behind to show a log.
    card.hidden = false;
    busy(false);
    const button = CLP_ROOT.getElementById('git-deploy');
    if (button) { button.disabled = true; button.textContent = 'Deploying…'; }
    const meta = CLP_ROOT.getElementById('git-job-meta');
    if (meta) meta.textContent = 'Started just now · Manual deployment';
    const error = CLP_ROOT.getElementById('git-job-error');
    if (error) error.hidden = true;
    updateJobUI({ state: 'queued', step: 'queued' }, '', card);
    watchJob(body.data.job, card);
  } catch (e) {
    busy(false);
    notify('Could not start the deployment: ' + e.message, 'error');
  }
}

function gitSelected() {
  return Array.from(CLP_ROOT.querySelectorAll('.git-select:checked:not(:disabled)')).map(function (box) {
    return box.getAttribute('data-domain');
  });
}

function gitSelectionChanged() {
  const count = gitSelected().length;
  const total = CLP_ROOT.querySelectorAll('.git-select:not(:disabled)').length;
  const button = CLP_ROOT.getElementById('git-deploy-selected');
  if (button) {
    button.disabled = count === 0;
    button.textContent = count ? 'Deploy selected (' + count + ')' : 'Deploy selected';
  }
  const all = CLP_ROOT.getElementById('git-select-all');
  if (all) {
    all.checked = total > 0 && count === total;
    all.indeterminate = count > 0 && count < total;
  }
  const mobile = CLP_ROOT.getElementById('git-select-mobile');
  if (mobile) mobile.textContent = total > 0 && count === total ? 'Deselect all' : 'Select all';
}

function toggleGitAll(checked) {
  CLP_ROOT.querySelectorAll('.git-select:not(:disabled)').forEach(function (box) { box.checked = checked; });
  gitSelectionChanged();
}

function selectGitAll() {
  toggleGitAll(gitSelected().length < CLP_ROOT.querySelectorAll('.git-select:not(:disabled)').length);
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
// rewrites Host, where the address seen by the manager would be wrong.
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

function running(site: GitSiteStatus): boolean {
  return site.lastJob?.state === "queued" || site.lastJob?.state === "running";
}

function stateLabel(state: string): string {
  return ({ queued: "Queued", running: "Deploying", done: "Deployed", failed: "Failed" } as Record<string, string>)[state] ?? state;
}

/** Compact display only; the original remote stays in the settings and title. */
function repositoryName(remote: string): string {
  const path = remote.includes("://") ? remote.replace(/^[^:]+:\/\/[^/]+\//, "") : remote.replace(/^[^:]+:/, "");
  return path.replace(/\.git$/, "");
}

function relativeTime(iso: string): string {
  return iso ? `<time datetime="${esc(iso)}" title="${esc(when(iso))}">${esc(since(iso))}</time>` : "—";
}

/** The job card: the last deployment's state, step and output. */
function jobCard(job: GitJobView | null, log = ""): string {
  const finished = !job || job.state === "done" || job.state === "failed";
  const hidden = job ? "" : " hidden";
  return `
    <div class="card" id="git-job-card"${hidden}>
      <div class="git-section-heading">
        <h2>Latest deployment</h2>
        <span class="badge ${stateClass(job?.state ?? "queued")}" id="job-state">${esc(stateLabel(job?.state ?? "queued"))}</span>
      </div>
      <div class="hint" id="git-job-meta">${job ? relativeTime(job.startedAt || job.createdAt) : "—"}
        · ${job?.startedBy === "push" ? "Triggered by a push" : "Manual deployment"}</div>
      <div class="step" id="job-step" style="margin-top:0.5rem;">${esc(job && !finished ? job.step : "")}</div>
      ${job?.error ? `<div class="alert" id="git-job-error" style="margin-top:0.75rem;">${esc(job.error)}</div>` : ""}
      <details class="git-output"${job && job.state === "failed" ? " open" : ""}>
        <summary>Deployment output</summary>
        <pre id="job-log">${esc(log || "(no output yet)")}</pre>
      </details>
      ${job && !finished ? `<div id="job-watch" data-job="${esc(job.id)}" hidden></div>` : ""}
    </div>`;
}

/** Status first for connected sites; the connection form first for new ones. */
export function siteView(site: GitSiteStatus, log: string): string {
  const config = site.config;
  const deployAction = site.configured
    ? `<button class="btn btn-primary" id="git-deploy" type="button" onclick="deployGitSite('${esc(site.domain)}')"${running(site) ? " disabled" : ""}>${running(site) ? "Deploying…" : "Deploy now"}</button>`
    : "";

  const current = `
    <div class="card git-overview">
      <div class="git-eyebrow">Current checkout</div>
      <div class="git-commit">
        ${site.commit ? `<span class="badge mono" title="${esc(site.commit.hash)}">${esc(site.commit.shortHash)}</span>` : ""}
        <div>
          <h2>${site.commit ? esc(site.commit.subject) : "Ready for your first deployment"}</h2>
          <p class="hint">${site.commit
            ? `${esc(site.commit.author || "Unknown author")} · committed ${relativeTime(site.commit.committedAt)}`
            : config && usesDeployKey(config.remote)
              ? "Add the deploy key to your repository, then select Deploy now."
              : "Your repository is configured. Select Deploy now to fetch its files."}</p>
        </div>
      </div>
      <dl class="git-meta">
        <div><dt>Repository</dt><dd title="${esc(config?.remote ?? "")}">${esc(repositoryName(config?.remote ?? ""))}</dd></div>
        <div><dt>Branch</dt><dd class="mono">${esc(config?.branch ?? "—")}</dd></div>
        <div><dt>Deployment mode</dt><dd>${config?.webhook ? "Push to deploy" : "Manual"}</dd></div>
      </dl>
    </div>`;

  const settings = repositoryForm(site);
  const key = deployKeySection(site);
  return `
    <div class="page-heading">
      <div>
        <h1>Git deploy</h1>
        <p>${site.configured ? "Your checkout, latest deployment, and repository settings." : `Connect a repository to deploy ${esc(site.domain)}.`}</p>
      </div>
      ${deployAction}
    </div>
    ${site.configured ? `
      ${current}
      <div class="git-dashboard" style="--git-rows: ${key ? 3 : 2}">
        ${jobCard(site.lastJob, log)}
        ${webhookSection(site)}
        ${settings}
        ${key}
      </div>` : `<div class="git-setup">${settings}</div>`}`;
}

function repositoryForm(site: GitSiteStatus): string {
  const config = site.config;
  const custom = [config?.directory ? "Custom directory" : "", config?.postDeploy ? "Post-deploy command" : ""].filter(Boolean);
  const fields = `
      <form onsubmit="event.preventDefault(); saveGitConfig('${esc(site.domain)}')">
        <div class="form-grid">
          <div class="form-field form-field-full">
            <label class="required" for="git-remote">Repository URL</label>
            <input id="git-remote" type="text" required maxlength="${MAX_REMOTE_LENGTH}" spellcheck="false" autocapitalize="off"
              placeholder="git@github.com:owner/repo.git" value="${esc(config?.remote ?? "")}">
            <div class="hint">Use SSH for a private repository, or HTTPS for a public one.</div>
          </div>
          <div class="form-field form-field-full">
            <label class="required" for="git-branch">Branch</label>
            <input id="git-branch" type="text" required maxlength="${MAX_BRANCH_LENGTH}" spellcheck="false" autocapitalize="off"
              placeholder="main" value="${esc(config?.branch ?? "main")}">
          </div>
        </div>
        <details class="git-disclosure git-advanced">
          <summary><span><span class="git-summary-title">Advanced</span><span class="hint">${esc(custom.join(" · ") || "Deploy directory and post-deploy command")}</span></span></summary>
          <div class="form-grid">
            <div class="form-field">
              <label for="git-directory">Subdirectory</label>
              <input id="git-directory" type="text" maxlength="${MAX_DIRECTORY_LENGTH}" spellcheck="false" autocapitalize="off"
                placeholder="Leave empty for the site directory" value="${esc(config?.directory ?? "")}">
              <div class="hint">Relative to <span class="mono">/home/${esc(site.siteUser)}/htdocs/${esc(site.domain)}</span>.</div>
            </div>
            <div class="form-field">
              <label for="git-post-deploy">Post-deploy command</label>
              <input id="git-post-deploy" type="text" maxlength="${MAX_POST_DEPLOY_LENGTH}" spellcheck="false" autocapitalize="off"
                placeholder="composer install --no-dev" value="${esc(config?.postDeploy ?? "")}">
              <div class="hint">Runs as ${esc(site.siteUser)} in the deployed directory after every deployment.</div>
            </div>
          </div>
          ${site.configured ? `<div class="git-danger">
            <p class="hint">Disconnect the repository and keep the deployed files.</p>
            <button class="btn btn-danger" type="button" onclick="forgetGitSite('${esc(site.domain)}')">Stop deploying</button>
          </div>` : ""}
        </details>
        <div class="form-actions"><button class="btn btn-primary" type="submit">${site.configured ? "Save changes" : "Connect repository"}</button></div>
      </form>`;

  return site.configured ? `
    <details class="card git-disclosure" id="git-repository-settings">
      <summary><span><span class="git-summary-title">Repository settings</span><span class="hint">Repository, branch, and deployment options</span></span></summary>
      ${fields}
    </details>` : `
    <div class="card">
      <div class="git-setup-intro"><h2>Connect your repository</h2><p class="hint">Choose a repository and branch. An SSH deploy key is generated when you save.</p></div>
      ${fields}
    </div>`;
}

/** Keep the public key visible until the first checkout, or if keygen failed. */
function deployKeySection(site: GitSiteStatus): string {
  if (!site.config || !usesDeployKey(site.config.remote)) return "";
  return `
    <details class="card git-disclosure" id="git-deploy-key"${!site.commit || !site.publicKey ? " open" : ""}>
      <summary><span><span class="git-summary-title">Deploy key</span><span class="hint">${site.publicKey ? "SSH access to your repository" : "Generate a key to access this repository"}</span></span></summary>
        ${
          site.publicKey
            ? `<p class="hint">Add this public key to your repository's deploy keys. The private key stays on this server.</p>
        <div class="key-block">
          <pre id="git-public-key">${esc(site.publicKey)}</pre>
          <div class="actions">
            <button class="btn" type="button" onclick="copyGitBlock('git-public-key', 'Deploy key')">Copy key</button>
            <button class="btn btn-danger" type="button" onclick="generateGitKey('${esc(site.domain)}', true)">Replace key</button>
          </div>
        </div>`
            : `<p class="hint">Generate a key, then add its public half to your repository before deploying.</p>
        <div class="actions">
          <button class="btn btn-primary" type="button" onclick="generateGitKey('${esc(site.domain)}', false)">Generate deploy key</button>
        </div>`
        }
    </details>`;
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
  const github = /^(?:git@github\.com:|ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|https:\/\/github\.com\/)/i.test(site.config?.remote ?? "");
  const githubSteps = `
    <ol class="git-hook-steps">
      <li>In your GitHub repository, open <strong>Settings → Webhooks → Add webhook</strong>.</li>
      <li>Paste the URL above and set the content type to <span class="mono">application/json</span>.</li>
      <li>Send push events to deploy <strong>${esc(branch)}</strong>.</li>
    </ol>`;
  const url = !webhook ? "" : `
      <details class="git-disclosure git-webhook-setup">
        <summary>Webhook setup</summary>
        <div class="git-hook-label">Webhook URL</div>
        <div class="key-block">
          <pre id="git-webhook-url" data-path="${esc(path)}">${esc(path)}</pre>
          <div class="actions">
            <button class="btn" type="button" onclick="copyGitBlock('git-webhook-url', 'Webhook URL')">Copy URL</button>
            <button class="btn btn-danger" type="button" onclick="rotateGitWebhook('${esc(site.domain)}')">Rotate URL</button>
          </div>
        </div>
        <div class="hint">Keep this URL private. Anyone with it can deploy this site.</div>
        ${github ? githubSteps : `<details class="git-disclosure git-webhook-setup"><summary>GitHub</summary>${githubSteps}</details>`}
      </details>
      <details class="git-disclosure git-webhook-setup">
        <summary>Other providers &amp; CI</summary>
        <p class="hint">Send a POST request to deploy the configured branch from your CI job or another service.</p>
        <pre class="hook-curl mono" id="git-webhook-curl">curl -X POST ${esc(path)}</pre>
        <button class="btn" type="button" onclick="copyGitBlock('git-webhook-curl', 'Command')">Copy command</button>
      </details>`;

  return `
      <div class="card git-webhook${webhook ? " git-webhook-on" : ""}">
        <div class="git-section-heading">
          <h2>Push to deploy</h2>
          <label class="switch">
            <input id="git-webhook-toggle" type="checkbox"${webhook ? " checked" : ""}
              aria-label="Push to deploy for ${esc(site.domain)}"
              onchange="setGitWebhook('${esc(site.domain)}', this.checked)"><span></span>
          </label>
        </div>
        <p class="hint">${webhook ? `Automatically deploy pushes to <strong>${esc(branch)}</strong>.` : "Enable a webhook to deploy automatically from your repository or CI."}</p>
        ${webhook ? `<div class="hook-delivery">${esc(deliveryLine(site))}</div>` : ""}
        ${url}
      </div>`;
}

/** The fleet page: every site this addon deploys, and what it last deployed. */
export function fleetView(sites: GitSiteStatus[]): string {
  const available = (site: GitSiteStatus): boolean => site.configured && !!site.siteType && !running(site);
  const attention = (site: GitSiteStatus): boolean => !site.configured || !site.siteType || site.lastJob?.state === "failed";
  const selectable = sites.some(available);

  const row = (site: GitSiteStatus): string => {
    const job = site.lastJob;
    return `
      <tr>
        <td class="site-select">
          <input class="git-select" type="checkbox" data-domain="${esc(site.domain)}"
            aria-label="Select ${esc(site.domain)}"${available(site) ? "" : " disabled"}>
        </td>
        <td class="site-cell">
          <a href="${BASE}/?domain=${encodeURIComponent(site.domain)}">${esc(site.domain)}</a>
          <div class="hint" title="${esc(site.config?.remote ?? "")}">${esc(site.config ? repositoryName(site.config.remote) : "Settings unavailable")}</div>
          <div class="hint">${esc(site.siteType ? siteTypeLabel(site.siteType) : "Site no longer in CloudPanel")}</div>
        </td>
        <td data-label="Branch" class="git-branch mono">${esc(site.config?.branch ?? "—")}</td>
        <td data-label="Current checkout" class="commit-cell wide-cell">${site.commit
          ? `<span class="mono" title="${esc(site.commit.hash)}">${esc(site.commit.shortHash)}</span><div class="hint">${esc(site.commit.subject)}</div>`
          : '<span class="hint">No checkout yet</span>'}</td>
        <td data-label="Last deployment">
          ${!site.configured || !site.siteType ? '<span class="badge state-failed">Unavailable</span>'
            : job ? `<span class="badge ${stateClass(job.state)}">${esc(stateLabel(job.state))}</span><div class="hint">${relativeTime(job.startedAt || job.createdAt)}</div>`
            : '<span class="badge state-queued">Not deployed</span>'}
        </td>
        <td class="action-cell">
          <button class="btn" type="button" onclick="deployGitSite('${esc(site.domain)}')"${available(site) ? "" : " disabled"}>${running(site) ? "Deploying…" : "Deploy"}</button>
        </td>
      </tr>`;
  };

  const toolbar = sites.length === 0 ? "" : `
      <div class="card-header toolbar">
        <h2>Configured sites</h2>
        <div class="toolbar-end actions">
          <button class="btn mobile-select-all" type="button" id="git-select-mobile" onclick="selectGitAll()"${selectable ? "" : " disabled"}>Select all</button>
          <button class="btn btn-primary" type="button" id="git-deploy-selected" onclick="deployGitSelected()" disabled>Deploy selected</button>
        </div>
      </div>`;

  return `
    <div class="page-heading">
      <div>
        <h1>Git deploy</h1>
        <p>Monitor your deployments and ship updates across your sites.</p>
      </div>
      <a class="btn" href="/">Connect a site</a>
    </div>
    ${sites.length ? `<dl class="git-metrics">
      <div class="card git-metric"><dt>Configured sites</dt><dd>${sites.length}</dd></div>
      <div class="card git-metric git-metric-active"><dt>Deploying now</dt><dd>${sites.filter(running).length}</dd></div>
      <div class="card git-metric${sites.some(attention) ? " git-metric-alert" : ""}"><dt>Need attention</dt><dd>${sites.filter(attention).length}</dd></div>
    </dl>` : ""}
    <div class="card card-table git-fleet">
      ${toolbar}
      ${
        sites.length === 0
          ? `<div class="git-empty"><h2>Deploy your first site</h2><p>Open a site in CloudPanel, choose the Git tab, and connect your repository.</p><a class="btn btn-primary" href="/">Open sites</a></div>`
          : `<table class="fleet-table">
        <thead><tr>
          <th scope="col" class="site-select"><input type="checkbox" id="git-select-all" aria-label="Select every available site" onchange="toggleGitAll(this.checked)"${selectable ? "" : " disabled"}></th>
          <th scope="col">Site</th><th scope="col">Branch</th>
          <th scope="col">Current checkout</th><th scope="col">Last deployment</th><th scope="col" aria-label="Actions"></th>
        </tr></thead>
        <tbody>${sites.map(row).join("")}</tbody>
      </table>`
      }
    </div>`;
}
