import { PHP_GUARD_INI_NAME } from "../../../cli/paths";
import { esc } from "../../../lib/app-http";
import { TWEAK_ROW_JS, TWEAK_ROW_STYLE, renderLayout, sinceText } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { SystemTweaksState } from "../action";
import type { CoverageRow, LastRun, UpdateSettings, UpdatesStatus } from "../updates";
import type { FpmUploadProgress } from "../upload-progress";
import type { PanelPhpChoice, PanelPhpStatus } from "../panel-php";

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

const DAY_MS = 86_400_000;
/** How long a required reboot may wait, with automatic reboot off, before the page says so. */
const REBOOT_OVERDUE_DAYS = 7;

interface Row {
  key: string;
  title: string;
  description: string;
  /** The switch's state; a row with `control` instead has none. */
  checked?: boolean;
  disabled?: boolean;
  onchange?: string;
  /** What sits where the switch would, such as a select. */
  control?: string;
  nested?: boolean;
  extra?: string;
}

function settingRow(row: Row): string {
  const note = `tweak-note-${row.key}`;
  const control = row.control ?? `
            <label class="switch" title="${esc(row.title)}">
              <input type="checkbox" data-setting="${esc(row.key)}" onchange="${row.onchange}"${row.checked ? " checked" : ""}
                ${row.disabled ? "disabled " : ""}aria-label="${esc(row.title)}">
              <span></span>
            </label>`;
  return `
      <div class="tweak-row${row.nested ? " is-nested" : ""}">
        <div class="tweak-body">
          <div class="tweak-heading">
            <h3>${esc(row.title)}<button class="tweak-more" type="button" aria-expanded="false"
              aria-controls="${note}" aria-label="What ${esc(row.title.toLowerCase())} does"
              onclick="toggleNote(this)"></button></h3>${control}
          </div>
          <div class="tweak-note" id="${note}"><p>${esc(row.description)}</p></div>${row.extra ?? ""}
        </div>
      </div>`;
}

function warning(text: string): string {
  return `<p class="notice st-inline-notice">${text}</p>`;
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
    return `${badge("On", "ok")} <span>Configured outside System Tweaks${where}.${next}</span>`;
  }
  if (!status.managed) return `${badge("Off", "plain")}`;
  const why = status.overriddenBy
    ? `${esc(status.overriddenBy)} turns it off again after System Tweaks' file.`
    : status.timer.state !== "enabled"
      ? `apt-daily-upgrade.timer is ${esc(status.timer.state)}.`
      : "apt does not run it.";
  return `${badge("Off", "warn")} <span>${why}</span>`;
}

/** Updates that run but leave CloudPanel's PHP to a manual apt upgrade. */
function phpGapWarning(status: UpdatesStatus): string {
  const php = status.coverage.find((row) => row.name === "CloudPanel PHP");
  if (!status.enabled || !php || php.covered === "all") return "";
  return warning(status.managed
    ? "apt's configuration leaves CloudPanel's PHP out of automatic updates, so its security fixes wait for apt upgrade."
    : "Automatic updates skip CloudPanel's PHP, so its security fixes wait for apt upgrade. Switch on Install updates automatically to add it.");
}

function rebootTiming(status: UpdatesStatus, settings: UpdateSettings): string {
  const at = settings.rebootTime !== "now";
  const effective = status.rebootTime || "now";
  const overridden = effective !== settings.rebootTime
    ? `<p class="hint">Another apt file sets it to ${/^\+\d+$/.test(effective) ? `${esc(effective.slice(1))} minutes after the run`
      : effective === "now" ? "right after the run" : esc(effective)}, and wins.</p>`
    : "";
  return `
          <div class="st-reboot-time">
            <select id="reboot-mode" aria-label="When to reboot" onchange="setRebootTime(this)">
              <option value="now"${at ? "" : " selected"}>Right after the update run</option>
              <option value="time"${at ? " selected" : ""}>At a set time</option>
            </select>
            <input type="time" id="reboot-time" aria-label="Reboot time" value="${esc(at ? settings.rebootTime : "03:00")}"${at ? "" : " hidden"} onchange="setRebootTime(this)">
            <span class="hint">${esc(status.timezone)}</span>
          </div>${overridden}`;
}

function updateRows(status: UpdatesStatus, settings: UpdateSettings): string {
  const install = status.installed ? "" : `
          <div class="st-install"><button class="btn" type="button" onclick="installUpdates(this)">Install unattended-upgrades</button></div>`;
  const lists = status.enabled && !status.listsUpdated
    ? warning("Package lists are not refreshed automatically, so it only installs updates something else downloaded.")
    : "";
  const main = settingRow({
    key: "enabled",
    title: "Install updates automatically",
    description: "Once a day, with the distro's unattended-upgrades: its security updates and every PHP version CloudPanel ships.",
    checked: status.managed,
    disabled: !status.installed,
    onchange: "setUpdates(this)",
    extra: `<p class="st-status" id="updates-status">${updatesLine(status)}</p>${phpGapWarning(status)}${lists}${install}`,
  });
  if (!status.installed || !status.managed) return main;
  const nested = (key: "nginx" | "database" | "panel" | "reboot", title: string, description: string, extra = "") =>
    settingRow({ key, title, description, checked: settings[key], onchange: "setUpdates(this)", nested: true, extra });
  return main + [
    nested("nginx", "Nginx", "CloudPanel's Nginx build. An update reloads it without dropping connections."),
    nested("database", "MySQL", "CloudPanel's database server. An update restarts it, so sites lose their database for a moment."),
    nested("panel", "CloudPanel", "The panel itself, which clp-update normally updates."),
    nested("reboot", "Reboot when required", "Restarts the server when an update such as a kernel needs it.",
      settings.reboot ? rebootTiming(status, settings) : ""),
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
  if (run.outcome === "failed") return `${at}: ${/\b404\s+Not Found\b/i.test(run.message)
    ? "A package download failed (HTTP 404)." : "Failed. See the details below."}`;
  return `${at}: no result logged yet.`;
}

function statusList(status: UpdatesStatus, now: number): string {
  if (!status.installed) return "";
  const required = status.rebootRequired;
  const failure = status.lastRun?.outcome === "failed"
    ? `<details class="st-run-details"><summary>Failure details</summary><pre>${esc(status.lastRun.message)}</pre></details>` : "";
  const overdue = required && !status.reboot && now - Date.parse(required.since) > REBOOT_OVERDUE_DAYS * DAY_MS
    ? warning(`A reboot has been needed since ${esc(required.since.slice(0, 10))} and automatic reboot is off, so the server still runs the old ${
      required.packages.some((name) => name.startsWith("linux-")) ? "kernel" : "code"}. Restart it, or switch on Reboot when required.`)
    : "";
  return `
      <dl class="kv st-kv">
        <dt>Last run</dt><dd>${esc(lastRunText(status.lastRun))}${failure}</dd>${required ? `
        <dt>Reboot</dt><dd>${badge("Required", "warn")} since ${esc(required.since.slice(0, 10))}${required.packages.length
          ? ` for ${esc(required.packages.join(", "))}` : ""}.</dd>` : ""}
      </dl>${overdue}`;
}

function coverageBadge(row: CoverageRow): string {
  if (row.covered === "all") return badge("Covered", "ok");
  if (row.covered === "some") return badge("Partly", "warn");
  return badge("Not covered", "plain");
}

/** A name with its detail beneath, and its state at the end of the row. */
function stateRow(name: string, detail: string, state: string): string {
  const shown = detail && detail.toLowerCase() !== name.toLowerCase();
  return `
          <tr><td><span class="st-name">${esc(name)}</span>${shown ? `<span class="hint st-detail">${esc(detail)}</span>` : ""}</td>
            <td class="st-state">${state}</td></tr>`;
}

/** Where updates come from, folded to a count. */
function coverageDetails(status: UpdatesStatus): string {
  if (!status.installed) return "";
  if (!status.coverage.length) return `<p class="hint st-fold">apt lists no repositories.</p>`;
  const covered = status.coverage.filter((row) => row.covered !== "none").length;
  const summary = status.enabled
    ? `Repositories: ${covered} of ${status.coverage.length} covered`
    : `Repositories: none covered while updates are off`;
  return `
      <details class="st-fold">
        <summary>${summary}</summary>
        <p class="hint">As apt reads its configuration now${status.enabled ? "" : ", once updates are on"}. A repository that is not covered still needs apt upgrade.</p>
        <div class="table-scroll"><table class="st-table"><thead><tr><th>Repository</th><th class="st-state">Updates</th></tr></thead>
          <tbody>${status.coverage.map((row) => stateRow(row.name, row.detail, coverageBadge(row))).join("")}</tbody></table></div>
      </details>`;
}

/** Who decided the value, and any pool that turns it back on. */
function uploadProgressSource(row: FpmUploadProgress): string {
  const file = row.source.includes("/conf.d/") ? row.source.slice(row.source.lastIndexOf("/") + 1) : row.source;
  const pools = row.poolsOn.length ? ` On in pool${row.poolsOn.length === 1 ? "" : "s"} ${row.poolsOn.join(", ")}.` : "";
  if (!row.enabled && row.setBy === "clp-addons") return `Set by clp-addons${row.offWithoutGuard ? " and your own config" : ""}.${pools}`;
  if (!row.enabled) return `Set by your config in ${file}.${pools}`;
  return `${row.setBy === "default" ? "PHP's default" : `Set in ${file}`}.${pools}`;
}

/** Each PHP-FPM's upload progress, folded to what needs a look. */
function uploadProgressDetails(fpms: FpmUploadProgress[]): string {
  if (!fpms.length) return `<p class="st-status hint">No PHP-FPM is installed.</p>`;
  const on = fpms.filter((row) => row.enabled).length;
  const pools = fpms.reduce((total, row) => total + row.poolsOn.length, 0);
  const summary = on === 0 ? `Off on all ${fpms.length} PHP-FPMs` : `On in ${on} of ${fpms.length} PHP-FPMs`;
  const poolText = pools ? `, on again in ${pools} pool${pools === 1 ? "" : "s"}` : "";
  return `
          <details class="st-fold">
            <summary>${badge(on || pools ? "Check" : "Off", on || pools ? "warn" : "ok")} ${summary}${poolText}</summary>
            <div class="table-scroll"><table class="st-table"><thead><tr><th>PHP-FPM</th><th class="st-state">Upload progress</th></tr></thead>
              <tbody>${fpms.map((row) => stateRow(row.label, uploadProgressSource(row), row.enabled ? badge("On", "bad") : badge("Off", "ok"))).join("")}</tbody></table></div>
          </details>`;
}

function phpOption(choice: PanelPhpChoice, stock: string | null, selected: boolean): string {
  const release = choice.installed ? ` (${choice.installed})` : "";
  const label = `PHP ${choice.version}${release}${choice.version === stock ? ", CloudPanel's own" : ""}`;
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

export function panelPhpRow(status: PanelPhpStatus | { error: string }): string {
  const description = "Runs CloudPanel's pages, phpMyAdmin and the File Manager. CloudPanel has not tested newer versions, so a change is undone if the login page or File Manager stops answering.";
  if ("error" in status) {
    return settingRow({ key: "panelPhp", title: "Panel PHP", description, control: "",
      extra: `<div class="alert st-alert" role="alert">${esc(status.error)}</div>` });
  }
  if (status.stock === null) {
    return settingRow({ key: "panelPhp", title: "Panel PHP", description, control: "",
      extra: `<p class="st-status hint">CloudPanel's PHP-FPM unit is not one this addon recognises, so the panel keeps the PHP CloudPanel chose.</p>` });
  }
  const select = `
            <select id="panel-php" aria-label="Panel PHP" data-current="${esc(status.wanted)}" onchange="setPanelPhp(this)"${status.overriddenBy ? " disabled" : ""}>${status.choices
    .map((choice) => phpOption(choice, status.stock, (status.wanted || status.stock) === choice.version)).join("")}${
    status.wanted && !status.choices.some((choice) => choice.version === status.wanted)
      ? `<option value="${esc(status.wanted)}" selected disabled>PHP ${esc(status.wanted)} (unavailable)</option>` : ""}</select>`;
  const newer = status.choices.some((choice) => choice.version !== status.stock);
  const eol = status.stock === "8.1" && !status.wanted && !status.overriddenBy
    ? warning(newer
      ? "The panel runs on PHP 8.1, which no longer gets security fixes. Choose a newer PHP above."
      : "The panel runs on PHP 8.1, which no longer gets security fixes. Install a newer PHP-FPM to choose it here.")
    : "";
  return settingRow({
    key: "panelPhp", title: "Panel PHP", description, control: select,
    extra: `<p class="st-status hint" id="panel-php-status">${esc(panelPhpLine(status))}</p>${eol}`,
  });
}

function realIpLine(state: SystemTweaksState["realIp"]): string {
  if (state.problem) return `${badge("Unknown", "warn")} <span>${esc(state.problem)}</span>`;
  if (!state.trustsAnyAddress) return `${badge("Blocked", "ok")} <span>Only local and private-network proxies can set the visitor IP.</span>`;
  return `${badge("Trusted", state.blockForged ? "warn" : "plain")} <span>Any client can set its own IP with a header.${
    state.blockForged ? " Run clp-addons repair." : ""}</span>`;
}

function settingsCard(state: SystemTweaksState): string {
  return `
    <div class="card">
      <div class="card-header"><h2>Settings</h2></div>
      <div class="tweak-list">${panelPhpRow(state.panelPhp)}${settingRow({
        key: "uploadProgressGuard",
        title: "PHP upload-progress mitigation",
        description: `Turns PHP's session upload progress, a route into CVE-2026-109619, off on every PHP-FPM with ${PHP_GUARD_INI_NAME}. Off removes only that file.`,
        checked: state.uploadProgress.guard,
        onchange: "setUploadGuard(this)",
        extra: uploadProgressDetails(state.uploadProgress.fpms),
      })}${settingRow({
        key: "blockForgedRealIp",
        title: "Block forged visitor IPs",
        description: "Stops any client from naming its own IP with a header to PHP, logs, basic auth and Cloudflare-only access. Local proxies stay trusted, and the panel also trusts Cloudflare. Switch it off only behind another public proxy.",
        checked: state.realIp.blockForged,
        onchange: "setRealIp(this)",
        extra: `<p class="st-status">${realIpLine(state.realIp)}</p>`,
      })}
      </div>
    </div>`;
}

export function dashboardView(state: SystemTweaksState, now = Date.now()): string {
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
      </div>${statusList(state.updates, now)}${coverageDetails(state.updates)}
    </div>${settingsCard(state)}`;
}
