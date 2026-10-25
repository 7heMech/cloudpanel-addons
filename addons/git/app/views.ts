// Server-rendered HTML for the Git addon. Every interpolated value goes through
// esc(): remote URLs, branch names, commit subjects and a post-deploy command
// all come from outside this process and are drawn for an operator whose
// session can change any site on the box.

import { esc } from "../../../lib/app-http";
import {
  FLEET_NONE_HTML, FLEET_ROW_SELECTION_JS, JOB_STYLE, JOB_WATCH_JS, fleetFilterHtml, fleetRowSelectionStyle, jobStateClass,
  renderFragment, renderLayout, sinceText, whenText,
} from "../../../lib/app-ui";
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

// Built once: nothing here changes between renders.
const PAGE_STYLE = STYLE + JOB_STYLE + fleetRowSelectionStyle("git-fleet-table");
const PAGE_SCRIPT = `${JOB_WATCH_JS}\n${FLEET_ROW_SELECTION_JS}\n${CLIENT_JS}`;

export function layout(
  title: string,
  content: string,
  updateNotice?: { current: string; latest: string } | null,
  site?: SiteContext,
  admin = true,
): string {
  return renderLayout(title, content, {
    brand: "Git Deploy",
    base: BASE,
    nav: [],
    css: PAGE_STYLE,
    script: PAGE_SCRIPT,
    updateNotice,
    admin,
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
  return `Last delivery: ${sinceText(webhook.lastDeliveryAt)} — ${what}`;
}

/** A delivery the token let in that deployed nothing, other than a push to another branch. */
function deliveryRefused(site: GitSiteStatus): boolean {
  const outcome = site.config?.webhook?.lastDelivery ?? "";
  return outcome.startsWith("ignored: ") && !outcome.startsWith("ignored: the push was for");
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
  return iso ? `<time datetime="${esc(iso)}" title="${esc(whenText(iso))}">${esc(sinceText(iso))}</time>` : "—";
}

/** What is checked out and what the last deployment did, with the button that starts the next. */
function statusCard(site: GitSiteStatus, log: string): string {
  const config = site.config;
  const job = site.lastJob;
  const finished = !job || job.state === "done" || job.state === "failed";
  return `
    <div class="card git-status" id="git-job-card">
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
      <div class="git-deployment">
        <div class="git-deployment-state">${job
          ? `<span class="badge ${jobStateClass(job.state)}" id="job-state">${esc(stateLabel(job.state))}</span>
          <span class="hint" id="git-job-meta">${relativeTime(job.startedAt || job.createdAt)} · ${job.startedBy === "push" ? "push" : "manual"}</span>`
          : '<span class="hint">Not deployed yet</span>'}</div>
        <button class="btn btn-primary" id="git-deploy" type="button" onclick="deployGitSite('${esc(site.domain)}')"${running(site) ? " disabled" : ""}>${running(site) ? "Deploying…" : "Deploy now"}</button>
      </div>
      ${job ? `<div class="step" id="job-step">${esc(!finished ? job.step : "")}</div>` : ""}
      ${job?.error ? `<div class="alert" id="git-job-error">${esc(job.error)}</div>` : ""}
      ${job ? `<details id="git-output" class="git-output"${job.state === "failed" ? " open" : ""}>
        <summary>Deployment output</summary>
        <pre id="job-log">${esc(log || "(no output yet)")}</pre>
      </details>` : ""}
      ${job && !finished ? `<div id="job-watch" data-job="${esc(job.id)}" hidden></div>` : ""}
    </div>`;
}

/** Status first for connected sites; the connection form first for new ones. */
export function siteView(site: GitSiteStatus, log: string): string {
  return `
    <div class="page-heading" data-git-domain="${esc(site.domain)}">
      <div>
        <h1>Git Deploy</h1>
        <p>${site.configured ? "Your checkout, latest deployment, and repository settings." : `Connect a repository to deploy ${esc(site.domain)}.`}</p>
      </div>
    </div>
    ${site.configured ? `${statusCard(site, log)}${settingsCard(site)}` : `<div class="git-setup">${repositoryForm(site)}</div>`}`;
}

function summary(title: string, hint: string, id = ""): string {
  return `<summary><span class="git-summary-text"><span class="summary-title">${title}</span><span class="hint"${id ? ` id="${id}"` : ""}>${hint}</span></span></summary>`;
}

/** Repository, deploy key and push to deploy: each set once, so each is a row that opens. */
function settingsCard(site: GitSiteStatus): string {
  const config = site.config!;
  const keyNeeded = usesDeployKey(config.remote);
  const keyMissing = keyNeeded && !site.publicKey;
  const repository = `
    <details class="disclosure" id="git-repository-settings">
      ${summary("Repository settings", esc([repositoryName(config.remote), config.branch, config.postDeploy].filter(Boolean).join(" · ")))}
      ${repositoryForm(site)}
    </details>`;
  const key = keyNeeded ? deployKeySection(site, keyMissing || !site.commit) : "";
  return `
    <div class="card git-settings">
      ${keyMissing ? key + repository : repository + key}
      ${webhookSection(site)}
    </div>`;
}

function repositoryForm(site: GitSiteStatus): string {
  const config = site.config;
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
          <div class="form-field">
            <label for="git-post-deploy">Post-deploy command</label>
            <input id="git-post-deploy" type="text" maxlength="${MAX_POST_DEPLOY_LENGTH}" spellcheck="false" autocapitalize="off"
              placeholder="composer install --no-dev" value="${esc(config?.postDeploy ?? "")}">
            <div class="hint">Optional. Runs as ${esc(site.siteUser)} in the deployed directory after every deployment.</div>
          </div>
        </div>
        <details id="git-advanced" class="disclosure git-advanced">
          ${summary("Advanced", config?.directory ? `Deploys into ${esc(config.directory)}` : "Deploy directory")}
          <div class="form-field">
            <label for="git-directory">Subdirectory</label>
            <input id="git-directory" type="text" maxlength="${MAX_DIRECTORY_LENGTH}" spellcheck="false" autocapitalize="off"
              placeholder="Leave empty for the site directory" value="${esc(config?.directory ?? "")}">
            <div class="hint">Relative to <span class="mono">~/htdocs/${esc(site.domain)}</span></div>
          </div>
          ${site.configured ? `<div class="git-danger">
            <p class="hint">Disconnect the repository and keep the deployed files.</p>
            <button class="btn btn-danger" type="button" onclick="forgetGitSite('${esc(site.domain)}')">Stop deploying</button>
          </div>` : ""}
        </details>
        <div class="form-actions"><button class="btn btn-primary" type="submit">${site.configured ? "Save changes" : "Connect repository"}</button></div>
      </form>`;

  return site.configured ? fields : `
    <div class="card">
      <div class="git-setup-intro"><h2>Connect your repository</h2><p class="hint">Choose a repository and branch. An SSH deploy key is generated when you save.</p></div>
      ${fields}
    </div>`;
}

function deployKeySection(site: GitSiteStatus, open: boolean): string {
  return `
    <details class="disclosure" id="git-deploy-key"${open ? " open" : ""}>
      ${summary("Deploy key", site.publicKey ? "SSH access to your repository" : "Missing: generate one to fetch this repository")}
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
  const toggle = `<label class="switch git-push-switch">
      <input id="git-webhook-toggle" type="checkbox"${webhook ? " checked" : ""}
        aria-label="Push to deploy for ${esc(site.domain)}"
        onchange="setGitWebhook('${esc(site.domain)}', this.checked)"><span></span>
    </label>`;
  if (!webhook) {
    return `
      <div class="git-push-row">
        <span class="git-summary-text"><span class="summary-title">Push to deploy</span><span class="hint">Off. Turn it on to deploy from your repository or CI.</span></span>
        ${toggle}
      </div>`;
  }
  const path = gitHookPath(site.domain, webhook.token);
  const branch = site.config?.branch ?? "the configured branch";
  const github = /^(?:git@github\.com:|ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|https:\/\/github\.com\/)/i.test(site.config?.remote ?? "");
  const githubSteps = `
    <ol class="git-hook-steps">
      <li>In your GitHub repository, open <strong>Settings → Webhooks → Add webhook</strong>.</li>
      <li>Paste the URL above and set the content type to <span class="mono">application/json</span>.</li>
      <li>Send push events to deploy <strong>${esc(branch)}</strong>.</li>
    </ol>`;
  return `
    <details class="disclosure git-push" id="git-webhook-setup">
      <summary><span class="git-summary-text"><span class="summary-title">Push to deploy</span><span class="hint hook-delivery">${esc(deliveryLine(site))}</span></span>${toggle}</summary>
      <p class="hint">Deploys pushes to <strong>${esc(branch)}</strong>.</p>
      <div class="git-hook-label">Webhook URL</div>
      <div class="key-block">
        <pre id="git-webhook-url" data-path="${esc(path)}">${esc(path)}</pre>
        <div class="actions">
          <button class="btn" type="button" onclick="copyGitBlock('git-webhook-url', 'Webhook URL')">Copy URL</button>
          <button class="btn btn-danger" type="button" onclick="rotateGitWebhook('${esc(site.domain)}')">Rotate URL</button>
        </div>
      </div>
      <div class="hint">Keep this URL private. Anyone with it can deploy this site.</div>
      ${github ? githubSteps : `<details id="git-webhook-github" class="disclosure git-webhook-setup"><summary>GitHub</summary>${githubSteps}</details>`}
      <details id="git-webhook-providers" class="disclosure git-webhook-setup">
        <summary>Other providers &amp; CI</summary>
        <p class="hint">Send a POST request to deploy the configured branch from your CI job or another service.</p>
        <pre class="hook-curl mono" id="git-webhook-curl">curl -X POST ${esc(path)}</pre>
        <button class="btn" type="button" onclick="copyGitBlock('git-webhook-curl', 'Command')">Copy command</button>
      </details>
    </details>`;
}

/** Why a site needs the operator, or "" when it does not. */
function attention(site: GitSiteStatus): string {
  if (!site.siteType) return "no longer in CloudPanel";
  if (!site.configured) return "its settings cannot be read";
  if (site.lastJob?.state === "failed") return "the last deployment failed";
  if (site.keyMissing) return "its deploy key is missing";
  if (deliveryRefused(site)) return "the last push was not deployed";
  return "";
}

/** The fleet page: every site this addon deploys, and what it last deployed. */
export function fleetView(sites: GitSiteStatus[]): string {
  const available = (site: GitSiteStatus): boolean => site.configured && !!site.siteType && !running(site);
  const needs = sites.flatMap((site) => {
    const why = attention(site);
    return why ? [`${site.domain} (${why})`] : [];
  });

  const row = (site: GitSiteStatus): string => {
    const job = site.lastJob;
    const domain = esc(site.domain);
    const show = [attention(site) ? "attention" : "", running(site) ? "deploying" : ""].filter(Boolean).join(" ");
    return `
      <tr data-domain="${domain}" data-show="${show}"${running(site) ? ` data-job="${esc(job!.id)}"` : ""} tabindex="0" aria-selected="false"
        onclick="toggleSiteSelection(event, this)" onkeydown="toggleSiteSelection(event, this)">
        <td class="site-select">
          <input class="site-checkbox" type="checkbox" onchange="paintFleetSelection()" aria-label="Select ${domain}"${available(site) ? "" : " disabled"}>
        </td>
        <td class="site-cell">
          <a href="${BASE}/?domain=${encodeURIComponent(site.domain)}">${domain}</a>
          <div class="hint" title="${esc(site.config?.remote ?? "")}">${esc(site.config ? repositoryName(site.config.remote) : "Settings unavailable")}</div>
          <div class="hint">${esc(site.siteType ? siteTypeLabel(site.siteType) : "Site no longer in CloudPanel")}</div>
        </td>
        <td data-label="Branch" class="git-branch mono">${esc(site.config?.branch ?? "—")}</td>
        <td data-label="Current checkout" class="commit-cell wide-cell">${site.commit
          ? `<span class="mono" title="${esc(site.commit.hash)}">${esc(site.commit.shortHash)}</span><div class="hint">${esc(site.commit.subject)}</div>`
          : '<span class="hint">No checkout yet</span>'}</td>
        <td data-label="Last deployment">
          ${!site.configured || !site.siteType ? '<span class="badge state-failed">Unavailable</span>'
            : job ? `<span class="badge ${jobStateClass(job.state)}">${esc(stateLabel(job.state))}</span><div class="hint">${relativeTime(job.startedAt || job.createdAt)}</div>`
            : '<span class="badge state-queued">Not deployed</span>'}
        </td>
        <td class="action-cell">
          <button class="btn" type="button" onclick="deployGitSite('${esc(site.domain)}')"${available(site) ? "" : " disabled"}>${running(site) ? "Deploying…" : "Deploy"}</button>
        </td>
      </tr>`;
  };

  return `
    <div class="page-heading">
      <div>
        <h1>Git Deploy</h1>
        <p>Monitor your deployments and ship updates across your sites.</p>
      </div>
      <a class="btn" href="/">Connect a site</a>
    </div>
    ${needs.length ? `<div class="notice" role="status">Needs attention: ${esc(needs.join(", "))}.</div>` : ""}
    <div class="card card-table git-fleet">
      ${
        sites.length === 0
          ? `<div class="git-empty"><h2>Deploy your first site</h2><p>Open a site in CloudPanel, choose the Git tab, and connect your repository.</p><a class="btn btn-primary" href="/">Open sites</a></div>`
          : `<div class="card-header toolbar">
        <h2>Configured sites</h2>
        <span class="toolbar-note" id="site-selection">No sites selected</span>
        <button class="btn mobile-select-all" id="select-all-btn" type="button" onclick="toggleAllSites()">Select all</button>
        <button class="btn btn-primary toolbar-end" type="button" data-needs-selection disabled onclick="deployGitSelected()">Deploy selected</button>
      </div>
      ${fleetFilterHtml({
        count: sites.length,
        filters: [{ value: "attention", label: "Needs attention" }, { value: "deploying", label: "Deploying" }],
        summary: `${sites.length} sites`,
      })}
      <table class="fleet-table git-fleet-table">
        <thead><tr>
          <th scope="col" class="site-select"><input type="checkbox" id="select-all" aria-label="Select all sites" onchange="selectAllSites(this.checked)"></th>
          <th scope="col">Site</th><th scope="col">Branch</th>
          <th scope="col">Current checkout</th><th scope="col">Last deployment</th><th scope="col" aria-label="Actions"></th>
        </tr></thead>
        <tbody>${sites.map(row).join("")}</tbody>
      </table>
      ${FLEET_NONE_HTML}`
      }
    </div>`;
}
