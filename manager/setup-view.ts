import { esc } from "../lib/app-http";
import { SETUP_LEVELS, type SetupLevel } from "../lib/addon-definition";
import { orderPathSteps, type ActionItem, type SetupContext, type SetupItem, type SetupView } from "./setup";
import { SETUP_GUIDES } from "./setup-guides";

const MARK: Record<SetupItem["state"] | "here", string> = {
  done: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="var(--ok)"/><path d="M4.5 8.2l2.3 2.3 4.7-4.9" fill="none" stroke="var(--panel)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  todo: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="var(--muted)" stroke-width="1.6"/></svg>',
  here: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="var(--panel)" stroke="var(--accent)" stroke-width="1.8"/><circle cx="8" cy="8" r="3" fill="var(--accent)"/></svg>',
  skipped: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="var(--muted)" stroke-width="1.6"/><path d="M5 8h6" stroke="var(--muted)" stroke-width="1.6" stroke-linecap="round"/></svg>',
  na: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="var(--muted)" stroke-width="1.6" stroke-dasharray="2.5 2.5"/></svg>',
  blocked: '<svg viewBox="0 0 18 18"><circle class="setup-lock-ring" cx="9" cy="9" r="8.5" pathLength="56"/><g class="setup-lock-glyph"><rect x="5.9" y="8.4" width="6.2" height="4.6" rx="1"/><path d="M7.1 8.4V7.1a1.9 1.9 0 0 1 3.8 0v1.3"/></g></svg>',
};

const WARN_ICON = '<svg viewBox="0 0 16 16"><path d="M8 1.5l7 12.5H1z" fill="var(--warn)"/><path d="M8 6v3.6" stroke="var(--panel)" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.6" r=".9" fill="var(--panel)"/></svg>';
const GO_UP = '<svg class="setup-go is-up" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 10.5V1.8M2.6 5.2L6 1.8l3.4 3.4"/></svg>';
const GO_OUT = '<svg class="setup-go is-out" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 9l6-6M4.2 3H9v4.8"/></svg>';

const STATE_WORD: Record<SetupItem["state"], string> = {
  done: "Done",
  todo: "Open",
  skipped: "Skipped",
  na: "Does not apply",
  blocked: "Waiting",
};

const PATH_INTRO: Record<SetupLevel, string> = {
  domain: "An HTTPS hostname for CloudPanel. Passkeys and Cloudflare Access need one.",
  secure: "Close the gaps a fresh CloudPanel install ships with.",
  sites: "Give new sites DNS, SSL, PHP limits, outgoing mail, and offsite backups.",
};

export interface InlineAction { url: string; body: Record<string, unknown>; label: string; doneMessage: string }

export const INLINE_ACTIONS: Record<string, InlineAction> = {
  "panel-cert": {
    url: "/addons/system-tweaks/api/panel-cert", body: { enabled: true },
    label: "Generate server certificate", doneMessage: "Generated a unique port 8443 certificate for this server.",
  },
  "real-ip": {
    url: "/addons/system-tweaks/api/real-ip", body: { enabled: true },
    label: "Block forged visitor IPs", doneMessage: "Blocked untrusted X-Real-IP headers.",
  },
  phpmyadmin: {
    url: "/addons/system-tweaks/api/phpmyadmin", body: { enabled: true },
    label: "Lock down phpMyAdmin", doneMessage: "Locked down phpMyAdmin rules.",
  },
  "auto-ssl": {
    url: "/addons/panel-tweaks/api/tweaks", body: { autoSsl: true },
    label: "Enable automatic SSL", doneMessage: "New sites will request a Let's Encrypt certificate automatically.",
  },
};

export function setupSuggests(view: SetupView): boolean {
  return view.steps.some((step) => step.state === "todo");
}

/** Whether the header chip shows: anything Action needed, or a step to do, unless this administrator hid them. */
export function setupShows(view: SetupView): boolean {
  return !view.off && (view.actions.length > 0 || (!view.hidden && setupSuggests(view)));
}

/**
 * Locked steps that sit directly beneath their same-path prerequisite hang off
 * it as indented dashed tree branches.
 */
function pathBranches(steps: SetupItem[]): Map<string, string> {
  const ids = steps.map((step) => step.id);
  const parent = new Map<string, string>();
  steps.forEach((step, index) => {
    if (step.state !== "blocked" || !step.blockedBy?.length) return;
    const samePath = step.blockedBy.filter((req) => ids.includes(req.id));
    if (!samePath.length) return;
    const reqId = samePath[samePath.length - 1]!.id;
    const at = ids.indexOf(reqId);
    if (at < 0 || at >= index) return;
    for (let k = at + 1; k < index; k++) {
      if (parent.get(ids[k]!) !== reqId) return;
    }
    parent.set(step.id, reqId);
  });
  return parent;
}

function panelHostInline(step: SetupItem, ctx: SetupContext | undefined): string {
  if (!ctx) return `<div class="setup-controls"><a class="btn btn-primary" href="${esc(step.href)}">Open Panel hostname</a></div>`;
  const ips = [ctx.serverIps.ipv4, ctx.serverIps.ipv6].filter(Boolean);
  if (!ctx.dnsConnected) {
    const ipCodes = ips.map((ip) => `<button class="btn setup-copy-chip" type="button" data-setup-copy="${esc(ip!)}" title="Copy ${esc(ip!)}"><code>${esc(ip!)}</code></button>`).join(" ");
    const ipHint = ips.length
      ? `<p class="setup-body-note">Point an A or AAAA record for your chosen hostname at ${ipCodes} in your DNS provider, then enter it under CloudPanel's <a href="/admin/settings" target="_blank" rel="noopener noreferrer">Admin → Settings → Custom Domain</a>.</p>`
      : `<p class="setup-body-note">Point a hostname at this server's IP in your DNS provider, then enter it under CloudPanel's <a href="/admin/settings" target="_blank" rel="noopener noreferrer">Admin → Settings → Custom Domain</a>.</p>`;
    return `${ipHint}
      <div class="setup-controls">
        <a class="btn btn-primary" href="/admin/settings" target="_blank" rel="noopener noreferrer">Open Custom Domain</a>
        <button class="btn" type="button" data-setup-jump="dns-connection">Or connect Cloudflare first</button>
      </div>`;
  }
  const zones = ctx.dnsZones.length
    ? `<datalist id="setup-dns-zones">${ctx.dnsZones.map((zone) => `<option value="${esc(zone)}"></option>`).join("")}</datalist>`
    : "";
  const adopt = !ctx.dnsPanelHost && ctx.customDomain
    ? `<div class="notice setup-adopt-note"><span>CloudPanel already uses <strong>${esc(ctx.customDomain.name)}</strong>.</span>
        <button class="btn" type="button" data-setup-adopt-host="${esc(ctx.customDomain.name)}">Manage in Cloudflare</button></div>`
    : "";
  const customDomainLink = '<a href="/admin/settings" target="_blank" rel="noopener noreferrer">Admin → Settings → Custom Domain</a>';
  const copyOpenBtn = ctx.dnsPanelHost
    ? `<button class="btn${ctx.dnsAutomatic ? " btn-primary" : ""}" type="button" data-setup-copy-open="${esc(ctx.dnsPanelHost)}" data-setup-open-url="/admin/settings">Copy &amp; open Custom Domain</button>`
    : "";
  return `<ol class="setup-substeps">
    <li class="${ctx.dnsPanelHost ? "is-done" : ""}">
      <div>
        <strong>Choose a hostname in Cloudflare</strong>
        <p class="hint">DNS creates a temporary unproxied record so Let's Encrypt can verify it, then proxies it or hands it off to your zone's wildcard.</p>
        ${adopt}
        <form class="setup-host-form" onsubmit="setupSavePanelHost(event)">
          <input class="setup-host-input" id="setup-panel-host-name" data-keep name="name" aria-label="Panel hostname" autocomplete="off" spellcheck="false" placeholder="k7m2p9x4.example.com"${zones ? ' list="setup-dns-zones"' : ""} value="${esc(ctx.dnsPanelHost ?? "")}">${zones}
          <button class="btn" type="button" data-setup-random-host>Random</button>
          <button class="btn${ctx.dnsPanelHost ? "" : " btn-primary"}" type="submit">${ctx.dnsPanelHost ? "Change" : "Save"}</button>
          ${ctx.dnsPanelHost ? `<button class="btn" type="button" data-setup-copy="${esc(ctx.dnsPanelHost)}">Copy</button>` : ""}
        </form>
      </div>
    </li>
    <li class="${ctx.customDomain?.issued ? "is-done" : ""}">
      <div>
        <strong>Enter it under CloudPanel Custom Domain</strong>
        ${ctx.dnsPanelHost && !ctx.dnsAutomatic
          ? `<p class="hint">DNS is still in Ask first mode. Turn on Automatic DNS records so the temporary record is written before CloudPanel checks <code>${esc(ctx.dnsPanelHost)}</code> under ${customDomainLink}.</p>
             <div class="setup-controls"><button class="btn btn-primary" type="button" data-setup-jump="dns-automatic">Go to Automatic DNS records</button>${copyOpenBtn}</div>`
          : `<p class="hint">${ctx.dnsPanelHost
              ? `Paste <code>${esc(ctx.dnsPanelHost)}</code> into ${customDomainLink} in CloudPanel and save. This page checks again when you return.`
              : `Save a hostname in step 1 first, then enter it under ${customDomainLink}.`}</p>
             ${ctx.dnsPanelHost ? `<div class="setup-controls">${copyOpenBtn}<button class="btn" type="button" data-setup-refresh>Check again</button></div>` : ""}`}
      </div>
    </li>
  </ol>`;
}

function formatDependentList(steps: SetupItem[]): string {
  if (steps.length === 1) return esc(steps[0]!.title);
  if (steps.length === 2) return `${esc(steps[0]!.title)} and ${esc(steps[1]!.title)}`;
  return `${steps.length} dependent steps`;
}

function unlocksNoteHtml(dependents: SetupItem[]): string {
  if (!dependents.length) return "";
  const unlocked = dependents.filter((step) => (step.blockedBy?.length ?? 1) <= 1);
  const partial = dependents.filter((step) => (step.blockedBy?.length ?? 1) > 1);
  const parts: string[] = [];
  if (unlocked.length) parts.push(`unlocks ${formatDependentList(unlocked)}`);
  if (partial.length) parts.push(`completes one requirement for ${formatDependentList(partial)}`);
  return `<p class="setup-hint">Finishing this step <span class="setup-unlocks">${parts.join(" and ")}</span>.</p>`;
}

function stepControlsHtml(step: SetupItem, ctx: SetupContext | undefined, skipBtn: string, unlocksHint: string): string {
  if (step.state === "done") {
    if (step.id === "panel-hostname" && ctx?.proxyHost && !ctx.customDomain) {
      const targetHref = ctx.dnsConnected ? step.href : "/admin/settings";
      const targetLabel = ctx.dnsConnected ? "Open DNS settings" : "Open Custom Domain";
      const external = targetHref.startsWith("/admin/") ? ' target="_blank" rel="noopener noreferrer"' : "";
      return `<p class="setup-body-note hint">Your reverse proxy or tunnel already serves CloudPanel at <code>https://${esc(ctx.proxyHost)}</code>. CloudPanel's built-in Custom Domain is optional while that stays in place.</p>
        <div class="setup-controls"><a class="btn" href="${esc(targetHref)}"${external}>${esc(targetLabel)}</a></div>`;
    }
    const external = step.href.startsWith("/admin/") ? ' target="_blank" rel="noopener noreferrer"' : "";
    return `<div class="setup-controls"><a class="btn" href="${esc(step.href)}"${external}>Open ${esc(step.addon?.title ?? "settings")}</a></div>`;
  }
  if (step.state === "skipped") {
    return `<div class="setup-controls"><button class="btn btn-primary" type="button" data-setup-unskip="${esc(step.id)}" aria-label="Undo skipping ${esc(step.title)}">Undo skip</button></div>`;
  }
  if (step.state === "na") {
    return `<p class="setup-hint">This step does not apply on this server.</p>`;
  }
  if (step.addon && !step.addon.enabled) {
    const manual = step.id === "panel-hostname"
      ? `<a class="btn" href="/admin/settings" target="_blank" rel="noopener noreferrer">Open Custom Domain</a>`
      : "";
    return `<div data-manager-job-card="${esc(step.addon.name)}">
      <div class="setup-controls">
        <button class="btn btn-primary" type="button" data-setup-enable="${esc(step.addon.name)}" aria-label="Enable ${esc(step.addon.title)}">Enable ${esc(step.addon.title)}</button>
        ${manual}
        ${skipBtn}
      </div>
    </div>${unlocksHint}`;
  }
  if (step.id === "panel-hostname") {
    const foot = unlocksHint || skipBtn ? `<div class="setup-substep-foot">${unlocksHint}${skipBtn}</div>` : "";
    return `${panelHostInline(step, ctx)}${foot}`;
  }
  const inline = INLINE_ACTIONS[step.id];
  if (inline) {
    return `<div class="setup-controls">
      <button class="btn btn-primary" type="button" data-setup-inline-url="${esc(inline.url)}" data-setup-inline-body="${esc(JSON.stringify(inline.body))}" data-setup-inline-done="${esc(inline.doneMessage)}">${esc(inline.label)}</button>
      <a class="btn" href="${esc(step.href)}">Open ${esc(step.addon?.title ?? "settings")}</a>
      ${skipBtn}
    </div>${unlocksHint}`;
  }
  if (step.id === "passkeys") {
    const domain = ctx?.customDomain?.issued ? ctx.customDomain.name : (ctx?.proxyHost ?? "");
    return `<div class="setup-passkey-live" data-setup-passkey-live data-custom-domain="${esc(domain)}">
      <div class="notice setup-origin-notice" data-setup-origin-warn hidden></div>
      <div class="setup-controls">
        <a class="btn btn-primary" data-setup-passkey-link href="${esc(step.href)}">Open Account → Security</a>
        ${skipBtn}
      </div>
    </div>`;
  }
  const external = step.href.startsWith("/admin/") ? ' target="_blank" rel="noopener noreferrer"' : "";
  return `<div class="setup-controls">
    <a class="btn btn-primary" href="${esc(step.href)}"${external} aria-label="Open ${esc(step.title)}">Open ${esc(step.title)}</a>
    ${skipBtn}
  </div>${unlocksHint}`;
}

function stepRowHtml(
  step: SetupItem,
  pathId: SetupLevel,
  isOpen: boolean,
  branchParent: string | undefined,
  isBranchEnd: boolean,
  hasBranch: boolean,
  allStepsById: Map<string, SetupItem>,
  blockedDependents: SetupItem[],
  ctx: SetupContext | undefined,
): string {
  const cls = [
    "setup-step",
    `is-${step.state}`,
    isOpen && "is-open",
    branchParent && "is-branch",
    branchParent && isBranchEnd && "is-branch-end",
    hasBranch && "has-branch",
  ].filter(Boolean).join(" ");
  const arm = branchParent ? '<span class="setup-arm" aria-hidden="true"></span>' : "";

  if (step.state === "blocked") {
    const reqs = step.blockedBy ?? [];
    const targetId = branchParent ?? reqs[0]?.id ?? "";
    const targetStep = targetId ? allStepsById.get(targetId) : undefined;
    const samePath = Boolean(branchParent || (targetStep && targetStep.level === pathId));
    const where = targetStep && !samePath ? ` on ${SETUP_LEVELS[targetStep.level]}` : "";
    const needsText = reqs.length ? `Needs ${reqs.map((req) => req.title).join(" and ")}` : step.reason;
    const targetTitle = targetStep?.title ?? reqs[0]?.title ?? "prerequisite";
    // Browser-origin fallback when Passkeys is blocked server-side but the
    // browser is already on a valid standard-port HTTPS proxy origin.
    const passkeyFallback = step.id === "passkeys"
      ? `<div class="setup-step-head" data-setup-passkey-head hidden>
          <span class="setup-mark" aria-hidden="true">${MARK.here}</span>
          <span class="setup-step-line">
            <span class="setup-step-title"><span class="sr-only">Open: </span>${esc(step.title)}</span>
            <span class="setup-step-note">Available on this origin</span>
          </span>
        </div>
        <div class="setup-passkey-origin" data-setup-passkey-blocked hidden${step.addon ? ` data-manager-job-card="${esc(step.addon.name)}"` : ""}>
          <p class="setup-body-note" data-setup-passkey-note></p>
          <div class="setup-controls">${step.addon && !step.addon.enabled
            ? `<button class="btn btn-primary" type="button" data-setup-enable="${esc(step.addon.name)}" aria-label="Enable ${esc(step.addon.title)}">Enable ${esc(step.addon.title)}</button>`
            : `<a class="btn btn-primary" href="${esc(step.href)}">Add a security key</a>`}</div>
        </div>`
      : "";
    return `<li class="${cls}" data-setup-step="${esc(step.id)}" data-setup-panel="${esc(step.id)}" data-setup-state="blocked"${branchParent ? ` data-setup-branch-of="${esc(branchParent)}"` : ""}>${arm}
      <button class="setup-step-head is-jump" type="button" data-setup-jump="${esc(targetId)}" data-setup-from="${esc(step.id)}" data-setup-blocked-box title="Go to ${esc(targetTitle)}${esc(where)}">
        <span class="setup-mark" aria-hidden="true">${MARK.blocked}</span>
        <span class="setup-step-line">
          <span class="setup-step-title"><span class="sr-only">Waiting: </span>${esc(step.title)}</span>
          <span class="setup-step-note">${esc(needsText)}${samePath ? GO_UP : GO_OUT}<span class="sr-only">. Go to ${esc(targetTitle)}${esc(where)}.</span></span>
        </span>
      </button>${passkeyFallback}
    </li>`;
  }

  const markKey: keyof typeof MARK = step.state === "todo" && isOpen ? "here" : step.state;
  const note = step.state === "skipped" ? "Skipped" : step.reason;
  const aside = step.state === "skipped"
    ? `<div class="setup-step-aside"${isOpen ? " hidden" : ""}><button class="setup-textbtn" type="button" data-setup-unskip="${esc(step.id)}" aria-label="Undo skipping ${esc(step.title)}">Undo</button></div>`
    : "";
  const skipBtn = step.state === "todo"
    ? `<button class="setup-textbtn setup-push" type="button" data-setup-skip="${esc(step.id)}" aria-label="Skip ${esc(step.title)}">Skip</button>`
    : "";
  const showFinding = !(step.id === "panel-hostname" && step.state === "todo" && ctx && (!step.addon || step.addon.enabled));
  const unlocksHint = step.state === "todo" ? unlocksNoteHtml(blockedDependents) : "";

  return `<li class="${cls}" data-setup-step="${esc(step.id)}" data-setup-panel="${esc(step.id)}" data-setup-state="${esc(step.state)}">${arm}
    <button class="setup-step-head" type="button" data-setup-toggle="${esc(step.id)}" aria-expanded="${isOpen ? "true" : "false"}" aria-controls="setup-body-${esc(step.id)}">
      <span class="setup-mark" aria-hidden="true">${MARK[markKey]}</span>
      <span class="setup-step-line">
        <span class="setup-step-title"><span class="sr-only">${esc(STATE_WORD[step.state])}: </span>${esc(step.title)}</span>
        <span class="setup-step-note">${esc(note)}</span>
      </span>
    </button>${aside}
    <div class="setup-step-body" id="setup-body-${esc(step.id)}"${isOpen ? "" : " hidden"}>
      ${step.why ? `<p class="setup-why">${esc(step.why)}</p>` : ""}
      ${showFinding ? `<p class="setup-finding-line">${esc(step.reason)}</p>` : ""}
      ${stepControlsHtml(step, ctx, skipBtn, unlocksHint)}
    </div>
  </li>`;
}

function actionBandHtml(actions: ActionItem[]): string {
  if (!actions.length) return "";
  const rows = actions.map((item) => {
    const external = /^https?:/.test(item.href) ? ' target="_blank" rel="noopener noreferrer"' : "";
    const owner = item.addon?.title ?? "CloudPanel";
    return `<li class="setup-action-row" data-setup-action="${esc(item.id)}">
      <span class="setup-mark" role="img" aria-label="Action needed">${WARN_ICON}</span>
      <div class="setup-action-body">
        <div class="setup-action-head">
          <strong>${esc(item.title)}</strong>
          <span class="setup-action-owner">${esc(owner)}</span>
        </div>
        <p class="setup-action-reason">${esc(item.reason)}</p>
      </div>
      <div class="setup-action-cta">
        <a class="btn btn-primary" href="${esc(item.href)}"${external} aria-label="Fix: ${esc(item.title)}">Fix</a>
      </div>
    </li>`;
  }).join("");
  return `<section class="setup-actions-band" aria-label="Action needed">
    <div class="setup-actions-label">Action needed</div>
    <ul class="setup-actions-list">${rows}</ul>
  </section>`;
}

function guidesHtml(view: SetupView, stepIds: Set<string>): string {
  if (!view.steps.length) return "";
  const enabledSet = view.enabledAddons ? new Set(view.enabledAddons) : null;
  const knownState = new Map<string, boolean>();
  for (const step of view.steps) {
    if (step.addon) knownState.set(step.addon.name, step.addon.enabled);
  }
  const addonIsOn = (name: string): boolean => {
    if (enabledSet) return enabledSet.has(name);
    return knownState.get(name) ?? true;
  };
  const items = SETUP_GUIDES.map((guide) => {
    const uses = guide.addons.map((addon) => {
      const on = addonIsOn(addon.name);
      return `<span${on ? "" : ' class="is-off"'}>${esc(addon.title)}</span>`;
    }).join(" + ");
    const offNames = guide.addons.filter((addon) => !addonIsOn(addon.name)).map((addon) => `${esc(addon.title)} is off`);
    const countLabel = `${guide.steps.length} ${guide.steps.length === 1 ? "step" : "steps"}`;
    const bodySteps = guide.steps.map((step) => {
      const action = step.stepId && stepIds.has(step.stepId)
        ? `<button class="btn" type="button" data-setup-jump="${esc(step.stepId)}">${esc(step.linkLabel)}</button>`
        : `<a class="btn" href="${esc(step.href)}">${esc(step.linkLabel)}</a>`;
      return `<li>
        <div><strong>${esc(step.title)}</strong><p class="hint">${esc(step.detail)}</p></div>
        ${action}
      </li>`;
    }).join("");
    return `<li>
      <details class="setup-guide" id="setup-guide-${esc(guide.id)}">
        <summary class="setup-guide-row">
          <span class="setup-guide-title">${esc(guide.title)}</span>
          <span class="setup-guide-desc">${esc(guide.description)}</span>
          <span class="setup-guide-uses">${uses}${offNames.length ? `<small>${offNames.join(", ")}</small>` : ""}</span>
          <span class="setup-guide-len">${esc(countLabel)}</span>
        </summary>
        <ol class="setup-guide-steps">${bodySteps}</ol>
      </details>
    </li>`;
  }).join("");

  return `<section class="setup-guides" aria-labelledby="setup-guides-heading">
    <div class="setup-guides-head">
      <h2 id="setup-guides-heading">Guides</h2>
      <p>Procedures that use more than one addon.</p>
    </div>
    <ul class="setup-guides-list">${items}</ul>
  </section>`;
}

type UsageSharing = NonNullable<SetupView["usageSharing"]>;

/** Asked once, above everything else, until root answers. */
function usageShareAskHtml(sharing: UsageSharing | undefined): string {
  if (!sharing || sharing.answered) return "";
  return `<section class="card setup-share" aria-labelledby="setup-share-heading">
    <h2 id="setup-share-heading">Help prioritize what gets maintained</h2>
    <p>Once a week, this server can send exactly what is shown below; nothing is sent until you save.</p>
    <pre class="setup-share-payload">${esc(JSON.stringify(sharing.payload, null, 2))}</pre>
    <form class="setup-share-form" onsubmit="setupSaveUsageSharing(event)">
      <label class="setup-share-check"><input type="checkbox" name="enabled" checked> Share enabled addons</label>
      <button class="btn btn-primary" type="submit">Save</button>
    </form>
  </section>`;
}

function usageShareLineHtml(sharing: UsageSharing | undefined): string {
  if (!sharing?.answered) return "";
  return `<div class="setup-share-line">
    <label class="switch"><input type="checkbox" aria-label="Share enabled addons"${sharing.enabled ? " checked" : ""} onchange="setupToggleUsageSharing(this)"><span></span></label>
    <span>Share enabled addons once a week</span>
    <details><summary>What is sent</summary><pre class="setup-share-payload">${esc(JSON.stringify(sharing.payload, null, 2))}</pre></details>
  </div>`;
}

/**
 * Full Setup workspace rendered on /addons/setup and refreshed in place from
 * /addons/api/setup. Keeps the same exported name (`setupPanelHtml`) for tests
 * and callers.
 */
export function setupPanelHtml(view: SetupView): string {
  const payload = JSON.stringify({
    context: view.context ?? null,
    show: setupShows(view),
    attention: view.actions.length > 0,
  }).replaceAll("<", "\\u003c");
  const script = `<script type="application/json" id="clp-setup-state">${payload}</script>`;

  if (view.off) {
    return `${script}<div class="page-heading"><div><h1>Setup</h1></div></div><div class="card empty">Setup is off on this server. Root runs <code>clp-addons setup on</code> to turn it back on.</div>`;
  }

  if (view.hidden && view.actions.length) {
    return `${script}<div class="page-heading"><div><h1>Setup</h1><p>Something needs your attention.</p></div><div class="page-actions"><button class="btn" type="button" data-setup-refresh>Check again</button><button class="btn" type="button" data-setup-show>Show suggestions</button></div></div>
    ${usageShareAskHtml(view.usageSharing)}
    <section class="setup-sheet" aria-label="Action needed">${actionBandHtml(view.actions)}</section>
    ${usageShareLineHtml(view.usageSharing)}`;
  }

  const levelKeys = Object.keys(SETUP_LEVELS) as SetupLevel[];
  const pathGroups = levelKeys
    .map((level) => ({ level, title: SETUP_LEVELS[level], steps: orderPathSteps(view.steps.filter((step) => step.level === level)) }))
    .filter((group) => group.steps.length > 0);

  const initialPath = pathGroups.find((group) => group.steps.some((step) => step.state === "todo"))?.level
    ?? pathGroups[0]?.level
    ?? "domain";

  const initialOpenByPath = new Map<SetupLevel, string>();
  for (const group of pathGroups) {
    const firstTodo = group.steps.find((step) => step.state === "todo");
    if (firstTodo) initialOpenByPath.set(group.level, firstTodo.id);
  }
  const initialStep = initialOpenByPath.get(initialPath) ?? "";

  const allStepsById = new Map(view.steps.map((step) => [step.id, step]));
  const stepIds = new Set(allStepsById.keys());

  const count = { action: view.actions.length, done: 0, todo: 0, blocked: 0, skipped: 0 };
  for (const step of view.steps) {
    if (step.state === "done") count.done += 1;
    else if (step.state === "todo") count.todo += 1;
    else if (step.state === "blocked") count.blocked += 1;
    else if (step.state === "skipped") count.skipped += 1;
  }

  const legendItem = (key: string, cls: string, value: number, word: string, warn = false) =>
    `<li${warn ? ' class="is-warn"' : ""} data-setup-legend="${key}"><span class="setup-seg ${cls}" aria-hidden="true"></span><span><b>${value}</b> ${word}</span></li>`;
  const legendHtml = view.steps.length || view.actions.length
    ? `<ul class="setup-legend" aria-label="Server setup status">${[
        count.action ? legendItem("action", "s-action", count.action, "action needed", true) : "",
        legendItem("done", "s-done", count.done, "done"),
        legendItem("todo", "s-todo", count.todo, "open"),
        count.blocked ? legendItem("blocked", "s-blocked", count.blocked, "waiting on another step") : "",
        count.skipped ? legendItem("skipped", "s-skipped", count.skipped, "skipped") : "",
      ].join("")}</ul>`
    : "";

  const tabsHtml = pathGroups.map((group) => {
    const selected = group.level === initialPath;
    const openId = initialOpenByPath.get(group.level) ?? "";
    const todoCount = group.steps.filter((step) => step.state === "todo").length;
    const blockedCount = group.steps.filter((step) => step.state === "blocked").length;
    const countText = todoCount
      ? `<b>${todoCount}</b> open`
      : blockedCount
        ? `<b>${blockedCount}</b> waiting`
        : "Nothing open";
    const segs = group.steps.map((step) => {
      const here = selected && openId === step.id && step.state === "todo";
      return `<span class="setup-seg s-${esc(step.state)}${here ? " is-here" : ""}" data-setup-seg="${esc(step.id)}" data-setup-seg-state="${esc(step.state)}" title="${esc(step.title)}: ${STATE_WORD[step.state]}"></span>`;
    }).join("");
    return `<button class="setup-tab" type="button" role="tab" id="setup-tab-${esc(group.level)}" data-setup-tab="${esc(group.level)}" aria-selected="${selected ? "true" : "false"}" aria-controls="setup-path-${esc(group.level)}" tabindex="${selected ? "0" : "-1"}">
      <span class="setup-tab-title">${esc(group.title)}</span>
      <span class="setup-tab-meta"><span class="setup-segs" aria-hidden="true">${segs}</span><span class="setup-tab-count" data-setup-tab-count="${esc(group.level)}">${countText}</span></span>
    </button>`;
  }).join("");

  const panelsHtml = pathGroups.map((group) => {
    const selected = group.level === initialPath;
    const openId = initialOpenByPath.get(group.level) ?? "";
    const tree = pathBranches(group.steps);
    const items = group.steps.map((step, index) => {
      const next = group.steps[index + 1];
      const branchParent = tree.get(step.id);
      const isBranchEnd = Boolean(branchParent && (!next || tree.get(next.id) !== branchParent));
      const hasBranch = Boolean(next && tree.get(next.id) === step.id);
      const dependents = view.steps.filter((candidate) =>
        candidate.state === "blocked" && candidate.blockedBy?.some((req) => req.id === step.id),
      );
      return stepRowHtml(
        step, group.level, step.id === openId && step.state !== "blocked",
        branchParent, isBranchEnd, hasBranch, allStepsById, dependents, view.context,
      );
    }).join("");
    return `<div class="setup-path" role="tabpanel" id="setup-path-${esc(group.level)}" data-setup-path="${esc(group.level)}" aria-labelledby="setup-tab-${esc(group.level)}"${selected ? "" : " hidden"}>
      <p class="setup-path-intro">${esc(PATH_INTRO[group.level])}</p>
      <ol class="setup-steps">${items}</ol>
    </div>`;
  }).join("");

  const toggleHeader = view.hidden
    ? `<button class="btn" type="button" data-setup-show>Show in header</button>`
    : `<button class="btn" type="button" data-setup-hide title="Hide the Setup link from the top bar">Hide from header</button>`;

  const lead = setupSuggests(view)
    ? "Suggestions checked against this server. Skip any that do not fit."
    : view.actions.length
      ? "Something needs your attention."
      : count.blocked > 0
        ? "Remaining steps are waiting on skipped prerequisites. Undo a skip to continue."
        : "Everything suggested is done or skipped. Skipped steps can be undone here.";

  const sheetBody = pathGroups.length
    ? `<div class="setup-tabs" role="tablist" aria-label="Setup paths" style="--setup-cols:${pathGroups.length}">${tabsHtml}</div>${panelsHtml}`
    : !view.actions.length
      ? '<div class="setup-empty">No setup steps apply to this server.</div>'
      : "";

  return `${script}<div class="page-heading"><div><h1>Setup</h1><p>${esc(lead)}</p>${legendHtml}</div><div class="page-actions"><button class="btn" type="button" data-setup-refresh>Check again</button>${toggleHeader}</div></div>
${usageShareAskHtml(view.usageSharing)}
<section class="setup-sheet" data-setup-workspace data-initial-path="${esc(initialPath)}" data-initial-step="${esc(initialStep)}" aria-label="Setup paths">
  ${actionBandHtml(view.actions)}
  ${sheetBody}
</section>
<p class="sr-only" role="status" aria-live="polite" id="setup-announce"></p>
${guidesHtml(view, stepIds)}
${usageShareLineHtml(view.usageSharing)}`;
}
