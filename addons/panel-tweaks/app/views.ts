import { esc } from "../../../lib/app-http";
import { renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { PanelTweaks, PanelTweaksState } from "../action";

const BASE = mountPath("panel-tweaks");

// Cards, switches, badges, the fleet table and its narrow-screen layout are in
// lib/app-ui; only the two rows this page alone draws are here.
const STYLE = `
.tweak-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px;
  padding: 22px 0; border-top: 1px solid var(--row-border); }
.tweak-row > div { flex: 1 1 auto; min-width: 0; }
.tweak-category + .tweak-category { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--row-border); }
.tweak-category-title { margin: 0; color: var(--muted); font-size: 12px; font-weight: 700;
  letter-spacing: .06em; text-transform: uppercase; }
.tweak-category > .tweak-row:nth-child(2) { padding-top: 10px; border-top: 0; }
.tweak-category > .tweak-row:last-child { padding-bottom: 0; }
.tweak-row.is-nested { position: relative; padding-top: 0; padding-left: 36px; border-top: 0; }
/* The branch starts beneath the parent and ends beside the child heading. */
.tweak-row.is-nested::before { content: ""; position: absolute; top: -16px; left: 8px; width: 18px; height: 26px;
  border-left: 2px solid var(--border); border-bottom: 2px solid var(--border); border-bottom-left-radius: 5px;
  pointer-events: none; }
.tweak-row.is-nested h3 { font-size: 15px; font-weight: 500; }
.tweak-row h3 { margin: 0 0 6px; font-size: 16px; }
.tweak-row p { margin: 0; color: var(--muted); font-size: 14px; }
.tweak-row .switch { flex: 0 0 auto; margin-top: 4px; }
.tweak-scan { display: none; align-items: center; gap: 12px; margin-top: 12px; color: var(--muted); font-size: 13px; }
.tweak-row.is-enabled .tweak-scan { display: flex; }
.tweak-scan span { flex: 1 1 auto; }
.tweak-scan .btn { flex: 0 0 auto; min-height: 32px; padding: 4px 12px; }
/* A phone gets the titles and the switches, with the wording a tap away. The
   button is display: none above that, so nothing can focus a control that
   would do nothing. */
.tweak-more { display: none; }
@media (max-width: 760px) {
  .tweak-row.is-nested { padding-left: 28px; }
  .tweak-row.is-nested::before { left: 4px; width: 14px; }
  .tweak-row h3 { position: relative; margin: 0; padding-right: 30px; }
  .tweak-row .tweak-note { display: none; margin-top: 8px; }
  .tweak-row.is-open .tweak-note { display: block; }
  .tweak-scan { flex-direction: column; align-items: flex-start; gap: 8px; }
  /* The transparent button covers the heading, so tapping either the title or
     its arrow opens the description. */
  .tweak-more { position: absolute; inset: 0; display: flex; align-items: center; justify-content: flex-end;
    width: 100%; height: 100%; padding: 0 6px 0 0; border: 0; background: none; color: var(--muted);
    font-size: 0; line-height: 1; cursor: pointer; }
  .tweak-more::after { content: "\\25BE"; font-size: 13px; transition: transform .15s; }
  .tweak-more:hover { color: var(--text); }
  .tweak-row.is-open .tweak-more::after { transform: rotate(180deg); }
}
.preview-widths { display: flex; gap: 8px; }
.preview-widths .btn { min-height: 36px; padding: 4px 14px; font-size: 13px; }
.preview-widths .btn.is-active { border-color: var(--primary); color: var(--primary); }
/* The frame carries the panel's own background, so the border is what says
   where the preview stops and this page starts. */
.preview-frame { border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
.preview-frame iframe { display: block; width: 100%; max-width: 100%; height: 320px; border: 0;
  background: var(--panel); color-scheme: normal; }
.preview-frame.is-phone { display: flex; justify-content: center; background: var(--row-hover, transparent); }
.preview-frame.is-phone iframe { width: 390px; max-width: 100%; }
@media (max-width: 760px) {
  .preview-widths { display: none; }
  /* Let the panel preview use the whole phone width instead of nesting it
     inside both the page and card gutters. */
  .preview-frame { display: flex; justify-content: center; margin-right: calc(-25px - 13px); margin-left: calc(-25px - 13px);
    border-right: 0; border-left: 0; border-radius: 0; }
  .preview-frame iframe { width: 390px; max-width: 100%; }
}
.size-cell { font-variant-numeric: tabular-nums; white-space: nowrap; }
`;

const SCRIPT = `
async function setTweak(input) {
  const key = input.dataset.tweak;
  const wanted = input.checked;
  clearNotice();
  busy(true);
  try {
    const reply = await call('/api/tweaks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: wanted }),
    });
    input.closest('.tweak-row').classList.toggle('is-enabled', wanted);
    const frame = document.getElementById('preview-frame');
    if (frame) frame.src = CLP_BASE + '/preview?refresh=' + Date.now();
    busy(false);
    notify('Saved.', 'ok');
  } catch (error) {
    input.checked = !wanted;
    busy(false);
    notify(error.message, 'error');
  }
}

async function measureNow(button) {
  clearNotice();
  busy(true);
  notify('Measuring every site. This reads the whole disk, so it can take a while.', 'warn');
  try {
    const reply = await call('/api/scan', { method: 'POST' });
    const data = reply.data || {};
    const skipped = data.skipped ? ', ' + data.skipped + ' skipped' : '';
    reloadWith(data.measured + (data.measured === 1 ? ' site measured' : ' sites measured') + skipped + '.', 'ok');
  } catch (error) {
    busy(false);
    notify(error.message, 'error');
  }
}

// The frame is this origin's, so its document can be measured directly: it
// grows when the injected script fills the columns, and again whenever a
// column is switched on inside it.
function fitPreview() {
  const frame = document.getElementById('preview-frame');
  if (!frame) return;
  const inner = frame.contentDocument;
  const content = inner && inner.getElementById('clp-preview');
  if (!content) return;
  const wrap = document.querySelector('.preview-frame');
  inner.documentElement.classList.toggle('clp-preview-framed-phone', !!wrap && wrap.classList.contains('is-phone'));
  // The wrapper's height, not the document's or the body's: CloudPanel gives
  // both of those a height of their own, which inside a frame is the frame's
  // height, so measuring either would only ever grow it.
  const measure = () => {
    frame.style.height = Math.max(160, Math.ceil(content.getBoundingClientRect().height)) + 'px';
  };
  measure();
  if (window.ResizeObserver) new ResizeObserver(measure).observe(content);
}

function setPreviewWidth(button) {
  const wrap = document.querySelector('.preview-frame');
  for (const other of button.parentElement.children) other.classList.toggle('is-active', other === button);
  wrap.classList.toggle('is-phone', button.dataset.width !== '0');
  fitPreview();
}

function toggleNote(button) {
  const row = button.closest('.tweak-row');
  const open = row.classList.toggle('is-open');
  button.setAttribute('aria-expanded', open ? 'true' : 'false');
}

const FLASH_KEY = 'clp-panel-tweaks-flash';

function reloadWith(message, kind) {
  try { sessionStorage.setItem(FLASH_KEY, JSON.stringify({ message: message, kind: kind })); } catch (e) {}
  location.reload();
}

(function showCarriedFlash() {
  let carried = null;
  try {
    carried = sessionStorage.getItem(FLASH_KEY);
    if (carried) sessionStorage.removeItem(FLASH_KEY);
  } catch (e) { return; }
  if (!carried) return;
  try {
    const flash = JSON.parse(carried);
    notify(flash.message, flash.kind);
  } catch (e) {}
})();
`;

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
  nested?: boolean;
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
    title: "Search, sort and extra columns on Sites",
    description: "Adds a site count, search, application filter and sortable extra columns. Column choices are saved per browser.",
  },
  {
    key: "diskUsage",
    category: "Sites",
    title: "Measured site sizes",
    description: "Adds site sizes from a low-priority scan every 15 minutes. This can add load on busy servers.",
    nested: true,
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

function switchRow(copy: TweakCopy, on: boolean, extra = ""): string {
  const note = `tweak-note-${copy.key}`;
  return `
      <div class="tweak-row${copy.nested ? " is-nested" : ""}${on ? " is-enabled" : ""}">
        <div>
          <h3>${esc(copy.title)}<button class="tweak-more" type="button" aria-expanded="false"
            aria-controls="${note}" aria-label="What ${esc(copy.title.toLowerCase())} does"
            onclick="toggleNote(this)"></button></h3>
          <div class="tweak-note" id="${note}"><p>${esc(copy.description)}</p>${extra}</div>
        </div>
        <label class="switch" title="${esc(copy.title)}">
          <input type="checkbox" data-tweak="${esc(copy.key)}" onchange="setTweak(this)"${on ? " checked" : ""}
            aria-label="${esc(copy.title)}">
          <span></span>
        </label>
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
  return (["Sites", "Dashboard", "Login"] as const).map((category) => `
        <section class="tweak-category" aria-labelledby="tweak-category-${category.toLowerCase()}">
          <h3 class="tweak-category-title" id="tweak-category-${category.toLowerCase()}">${category}</h3>${COPY
            .filter((copy) => copy.category === category)
            .map((copy) => switchRow(copy, state.tweaks[copy.key], copy.key === "diskUsage" ? scanControls(state) : ""))
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
    <div class="card">
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
