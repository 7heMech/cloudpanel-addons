import { esc } from "../../../lib/app-http";
import {
  JOB_PROGRESS_JS, TWEAK_ROW_JS, jobProgressHtml, renderLayout, sinceText,
} from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { PanelTweaks, PanelTweaksState } from "../action";
import { DEFAULT_BRANDING, type Branding } from "../branding";
import { brandingCard } from "./branding";

const BASE = mountPath("panel-tweaks");

import STYLE from "./views.css" with { type: "text" };

import SCRIPT from "./views.client.js" with { type: "text" };
import BRANDING_SCRIPT from "./branding.client.js" with { type: "text" };

export function layout(
  title: string,
  content: string,
  updateNotice?: { current: string; latest: string } | null,
): string {
  return renderLayout(title, content, {
    base: BASE,
    css: STYLE,
    script: TWEAK_ROW_JS + JOB_PROGRESS_JS + SCRIPT + BRANDING_SCRIPT,
    updateNotice,
  });
}

interface TweakCopy {
  key: keyof PanelTweaks;
  category: "Sites" | "Panel";
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
    description: "Turns the Sites table into readable cards on narrow screens. Switch it off to keep CloudPanel's sideways-scrolling table.",
  },
  {
    key: "actionMenu",
    category: "Sites",
    title: "Row actions in a menu",
    description: "Moves each site's Manage and addon links into one menu.",
  },
  {
    key: "panelMobile",
    category: "Panel",
    title: "CloudPanel mobile layout",
    description: "Fits CloudPanel's header, Dashboard charts, new-site pages, site tabs' tables and Admin Area to phone screens.",
  },
  {
    key: "deviceTheme",
    category: "Panel",
    title: "Device theme on first visit",
    description: "Uses the device's theme on the first visit. Afterward, CloudPanel's theme switch takes over.",
  },
  {
    key: "branding",
    category: "Panel",
    title: "Theme & Branding",
    description: "Your own logos, favicon, CSS and footer on every CloudPanel page, the login page included. Switching it off keeps the settings.",
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

/** Nothing measuring yet: the bar the page fills in when it starts one. */
const NO_MEASUREMENT = { id: "", state: "queued", step: "", completed: 0, total: 0, site: "" };

function scanControls(state: PanelTweaksState): string {
  const measured = state.sites.filter((site) => site.disk).length;
  const summary = measured === 0
    ? "Nothing measured yet."
    : `${measured} of ${state.sites.length} site${state.sites.length === 1 ? "" : "s"} measured, ${esc(sinceText(state.diskMeasuredAt))}.`;
  const job = state.measuring;
  return `<div class="tweak-scan"><span class="tweak-scan-summary"${job ? " hidden" : ""}>${summary}</span>
    ${jobProgressHtml(job ?? NO_MEASUREMENT, "Measuring", !job)}
    <button class="btn" type="button" onclick="measureNow(this)"${job ? " disabled" : ""}>${job ? "Measuring…" : "Measure now"}</button></div>`;
}

function tweakList(state: PanelTweaksState, category: TweakCopy["category"]): string {
  return COPY
    .filter((copy) => copy.category === category)
    .map((copy) => switchRow(copy, state.tweaks, copy.key === "diskUsage" ? scanControls(state) : ""))
    .join("");
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

export function dashboardView(state: PanelTweaksState, branding: Branding = DEFAULT_BRANDING): string {
  return `
    <div class="page-heading">
      <div>
        <h1>Panel Tweaks</h1>
        <p>Optional improvements to CloudPanel's sites, dashboard and login.</p>
      </div>
    </div>
    <div class="card" id="pt-sites">
      <div class="card-header"><h2>Sites</h2></div>
      <div class="tweak-list">${tweakList(state, "Sites")}
      </div>
    </div>${previewCard(state)}
    <div class="card">
      <div class="card-header"><h2>Whole panel</h2></div>
      <div class="tweak-list">${tweakList(state, "Panel")}
      </div>
    </div>${brandingCard(branding, state.tweaks.branding)}`;
}
