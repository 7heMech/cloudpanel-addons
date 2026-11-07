/**
 * CloudPanel's package wipes /etc/update-motd.d on every install and upgrade
 * and leaves one script that prints its links and looks up the server's
 * address online at every SSH login. This turns that script off and adds one
 * that prints the server's own state instead; repair puts both back after a
 * CloudPanel upgrade.
 */
import { chmodSync, existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { writeFileAtomic } from "../../lib/atomic-write";
import { UPDATE_MOTD_DIR } from "../../cli/paths";

export const DEFAULT_MOTD_PATHS = {
  banner: `${UPDATE_MOTD_DIR}/10-cloudpanel`,
  script: `${UPDATE_MOTD_DIR}/10-clp-addons-server-info`,
};

// pam_motd runs it as root with an empty environment at every login, so it
// reads nothing that can block, and reads the panel's domain file, which the
// clp user owns, through a timeout and a character filter.
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
command -v apt >/dev/null && row Updates "$(timeout 3 apt list --upgradable 2>/dev/null | grep -c upgradable) pending"
by=$(sort -u /var/run/reboot-required.pkgs 2>/dev/null | paste -sd ' ')
[ -f /var/run/reboot-required ] && row Reboot "required\${by:+ by $by}"
domain=$([ -f /etc/.clp_custom_domain ] && timeout 1 head -c 253 /etc/.clp_custom_domain | tr -cd 'A-Za-z0-9.-')
ipv4=$(printf '%s\\n' $addresses | grep -m 1 -v :)
if [ -n "$domain" ]; then row Panel "https://$domain/"; elif [ -d /home/clp ] && [ -n "$ipv4" ]; then row Panel "https://$ipv4:8443"; fi
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
const scriptInPlace = (path: string) => modeOf(path) === 0o755 && readFileSync(path, "utf8") === MOTD_SCRIPT;

export function motdStatus(options: MotdOptions = {}): MotdStatus {
  const paths = pathsOf(options);
  return { script: scriptInPlace(paths.script), banner: executable(paths.banner) };
}

/**
 * Puts the login message in the wanted state; returns whether anything
 * changed. Off turns the banner back on only when the script was there, so a
 * banner the operator turned off stays off.
 */
export function applyMotd(serverInfo: boolean, options: MotdOptions = {}): boolean {
  const paths = pathsOf(options);
  if (serverInfo) {
    const write = !scriptInPlace(paths.script);
    if (write) writeFileAtomic(paths.script, MOTD_SCRIPT, { mode: 0o755, createParent: true });
    const silence = executable(paths.banner);
    if (silence) chmodSync(paths.banner, 0o644);
    return write || silence;
  }
  if (!existsSync(paths.script)) return false;
  rmSync(paths.script, { force: true });
  if (modeOf(paths.banner) !== null && !executable(paths.banner)) chmodSync(paths.banner, 0o755);
  return true;
}
