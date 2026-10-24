import { esc } from "../../../lib/app-http";
import { TWEAK_ROW_JS, TWEAK_ROW_STYLE, renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { PanelTweaks, PanelTweaksState } from "../action";
import type { PanelPhpChoice, PanelPhpStatus } from "../panel-php";

const BASE = mountPath("panel-tweaks");

// Cards, switches, badges, the switch rows and the fleet table are in lib/app-ui;
// only what this page alone draws is here.
import STYLE from "./views.css" with { type: "text" };

import SCRIPT from "./views.client.js" with { type: "text" };

export function layout(
  title: string,
  content: string,
  updateNotice?: { current: string; latest: string } | null,
): string {
  return renderLayout(title, content, {
    brand: "Panel Tweaks",
    base: BASE,
    nav: [],
    css: TWEAK_ROW_STYLE + STYLE,
    script: TWEAK_ROW_JS + SCRIPT,
    updateNotice,
  });
}

interface TweakCopy {
  key: keyof PanelTweaks;
  category: "Sites" | "Dashboard" | "Login";
  title: string;
  description: string;
  /** The switch this one depends on: off with it, and unusable until it is on. */
  parent?: keyof PanelTweaks;
}

/**
 * What each switch does, said in terms of what the operator will see change.
 * Related controls stay together: the disk scan is nested under the Sites
 * table enhancement because that table is where its result appears.
 */
const COPY: TweakCopy[] = [
  {
    key: "autoSsl",
    category: "Sites",
    title: "SSL after site creation",
    description: "Adds a checked Let's Encrypt option to the new-site forms. Once the site is created, its domain gets a certificate while the page is open.",
  },
  {
    key: "sitesTable",
    category: "Sites",
    title: "Search, sort and extra columns",
    description: "Adds a site count, search, application filter and sortable extra columns. Column choices are saved per browser.",
  },
  {
    key: "diskUsage",
    category: "Sites",
    title: "Measured site sizes",
    description: "Enabling starts a low-priority scan now. It refreshes about every 6 hours, or whenever you choose Measure now. Each refresh walks the disk.",
    parent: "sitesTable",
  },
  {
    key: "sitesMobile",
    category: "Sites",
    title: "Sites list as cards on a phone",
    description: "Turns the Sites table into readable cards below 860px. Switch it off to keep CloudPanel's sideways-scrolling table.",
  },
  {
    key: "actionMenu",
    category: "Sites",
    title: "Row actions in a menu",
    description: "Moves each site's Manage and addon links into one menu.",
  },
  {
    key: "panelMobile",
    category: "Dashboard",
    title: "CloudPanel mobile layout",
    description: "Fits CloudPanel's header, Dashboard charts, new-site pages and Admin Area to phone screens.",
  },
  {
    key: "deviceTheme",
    category: "Login",
    title: "Device theme on first visit",
    description: "Uses the device's theme on the first visit. Afterward, CloudPanel's theme switch takes over.",
  },
];

function switchRow(copy: TweakCopy, tweaks: PanelTweaks, extra = ""): string {
  const note = `tweak-note-${copy.key}`;
  const on = tweaks[copy.key];
  const locked = copy.parent !== undefined && !tweaks[copy.parent];
  return `
      <div class="tweak-row${copy.parent ? " is-nested" : ""}${on ? " is-enabled" : ""}">
        <div class="tweak-body">
          <div class="tweak-heading">
            <h3>${esc(copy.title)}<button class="tweak-more" type="button" aria-expanded="false"
              aria-controls="${note}" aria-label="What ${esc(copy.title.toLowerCase())} does"
              onclick="toggleNote(this)"></button></h3>
            <label class="switch" title="${esc(copy.title)}">
              <input type="checkbox" data-tweak="${esc(copy.key)}" onchange="setTweak(this)"${on ? " checked" : ""}
                ${copy.parent ? `data-tweak-parent="${esc(copy.parent)}" ` : ""}${locked ? "disabled " : ""}aria-label="${esc(copy.title)}">
              <span></span>
            </label>
          </div>
          <div class="tweak-note" id="${note}"><p>${esc(copy.description)}</p></div>
          ${extra}
        </div>
      </div>`;
}

function scanControls(state: PanelTweaksState): string {
  const measured = state.sites.filter((site) => site.disk).length;
  const summary = measured === 0
    ? "Nothing measured yet."
    : `${measured} of ${state.sites.length} site${state.sites.length === 1 ? "" : "s"} measured, ${esc(sinceText(state.diskMeasuredAt))}.`;
  return `<div class="tweak-scan"><span>${summary}</span>
    <button class="btn" type="button" onclick="measureNow(this)">Measure now</button></div>`;
}

function tweakList(state: PanelTweaksState): string {
  return (["Dashboard", "Login", "Sites"] as const).map((category) => `
        <section class="tweak-category" aria-labelledby="tweak-category-${category.toLowerCase()}">
          <h3 class="tweak-category-title" id="tweak-category-${category.toLowerCase()}">${category}</h3>${COPY
            .filter((copy) => copy.category === category)
            .map((copy) => switchRow(copy, state.tweaks, copy.key === "diskUsage" ? scanControls(state) : ""))
            .join("")}
        </section>`).join("");
}

/** How long ago something happened, in the words a status line would use. */
export function sinceText(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "never";
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function phpOption(choice: PanelPhpChoice, stock: string | null, selected: boolean): string {
  const release = choice.installed ? ` (${choice.installed})` : "";
  const label = choice.version === stock ? `CloudPanel's own: PHP ${choice.version}${release}` : `PHP ${choice.version}${release}`;
  return `<option value="${choice.version === stock ? "" : esc(choice.version)}"${selected ? " selected" : ""}>${esc(label)}</option>`;
}

/** What the panel runs on now, said once, under the picker. */
export function panelPhpLine(status: PanelPhpStatus): string {
  const lines: string[] = [];
  if (status.overriddenBy) lines.push(`${status.overriddenBy} sets this already. Remove it to choose here.`);
  if (status.running) lines.push(`Running on PHP ${status.running}.`);
  const chosen = status.choices.find((choice) => choice.version === (status.wanted || status.stock));
  if (chosen?.available) lines.push(`${chosen.available} is available; run apt upgrade to install it.`);
  if (status.failure && status.failure.php === status.wanted) {
    lines.push(`PHP ${status.failure.php} failed ${sinceText(status.failure.at)}: ${status.failure.error}`);
  }
  return lines.join(" ");
}

function panelPhpCard(status: PanelPhpStatus | { error: string }): string {
  if ("error" in status) {
    return `
    <div class="card"><div class="card-header"><h2>Panel PHP</h2></div>
      <div class="alert" role="alert">${esc(status.error)}</div></div>`;
  }
  const eol = status.stock === "8.1" ? ", which no longer gets security fixes" : "";
  const body = status.stock === null
    ? `<p class="hint">CloudPanel's PHP-FPM unit is not one this addon recognises, so the panel keeps the PHP CloudPanel chose.</p>`
    : `<p class="hint">CloudPanel runs its pages, phpMyAdmin and the File Manager on PHP ${esc(status.stock)}${eol}.
      A newer installed PHP can run them instead. CloudPanel has not tested this, so after a change the panel is
      asked for its login page and File Manager, and the change is undone if either fails.</p>
      <div class="panel-php-choice">
        <label class="hint" for="panel-php">Panel runs on</label>
        <select id="panel-php" data-current="${esc(status.wanted)}" onchange="setPanelPhp(this)"${status.overriddenBy ? " disabled" : ""}>${status.choices
    .map((choice) => phpOption(choice, status.stock, (status.wanted || status.stock) === choice.version)).join("")}${
    status.wanted && !status.choices.some((choice) => choice.version === status.wanted)
      ? `<option value="${esc(status.wanted)}" selected disabled>PHP ${esc(status.wanted)} (unavailable)</option>` : ""}</select>
      </div>`;
  return `
    <div class="card">
      <div class="card-header"><h2>Panel PHP</h2></div>
      ${body}
      <p class="hint" id="panel-php-status">${esc(panelPhpLine(status))}</p>
    </div>`;
}

function previewCard(state: PanelTweaksState): string {
  const sites = state.sites.length;
  return `
    <div class="card preview-card">
      <div class="card-header">
        <h2>Preview</h2>
        <div class="preview-widths" role="group" aria-label="Preview width">
          <button class="btn is-active" type="button" data-width="0" onclick="setPreviewWidth(this)">This screen</button>
          <button class="btn" type="button" data-width="390" onclick="setPreviewWidth(this)">Phone</button>
        </div>
      </div>
      <p class="hint">CloudPanel's own Sites page, as the switches above leave it.${sites === 0
    ? " There are no sites on this box yet, so there is little to see."
    : ""}</p>
      <div class="preview-frame">
        <iframe id="preview-frame" src="${esc(BASE)}/preview" title="Preview of the Sites page"
          onload="fitPreview()"></iframe>
      </div>
    </div>`;
}

export function dashboardView(state: PanelTweaksState, php?: PanelPhpStatus | { error: string }): string {
  return `
    <div class="page-heading">
      <div>
        <h1>Panel Tweaks</h1>
        <p>Optional improvements to CloudPanel's sites, dashboard and login.</p>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><h2>What it adds</h2></div>
      <div class="tweak-list">${tweakList(state)}
      </div>
    </div>${php ? panelPhpCard(php) : ""}${previewCard(state)}`;
}
