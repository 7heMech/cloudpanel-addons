// The Addons page: the card list, the update page, and the job card a
// mutation leaves behind.
import { ADDONS, addonHandler } from "../cli/addon-catalog";
import { CLI_VERSION } from "../cli/release";
import { esc, escJs, htmlResponse } from "../lib/app-http";
import { JOB_STYLE, JOB_WATCH_JS, renderLayout } from "../lib/app-ui";
import { mountPath } from "../lib/mount";
import { CHANGELOG_URL, UPDATE_PATH } from "../lib/update-ui";
import type { CliUpdateInfo } from "../lib/update-check";
import type { ManagerJobView } from "../cli/manager-action";

import MANAGER_INDEX_CSS from "./views.css" with { type: "text" };

import MANAGER_INDEX_JS from "./views.client.js" with { type: "text" };

/** Renders the manager card for a known addon, or nothing for an unknown name. */
function addonCard(name: string, enabled: boolean, job: ManagerJobView | null = null): string {
  const spec = ADDONS[name];
  if (!spec) return "";
  const title = spec.title ?? spec.name;
  const description = spec.description ? `<p>${esc(spec.description)}</p>` : "";
  const mounted = addonHandler(spec.name) !== undefined;
  const live = liveManagerJob(job);
  const addonJob = live && live.addon === spec.name ? live : null;
  const actions = enabled
    ? `${mounted ? `<a class="btn btn-primary btn-lg" href="${esc(`${mountPath(spec.name)}/`)}" aria-label="Open ${esc(title)}">Open</a>` : '<span class="badge state-running addon-status">Enabled</span>'}
    <button class="btn btn-danger btn-lg" type="button" onclick="disableAddon('${escJs(spec.name)}', '${escJs(title)}', this)">Disable</button>`
    : `<button class="btn btn-primary btn-lg" type="button" onclick="enableAddon('${escJs(spec.name)}', this)">Enable ${esc(title)}</button>`;
  return `<article class="card addon-card" data-manager-job-card="${esc(spec.name)}">
  <div class="card-header"><h2>${esc(title)}</h2></div>
  ${description}
  <div class="actions">${actions}</div>
  ${addonJob ? managerJobStatus(addonJob) : ""}
</article>`;
}

function liveManagerJob(job: ManagerJobView | null): ManagerJobView | null {
  return job && (job.state === "queued" || job.state === "running") ? job : null;
}

/**
 * Live manager progress stays with the card whose action started the job.
 *
 * The log is behind a summary rather than gone: enabling an addon that has to
 * install Docker spends minutes on one step, and what it is doing is in the
 * log. Closed by default, because the state and the step are what a card has
 * room for.
 */
function managerJobStatus(job: ManagerJobView): string {
  return `<div class="manager-job-status" data-manager-job-status aria-live="polite">
  <div class="job-summary">
    <strong id="job-title">${esc(describeJob(job))}</strong>
    <span class="badge state-${esc(job.state)}" id="job-state">${esc(job.state)}</span>
  </div>
  <p class="step" id="job-step">${esc(job.step)}</p>
  ${JOB_LOG_DETAILS}
</div>`;
}

const JOB_LOG_DETAILS = `<details class="job-log-details">
    <summary>Output</summary>
    <pre id="job-log">(no output yet)</pre>
  </details>`;

/**
 * A job with no card of its own -- an update watched from the index, an enable
 * watched from the update page -- still has to be visible, so it takes a block
 * of its own above the cards.
 */
function managerJobBlock(job: ManagerJobView | null, homeCard: string | null): string {
  const live = liveManagerJob(job);
  if (!live || managerJobKey(live) === homeCard) return "";
  return `<article class="card" data-manager-job-card="${esc(managerJobKey(live))}">${managerJobStatus(live)}</article>`;
}

/** The card a job belongs to: the addon it is about, or the update page's own. */
function managerJobKey(job: ManagerJobView): string {
  return job.kind === "update" ? "update" : job.addon;
}

/** Failure details survive navigation without creating a second progress card. */
function managerJobFailure(job: ManagerJobView | null): string {
  const failure = job && job.state === "failed" ? job : null;
  const failureBlock = failure
    ? `<div class="alert" id="job-failure" data-job="${esc(failure.id)}">
  <strong>${esc(describeJob(failure))} failed.</strong> ${esc(failure.error || "No reason was recorded.")}
  <button class="btn" type="button" onclick="dismissFailure('${escJs(failure.id)}')">Dismiss</button>
</div>`
    : "";
  return failureBlock;
}

type ManagerPageOptions = { job?: ManagerJobView | null; csrf?: string };

/** The manager index: enabled addons, bundled addons available to enable, and progress. */
export function indexPage(
  enabled: string[],
  update?: { current: string; latest: string } | null,
  options: ManagerPageOptions & { available?: string[] } = {},
): Response {
  const available = options.available ?? [];
  const cards = enabled.map((name) => addonCard(name, true, options.job ?? null)).join("");
  const availableCards = available.map((name) => addonCard(name, false, options.job ?? null)).join("");

  const live = liveManagerJob(options.job ?? null);
  const claimed = live && [...enabled, ...available].includes(managerJobKey(live)) ? managerJobKey(live) : null;
  const content = `<div class="page-heading"><h1>Addons</h1><a class="btn" href="${UPDATE_PATH}">Updates</a></div>` +
    managerJobFailure(options.job ?? null) +
    managerJobBlock(options.job ?? null, claimed) +
    (cards
      ? `<div class="addon-grid">${cards}</div>`
      : `<div class="card empty">${esc(available.length
        ? "No addons are enabled. Enable one below to add it to CloudPanel."
        : "No addons are currently available.")}</div>`) +
    (availableCards
      ? `<section class="addon-section"><h2>Available</h2><div class="addon-grid">${availableCards}</div></section>`
      : "");

  return managerPage("CloudPanel Addons", content, update, options);
}

/** A GET only shows the release; installation still requires a guarded POST. */
export function updatePage(
  info: CliUpdateInfo | null,
  currentVersion = CLI_VERSION,
  options: ManagerPageOptions = {},
): Response {
  const update = info?.hasUpdate ? info : null;
  const live = liveManagerJob(options.job ?? null);
  const development = currentVersion === "0.0.0-dev";
  const status = update ? "Update available" : info ? "Up to date" : development ? "Development build" : "Unable to check";
  const message = update
    ? "Install the latest release of CloudPanel Addons. The Addons manager will restart briefly during the update."
    : info ? "No newer release is available for this installation."
    : development ? "Update checks are disabled for development builds."
    : "We could not check for a new release. Try again later or view the changelog on GitHub.";
  const content = `<div class="update-page">
  <div class="page-heading"><h1>Update CloudPanel Addons</h1><a class="btn" href="/addons/">Back to Addons</a></div>
  ${managerJobFailure(options.job ?? null)}
  ${managerJobBlock(options.job ?? null, "update")}
  <article class="card" data-manager-job-card="update">
    <div class="card-header"><h2>CloudPanel Addons</h2><span class="badge ${update ? "state-queued" : info ? "state-done" : "state-unknown"}">${status}</span></div>
    <dl class="update-versions">
      <div><dt>Installed version</dt><dd>v${esc((info?.current ?? currentVersion).replace(/^v/, ""))}</dd></div>
      <div><dt>Latest release</dt><dd>${info ? `v${esc(info.latest)}` : "Unavailable"}</dd></div>
    </dl>
    <p>${message}</p>
    <div class="actions update-actions">
      <a class="btn" href="${CHANGELOG_URL}" target="_blank" rel="noopener noreferrer">Changelog</a>
      ${update ? `<button class="btn btn-primary" type="button" onclick="updateNow(this)"${live ? " disabled" : ""}>Install update</button>` : ""}
    </div>
    ${live && live.kind === "update" ? managerJobStatus(live) : ""}
    ${live && live.kind !== "update" ? '<p class="hint">Another addon operation is in progress; the update can start once it finishes.</p>' : ""}
  </article>
</div>`;
  return managerPage("Update CloudPanel Addons", content, update, options);
}

function managerPage(
  title: string,
  content: string,
  update: { current: string; latest: string } | null | undefined,
  options: ManagerPageOptions,
): Response {
  const job = options.job;
  const live = liveManagerJob(job ?? null);
  return htmlResponse(renderLayout(title, content, {
    brand: "CloudPanel Addons",
    base: "/addons",
    nav: [],
    css: JOB_STYLE + MANAGER_INDEX_CSS,
    script: MANAGER_INDEX_JS + JOB_WATCH_JS + (live ? `
const managerJobTarget = CLP_ROOT.querySelector('[data-manager-job-status]');
watchJob('${escJs(live.id)}', managerJobTarget ? managerJobTarget.closest('[data-manager-job-card]') : null);
` : ""),
    updateNotice: update,
  }), { csrf: options.csrf });
}

/** How a job is named in the UI: "Enabling stager", "Updating clp-addons". */
function describeJob(job: ManagerJobView): string {
  if (job.kind === "update") return "Updating clp-addons";
  const verb = job.kind === "disable" ? "Disabling" : "Enabling";
  return `${verb} ${job.addon || "an addon"}`;
}
