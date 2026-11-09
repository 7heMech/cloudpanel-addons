import { esc } from "../../../lib/app-http";
import { TWEAK_ROW_JS, renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { LockState } from "../../../lib/root-locks";
import { HARDENING, type SystemTweaksState } from "../registry";
import type { CoverageRow, LastRun, UpdateSettings, UpdatesStatus } from "../updates";
import { MAX_BACKUP_LEVEL } from "../backup-compression";
import { DOMAIN_JAIL, JAIL_LIMITS, PANEL_JAIL, type Ban, type SshLogin } from "../login-jails";
import { MOTD_TWEAK } from "../motd";
import { badge, lockableRow, settingRow, stateRow, warning } from "./rows";

import STYLE from "./views.css" with { type: "text" };
import SCRIPT from "./views.client.js" with { type: "text" };

export function layout(
  title: string,
  content: string,
  updateNotice?: { current: string; latest: string } | null,
): string {
  return renderLayout(title, content, {
    base: mountPath("system-tweaks"),
    css: STYLE,
    script: TWEAK_ROW_JS + SCRIPT,
    updateNotice,
  });
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

function motdCard(state: SystemTweaksState, locked: boolean): string {
  return `
    <div class="card">
      <div class="card-header"><h2>SSH login</h2></div>
      <div class="tweak-list">${MOTD_TWEAK.row(state, locked)}
      </div>
    </div>`;
}

/**
 * Root's lock covers this card and Failed logins, which follows it, so its
 * control and its notice are here rather than at the top of a page whose other
 * settings it leaves alone.
 */
function hardeningCard(state: SystemTweaksState, lock: LockState): string {
  const locked = lock !== "unlocked";
  return `
    <div class="card">
      <div class="card-header"><h2>Hardening</h2>${lockControl(lock)}</div>${locked ? `
      <p class="notice st-lock-notice">${LOCK_NOTICE[lock as keyof typeof LOCK_NOTICE]}</p>` : ""}
      <div class="tweak-list">${HARDENING.map((tweak) => tweak.row(state, locked)).join("")}
      </div>
    </div>`;
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

/** The setting never changes sshd. */
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
  if (!bans.length) return `<details class="st-fold" id="st-bans"><summary>Blocked addresses: none</summary>${command}</details>`;
  const rows = bans.map((ban) => `
          <tr><td><span class="st-name">${esc(ban.ip)}</span><span class="hint st-detail">${ban.jail === PANEL_JAIL ? "Panel" : ban.jail === DOMAIN_JAIL ? "Custom domain, HTTPS" : "SSH"}, until ${esc(ban.until)}</span></td>
            <td class="st-state"><button class="btn btn-sm" type="button" data-jail="${esc(ban.jail)}" data-ip="${esc(ban.ip)}" onclick="unban(this)">Unblock</button></td></tr>`).join("");
  return `
      <details class="st-fold" id="st-bans">
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

function loginJailsCard(jails: LoginJails, locked: boolean): string {
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
      <div class="tweak-list">${lockableRow("set-login-jails", {
        key: "panel",
        title: "Block panel login guessing",
        description: [
          `After ${LIMIT_TEXT}, fail2ban blocks the address from the panel's port 8443 for an hour. This server's own addresses, private networks and Cloudflare are never blocked.`,
          "Behind Cloudflare the server sees only Cloudflare's addresses, so nothing is blocked; use Cloudflare's rate limiting there.",
        ],
        checked: jails.panel,
        onchange: "setLoginJails(this)",
        extra: `<p class="st-status">${jailLine(jails, PANEL_JAIL, jails.panel)}</p>${customDomainLine(jails)}`,
      }, locked)}${lockableRow("set-login-jails", {
        key: "ssh",
        title: "Block SSH login guessing",
        description: [
          `After ${LIMIT_TEXT}, fail2ban blocks the address from SSH for an hour.`,
          "Off by default, because an SSH client that offers several wrong keys counts as failed logins and could block you.",
        ],
        checked: jails.ssh,
        onchange: "setLoginJails(this)",
        extra: `<p class="st-status">${jailLine(jails, "sshd", jails.ssh)}</p>${jails.ssh ? '<p class="hint st-suggest">SSH already records failed logins. The last hour counts when you switch this on, so addresses can be blocked immediately, even after a fresh fail2ban install.</p>' : ""}${sshdWarning(jails.sshd)}`,
      }, locked)}
      </div>${install}${jails.running.length ? bansTable(jails.bans) : ""}
    </div>`;
}

const LOCK_NOTICE: Record<Exclude<LockState, "unlocked">, string> = {
  locked: "Root has locked Hardening and Failed logins: they can be switched on here but not off, and the panel's PHP only moves to a newer version. To change that, run <code>clp-addons unlock system-tweaks</code> in a root terminal.",
  damaged: "Root's lock file cannot be trusted, so Hardening and Failed logins can be switched on here but not off. Run <code>clp-addons lock</code> in a root terminal to see how to fix it.",
};

/** In Hardening's header: the button that switches everything on and locks, or the lock once there is one. */
function lockControl(lock: LockState): string {
  if (lock === "unlocked") return `<button class="btn" type="button" onclick="lockSettings(this)">Lock settings</button>`;
  const title = lock === "damaged"
    ? "The lock file cannot be read or trusted; run clp-addons lock on the server"
    : "Run clp-addons unlock system-tweaks on the server to switch these off again";
  return `<span class="badge st-locked" title="${esc(title)}">Locked by root</span>`;
}

export function dashboardView(state: SystemTweaksState, now = Date.now(), lock: LockState = "unlocked"): string {
  const locked = lock !== "unlocked";
  return `
    <div class="page-heading">
      <div>
        <h1>System Tweaks</h1>
        <p>Hardening, automatic updates, panel PHP, remote backups and the SSH login message.</p>
        <p class="hint">Every 15 minutes it also clears PHP and ImageMagick temp files that timed-out requests left in /tmp. PHP worker limits and memory sizing are in <a href="/addons/resource-limits/">Resource Limits</a>.</p>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><h2>Automatic updates</h2></div>
      <div class="tweak-list">${updateRows(state.updates, state.settings)}
      </div>${statusList(state.updates, now)}${coverageDetails(state.updates)}
    </div>${backupCompressionCard(state.backupCompression)}${hardeningCard(state, lock)}${loginJailsCard(state.loginJails, locked)}${motdCard(state, locked)}`;
}
