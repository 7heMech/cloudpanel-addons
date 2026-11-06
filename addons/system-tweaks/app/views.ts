import { PHP_GUARD_INI_NAME } from "../../../cli/paths";
import { esc } from "../../../lib/app-http";
import { TWEAK_ROW_JS, renderLayout, sinceText } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { SystemTweaksState } from "../action";
import type { CoverageRow, LastRun, UpdateSettings, UpdatesStatus } from "../updates";
import type { FpmUploadProgress } from "../upload-progress";
import type { PanelPhpChoice, PanelPhpStatus } from "../panel-php";
import type { FirewallStatus } from "../firewall";
import { MAX_BACKUP_LEVEL } from "../backup-compression";
import { DOMAIN_JAIL, JAIL_LIMITS, PANEL_JAIL, type Ban, type SshLogin } from "../login-jails";
import type { DatabaseStatus } from "../database";
import { CONNECTION_MB, type MemoryProfile } from "../memory";

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
    css: STYLE,
    script: TWEAK_ROW_JS + SCRIPT,
    updateNotice,
  });
}

function badge(text: string, tone: "ok" | "warn" | "bad" | "plain"): string {
  const state = { ok: " tone-ok", warn: " tone-warn", bad: " tone-bad", plain: "" }[tone];
  return `<span class="badge${state}">${esc(text)}</span>`;
}

function backupCompressionCard(state: SystemTweaksState["backupCompression"]): string {
  const available = state.supported && state.installed;
  const status = state.active ? badge("On", "ok") : state.enabled ? badge("Paused", "warn") : badge("Off", "plain");
  const select = (key: "level" | "threads", count: number, label: string) => `
    <label for="backup-${key}">${label}</label>
    <select id="backup-${key}" aria-label="${label}" data-current="${state[key]}" onchange="setBackupCompression(this)"${available ? "" : " disabled"}>
      ${Array.from({ length: count }, (_, index) => index + 1).map((value) => `<option value="${value}"${value === state[key] ? " selected" : ""}>${value}</option>`).join("")}
    </select>`;
  return `<div class="card">
    <div class="card-header"><h2>Remote backups</h2></div>
    <div class="tweak-list">${settingRow({
      key: "backup-compression", title: "Compress remote backups with Zstandard",
      description: [
        "Creates backup.tar.zst for CloudPanel's Remote Backups. Higher levels can make smaller files but use more CPU time and memory. One worker thread is the default.",
        "Existing backups, database dumps, schedules, exclusions and retention stay as configured. To restore, download the archive and extract it over SSH with tar --zstd -xf backup.tar.zst in an empty directory.",
      ],
      checked: state.enabled, disabled: !available && !state.enabled, onchange: "setBackupCompression(this)",
      extra: `<p class="st-status">${status} <span>${esc(state.problem || (state.active ? "The next remote backup uses backup.tar.zst." : "CloudPanel's backup format is unchanged."))}</span></p>
        <div class="st-backup-options">${select("level", MAX_BACKUP_LEVEL, "Compression level")}${select("threads", 8, "Worker threads")}</div>
        ${state.enabled ? '<p class="hint">Restore .tar.zst archives over SSH; CloudPanel’s File Manager does not offer extraction for this format.</p>' : ""}`,
    })}</div>
  </div>`;
}

const DAY_MS = 86_400_000;
/** How long a required reboot may wait, with automatic reboot off, before the page says so. */
const REBOOT_OVERDUE_DAYS = 7;

interface Row {
  key: string;
  title: string;
  /** One paragraph, or a line each. */
  description: string | string[];
  /** The switch's state; a row with `control` instead has none. */
  checked?: boolean;
  disabled?: boolean;
  onchange?: string;
  /** What sits where the switch would, such as a select. */
  control?: string;
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
      <div class="tweak-row">
        <div class="tweak-body">
          <div class="tweak-heading">
            <h3>${esc(row.title)}<button class="tweak-more" type="button" aria-expanded="false"
              aria-controls="${note}" aria-label="What ${esc(row.title.toLowerCase())} does"
              onclick="toggleNote(this)"></button></h3>${control}
          </div>
          <div class="tweak-note" id="${note}">${[row.description].flat().map((line) => `<p>${esc(line)}</p>`).join("")}</div>${row.extra ?? ""}
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

/**
 * Updates that run but leave CloudPanel's PHP to a manual apt upgrade. Under
 * System Tweaks' own file that is a fault; under someone else's it is only
 * what the switch would add.
 */
function phpGap(status: UpdatesStatus): string {
  const php = status.coverage.find((row) => row.name === "CloudPanel PHP");
  if (!status.enabled || !php || php.covered === "all") return "";
  return status.managed
    ? warning("apt's configuration leaves CloudPanel's PHP out of automatic updates, so its security fixes wait for apt upgrade.")
    : `<p class="hint st-suggest">Switch on Install updates automatically to also get CloudPanel's PHP security updates.</p>`;
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
            <select id="reboot-mode" aria-label="When to reboot" data-current="${at ? "time" : "now"}" onchange="setRebootTime(this)">
              <option value="now"${at ? "" : " selected"}>Right after the update run</option>
              <option value="time"${at ? " selected" : ""}>At a set time</option>
            </select>
            <input type="time" id="reboot-time" aria-label="Reboot time" value="${esc(at ? settings.rebootTime : "03:00")}"
              data-current="${esc(at ? settings.rebootTime : "03:00")}"${at ? "" : " hidden"} onchange="setRebootTime(this)" onblur="flushRebootTime()">
            <span class="hint">${esc(status.timezone)}</span>
          </div>${overridden}`;
}

function updateRows(status: UpdatesStatus, settings: UpdateSettings): string {
  const install = status.installed ? "" : `
          <div class="st-install"><button class="btn" type="button" onclick="installUpdates(this)">Install unattended-upgrades</button></div>`;
  const lists = status.enabled && !status.listsUpdated
    ? warning("Package lists are not refreshed automatically, so it only installs updates something else downloaded.")
    : "";
  const option = (key: "nginx" | "database" | "panel" | "reboot", title: string, description: string, extra = "") => `
            <div class="st-option">
              <div class="st-option-row">
                <div><label for="update-${key}">${title}</label><p class="hint">${description}</p></div>
                <label class="switch"><input id="update-${key}" type="checkbox" data-setting="${key}" onchange="setUpdates(this)"${settings[key] ? " checked" : ""}><span></span></label>
              </div>${extra}
            </div>`;
  const options = status.installed && status.managed ? `
          <div class="st-options">${[
    option("nginx", "Nginx", "CloudPanel's Nginx build. An update reloads it without dropping connections."),
    option("database", "MySQL", "CloudPanel's database server. An update restarts it, so sites lose their database for a moment."),
    option("panel", "CloudPanel", "The panel itself, which clp-update normally updates."),
    option("reboot", "Reboot when required", "Restarts the server when an update such as a kernel needs it.",
      settings.reboot ? rebootTiming(status, settings) : ""),
  ].join("")}
          </div>` : "";
  return settingRow({
    key: "enabled",
    title: "Install updates automatically",
    description: "Once a day, with the distro's unattended-upgrades: its security updates and every PHP version CloudPanel ships.",
    checked: status.managed,
    disabled: !status.installed,
    onchange: "setUpdates(this)",
    extra: `<p class="st-status" id="updates-status">${updatesLine(status)}</p>${phpGap(status)}${lists}${install}${options}`,
  });
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

/** When the box restarts by itself: the next update run sees the flag and reboots, then or at its set time. */
function selfReboot(status: UpdatesStatus): string {
  if (!status.enabled || !status.reboot) return "";
  const run = `the next update run${status.timer.next ? ` (${esc(status.timer.next)})` : ""}`;
  const time = status.rebootTime || "now";
  const when = time === "now" ? `${run} restarts the server.`
    : /^\+\d+$/.test(time) ? `the server restarts ${esc(time.slice(1))} minutes after ${run}.`
    : `${run} schedules a restart for ${esc(time)} ${esc(status.timezone)}.`;
  const users = status.rebootWithUsers ? "" : " It is skipped while anyone is logged in.";
  return `<span class="hint st-detail">Automatic reboot is on: ${when}${users}</span>`;
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
          ? ` for ${esc(required.packages.join(", "))}` : ""}.${selfReboot(status)}</dd>` : ""}
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
  const covered = status.coverage.filter((row) => row.covered === "all").length;
  const partly = status.coverage.filter((row) => row.covered === "some").length;
  const summary = status.enabled
    ? `Repositories: ${covered} of ${status.coverage.length} covered${partly ? `, ${partly} partly` : ""}`
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
  const count = `${fpms.length} PHP-FPM${fpms.length === 1 ? "" : "s"}`;
  const summary = on === 0 ? `Off on ${fpms.length === 1 ? "its one PHP-FPM" : `all ${count}`}` : `On in ${on} of ${count}`;
  const poolText = pools ? `, on again in ${pools} pool${pools === 1 ? "" : "s"}` : "";
  return `
          <details class="st-fold">
            <summary>${badge(on || pools ? "Check" : "Off", on || pools ? "warn" : "ok")} ${summary}${poolText}</summary>
            <div class="table-scroll"><table class="st-table"><thead><tr><th>PHP-FPM</th><th class="st-state">Upload progress</th></tr></thead>
              <tbody>${fpms.map((row) => stateRow(row.label, uploadProgressSource(row),
                row.enabled ? badge("On", "bad") : row.poolsOn.length ? badge("Partly", "warn") : badge("Off", "ok"))).join("")}</tbody></table></div>
          </details>`;
}

function phpOption(choice: PanelPhpChoice, stock: string | null, selected: boolean): string {
  const label = `PHP ${choice.version}${choice.version === stock ? ", CloudPanel's own" : ""}`;
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

function phpMyAdminLine(state: SystemTweaksState["phpMyAdmin"]): string {
  if (state.problem) return `${badge("Unknown", "warn")} <span>${esc(state.problem)}</span>`;
  if (state.active) return `${badge("On", "ok")} <span>Basic auth covers every panel URL outside phpMyAdmin.</span>`;
  if (state.enabled) return `${badge("Not applied", "warn")} <span>Run clp-addons repair.</span>`;
  return `${badge("Off", "plain")} <span>phpMyAdmin's example sign-on script lets anyone make this server try MySQL logins on other hosts.</span>`;
}

/** Which certificate the panel serves on 8443, and the custom domain's, which the sites' Nginx serves. */
export function panelCertLine(state: SystemTweaksState["panelCert"]): string {
  const until = state.expires ? ` It expires on ${state.expires.slice(0, 10)}.` : "";
  const line = {
    shared: `${badge("Shared", state.replace ? "bad" : "warn")} <span>The panel uses CloudPanel's default certificate, whose private key is public.${
      state.replace ? " Run clp-addons repair." : ""}</span>`,
    generated: `${badge("Generated", "ok")} <span>The panel uses a certificate made on this server for ${esc((state.names ?? []).join(", "))}.${until}</span>`,
    own: `${badge("Own", "ok")} <span>The panel uses its own certificate${state.subject ? `, ${esc(state.subject)}` : ""}.${until}</span>`,
    unknown: `${badge("Unknown", "warn")} <span>${esc(state.problem ?? "")}</span>`,
  }[state.kind];
  const fingerprint = state.kind === "generated" && state.fingerprint
    ? `<br><span class="hint">SHA-256 ${esc(state.fingerprint)}: check it against the one your browser shows before you accept it.</span>` : "";
  const domain = state.customDomain
    ? `<br><span>Your custom domain ${esc(state.customDomain)} serves its own certificate on port 443 and is not changed.</span>` : "";
  return line + fingerprint + domain;
}

/** Site settings saved before the guard, or by a site's own user, that it would refuse now. */
function storedValuesWarning(stored: SystemTweaksState["vhostGuard"]["stored"]): string {
  if ("error" in stored) return `<p class="st-status hint">Stored site settings could not be checked: ${esc(stored.error)}</p>`;
  if (!stored.length) return "";
  const listed = stored.slice(0, 10).map((value) => `${esc(value.domain)}: ${esc(value.field)}`).join("; ");
  return warning(`These saved site settings would be refused now, so they may hold nginx directives: ${listed}${
    stored.length > 10 ? `; and ${stored.length - 10} more` : ""}. Check each one and the site's vhost.`);
}

/** Sites whose vhost the sync leaves alone, so nginx still opens their logs in the user's home. */
function homeLogsWarning(domains: string[]): string {
  if (!domains.length) return "";
  const listed = domains.slice(0, 10).map(esc).join(", ");
  return warning(`These sites' vhosts still write nginx logs in the site user's home, where that user can point them at any file: ${listed}${
    domains.length > 10 ? ` and ${domains.length - 10} more` : ""}. clp-addons rewrites a vhost only when root alone can write it: make each one in /etc/nginx/sites-enabled owned by root with mode 644, then run clp-addons repair.`);
}

/** Sites whose logrotate file was edited by hand, so the sync left it as it is. */
function ownLogrotateWarning(domains: string[]): string {
  if (!domains.length) return "";
  const listed = domains.slice(0, 10).map(esc).join(", ");
  return warning(`These sites' files in /etc/logrotate.d were edited by hand, so clp-addons left them as they are: ${listed}${
    domains.length > 10 ? ` and ${domains.length - 10} more` : ""}. A file that rotates the site's home as root lets its user have root rotate files it links there. Rotate the home with su set to the site's user.`);
}

function phpPoolsLine(state: SystemTweaksState["phpPools"]): string {
  if (state.problem) return `${badge("Not applied", "warn")} <span>${esc(state.problem)}</span>`;
  if (state.active) return `${badge("On", "ok")} <span>Each pool's port answers only nginx and the pool's own user.</span>`;
  if (state.enabled) return `${badge("Not applied", "warn")} <span>Run clp-addons repair.</span>`;
  return `${badge("Off", "plain")} <span>Any account on the server can run PHP as any site through its pool's port.</span>`;
}

function vhostGuardLine(state: SystemTweaksState["vhostGuard"]): string {
  if (state.active) return `${badge("On", "ok")} <span>Panel input is checked before CloudPanel writes it into a vhost.</span>`;
  if (state.enabled) return `${badge("Not applied", "warn")} <span>Run clp-addons repair.</span>`;
  return `${badge("Off", "plain")} <span>Any panel account with a site can write nginx config, and nginx runs as root.</span>`;
}

function fileManagerGuardLine(state: SystemTweaksState["fileManagerGuard"]): string {
  if (state.active) return `${badge("On", "ok")} <span>File Manager access is limited to each site's files.</span>`;
  if (state.enabled) return `${badge("Not applied", "warn")} <span>Run clp-addons repair.</span>`;
  return `${badge("Off", "plain")} <span>Any panel account with a site can read and change files anywhere on the server through the File Manager, which runs as root.</span>`;
}

function clpctlGuardLine(state: SystemTweaksState["clpctlGuard"]): string {
  if ("error" in state) return `${badge("Unknown", "warn")} <span>${esc(state.error)}</span>`;
  const where = state.version ? ` (CloudPanel ${esc(state.version)})` : "";
  if (state.active) return `${badge("On", "ok")} <span>The clpctlWrapper is the hardened one${where}.</span>`;
  if (state.enabled && state.wrapper === "ours") {
    // Our wrapper is installed but its saved original is gone, so it falls back
    // to nothing and refuses every caller: clpctl cannot run until it is fixed.
    return `${badge("Action needed", "bad")} <span>${esc(state.reason ?? "the saved original is missing")}, so clpctl cannot run. Restore CloudPanel's clpctlWrapper, then run clp-addons repair.</span>`;
  }
  if (state.enabled) {
    return `${badge("Paused", "warn")} <span>${esc(state.reason ?? "the wrapper was left in place")}. CloudPanel's own wrapper is untouched.</span>`;
  }
  return `${badge("Off", "plain")} <span>A site's own user can reach root through clpctlWrapper${where}.</span>`;
}

function telemetryLine(state: SystemTweaksState["telemetry"]): string {
  if (state.problem) return `${badge("Unknown", "warn")} <span>${esc(state.problem)}</span>`;
  if (!state.agent) return `${badge("No agent", "plain")} <span>CloudPanel's clp-agent is not installed here.</span>`;
  if (state.blocked) return `${badge("Blocked", "ok")} <span>clp-agent can reach only this server.</span>`;
  if (state.enabled) return `${badge("Not applied", "warn")} <span>Run clp-addons repair.</span>`;
  return `${badge("Sending", "plain")} <span>clp-agent sends CloudPanel every site's domain and every panel user's name and email once a day.</span>`;
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
        description: [
          "Stops any client from naming its own IP with a header to PHP, logs, basic auth and Cloudflare-only access.",
          "Local proxies stay trusted, and the panel also trusts Cloudflare. Switch it off only behind another public proxy.",
        ],
        checked: state.realIp.blockForged,
        onchange: "setRealIp(this)",
        extra: `<p class="st-status">${realIpLine(state.realIp)}</p>`,
      })}${settingRow({
        key: "protectPhpMyAdmin",
        title: "Lock down phpMyAdmin",
        description: [
          "Keeps the panel's basic auth on URLs that only start with /phpmyadmin, such as /phpmyadmin/../file-manager/.",
          "Hides phpMyAdmin's example and setup scripts and the files that show its version. Signing in from the panel still works.",
        ],
        checked: state.phpMyAdmin.enabled,
        onchange: "setPhpMyAdmin(this)",
        extra: `<p class="st-status">${phpMyAdminLine(state.phpMyAdmin)}</p>`,
      })}${settingRow({
        key: "replacePanelCert",
        title: "Replace the shared panel certificate",
        description: [
          "Every CloudPanel install serves port 8443 with the same certificate and private key, so anyone who sees the traffic can decrypt it. This swaps it for one generated on this server.",
          "A certificate you installed yourself is left alone. Off stops replacing it; a generated one stays.",
        ],
        checked: state.panelCert.replace,
        onchange: "setPanelCert(this)",
        extra: `<p class="st-status">${panelCertLine(state.panelCert)}</p>`,
      })}${settingRow({
        key: "blockVhostInjection",
        title: "Block nginx config injection",
        description: [
          "Refuses site settings CloudPanel would write into a vhost unchecked, such as a Root Directory or Varnish server holding nginx directives.",
          "Only administrators can save the Vhost editor and PageSpeed settings, and site nginx logs move where only root can write.",
        ],
        checked: state.vhostGuard.enabled,
        onchange: "setVhostGuard(this)",
        extra: `<p class="st-status">${vhostGuardLine(state.vhostGuard)}</p>${storedValuesWarning(state.vhostGuard.stored)}${homeLogsWarning(state.vhostGuard.homeLogs)}${ownLogrotateWarning(state.vhostGuard.ownLogrotate)}`,
      })}${settingRow({
        key: "isolatePhpPools",
        title: "Isolate PHP pools",
        description: [
          "Lets only nginx and each site's own user connect to the site's PHP-FPM port, so one site's user cannot run PHP as another site's.",
          "A tool that reaches another site's pool from its own account, such as a monitoring agent, stops working.",
        ],
        checked: state.phpPools.enabled,
        onchange: "setPhpPools(this)",
        extra: `<p class="st-status">${phpPoolsLine(state.phpPools)}</p>`,
      })}${settingRow({
        key: "confineFileManager",
        title: "Restrict File Manager to site files",
        description: [
          "Refuses File Manager requests that reach outside the site's home through .. or a symbolic link, and archives that would extract device files or setuid programs.",
          "Only the panel's own nginx can reach the File Manager's PHP.",
        ],
        checked: state.fileManagerGuard.enabled,
        onchange: "setFileManagerGuard(this)",
        extra: `<p class="st-status">${fileManagerGuardLine(state.fileManagerGuard)}</p>`,
      })}${settingRow({
        key: "blockClpctlInjection",
        title: "Block clpctl injection",
        description: [
          "Replaces CloudPanel's clpctlWrapper so a site's own Unix user cannot break out of clpctl's shell and run commands as root.",
          "Root and the panel are unaffected, and the four commands sites may run still work with ordinary values.",
        ],
        checked: "error" in state.clpctlGuard ? true : state.clpctlGuard.enabled,
        onchange: "setClpctlGuard(this)",
        extra: `<p class="st-status">${clpctlGuardLine(state.clpctlGuard)}</p>`,
      })}${settingRow({
        key: "blockTelemetry",
        title: "Block CloudPanel telemetry",
        description: [
          "Cuts CloudPanel's clp-agent off from the network, so it stops sending the server's ID and hardware, every site's domain and every panel user's name and email.",
          "The agent keeps recording the dashboard's graphs.",
        ],
        checked: state.telemetry.enabled,
        onchange: "setTelemetry(this)",
        extra: `<p class="st-status">${telemetryLine(state.telemetry)}</p>`,
      })}
      </div>
    </div>`;
}

type DatabaseState = SystemTweaksState["database"];

function listing(items: string[]): string {
  return esc(items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0] ?? "");
}

/** Where MySQL listens, and what stands between it and the internet. */
function databaseLine(state: DatabaseStatus & { loopback: boolean }): string {
  if (state.listenersUnknown) return `${badge("Unknown", "warn")} <span>Where MySQL listens could not be read: ${esc(state.listenersUnknown)}.</span>`;
  if (!state.running) return `${badge("Not running", "plain")} <span>MySQL is not listening on TCP here.</span>`;
  if (!state.exposed.length) return `${badge("This server only", "ok")} <span>MySQL accepts connections only from this server.</span>`;
  const where = `Listens on ${listing(state.exposed)}.`;
  if (state.loopback && state.fileInPlace) {
    if (state.socketUnit) return `${badge("Not applied", "warn")} <span>${where} The saved restriction applies when MySQL and ${esc(state.socketUnit)} are stopped and started together.</span>`;
    return `${badge("Not applied", "warn")} <span>${where} It moves to 127.0.0.1 at MySQL's next restart: systemctl restart mysql.</span>`;
  }
  if (state.firewall.state === "off") {
    return `${badge("Open", "bad")} <span>${where} The firewall rules loaded now let anyone reach it, unless a firewall outside this server blocks it.</span>`;
  }
  if (state.firewall.state === "unknown") {
    return `${badge("Unknown", "warn")} <span>${where} Whether the loaded firewall rules block it is unclear: ${esc(state.firewall.reason ?? "they could not be read")}.</span>`;
  }
  if (state.firewall.openTo.length) {
    return `${badge("Open", "warn")} <span>${where} The loaded firewall rules allow ${listing(state.firewall.openTo)}.</span>`;
  }
  return `${badge("Firewalled", "warn")} <span>${where} The loaded firewall rules drop it, so the firewall is all that keeps it private.</span>`;
}

/** Root's default password, and how to change it without breaking the panel. */
function defaultPasswordNote(state: DatabaseStatus): string {
  const found = state.defaultPassword;
  if ("error" in found) return `<p class="st-status hint">Root's password could not be checked: ${esc(found.error)}</p>`;
  if (!state.running) return "";
  if (!found.length) return `<p class="st-status hint">Root does not log in with a default password.</p>`;
  const what = found.map((hit) => `${hit.password === "root" ? "the password root" : "no password"} from ${hit.from === "loopback" ? "this server" : "other hosts"}`);
  return warning(`MySQL's root account logs in with ${listing(what)}. Change it in MySQL first, then enter the new password under
    Admin → Settings → <a href="/admin/database-servers">Database Servers</a> on the 127.0.0.1 server. CloudPanel logs in with the password stored there,
    so changing it only in MySQL breaks its Databases page.`);
}

function databaseCard(state: DatabaseState): string {
  const description = [
    "Allows MySQL and MariaDB connections only from this server. Sites and the panel connect over localhost or a Unix socket and keep working. Apps on other machines lose access; reach it over an SSH tunnel instead.",
    "Off by default: CloudPanel creates every database user for any host, so System Tweaks cannot tell whether something remote uses one. A change restarts MySQL, so sites lose their database for a few seconds.",
  ];
  if ("error" in state) {
    return `
    <div class="card">
      <div class="card-header"><h2>Database</h2></div>
      <div class="tweak-list">${settingRow({ key: "databaseLoopback", title: "MySQL on this server only", description, control: "",
        extra: `<div class="alert st-alert" role="alert">${esc(state.error)}</div>` })}
      </div>
    </div>`;
  }
  const remote = state.remoteClients.length
    ? warning(`Connected now from ${listing(state.remoteClients)}. ${state.loopback ? "" : "These lose access once MySQL accepts connections from this server only."}`)
    : "";
  return `
    <div class="card">
      <div class="card-header"><h2>Database</h2></div>
      <div class="tweak-list">${settingRow({
        key: "databaseLoopback",
        title: "MySQL on this server only",
        description,
        checked: state.loopback,
        disabled: !state.running && !state.loopback,
        onchange: "setDatabaseLoopback(this)",
        extra: `<p class="st-status">${databaseLine(state)}</p>${remote}${defaultPasswordNote(state)}`,
      })}
      </div>
    </div>`;
}

type Memory = Exclude<SystemTweaksState["memory"], { error: string }>;

const PROFILE_NAMES: Record<MemoryProfile, string> = { balanced: "Balanced", database: "Database-heavy", cache: "Cache-heavy" };

/** Whole GB above 10, one decimal below, MB under 1 GB. */
export function size(mb: number): string {
  if (mb < 1024) return `${mb} MB`;
  const gb = mb / 1024;
  return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`;
}

/**
 * What the profile gives each part of the server, and what is left for PHP.
 * MySQL and Redis are counted at the profile's sizes even while their switch
 * is off, since what they use then is not known here.
 */
function memoryBudget(state: Memory): string {
  const { plan } = state;
  const parts: [string, number][] = [
    ["MySQL buffer pool", state.mysql.installed ? plan.bufferPoolMb : 0],
    ["MySQL connections, at most", state.mysql.installed ? plan.maxConnections * CONNECTION_MB : 0],
    ["Redis", state.redis.installed ? plan.redisMb : 0],
    ["Varnish", state.varnishMb ?? 0],
    ["Memcached", state.memcachedMb ?? 0],
  ];
  const shown = parts.filter(([, mb]) => mb > 0);
  const left = plan.ramMb - shown.reduce((total, [, mb]) => total + mb, 0);
  const rows = shown.map(([name, mb]) => `
          <dt>${esc(name)}</dt><dd>${esc(size(mb))}</dd>`).join("");
  const rest = left > 0 ? `<dt>Left for PHP and the rest</dt><dd>${esc(size(left))}</dd>`
    : `<dt>Left for PHP and the rest</dt><dd>${badge("None", "bad")} These add up to more than the server's ${esc(size(plan.ramMb))}.</dd>`;
  return `
      <dl class="kv st-kv">
          <dt>RAM</dt><dd>${esc(size(plan.ramMb))}</dd>${rows}
          ${rest}
      </dl>
      <p class="hint st-suggest">The sizes this profile gives here, with both switches below on.</p>`;
}

function mysqlMemoryLine(state: Memory): string {
  const { plan } = state;
  const numbers = `${size(plan.bufferPoolMb)} buffer pool, up to ${plan.maxConnections} connections`;
  if (!state.mysql.installed && !state.settings.mysql) return `${badge("Not installed", "plain")} <span>MySQL is not installed here.</span>`;
  if (state.settings.mysql && !state.mysql.inPlace) return `${badge("Not applied", "warn")} <span>Run clp-addons repair.</span>`;
  if (state.settings.mysql && state.mysql.pending) {
    return `${badge("Pending", "warn")} <span>${esc(numbers)} from MySQL's next restart: systemctl restart mysql.</span>`;
  }
  if (state.settings.mysql) return `${badge("On", "ok")} <span>${esc(numbers)}.</span>`;
  if (state.mysql.pending) return `${badge("Off", "plain")} <span>CloudPanel's values come back at MySQL's next restart.</span>`;
  return `${badge("Off", "plain")} <span>CloudPanel's fixed values, the same on every server.</span>`;
}

function redisMemoryLine(state: Memory): string {
  const redis = state.redis;
  if (!redis.installed && !state.settings.redis) return `${badge("Not installed", "plain")} <span>Redis is not installed here.</span>`;
  if (redis.problem) return `${badge("Unknown", "warn")} <span>${esc(redis.problem)}</span>`;
  const used = redis.usedMb === null ? "" : `Using ${size(redis.usedMb)}`;
  if (redis.capped) return `${badge("On", "ok")} <span>${esc(used)} of ${esc(size(state.plan.redisMb))}.</span>`;
  if (state.settings.redis) return `${badge("Not applied", "warn")} <span>${redis.maxmemoryMb === null ? "Redis is not running; the cap applies when it starts." : "Run clp-addons repair."}</span>`;
  if (redis.maxmemoryMb === null) return `${badge("Off", "plain")}`;
  return `${badge("Off", "plain")} <span>${esc(used)}${redis.maxmemoryMb ? `, with Redis's own limit of ${esc(size(redis.maxmemoryMb))}` : ", with no limit"}.</span>`;
}

function oomLine(state: Memory): string {
  if (state.oom.inPlace && state.settings.oom) return `${badge("On", "ok")} <span>A site's PHP is killed first.</span>`;
  if (state.settings.oom) return `${badge("Not applied", "warn")} <span>Run clp-addons repair.</span>`;
  return `${badge("Off", "plain")} <span>The kernel usually kills MySQL first, the largest process.</span>`;
}

function memoryCard(state: SystemTweaksState["memory"]): string {
  if ("error" in state) {
    return `
    <div class="card">
      <div class="card-header"><h2>Memory</h2></div>
      <div class="alert st-alert" role="alert">${esc(state.error)}</div>
    </div>`;
  }
  const select = `
            <select id="memory-profile" aria-label="Memory profile" data-current="${esc(state.settings.profile)}" onchange="setMemory(this)">${(Object.keys(PROFILE_NAMES) as MemoryProfile[])
    .map((profile) => `<option value="${profile}"${profile === state.settings.profile ? " selected" : ""}>${esc(PROFILE_NAMES[profile])}</option>`).join("")}</select>`;
  return `
    <div class="card">
      <div class="card-header"><h2>Memory</h2></div>
      <div class="tweak-list">${settingRow({
        key: "memoryProfile",
        title: "Memory profile",
        description: [
          "How MySQL and Redis share this server's RAM: Balanced, more for the database, or more for the cache.",
          "Only a share is saved. The sizes are worked out again each time MySQL or Redis starts, so a server resized up or down gets new ones at its next boot.",
        ],
        control: select,
        extra: memoryBudget(state),
      })}${settingRow({
        key: "memory-mysql",
        title: "Size MySQL to this server",
        description: [
          "Sets MySQL's buffer pool, connection limit and per-connection buffers from the profile. CloudPanel's fixed values let 512 connections of up to 34 MB each, more than a small server has.",
          "Applies at MySQL's next restart; System Tweaks never restarts it. More connections at once than the limit get Too many connections.",
        ],
        checked: state.settings.mysql,
        disabled: !state.mysql.installed && !state.settings.mysql,
        onchange: "setMemory(this)",
        extra: `<p class="st-status">${mysqlMemoryLine(state)}</p>`,
      })}${settingRow({
        key: "memory-redis",
        title: "Cap Redis",
        description: [
          "Limits Redis to the profile's share and, when full, evicts the keys used least recently, so a growing cache cannot run the server out of memory. Applies at once.",
          "Leave it off if a site keeps data in Redis it cannot lose, such as a job queue.",
        ],
        checked: state.settings.redis,
        disabled: !state.redis.installed && !state.settings.redis,
        onchange: "setMemory(this)",
        extra: `<p class="st-status">${redisMemoryLine(state)}</p>`,
      })}${settingRow({
        key: "memory-oom",
        title: "Protect MySQL and nginx when memory runs out",
        description: "When the server runs out of memory, the kernel kills a site's PHP worker, which fails one request, instead of MySQL or nginx, which takes every site down.",
        checked: state.settings.oom,
        onchange: "setMemory(this)",
        extra: `<p class="st-status">${oomLine(state)}</p>`,
      })}
      </div>
    </div>`;
}

/** The protocols are set on CloudPanel's own Firewall page; this page only says where. */
function firewallLine(status: FirewallStatus | { error: string }): string {
  if ("error" in status || !status.available) return "";
  const link = `<a href="/admin/firewall">Firewall</a>`;
  return status.udpPorts.length
    ? `<br>UDP ports open from CloudPanel's ${link} page: ${esc(status.udpPorts.join(", "))}.`
    : `<br>Rules on CloudPanel's ${link} page can open UDP ports too.`;
}

type LoginJails = SystemTweaksState["loginJails"];
type LoginJailsReady = Exclude<LoginJails, { error: string }>;

const LIMIT_TEXT = `${JAIL_LIMITS.maxretry} failed logins within an hour`;

function jailLine(jails: LoginJailsReady, jail: string, on: boolean): string {
  if (!on) return `${badge("Off", "plain")}`;
  if (jails.missing.length) return `${badge("Not running", "warn")} <span>Install fail2ban below.</span>`;
  if (jails.service === "masked") return `${badge("Not running", "warn")} <span>fail2ban.service is masked. Unmask it, then run clp-addons repair.</span>`;
  if (jail === PANEL_JAIL && jails.panelLog === null) {
    return `${badge("Not running", "warn")} <span>This CloudPanel has no separate panel nginx to log failed logins from.</span>`;
  }
  if (jail === PANEL_JAIL && jails.problem) return `${badge("Not running", "warn")} <span>${esc(jails.problem)}</span>`;
  if (!jails.running.includes(jail) || (jail === PANEL_JAIL && !jails.panelLog)) {
    return `${badge("Not running", "warn")} <span>Run clp-addons repair.</span>`;
  }
  return `${badge("On", "ok")} <span>fail2ban is watching.</span>`;
}

/** What sshd accepts now, and how to stop it. The setting never changes sshd. */
function sshdWarning(sshd: SshLogin | null): string {
  if (!sshd) return "";
  const open: string[] = [];
  if (sshd.password) open.push("SSH accepts passwords");
  if (sshd.rootLogin === "yes") open.push(`root can log in with ${sshd.password ? "a password" : "a key or password"}`);
  if (!open.length) return "";
  return warning(`${esc(open.join(", and "))}. Once your key logs in, set <code>PasswordAuthentication no</code> and <code>PermitRootLogin prohibit-password</code> in a file in /etc/ssh/sshd_config.d/, then run <code>systemctl reload ssh</code>.`);
}

function bansTable(bans: Ban[]): string {
  const command = `<p class="hint">Or run <code>fail2ban-client unban &lt;address&gt;</code>.</p>`;
  if (!bans.length) return `<details class="st-fold"><summary>Blocked addresses: none</summary>${command}</details>`;
  const rows = bans.map((ban) => `
          <tr><td><span class="st-name">${esc(ban.ip)}</span><span class="hint st-detail">${ban.jail === PANEL_JAIL ? "Panel" : ban.jail === DOMAIN_JAIL ? "Custom domain, HTTPS" : "SSH"}, until ${esc(ban.until)}</span></td>
            <td class="st-state"><button class="btn btn-sm" type="button" data-jail="${esc(ban.jail)}" data-ip="${esc(ban.ip)}" onclick="unban(this)">Unblock</button></td></tr>`).join("");
  return `
      <details class="st-fold" open>
        <summary>${badge(String(bans.length), "warn")} Blocked address${bans.length === 1 ? "" : "es"}</summary>
        <div class="table-scroll"><table class="st-table"><thead><tr><th>Address</th><th class="st-state"></th></tr></thead>
          <tbody>${rows}</tbody></table></div>${command}
      </details>`;
}

/** Logins through CloudPanel's custom domain reach the panel from loopback, so the sites' nginx counts them. */
function customDomainLine(jails: LoginJailsReady): string {
  const domain = jails.customDomain;
  if (!domain || !jails.panel || jails.missing.length) return "";
  if (!domain.supported) {
    return warning(`Logins through ${esc(domain.name)} are not counted: its vhost has more than one server block or server_name, so System Tweaks leaves it alone.`);
  }
  if (!domain.logged || !jails.running.includes(DOMAIN_JAIL)) {
    return warning(`Logins through ${esc(domain.name)} are not counted yet. Run clp-addons repair.`);
  }
  return `<p class="hint st-suggest">Logins through ${esc(domain.name)} count too. A block for those covers HTTPS on port 443 for every site on this server, because the firewall cannot tell sites apart.</p>`;
}

function loginJailsCard(jails: LoginJails): string {
  if ("error" in jails) {
    return `
    <div class="card">
      <div class="card-header"><h2>Failed logins</h2></div>
      <div class="alert st-alert" role="alert">${esc(jails.error)}</div>
    </div>`;
  }
  const install = jails.missing.length && (jails.panel || jails.ssh) ? `
      <p class="st-status">${badge("Not installed", "bad")} <span>${esc(jails.missing.join(", "))} ${jails.missing.length === 1 ? "is" : "are"} not installed.</span></p>
      <div class="st-install"><button class="btn" type="button" onclick="installFail2ban(this)">Install fail2ban</button></div>` : "";
  return `
    <div class="card">
      <div class="card-header"><h2>Failed logins</h2></div>
      <div class="tweak-list">${settingRow({
        key: "panel",
        title: "Block panel login guessing",
        description: [
          `After ${LIMIT_TEXT}, fail2ban blocks the address from the panel's port 8443 for an hour. This server's own addresses, private networks and Cloudflare are never blocked.`,
          "Behind Cloudflare the server sees only Cloudflare's addresses, so nothing is blocked; use Cloudflare's rate limiting there.",
        ],
        checked: jails.panel,
        onchange: "setLoginJails(this)",
        extra: `<p class="st-status">${jailLine(jails, PANEL_JAIL, jails.panel)}</p>${customDomainLine(jails)}`,
      })}${settingRow({
        key: "ssh",
        title: "Block SSH login guessing",
        description: [
          `After ${LIMIT_TEXT}, fail2ban blocks the address from SSH for an hour.`,
          "Off by default, because an SSH client that offers several wrong keys counts as failed logins and could block you.",
        ],
        checked: jails.ssh,
        onchange: "setLoginJails(this)",
        extra: `<p class="st-status">${jailLine(jails, "sshd", jails.ssh)}</p>${sshdWarning(jails.sshd)}`,
      })}
      </div>${install}${jails.running.length ? bansTable(jails.bans) : ""}
    </div>`;
}

export function dashboardView(state: SystemTweaksState, now = Date.now()): string {
  return `
    <div class="page-heading">
      <div>
        <h1>System Tweaks</h1>
        <p>Server-wide settings for this machine.</p>
        <p class="hint">Every 15 minutes it also clears PHP and ImageMagick temp files that timed-out requests left in /tmp.${firewallLine(state.firewall)}</p>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><h2>Automatic updates</h2></div>
      <div class="tweak-list">${updateRows(state.updates, state.settings)}
      </div>${statusList(state.updates, now)}${coverageDetails(state.updates)}
    </div>${backupCompressionCard(state.backupCompression)}${settingsCard(state)}${loginJailsCard(state.loginJails)}${databaseCard(state.database)}${memoryCard(state.memory)}`;
}
