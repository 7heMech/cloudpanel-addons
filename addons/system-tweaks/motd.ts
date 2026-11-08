/**
 * CloudPanel's package wipes /etc/update-motd.d on every install and upgrade
 * and leaves one script that prints its links and looks up the server's
 * address online at every SSH login. This turns that script off and adds one
 * that prints the server's own state instead; repair puts both back after a
 * CloudPanel upgrade.
 */
import { addonStateDir, UPDATE_MOTD_DIR } from "../../lib/paths";
import { chmodSync, existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { writeFileAtomic } from "../../lib/atomic-write";

const DEFAULT_MOTD_PATHS = {
  banner: `${UPDATE_MOTD_DIR}/10-cloudpanel`,
  script: `${UPDATE_MOTD_DIR}/10-clp-addons-server-info`,
  /** Present while the banner is off because this turned it off. */
  marker: `${addonStateDir("system-tweaks")}/motd-banner-off`,
};

// pam_motd runs it as root with an empty environment for every SSH session,
// scp and sftp included, so it reads nothing that can block, counts updates
// only after apt's lists or dpkg's status change, and reads the panel's domain
// file, which the clp user owns, through a timeout and a character filter.
export const MOTD_SCRIPT = `#!/bin/sh
# clp-addons System Tweaks: Server info at SSH login. Switching it off removes this file.
row() { printf ' %-10s %s\\n' "$1" "$2"; }
[ -r /etc/os-release ] && . /etc/os-release
echo
printf ' %s, %s, kernel %s\\n\\n' "$(uname -n)" "\${PRETTY_NAME:-Linux}" "$(uname -r)"
row Uptime "$(uptime -p | sed 's/^up //')"
awk -v cpus="$(nproc)" '{ printf " %-10s %d%% of %d CPUs now, %d%% over 15 minutes\\n", "Load", $1 * 100 / cpus, cpus, $3 * 100 / cpus }' /proc/loadavg
awk '/^MemTotal:/ { t = $2 } /^MemAvailable:/ { a = $2 } /^SwapTotal:/ { st = $2 } /^SwapFree:/ { sf = $2 }
  END {
    printf " %-10s %.1f of %.1f GB used (%d%%)\\n", "Memory", (t - a) / 1048576, t / 1048576, t ? (t - a) * 100 / t : 0
    if (st > 0) printf " %-10s %.1f of %.1f GB used\\n", "Swap", (st - sf) / 1048576, st / 1048576
  }' /proc/meminfo
for mount in / /home; do
  df -P -h "$mount" 2>/dev/null | awk -v m="$mount" 'NR == 2 && $6 == m { printf " %-10s %s of %s used (%s)\\n", "Disk " m, $3, $2, $5 }'
done
addresses=$(ip -o addr show scope global 2>/dev/null | awk '$2 !~ /^(docker|br-|veth|virbr|lxc|cni|podman)/ { sub(/\\/.*/, "", $4); printf "%s%s", sep, $4; sep = " " }')
[ -n "$addresses" ] && row Addresses "$addresses"
updates=/run/clp-addons-motd-updates
if [ ! -e "$updates" ] || [ /var/lib/dpkg/status -nt "$updates" ] || [ /var/lib/apt/lists -nt "$updates" ]; then
  # A failed count is not cached, so the next login tries again.
  if list=$(timeout 3 apt list --upgradable 2>/dev/null); then
    printf '%s\\n' "$list" | grep -c upgradable > "$updates.$$"
    mv -f "$updates.$$" "$updates"
  fi
fi
count=$(cat "$updates" 2>/dev/null)
[ -n "$count" ] && [ "$count" != 0 ] && row Updates "$count pending"
by=$(sort -u /var/run/reboot-required.pkgs 2>/dev/null | paste -sd ' ')
[ -f /var/run/reboot-required ] && row Reboot "required\${by:+ by $by}"
domain=$([ -f /etc/.clp_custom_domain ] && timeout 1 head -c 253 /etc/.clp_custom_domain | tr -cd 'A-Za-z0-9.-')
if [ -n "$domain" ]; then row Panel "https://$domain/"; elif [ -d /home/clp ]; then row Panel "port 8443"; fi
echo
`;

export interface MotdOptions {
  paths?: Partial<typeof DEFAULT_MOTD_PATHS>;
}

export interface MotdStatus {
  /** The server-info script is in place and runs at login. */
  script: boolean;
  /** CloudPanel's banner runs at login. */
  banner: boolean;
}

function pathsOf(options: MotdOptions): typeof DEFAULT_MOTD_PATHS {
  return { ...DEFAULT_MOTD_PATHS, ...options.paths };
}

/** A regular file's permission bits, or null when there is none. */
function modeOf(path: string): number | null {
  const info = lstatSync(path, { throwIfNoEntry: false });
  return info?.isFile() ? info.mode & 0o7777 : null;
}

const executable = (path: string) => ((modeOf(path) ?? 0) & 0o111) !== 0;
function scriptInPlace(path: string): boolean {
  // A CloudPanel upgrade can remove it between the two reads.
  try { return modeOf(path) === 0o755 && readFileSync(path, "utf8") === MOTD_SCRIPT; }
  catch { return false; }
}

export function motdStatus(options: MotdOptions = {}): MotdStatus {
  const paths = pathsOf(options);
  return { script: scriptInPlace(paths.script), banner: executable(paths.banner) };
}

/**
 * Puts the login message in the wanted state; returns whether anything
 * changed. Off turns the banner back on only when this turned it off, so a
 * banner the operator turned off stays off.
 */
export function applyMotd(serverInfo: boolean, options: MotdOptions = {}): boolean {
  const paths = pathsOf(options);
  if (serverInfo) {
    // The banner first: one that cannot be changed stops this before the script runs beside it.
    const silence = executable(paths.banner);
    if (silence) {
      const marked = existsSync(paths.marker);
      writeFileAtomic(paths.marker, "", { mode: 0o600, createParent: true });
      try {
        chmodSync(paths.banner, 0o644);
      } catch (error) {
        if (!marked) rmSync(paths.marker, { force: true });
        throw error;
      }
    }
    const write = !scriptInPlace(paths.script);
    try {
      if (write) writeFileAtomic(paths.script, MOTD_SCRIPT, { mode: 0o755, createParent: true });
    } catch (error) {
      // Not a login with no message at all.
      if (silence) {
        chmodSync(paths.banner, 0o775);
        rmSync(paths.marker, { force: true });
      }
      throw error;
    }
    return write || silence;
  }
  const script = existsSync(paths.script);
  const silenced = existsSync(paths.marker);
  rmSync(paths.script, { force: true });
  // CloudPanel's own mode for it.
  if (silenced && modeOf(paths.banner) !== null && !executable(paths.banner)) chmodSync(paths.banner, 0o775);
  rmSync(paths.marker, { force: true });
  return script || silenced;
}
