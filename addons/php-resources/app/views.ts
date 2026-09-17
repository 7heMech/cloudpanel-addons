import { esc, escJs } from "../../../lib/app-http";
import { renderFragment, renderLayout } from "../../../lib/app-ui";
import type { EmbedFragment } from "../../../lib/shadow-embed";
import { mountPath } from "../../../lib/mount";
import type { SiteContext } from "../../../lib/site-context";
import { PM_MODES, STOCK_PROFILE, type PhpResourcesState, type PoolProfile, type PoolSiteState } from "../action";

const BASE = mountPath("php-resources");

// Cards, switches, the form grid, the confirmation dialog and the inline notice
// are in lib/app-ui; only what this addon alone draws is here.
const STYLE = `
.policy-head { display:flex; justify-content:space-between; align-items:flex-start; gap:24px; }
.policy-head h2 { margin:0 0 8px; }
.policy-head p { margin:0; }
.policy-head .hint { margin-top:8px; }
#default-fields { margin-top:25px; padding-top:25px; border-top:1px solid var(--border); }
.fleet-site { font-weight:600; }
.fleet-site a { overflow-wrap:anywhere; }
.numeric { text-align:right; font-variant-numeric:tabular-nums; }
.pool-path { font-family:var(--mono); font-size:13px; overflow-wrap:anywhere; }
.state-managed { color:var(--accent); border-color:var(--accent); }
.state-stock { color:var(--muted); }
.state-drifted { color:var(--warn); border-color:var(--warn); }
@media (max-width:700px) {
  .policy-head { flex-direction:column; gap:12px; }
}
`;

interface Field {
  key: keyof PoolProfile;
  label: string;
  hint: string;
  /** The process manager modes php-fpm reads this directive under. */
  modes: readonly string[];
}

const ALL_MODES = PM_MODES;

/**
 * One description of every editable directive, used by both forms and by the
 * table's column headings. The `modes` list is the same one the action writes
 * by: a field the mode does not use is hidden rather than removed, so switching
 * the mode back finds the number that was typed still there.
 */
const FIELDS: Field[] = [
  {
    key: "maxChildren",
    label: "Max children",
    hint: "The most PHP workers this site may run at once. Each one holds its own memory.",
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

/**
 * The editable half of a profile, for one scope: `site` or `default`.
 *
 * The saved values ride along in `data-baseline` so the page can tell an
 * untouched form from an edited one without asking the server again -- which is
 * what lets Save say "nothing to change" rather than rewrite the pool file and
 * reload php-fpm for no reason.
 */
function profileForm(scope: string, profile: PoolProfile): string {
  const modeOptions = ALL_MODES
    .map((mode) => `<option value="${esc(mode)}" ${profile.pm === mode ? "selected" : ""}>${esc(pmLabel(mode))}</option>`)
    .join("");
  const fields = FIELDS.map((field) => {
    const id = `${scope}-${field.key}`;
    const hidden = field.modes.includes(profile.pm) ? "" : " hidden";
    return `<div class="form-field" data-modes="${esc(field.modes.join(" "))}"${hidden}>
      <label for="${esc(id)}">${esc(field.label)}</label>
      <input id="${esc(id)}" data-field="${esc(field.key)}" type="number" inputmode="numeric" step="1" min="0" value="${esc(profile[field.key])}">
      <div class="hint">${esc(field.hint)}</div>
    </div>`;
  }).join("");
  return `<div id="${esc(scope)}-profile" data-profile-scope="${esc(scope)}" data-baseline="${esc(JSON.stringify(profile))}">
    <div class="form-grid">
      <div class="form-field form-field-full">
        <label for="${esc(scope)}-pm">Process manager</label>
        <select id="${esc(scope)}-pm" data-field="pm" onchange="paintProfileModes('${escJs(scope)}')">${modeOptions}</select>
        <div class="hint">On demand starts a worker per request and stops it when idle. Dynamic keeps a pool warm. Static keeps every worker running.</div>
      </div>
      ${fields}
    </div>
  </div>`;
}

export const CLIENT_JS = `
const PROFILE_KEYS = ${JSON.stringify(["pm", ...FIELDS.map((field) => field.key)])};

function profileRoot(scope) {
  return CLP_ROOT.getElementById(scope + '-profile');
}

/** Show only the directives the chosen process manager actually reads. */
function paintProfileModes(scope) {
  const root = profileRoot(scope);
  if (!root) return;
  const mode = root.querySelector('[data-field="pm"]').value;
  root.querySelectorAll('[data-modes]').forEach(function (field) {
    field.hidden = field.dataset.modes.split(' ').indexOf(mode) === -1;
  });
}

// Reads the form, or reports the first field that is not a whole number and
// returns null. The server checks all of this again; refusing here is only so
// an obvious slip does not cost a round trip.
function readProfile(scope) {
  const root = profileRoot(scope);
  if (!root) return null;
  const profile = {};
  let bad = '';
  root.querySelectorAll('[data-field]').forEach(function (input) {
    const key = input.dataset.field;
    if (key === 'pm') { profile.pm = input.value; return; }
    const raw = input.value.trim();
    if (!/^[0-9]+$/.test(raw)) {
      if (!bad) bad = (CLP_ROOT.querySelector('label[for="' + input.id + '"]') || {}).textContent || key;
      return;
    }
    profile[key] = Number(raw);
  });
  if (bad) {
    notify(bad + ' must be a whole number.', 'error');
    return null;
  }
  return profile;
}

function baselineProfile(scope) {
  const root = profileRoot(scope);
  try { return JSON.parse(root.dataset.baseline); } catch (e) { return null; }
}

function setBaseline(scope, profile) {
  const root = profileRoot(scope);
  if (root) root.dataset.baseline = JSON.stringify(profile);
}

function sameProfile(a, b) {
  if (!a || !b) return false;
  return PROFILE_KEYS.every(function (key) { return a[key] === b[key]; });
}

/** Fields the chosen mode does not use cannot make two profiles differ. */
function effectiveProfile(profile) {
  if (!profile) return profile;
  const copy = Object.assign({}, profile);
  if (profile.pm !== 'dynamic') { copy.startServers = 0; copy.minSpareServers = 0; copy.maxSpareServers = 0; }
  if (profile.pm !== 'ondemand') { copy.processIdleTimeout = 0; }
  return copy;
}

async function saveSiteResources(domain) {
  const profile = readProfile('site');
  if (!profile) return;
  if (sameProfile(effectiveProfile(profile), effectiveProfile(baselineProfile('site')))) {
    notify('These are already the limits this site has; nothing to change.', 'ok');
    return;
  }
  clearNotice();
  busy(true);
  try {
    const reply = await call('/api/sites/' + encodeURIComponent(domain), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: profile }),
    });
    paintSiteState(reply.data);
    notify('Saved. PHP-FPM reloaded, so requests already running were not interrupted.', 'ok');
  } catch (error) {
    notify('Could not save the PHP limits: ' + error.message, 'error');
  } finally {
    busy(false);
  }
}

async function resetSiteResources(domain) {
  const accepted = await confirmAction({
    title: 'Restore the CloudPanel limits for ' + domain + '?',
    text: 'The limits saved here are discarded and the pool goes back to what CloudPanel writes for a new site.',
    details: [
      'On demand, 250 max children, 100 requests per worker, a 7200 second request timeout.',
      'New sites keep following the default set on the PHP resources page.',
    ],
    confirmLabel: 'Restore',
    danger: true,
  });
  if (!accepted) return;
  clearNotice();
  busy(true);
  try {
    const reply = await call('/api/sites/' + encodeURIComponent(domain), { method: 'DELETE' });
    paintSiteState(reply.data);
    notify('The CloudPanel limits are back.', 'ok');
  } catch (error) {
    notify('Could not restore the limits: ' + error.message, 'error');
  } finally {
    busy(false);
  }
}

// Repaint from what the server answered rather than from what was asked for:
// the saved profile, the managed badge and the drift notice all come back in
// the same reply.
function paintSiteState(state) {
  if (!state) return;
  setBaseline('site', state.current);
  const root = profileRoot('site');
  if (root) {
    root.querySelectorAll('[data-field]').forEach(function (input) {
      input.value = state.current[input.dataset.field];
    });
    paintProfileModes('site');
  }
  const badge = CLP_ROOT.getElementById('managed-state');
  if (badge) {
    badge.textContent = state.managed ? 'Managed here' : 'CloudPanel values';
    badge.className = 'badge ' + (state.managed ? 'state-managed' : 'state-stock');
  }
  const drift = CLP_ROOT.getElementById('drift-notice');
  if (drift) drift.hidden = !state.drifted;
}

async function sendDefault(profile, message) {
  clearNotice();
  busy(true);
  try {
    await call('/api/default', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: profile }),
    });
    if (profile) setBaseline('default', profile);
    notify(message, 'ok');
    return true;
  } catch (error) {
    notify('Could not save the default: ' + error.message, 'error');
    return false;
  } finally {
    busy(false);
  }
}

function paintDefaultFields(on) {
  const fields = CLP_ROOT.getElementById('default-fields');
  if (fields) fields.hidden = !on;
  const state = CLP_ROOT.getElementById('default-state');
  if (state) state.textContent = on ? 'On' : 'Off';
}

async function toggleDefaultPolicy(on) {
  if (on) {
    const profile = readProfile('default');
    if (!profile) { CLP_ROOT.getElementById('default-policy').checked = false; return; }
    paintDefaultFields(true);
    const saved = await sendDefault(profile, 'New sites will start with these limits. Sites that already exist are unchanged.');
    if (!saved) { CLP_ROOT.getElementById('default-policy').checked = false; paintDefaultFields(false); }
    return;
  }
  paintDefaultFields(false);
  const saved = await sendDefault(null, 'New sites will keep the CloudPanel limits. Sites that already exist are unchanged.');
  if (!saved) { CLP_ROOT.getElementById('default-policy').checked = true; paintDefaultFields(true); }
}

async function saveDefaultProfile() {
  const profile = readProfile('default');
  if (!profile) return;
  if (sameProfile(effectiveProfile(profile), effectiveProfile(baselineProfile('default')))) {
    notify('These are already the saved defaults; nothing to change.', 'ok');
    return;
  }
  await sendDefault(profile, 'Saved. A site created from now on starts with these limits.');
}
`;

export function layout(
  title: string,
  content: string,
  updateNotice?: { current: string; latest: string } | null,
  site?: SiteContext,
): string {
  return renderLayout(title, content, {
    brand: "PHP Resources",
    // No tab strip of its own: the fleet page and the site page are reached
    // from the Addons list and from CloudPanel's site tabs respectively.
    base: BASE,
    nav: [],
    css: STYLE,
    script: CLIENT_JS,
    updateNotice,
    ...(site ? { site: { ...site, activeSlug: "php-resources" } } : {}),
  });
}

/**
 * The same page as `layout`, as a fragment for mounting inside CloudPanel's own
 * site page. No site context: the panel is already drawing it.
 */
export function fragment(title: string, content: string): EmbedFragment {
  return renderFragment(title, content, {
    brand: "PHP Resources",
    base: BASE,
    nav: [],
    css: STYLE,
    script: CLIENT_JS,
  });
}

function managedBadge(site: PoolSiteState): string {
  return site.managed
    ? '<span class="badge state-managed" id="managed-state">Managed here</span>'
    : '<span class="badge state-stock" id="managed-state">CloudPanel values</span>';
}

export function dashboardView(state: PhpResourcesState): string {
  const on = state.default !== null;
  const profile = state.default ?? STOCK_PROFILE;
  const managed = state.sites.filter((site) => site.managed !== null).length;
  const drifted = state.sites.filter((site) => site.drifted).length;

  const rows = state.sites.map((site) => `<tr>
    <td class="fleet-site"><a href="${BASE}?domain=${encodeURIComponent(site.domain)}">${esc(site.domain)}</a>${
      site.drifted ? '<div class="hint">The pool file no longer matches what was saved here.</div>' : ""
    }</td>
    <td>${esc(site.phpVersion)}</td>
    <td>${esc(pmLabel(site.current.pm))}</td>
    <td class="numeric">${esc(site.current.maxChildren)}</td>
    <td class="numeric">${esc(site.current.maxRequests)}</td>
    <td>${
      site.drifted
        ? '<span class="badge state-drifted">Drifted</span>'
        : site.managed
          ? '<span class="badge state-managed">Managed here</span>'
          : '<span class="badge state-stock">CloudPanel values</span>'
    }</td>
  </tr>`).join("");

  return `<div class="page-heading"><div><h1>PHP resources</h1>
    <p>Set how many PHP-FPM workers a site may run, and what a new site starts with.</p></div></div>
  <div class="card stats">
    <div class="stat"><div class="label">PHP sites</div><div class="value">${state.sites.length}</div></div>
    <div class="stat"><div class="label">Managed here</div><div class="value">${managed}</div></div>
    <div class="stat"><div class="label">Drifted</div><div class="value">${drifted}</div></div>
  </div>
  <div class="card">
    <div class="policy-head">
      <div>
        <h2>Defaults for new sites</h2>
        <p>A PHP site created from now on starts with these limits instead of CloudPanel's.</p>
        <p class="hint">Sites that already exist are never changed by this. A new site is picked up within about fifteen minutes of being created.</p>
      </div>
      <label class="switch-field" for="default-policy"><span class="switch-state" id="default-state">${on ? "On" : "Off"}</span>
        <span class="switch"><input type="checkbox" id="default-policy" ${on ? "checked" : ""} onchange="toggleDefaultPolicy(this.checked)"><span></span></span>
      </label>
    </div>
    <div id="default-fields"${on ? "" : " hidden"}>
      ${profileForm("default", profile)}
      <div class="form-actions"><button class="btn btn-primary" type="button" onclick="saveDefaultProfile()">Save defaults</button></div>
    </div>
  </div>
  <div class="card card-table"><div class="card-header"><h2>PHP sites</h2></div>
  ${state.sites.length
    ? `<table><thead><tr><th scope="col">Site</th><th scope="col">PHP</th><th scope="col">Process manager</th>
        <th scope="col" class="numeric">Max children</th><th scope="col" class="numeric">Max requests</th><th scope="col">Limits</th></tr></thead>
      <tbody>${rows}</tbody></table>`
    : '<div class="empty">No CloudPanel site runs PHP, so there is no PHP-FPM pool to tune.</div>'}
  </div>`;
}

export function siteView(site: PoolSiteState): string {
  return `<div class="page-heading"><div><h1>PHP resources</h1>
    <p>Process limits for this site's PHP-FPM pool, on PHP ${esc(site.phpVersion)}.</p></div>
    <div class="actions">${managedBadge(site)}<a class="btn" href="${BASE}/">All PHP sites</a></div></div>
  <div id="drift-notice" class="notice"${site.drifted ? "" : " hidden"}>This site's pool file no longer matches what was saved here, which is what happens when its PHP version changes. Saving below writes the limits again.</div>
  <div class="card">
    <div class="card-header"><div><h2>PHP-FPM pool</h2>
      <p class="hint">PHP's own memory limit, execution time and upload sizes stay on CloudPanel's Settings tab; these are the worker limits it does not show. Saving reloads PHP-FPM, so requests already running are not interrupted.</p>
    </div></div>
    ${profileForm("site", site.current)}
    <div class="form-actions">
      <button class="btn btn-danger" type="button" onclick="resetSiteResources('${escJs(site.domain)}')">Restore CloudPanel's limits</button>
      <button class="btn btn-primary" type="button" onclick="saveSiteResources('${escJs(site.domain)}')">Save limits</button>
    </div>
    <p class="hint pool-path">${esc(site.poolFile)}</p>
  </div>`;
}
