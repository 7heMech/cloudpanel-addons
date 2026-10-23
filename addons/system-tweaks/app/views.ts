import { PHP_GUARD_INI_NAME } from "../../../cli/paths";
import { esc } from "../../../lib/app-http";
import { TWEAK_ROW_JS, TWEAK_ROW_STYLE, renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { SystemTweaksState } from "../action";
import type { CoverageRow, LastRun, UpdateSettings, UpdatesStatus } from "../updates";
import type { FpmUploadProgress } from "../upload-progress";

import STYLE from "./views.css" with { type: "text" };
import SCRIPT from "./views.client.js" with { type: "text" };

export function layout(
  title: string,
  content: string,
  updateNotice?: { current: string; latest: string } | null,
): string {
  return renderLayout(title, content, {
    brand: "System Tweaks",
    base: mountPath("system-tweaks"),
    nav: [],
    css: TWEAK_ROW_STYLE + STYLE,
    script: TWEAK_ROW_JS + SCRIPT,
    updateNotice,
  });
}

function badge(text: string, tone: "ok" | "warn" | "bad" | "plain"): string {
  const state = { ok: " state-running", warn: " state-exited", bad: " state-absent", plain: "" }[tone];
  return `<span class="badge${state}">${esc(text)}</span>`;
}

interface Row {
  key: string;
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  nested?: boolean;
  onchange: string;
  extra?: string;
}

function switchRow(row: Row): string {
  const note = `tweak-note-${row.key}`;
  return `
      <div class="tweak-row${row.nested ? " is-nested" : ""}">
        <div class="tweak-body">
          <div class="tweak-heading">
            <h3>${esc(row.title)}<button class="tweak-more" type="button" aria-expanded="false"
              aria-controls="${note}" aria-label="What ${esc(row.title.toLowerCase())} does"
              onclick="toggleNote(this)"></button></h3>
            <label class="switch" title="${esc(row.title)}">
              <input type="checkbox" data-setting="${esc(row.key)}" onchange="${row.onchange}"${row.checked ? " checked" : ""}
                ${row.disabled ? "disabled " : ""}aria-label="${esc(row.title)}">
              <span></span>
            </label>
          </div>
          <div class="tweak-note" id="${note}"><p>${esc(row.description)}</p></div>${row.extra ?? ""}
        </div>
      </div>`;
}

/** What the switch leaves on the box, said once, under it. */
function updatesLine(status: UpdatesStatus): string {
  if (!status.installed) {
    return `${badge("Not installed", "bad")} <span>unattended-upgrades, the distro's package for this, is not installed.</span>`;
  }
  if (status.enabled) {
    const next = status.timer.next ? ` Next run ${esc(status.timer.next)}.` : "";
    if (status.managed) return `${badge("On", "ok")} <span>Runs once a day.${next}</span>`;
    const where = status.outsideSource ? ` in ${esc(status.outsideSource)}` : "";
    return `${badge("On", "ok")} <span>Configured outside System Tweaks${where}.${next} Switching on here adds
      CloudPanel's PHP to what it covers; switching off again leaves your setup as it was.</span>`;
  }
  if (!status.managed) return `${badge("Off", "plain")}`;
  const why = status.overriddenBy
    ? `${esc(status.overriddenBy)} turns it off again after System Tweaks' file.`
    : status.timer.state !== "enabled"
      ? `apt-daily-upgrade.timer is ${esc(status.timer.state)}.`
      : "apt does not run it.";
  return `${badge("Off", "warn")} <span>${why}</span>`;
}

function updateRows(status: UpdatesStatus, settings: UpdateSettings): string {
  const locked = !status.installed || !status.managed;
  const install = status.installed ? "" : `
          <div class="st-install"><button class="btn" type="button" onclick="installUpdates(this)">Install unattended-upgrades</button></div>`;
  const lists = status.enabled && !status.listsUpdated
    ? `<p class="notice st-inline-notice">Package lists are not refreshed automatically, so it only installs updates something else downloaded.</p>`
    : "";
  return [
    switchRow({
      key: "enabled",
      title: "Install updates automatically",
      description: "Uses the distro's unattended-upgrades once a day. It always covers the distro's security updates and every PHP version CloudPanel ships. Switching off removes only System Tweaks' own file.",
      checked: status.managed,
      disabled: !status.installed,
      onchange: "setUpdates(this)",
      extra: `<p class="st-status" id="updates-status">${updatesLine(status)}</p>${lists}${install}`,
    }),
    switchRow({
      key: "nginx",
      title: "Nginx",
      description: "CloudPanel's Nginx build. An update reloads Nginx without dropping connections.",
      checked: settings.nginx, disabled: locked, nested: true, onchange: "setUpdates(this)",
    }),
    switchRow({
      key: "database",
      title: "MySQL",
      description: "CloudPanel's database server. An update restarts MySQL, so every site loses its database for a moment.",
      checked: settings.database, disabled: locked, nested: true, onchange: "setUpdates(this)",
    }),
    switchRow({
      key: "panel",
      title: "CloudPanel",
      description: "The panel itself, which clp-update normally updates.",
      checked: settings.panel, disabled: locked, nested: true, onchange: "setUpdates(this)",
    }),
    switchRow({
      key: "reboot",
      title: "Reboot when required",
      description: "Restarts the server right after a run that installed something needing it, such as a new kernel.",
      checked: settings.reboot, disabled: locked, nested: true, onchange: "setUpdates(this)",
    }),
  ].join("");
}

function lastRunText(run: LastRun | null): string {
  if (!run) return "No run recorded.";
  const at = run.at || "Unknown time";
  if (run.outcome === "upgraded") {
    const count = run.packages.length;
    return `${at}: installed ${count} update${count === 1 ? "" : "s"}${count ? ` (${run.packages.join(", ")})` : ""}.`;
  }
  if (run.outcome === "nothing") return `${at}: nothing to install.`;
  if (run.outcome === "failed") return `${at}: failed. ${run.message}`;
  return `${at}: no result logged yet.`;
}

function statusList(status: UpdatesStatus): string {
  if (!status.installed) return "";
  const reboot = status.rebootRequired
    ? `${badge("Required", "warn")} since ${esc(status.rebootRequired.since.slice(0, 10))}${status.rebootRequired.packages.length
      ? ` for ${esc(status.rebootRequired.packages.join(", "))}` : ""}.`
    : "Not required.";
  const automatic = status.reboot
    ? `On${status.rebootTime && status.rebootTime !== "now" ? `, at ${esc(status.rebootTime)}` : ", right after the run"}.`
    : "Off.";
  return `
      <dl class="kv st-kv">
        <dt>Last run</dt><dd>${esc(lastRunText(status.lastRun))}</dd>
        <dt>Reboot</dt><dd>${reboot}</dd>
        <dt>Automatic reboot</dt><dd>${automatic}</dd>
      </dl>`;
}

function coverageBadge(row: CoverageRow): string {
  if (row.covered === "all") return badge("Covered", "ok");
  if (row.covered === "some") return badge("Partly", "warn");
  return badge("Not covered", "plain");
}

function coverageCard(status: UpdatesStatus): string {
  if (!status.installed) return "";
  const rows = status.coverage.map((row) => `
          <tr><td><span class="st-name">${esc(row.name)}</span>${row.detail ? `<span class="hint st-detail">${esc(row.detail)}</span>` : ""}</td>
            <td class="st-state">${coverageBadge(row)}</td></tr>`).join("");
  const hint = status.enabled
    ? "Where unattended-upgrades installs from, as apt reads its configuration now."
    : "Updates are off, so nothing is installed automatically. This is what they would cover.";
  return `
    <div class="card">
      <div class="card-header"><h2>Repositories</h2></div>
      <p class="hint">${hint}</p>
      ${rows ? `<div class="table-scroll"><table class="st-table"><thead><tr><th>Repository</th><th class="st-state">Updates</th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : `<p class="hint">apt lists no repositories.</p>`}
    </div>`;
}

function uploadProgressState(row: FpmUploadProgress): string {
  const file = row.source.includes("/conf.d/") ? row.source.slice(row.source.lastIndexOf("/") + 1) : row.source;
  const pools = row.poolsOn.length ? ` On in pool${row.poolsOn.length === 1 ? "" : "s"} ${row.poolsOn.join(", ")}.` : "";
  if (!row.enabled && row.setBy === "clp-addons") {
    return `${badge("Off", "ok")} <span class="hint">by clp-addons${row.offWithoutGuard ? ", and by your own config" : ""}.${esc(pools)}</span>`;
  }
  if (!row.enabled) return `${badge("Off", "ok")} <span class="hint">by your config in ${esc(file)}.${esc(pools)}</span>`;
  return `${badge("On", "bad")} <span class="hint">${row.setBy === "default" ? "PHP's default" : `set in ${esc(file)}`}.${esc(pools)}</span>`;
}

function uploadProgressCard(state: SystemTweaksState): string {
  const rows = state.uploadProgress.fpms.map((row) => `
          <tr><td class="st-name">${esc(row.label)}</td><td>${uploadProgressState(row)}</td></tr>`).join("");
  return `
    <div class="card">
      <div class="card-header"><h2>PHP</h2></div>
      <div class="tweak-list">${switchRow({
        key: "uploadProgressGuard",
        title: "PHP upload-progress mitigation",
        description: `Turns PHP's session upload progress off on every PHP-FPM, CloudPanel's own included, with ${PHP_GUARD_INI_NAME}. It is a route into CVE-2026-109619, and PHP's advisory GHSA-6wmf-4rv5-p3rp recommends keeping it off even on patched PHP. Switching off removes only that file; a setting of your own still applies.`,
        checked: state.uploadProgress.guard,
        onchange: "setUploadGuard(this)",
      })}
      </div>
      ${rows ? `<div class="table-scroll"><table class="st-table"><thead><tr><th>PHP-FPM</th><th>Upload progress</th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : `<p class="hint">No PHP-FPM is installed.</p>`}
    </div>`;
}

export function dashboardView(state: SystemTweaksState): string {
  return `
    <div class="page-heading">
      <div>
        <h1>System Tweaks</h1>
        <p>Server-wide settings for this machine.</p>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><h2>Automatic updates</h2></div>
      <div class="tweak-list">${updateRows(state.updates, state.settings)}
      </div>${statusList(state.updates)}
    </div>${coverageCard(state.updates)}${uploadProgressCard(state)}`;
}
