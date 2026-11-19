import { esc } from "../lib/app-http";
import { SETUP_LEVELS } from "../lib/addon-definition";
import type { ActionItem, SetupItem, SetupView } from "./setup";

const ICON: Record<SetupItem["state"], string> = {
  done: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="var(--ok)"/><path d="M4.5 8.2l2.3 2.3 4.7-4.9" fill="none" stroke="var(--panel)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  todo: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="var(--muted)" stroke-width="1.6"/></svg>',
  skipped: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="var(--muted)" stroke-width="1.6"/><path d="M5 8h6" stroke="var(--muted)" stroke-width="1.6" stroke-linecap="round"/></svg>',
  na: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="var(--muted)" stroke-width="1.6" stroke-dasharray="2.5 2.5"/></svg>',
};

const WARN_ICON = '<svg viewBox="0 0 16 16"><path d="M8 1.5l7 12.5H1z" fill="var(--warn)"/><path d="M8 6v3.6" stroke="var(--panel)" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.6" r=".9" fill="var(--panel)"/></svg>';

const STATE_LABEL: Record<SetupItem["state"], string> = { done: "Done", todo: "Suggested", skipped: "Skipped", na: "Does not apply" };

export function setupSuggests(view: SetupView): boolean {
  return view.steps.some((step) => step.state === "todo");
}

/** Whether the helper shows: anything Action needed, or a step to do, which a done step falling back counts as, unless this administrator hid them. */
export function setupShows(view: SetupView): boolean {
  return !view.off && (view.actions.length > 0 || (!view.hidden && setupSuggests(view)));
}

function actions(step: SetupItem): string {
  if (step.state === "skipped") return `<button class="btn" type="button" data-setup-unskip="${esc(step.id)}" aria-label="Undo skipping ${esc(step.title)}">Undo</button>`;
  if (step.state !== "todo") return "";
  const main = step.addon && !step.addon.enabled
    ? `<button class="btn" type="button" data-setup-enable="${esc(step.addon.name)}" aria-label="Enable ${esc(step.addon.title)}">Enable</button>`
    : `<a class="btn" href="${esc(step.href)}" aria-label="Open ${esc(step.title)}">Open</a>`;
  return `<span class="clp-setup-actions">${main}<button class="clp-setup-skip" type="button" data-setup-skip="${esc(step.id)}" aria-label="Skip ${esc(step.title)}">Skip</button></span>`;
}

function stepHtml(step: SetupItem): string {
  const owner = step.addon?.title ?? "CloudPanel";
  return `<li class="clp-setup-step is-${step.state}"><span class="clp-setup-icon" role="img" aria-label="${STATE_LABEL[step.state]}" title="${STATE_LABEL[step.state]}">${ICON[step.state]}</span>
  <div class="clp-setup-text"><strong>${esc(step.title)}</strong><span class="hint">${esc(owner)} · ${esc(step.reason)}</span></div>${actions(step)}</li>`;
}

function actionHtml(item: ActionItem): string {
  const external = /^https?:/.test(item.href) ? ' target="_blank" rel="noopener noreferrer"' : "";
  return `<li class="clp-setup-step is-action"><span class="clp-setup-icon" role="img" aria-label="Action needed" title="Action needed">${WARN_ICON}</span>
  <div class="clp-setup-text"><strong>${esc(item.title)}</strong><span class="hint">${esc(item.addon?.title ?? "CloudPanel")} · ${esc(item.reason)}</span></div>
  <span class="clp-setup-actions"><a class="btn" href="${esc(item.href)}"${external} aria-label="Fix: ${esc(item.title)}">Fix</a></span></li>`;
}

function head(lead: string, hide: boolean): string {
  return `<div class="clp-setup-head"><div><h2 id="clp-setup-title">Setup</h2><p class="hint">${esc(lead)}</p></div>${hide
    ? '\n  <button class="btn clp-setup-hide" type="button" data-setup-hide title="Bring it back from the Addons page">Hide</button>' : ""}</div>`;
}

export function setupPanelHtml(view: SetupView): string {
  if (view.off) return `${head("Setup is off on this server. Root runs clp-addons setup on to turn it back on.", false)}<div class="clp-setup-body"></div>`;
  const actions = view.actions.length
    ? `<section class="clp-setup-action"><h3>Action needed</h3><ul>${view.actions.map(actionHtml).join("")}</ul></section>` : "";
  if (view.hidden && view.actions.length) {
    return `${head("Something needs your attention. Suggestions stay hidden.", false)}
<div class="clp-setup-body">${actions}<p class="clp-setup-hidden-note hint">Suggestions are hidden. <button class="clp-setup-skip" type="button" data-setup-show>Show them</button></p></div>`;
  }
  const levels = Object.entries(SETUP_LEVELS).flatMap(([level, name]) => {
    const steps = view.steps.filter((step) => step.level === level);
    return steps.length ? [`<section class="clp-setup-level"><h3>${esc(name)}</h3><ul>${steps.map(stepHtml).join("")}</ul></section>`] : [];
  });
  const lead = setupSuggests(view)
    ? "Suggestions for this server, checked just now. Skip any you don't want."
    : view.actions.length ? "Something needs your attention." : "Nothing left to suggest. Skipped steps can be undone here.";
  return `${head(lead, true)}
<div class="clp-setup-body">${actions}${levels.join("")}</div>`;
}
