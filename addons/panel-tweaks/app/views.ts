import { esc } from "../../../lib/app-http";
import { renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { PanelTweaks, PanelTweaksState } from "../action";

const BASE = mountPath("panel-tweaks");

// Cards, switches, badges, the fleet table and its narrow-screen layout are in
// lib/app-ui; only the two rows this page alone draws are here.
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
    css: STYLE,
    script: SCRIPT,
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
    description: "Fits CloudPanel's header and Dashboard charts to phone screens.",
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

export function dashboardView(state: PanelTweaksState): string {
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
    </div>${previewCard(state)}`;
}
