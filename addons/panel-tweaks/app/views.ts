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
.tweak-list > .tweak-row:first-child { padding-top: 0; border-top: 0; }
.tweak-list > .tweak-row:last-child { padding-bottom: 0; }
.tweak-row h3 { margin: 0 0 6px; font-size: 16px; }
.tweak-row p { margin: 0; color: var(--muted); font-size: 14px; }
.tweak-row .switch { flex: 0 0 auto; margin-top: 4px; }
/* A phone gets the titles and the switches, with the wording a tap away. The
   button is display: none above that, so nothing can focus a control that
   would do nothing. */
.tweak-more { display: none; }
@media (max-width: 760px) {
  .tweak-row h3 { margin: 0; display: flex; align-items: center; gap: 2px; }
  .tweak-row .tweak-note { display: none; margin-top: 8px; }
  .tweak-row.is-open .tweak-note { display: block; }
  .tweak-more { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px;
    margin: -6px 0 -6px 2px; padding: 0; border: 0; border-radius: 50%; background: none; color: var(--muted);
    font-size: 13px; line-height: 1; cursor: pointer; }
  .tweak-more:hover { color: var(--text); }
  .tweak-row.is-open .tweak-more { transform: rotate(180deg); }
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
  /* Let the panel preview use the whole phone width instead of nesting it
     inside both the page and card gutters. */
  .preview-frame { margin-right: calc(-25px - 13px); margin-left: calc(-25px - 13px);
    border-right: 0; border-left: 0; border-radius: 0; }
}
.scan-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
.scan-row p { margin: 0; }
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
    reloadWith('Saved.', 'ok');
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
  title: string;
  description: string;
}

/**
 * What each switch does, said in terms of what the operator will see change.
 * The order is the order of cost: the Sites page, then the rest of the panel,
 * then the whole disk.
 */
const COPY: TweakCopy[] = [
  {
    key: "sitesTable",
    title: "Search, sort and extra columns on Sites",
    description: "Adds a site count, search, application filter and sortable extra columns. Column choices are saved per browser.",
  },
  {
    key: "sitesMobile",
    title: "Sites list as cards on a phone",
    description: "Turns the Sites table into readable cards below 860px. Switch it off to keep CloudPanel's sideways-scrolling table.",
  },
  {
    key: "actionMenu",
    title: "Row actions in a menu",
    description: "Moves each site's Manage and addon links into one menu.",
  },
  {
    key: "panelMobile",
    title: "CloudPanel mobile layout",
    description: "Fits CloudPanel's header and Dashboard charts to phone screens.",
  },
  {
    key: "deviceTheme",
    title: "Device theme on first visit",
    description: "Uses the device's theme on the first visit. Afterward, CloudPanel's theme switch takes over.",
  },
  {
    key: "diskUsage",
    title: "Measured site sizes",
    description: "Adds site sizes from a low-priority scan every 15 minutes. This can add load on busy servers.",
  },
];

function switchRow(copy: TweakCopy, on: boolean): string {
  const note = `tweak-note-${copy.key}`;
  return `
      <div class="tweak-row">
        <div>
          <h3>${esc(copy.title)}<button class="tweak-more" type="button" aria-expanded="false"
            aria-controls="${note}" aria-label="What ${esc(copy.title.toLowerCase())} does"
            onclick="toggleNote(this)">&#9662;</button></h3>
          <p class="tweak-note" id="${note}">${esc(copy.description)}</p>
        </div>
        <label class="switch" title="${esc(copy.title)}">
          <input type="checkbox" data-tweak="${esc(copy.key)}" onchange="setTweak(this)"${on ? " checked" : ""}
            aria-label="${esc(copy.title)}">
          <span></span>
        </label>
      </div>`;
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

function diskCard(state: PanelTweaksState): string {
  if (!state.tweaks.diskUsage) return "";
  const measured = state.sites.filter((site) => site.disk).length;
  return `
    <div class="card">
      <div class="card-header"><h2>Measured sizes</h2></div>
      <div class="scan-row">
        <p>${measured === 0
          ? "Nothing measured yet. The first sweep runs with the next repair, within fifteen minutes."
          : `${measured} of ${state.sites.length} site${state.sites.length === 1 ? "" : "s"} measured, ${esc(sinceText(state.diskMeasuredAt))}.`}</p>
        <button class="btn" type="button" onclick="measureNow(this)">Measure now</button>
      </div>
    </div>`;
}

export function dashboardView(state: PanelTweaksState): string {
  return `
    <div class="page-heading">
      <div>
        <h1>Panel Tweaks</h1>
        <p>Additions to CloudPanel's own pages. Each one can be switched off on its own.</p>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><h2>What it adds</h2></div>
      <div class="tweak-list">${COPY.map((copy) => switchRow(copy, state.tweaks[copy.key])).join("")}
      </div>
    </div>${diskCard(state)}${previewCard(state)}`;
}
