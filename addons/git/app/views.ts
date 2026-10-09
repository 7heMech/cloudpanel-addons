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
import STYLE from "./views.css" with { type: "text" };

/**
 * The pages' inline script.
 *
 * Element lookups go through CLP_ROOT, which is the shadow root when this page
 * is mounted inside CloudPanel's own site page.
 */
import CLIENT_JS from "./views.client.js" with { type: "text" };
export { CLIENT_JS };

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
  const custom = [config?.postDeploy ? "Post-deploy command" : "", config?.directory ? "Custom directory" : ""].filter(Boolean);
  const fields = `
      <form class="git-repo-form" onsubmit="event.preventDefault(); saveGitConfig('${esc(site.domain)}')">
        <div class="form-grid">
          <div class="form-field">
            <label class="required" for="git-remote">Repository URL</label>
            <input id="git-remote" type="text" required maxlength="${MAX_REMOTE_LENGTH}" spellcheck="false" autocapitalize="off"
              placeholder="git@github.com:owner/repo.git" value="${esc(config?.remote ?? "")}">
            <div class="hint">Use SSH for a private repository.</div>
          </div>
          <div class="form-field">
            <label class="required" for="git-branch">Branch</label>
            <input id="git-branch" type="text" required maxlength="${MAX_BRANCH_LENGTH}" spellcheck="false" autocapitalize="off"
              placeholder="main" value="${esc(config?.branch ?? "main")}">
          </div>
        </div>
        <details class="git-disclosure git-advanced">
          <summary><span><span class="git-summary-title">Advanced</span><span class="hint">${esc(custom.join(" · ") || "Post-deploy command and deploy directory")}</span></span></summary>
          <div class="form-grid">
            <div class="form-field">
              <label for="git-post-deploy">Post-deploy command</label>
              <input id="git-post-deploy" type="text" maxlength="${MAX_POST_DEPLOY_LENGTH}" spellcheck="false" autocapitalize="off"
                placeholder="composer install --no-dev" value="${esc(config?.postDeploy ?? "")}">
              <div class="hint">Runs as ${esc(site.siteUser)} in the deployed directory after every deployment.</div>
            </div>
            <div class="form-field">
              <label for="git-directory">Subdirectory</label>
              <input id="git-directory" type="text" maxlength="${MAX_DIRECTORY_LENGTH}" spellcheck="false" autocapitalize="off"
                placeholder="Leave empty for the site directory" value="${esc(config?.directory ?? "")}">
              <div class="hint">Relative to <span class="mono">~/htdocs/${esc(site.domain)}</span></div>
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
