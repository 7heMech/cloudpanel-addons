import CLIENT_JS_BODY from "./views.client.js" with { type: "text" };
import { esc } from "../../../lib/app-http";
import { CARRIED_FLASH_JS, FLEET_ROW_SELECTION_JS, fleetRowSelectionStyle, renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import {
  DEFAULT_CATEGORY_PROFILE, PM_MODES, STOCK_PROFILE,
  type PhpResourcesState, type PoolCategory, type PoolProfile, type PoolSiteState,
} from "../action";

const BASE = mountPath("php-resources");

// Cards, switches, the form grid, the confirmation dialog and the inline notice
// are in lib/app-ui; only what this addon alone draws is here.
import VIEWS_CSS from "./views.css" with { type: "text" };

const STYLE = VIEWS_CSS
  .split("/* fleet-row-selection */").join(fleetRowSelectionStyle("php-sites-table"));

interface Field {
  key: keyof PoolProfile;
  label: string;
  hint: string;
  /** The process manager modes php-fpm reads this directive under. */
  modes: readonly string[];
}

const ALL_MODES = PM_MODES;

/**
 * One description of every directive, used by the category dialog and by the
 * read-only block on CloudPanel's own site page. The `modes` list is the same
 * one the action writes by: a field the mode does not use is hidden rather than
 * removed, so switching the mode back finds the number that was typed still
 * there.
 */
const FIELDS: Field[] = [
  {
    key: "maxChildren",
    label: "Max children",
    hint: "The most PHP workers a site in this category may run at once. Each one holds its own memory.",
    modes: ALL_MODES,
  },
  {
    key: "startServers",
    label: "Start servers",
    hint: "Workers started with the pool.",
    modes: ["dynamic"],
  },
  {
    key: "minSpareServers",
    label: "Min spare servers",
    hint: "Idle workers kept ready for the next request.",
    modes: ["dynamic"],
  },
  {
    key: "maxSpareServers",
    label: "Max spare servers",
    hint: "Idle workers kept before the extra ones are stopped.",
    modes: ["dynamic"],
  },
  {
    key: "processIdleTimeout",
    label: "Idle timeout (seconds)",
    hint: "Seconds an idle worker waits before it is stopped.",
    modes: ["ondemand"],
  },
  {
    key: "maxRequests",
    label: "Max requests per worker",
    hint: "Requests a worker serves before it restarts. 0 never restarts it, so a leaking extension keeps its memory.",
    modes: ALL_MODES,
  },
  {
    key: "requestTerminateTimeout",
    label: "Request timeout (seconds)",
    hint: "Seconds one request may run before its worker is killed. 0 turns the limit off.",
    modes: ALL_MODES,
  },
  {
    key: "rlimitFiles",
    label: "Open file limit",
    hint: "Files and sockets one worker may hold open.",
    modes: ALL_MODES,
  },
];

const PM_LABELS: Record<string, string> = {
  ondemand: "On demand",
  dynamic: "Dynamic",
  static: "Static",
};

export function pmLabel(mode: string): string {
  return PM_LABELS[mode] ?? mode;
}

/** How a pool's worker settings read in one table cell. */
export function workerSummary(profile: PoolProfile): string {
  if (profile.pm === "dynamic") {
    return `Dynamic, ${profile.minSpareServers}–${profile.maxSpareServers} spare, up to ${profile.maxChildren}`;
  }
  if (profile.pm === "static") return `Static, ${profile.maxChildren} always running`;
  return `On demand, up to ${profile.maxChildren}`;
}

function seconds(value: number): string {
  return value === 0 ? "Off" : `${value}s`;
}

/** The two limits that are about a single worker rather than about the pool. */
function recycleSummary(profile: PoolProfile): string {
  const recycle = profile.maxRequests === 0 ? "Workers are never recycled" : `Recycled every ${profile.maxRequests} requests`;
  return profile.requestTerminateTimeout === 0
    ? `${recycle}, no request limit`
    : `${recycle}, ${profile.requestTerminateTimeout}s request limit`;
}

const NO_CATEGORY = "No category — CloudPanel limits";

/** The editable directives of one profile, for the category dialog. */
function profileForm(profile: PoolProfile): string {
  const modeOptions = ALL_MODES
    .map((mode) => `<option value="${esc(mode)}" ${profile.pm === mode ? "selected" : ""}>${esc(pmLabel(mode))}</option>`)
    .join("");
  const fields = FIELDS.map((field) => {
    const hidden = field.modes.includes(profile.pm) ? "" : " hidden";
    return `<div class="form-field" data-modes="${esc(field.modes.join(" "))}"${hidden}>
      <label for="category-${esc(field.key)}">${esc(field.label)}</label>
      <input id="category-${esc(field.key)}" data-field="${esc(field.key)}" type="number" inputmode="numeric" step="1" min="0" value="${esc(profile[field.key])}">
      <div class="hint">${esc(field.hint)}</div>
    </div>`;
  }).join("");
  return `<div id="category-profile">
    <div class="form-grid">
      <div class="form-field form-field-full">
        <label for="category-pm">Process manager</label>
        <select id="category-pm" data-field="pm" onchange="paintProfileModes()">${modeOptions}</select>
        <div class="hint">On demand starts a worker per request and stops it when idle. Dynamic keeps a pool warm. Static keeps every worker running.</div>
      </div>
      ${fields}
    </div>
  </div>`;
}

export const CLIENT_JS = `
${FLEET_ROW_SELECTION_JS}${CARRIED_FLASH_JS}
${CLIENT_JS_BODY}`;

export function layout(
  title: string,
  content: string,
  updateNotice?: { current: string; latest: string } | null,
): string {
  return renderLayout(title, content, {
    brand: "PHP Resources",
    // No tab strip of its own: this addon has one page, reached from the
    // Addons list, and the panel's own site page only reports what it decided.
    base: BASE,
    nav: [],
    css: STYLE,
    script: CLIENT_JS,
    updateNotice,
  });
}

function categoryOptions(categories: PoolCategory[], selected: string | null): string {
  return [`<option value="">${esc(NO_CATEGORY)}</option>`]
    .concat(categories.map((category) =>
      `<option value="${esc(category.id)}"${category.id === selected ? " selected" : ""}>${esc(category.name)}</option>`))
    .join("");
}

/**
 * The bulk picker starts on nothing rather than on a real choice: the button
 * beside it acts on however many sites are ticked, and the first entry of a
 * list should not be the one that empties a category.
 */
function bulkOptions(categories: PoolCategory[]): string {
  return [`<option value="" selected disabled>Choose a category</option>`]
    .concat(categories.map((category) => `<option value="${esc(category.id)}">${esc(category.name)}</option>`))
    .concat([`<option value="none">${esc(NO_CATEGORY)}</option>`])
    .join("");
}

function categoryRow(category: PoolCategory, sites: number, isDefault: boolean): string {
  return `<tr data-category="${esc(JSON.stringify(category))}" data-sites="${sites}">
    <td class="site-cell name-cell">${esc(category.name)}${
      isDefault ? '<span class="badge state-default">Default for new sites</span>' : ""
    }${category.description ? `<div class="hint">${esc(category.description)}</div>` : ""}</td>
    <td class="limit-cell wide-cell" data-label="Limits">${esc(workerSummary(category.profile))}
      <div class="hint">${esc(recycleSummary(category.profile))}</div></td>
    <td class="numeric" data-label="Sites">${sites}</td>
    <td class="action-cell" data-label="Actions"><div class="actions">
      <button class="btn" type="button" onclick="openCategoryDialog(this)">Edit</button>
      <button class="btn btn-danger" type="button" onclick="deleteCategory(this)">Delete</button>
    </div></td>
  </tr>`;
}

function siteTableRow(site: PoolSiteState, categories: PoolCategory[]): string {
  return `<tr data-domain="${esc(site.domain)}" data-category-id="${esc(site.categoryId ?? "")}" data-drifted="${site.drifted}" tabindex="0" aria-selected="false" onclick="toggleSiteSelection(event, this, paintSelection)" onkeydown="toggleSiteSelection(event, this, paintSelection)">
    <td class="site-select"><input class="site-checkbox" type="checkbox" onchange="paintSelection()" aria-label="Select ${esc(site.domain)}"></td>
    <td class="site-cell">${esc(site.domain)}${
      site.drifted ? '<div class="hint">Its pool file no longer matches this category.</div>' : ""
    }</td>
    <td class="type-cell">PHP ${esc(site.phpVersion)}</td>
    <td data-label="Category"><select aria-label="Category for ${esc(site.domain)}" onchange="assignRow(this)">${categoryOptions(categories, site.categoryId)}</select></td>
    <td class="limit-cell wide-cell" data-label="Now running">${esc(workerSummary(site.current))}</td>
  </tr>`;
}

export function dashboardView(state: PhpResourcesState): string {
  const counts = new Map(state.categories.map((category) => [category.id, 0]));
  for (const site of state.sites) {
    if (site.categoryId) counts.set(site.categoryId, (counts.get(site.categoryId) ?? 0) + 1);
  }
  const assigned = state.sites.filter((site) => site.categoryId !== null).length;
  const drifted = state.sites.filter((site) => site.drifted).length;

  const categoryRows = state.categories
    .map((category) => categoryRow(category, counts.get(category.id) ?? 0, category.id === state.defaultCategoryId))
    .join("");
  const siteRows = state.sites.map((site) => siteTableRow(site, state.categories)).join("");

  return `<div class="page-heading">
    <div><h1>PHP resources</h1>
      <p>Put PHP sites into categories, and give each category its PHP-FPM worker limits.</p>
      <p class="hint">Limits apply to every site separately. Assigning one category to many sites multiplies its possible workers.</p></div>
    <button class="btn btn-primary" type="button" onclick="openCategoryDialog(this)">New category</button>
  </div>
  ${drifted
    ? `<div class="notice">${drifted} ${drifted === 1 ? "site no longer matches the category it is" : "sites no longer match the category they are"} in, which is what changing a PHP version leaves behind. Repair puts ${drifted === 1 ? "it" : "them"} back within fifteen minutes.
      <div class="actions notice-actions"><button class="btn" type="button" onclick="repairDrifted()">Put them back now</button></div></div>`
    : ""}
  <div class="card stats">
    <div class="stat"><div class="label">PHP sites</div><div class="value">${state.sites.length}</div></div>
    <div class="stat"><div class="label">In a category</div><div class="value">${assigned}</div></div>
    <div class="stat"><div class="label">Categories</div><div class="value">${state.categories.length}</div></div>
  </div>
  <div class="card default-card">
    <div>
      <h2>New sites</h2>
      <p>A PHP site created from now on joins this category.</p>
      <p class="hint">Sites that already exist are never moved by this. A new site is picked up within about fifteen minutes of being created.</p>
    </div>
    <div class="default-choice">
      <label class="hint" for="default-category">Category for new sites</label>
      <select id="default-category" onchange="setDefaultCategory(this)">${categoryOptions(state.categories, state.defaultCategoryId)}</select>
    </div>
  </div>
  <div class="card card-table"><div class="card-header"><h2>Categories</h2></div>
  ${state.categories.length
    ? `<table class="fleet-table"><thead><tr><th scope="col">Category</th><th scope="col">Limits</th>
        <th scope="col" class="numeric">Sites</th><th scope="col" class="action-cell">Actions</th></tr></thead>
      <tbody>${categoryRows}</tbody></table>`
    : '<div class="empty">No categories yet. Create one to give a group of sites the same PHP-FPM limits.</div>'}
  </div>
  <div class="card card-table">
  ${state.sites.length
    ? `<div class="card-header toolbar">
        <h2>PHP sites</h2>
        <span class="toolbar-note" id="site-selection">No sites selected</span>
        <button class="btn mobile-select-all" id="select-all-btn" type="button" onclick="toggleAllSites(paintSelection)">Select all</button>
        <select class="toolbar-end" id="bulk-category" aria-label="Category to put the selected sites in">${bulkOptions(state.categories)}</select>
        <button class="btn" id="assign-selected" type="button" disabled onclick="assignSelected()">Assign selected</button>
      </div>
      <table class="fleet-table php-sites-table"><thead><tr>
        <th scope="col" class="site-select"><input id="select-all" type="checkbox" onchange="selectAllSites(this.checked, paintSelection)" aria-label="Select all sites"></th>
        <th scope="col">Site</th><th scope="col">PHP</th><th scope="col">Category</th><th scope="col">Now running</th>
      </tr></thead><tbody>${siteRows}</tbody></table>`
    : '<div class="empty">No CloudPanel site runs PHP, so there is no PHP-FPM pool to tune.</div>'}
  </div>
  <dialog id="category-dialog" aria-labelledby="category-dialog-title" data-default-profile="${esc(JSON.stringify(DEFAULT_CATEGORY_PROFILE))}" onmousedown="closeCategoryDialogOnBackdrop(event)">
    <div class="dialog-header"><h2 id="category-dialog-title">New category</h2></div>
    <div class="form-grid dialog-grid">
      <div class="form-field">
        <label for="category-name">Name</label>
        <input id="category-name" type="text" maxlength="40" autocomplete="off">
        <div class="hint">What this group of sites is, such as Standard.</div>
      </div>
      <div class="form-field">
        <label for="category-description">Description</label>
        <input id="category-description" type="text" maxlength="240" autocomplete="off">
        <div class="hint">Optional. Shown beside the name, to say when to pick it.</div>
      </div>
    </div>
    ${profileForm(DEFAULT_CATEGORY_PROFILE)}
    <form method="dialog" class="actions dialog-actions">
      <button class="btn" value="cancel" type="submit">Cancel</button>
      <button class="btn btn-primary" type="button" onclick="saveCategory()">Save category</button>
    </form>
  </dialog>`;
}

/**
 * The read-only block CloudPanel's own Settings tab shows beside its PHP
 * Settings form, in the panel's own markup. Changing limits is a decision about
 * a category rather than about one site, so it happens on the addon page and
 * this only reports what the site ended up with.
 */
export function siteCardHtml(site: PoolSiteState): string {
  const rows: [string, string][] = [
    ["Category", site.categoryName ?? NO_CATEGORY],
    ["Process Manager", pmLabel(site.current.pm)],
    ["Max Children", String(site.current.maxChildren)],
  ];
  if (site.current.pm === "dynamic") {
    rows.push(
      ["Start Servers", String(site.current.startServers)],
      ["Min Spare Servers", String(site.current.minSpareServers)],
      ["Max Spare Servers", String(site.current.maxSpareServers)],
    );
  }
  if (site.current.pm === "ondemand") rows.push(["Idle Timeout", seconds(site.current.processIdleTimeout)]);
  rows.push(
    ["Max Requests per Worker", site.current.maxRequests === 0 ? "Never recycled" : String(site.current.maxRequests)],
    ["Request Timeout", seconds(site.current.requestTerminateTimeout)],
    ["Open File Limit", String(site.current.rlimitFiles)],
  );

  const cells = rows.map(([label, value]) =>
    `<div class="col-6 col-lg-4"><label class="col-form-label">${esc(label)}</label>
      <div class="clp-addon-readonly">${esc(value)}</div></div>`).join("");

  const drift = site.drifted
    ? `<div class="row"><div class="col"><div class="form-text">These are not the limits saved for this category: the PHP version changed and CloudPanel wrote the pool file again. The addon puts them back within fifteen minutes.</div></div></div>`
    : "";

  return `<div class="row">${cells}</div>${drift}`;
}
