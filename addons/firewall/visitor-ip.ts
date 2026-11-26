/**
 * Sites behind Cloudflare, proxied or through a Cloudflare Tunnel on this
 * server, log and hand PHP the edge's or 127.0.0.1's address. This points the
 * sites' log formats and PHP's REMOTE_ADDR at `$clp_visitor_ip`, which
 * `lib/visitor-ip.ts` defines from CF-Connecting-IP when Cloudflare set it.
 * The map also reads the X-Real-IP CloudPanel's front server sends its local
 * backend, so 127.0.0.1 stops being trusted for that header, which a visitor
 * could otherwise send through a tunnel. `$remote_addr` is otherwise left
 * alone, so Cloudflare-only access still sees the connecting address.
 */
import { failAction } from "../../lib/action";
import { readIfPresent } from "../../lib/baseline";
import { runCommand, type CommandResult } from "../../lib/command";
import { errorMessage } from "../../lib/errors";
import { withFileLockSync } from "../../lib/file-lock";
import { cloudflareRanges, nginxFileChange, trustedVhost, withNginxTransaction } from "../../lib/nginx-transaction";
import { addonStateDir, CLOUDFLARE_IPS_PATH, LOCK_DIR, ROOT_UID } from "../../lib/paths";
import { addonLocked, lockRefusal } from "../../lib/root-locks";
import { readState, writeState } from "../../lib/root-state";
import { cloudflareVisitorMaps } from "../../lib/visitor-ip";

export const VISITOR_IP = "$clp_visitor_ip";
export const MAPS_MARKER = "# clp-addons:visitor-ip";
const COMMAND_MS = 60_000;
const STATE_VERSION = 1;

export const DEFAULT_VISITOR_IP_PATHS = {
  nginxConf: "/etc/nginx/nginx.conf",
  fastcgiParams: "/etc/nginx/fastcgi_params",
  maps: "/etc/nginx/sites-enabled/00-clp-addons-visitor-ip.conf",
  cloudflareIps: CLOUDFLARE_IPS_PATH,
  stateFile: `${addonStateDir("firewall")}/visitor-ip.json`,
  lockFile: `${LOCK_DIR}/firewall-visitor-ip.lock`,
  nginx: "nginx",
  systemctl: "systemctl",
  rootUid: ROOT_UID,
};

type Paths = typeof DEFAULT_VISITOR_IP_PATHS;

export interface VisitorIpOptions {
  paths?: Partial<Paths>;
  run?: (command: string, args: string[]) => CommandResult;
  /** Tests only: root's lock file, owned by them; production reads ROOT_LOCKS_FILE. */
  locks?: { file: string; rootUid: number };
}

export const UNTRUSTED_LOOPBACK = "#clp-addons:hop ";

/** Each edit: what follows `lead` as the file ships, and with the setting on. */
const EDITS: Record<"nginxConf" | "fastcgiParams", { lead: RegExp; off: string; on: string }[]> = {
  nginxConf: [
    { lead: /^([ \t]*log_format[ \t]+main[ \t]+')/, off: "$remote_addr", on: VISITOR_IP },
    { lead: /^([ \t]*log_format[ \t]+cloudflare[ \t]+')/, off: "$http_cf_connecting_ip", on: VISITOR_IP },
    { lead: /^([ \t]*)/, off: "set_real_ip_from 127.0.0.1;", on: `${UNTRUSTED_LOOPBACK}set_real_ip_from 127.0.0.1;` },
  ],
  fastcgiParams: [{ lead: /^([ \t]*fastcgi_param[ \t]+REMOTE_ADDR[ \t]+)/, off: "$remote_addr", on: VISITOR_IP }],
};

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Edit = (typeof EDITS)[keyof typeof EDITS][number];

const line = (edit: Edit, text: string, flags = "m") => new RegExp(`${edit.lead.source}${literal(text)}(?=[ \\t;']|$)`, flags);

/** Every matching line, so a directive the file repeats is never left half edited. */
function swap(content: string, file: keyof typeof EDITS, on: boolean): string {
  return EDITS[file].reduce((text, edit) => {
    const [from, to] = on ? [edit.off, edit.on] : [edit.on, edit.off];
    return text.replace(line(edit, from, "gm"), (_match, start: string) => `${start}${to}`);
  }, content);
}

function mapsContent(paths: Paths): string {
  return `${MAPS_MARKER}\n${cloudflareVisitorMaps("clp_visitor", cloudflareRanges(paths.cloudflareIps), "$remote_addr")}`;
}

const read = readIfPresent;

export interface VisitorIpStatus {
  /** Whether the map is current and nothing that could use it still uses the plain address. */
  applied: boolean;
  problem: string;
}

export interface VisitorIpState extends VisitorIpStatus {
  enabled: boolean;
}

export function visitorIpStatus(options: VisitorIpOptions = {}): VisitorIpStatus {
  const paths = { ...DEFAULT_VISITOR_IP_PATHS, ...options.paths };
  try {
    const maps = read(paths.maps);
    if (maps !== null && !maps.startsWith(`${MAPS_MARKER}\n`)) return { applied: false, problem: `${paths.maps} was not written by clp-addons; move it away, then run clp-addons repair` };
    let applied = maps === mapsContent(paths);
    const unknown: string[] = [];
    for (const file of ["nginxConf", "fastcgiParams"] as const) {
      const { content } = trustedVhost(paths[file], paths.rootUid);
      for (const edit of EDITS[file]) {
        if (line(edit, edit.off).test(content)) applied = false;
        else if (!line(edit, edit.on).test(content)) unknown.push(`${paths[file]} has no line with ${edit.off}`);
      }
    }
    return { applied: applied && unknown.length === 0, problem: unknown.join("; ") };
  } catch (error) {
    return { applied: false, problem: errorMessage(error) };
  }
}

function apply(on: boolean, options: VisitorIpOptions, reload: boolean, files: readonly (keyof typeof EDITS)[]): boolean {
  const paths = { ...DEFAULT_VISITOR_IP_PATHS, ...options.paths };
  const run = options.run ?? ((command, args) => runCommand(command, args, COMMAND_MS));
  const existing = read(paths.maps);
  const foreign = existing !== null && !existing.startsWith(`${MAPS_MARKER}\n`);
  if (on && foreign) throw new Error(`refusing ${paths.maps}: clp-addons did not write it`);
  const swapped = files.flatMap((file) => {
    const content = read(paths[file]);
    return content === null ? [] : [{ file, content, result: swap(content, file, on) }];
  });
  const edited = swapped.filter(({ content, result }) => result !== content).map(({ file }) => file);
  // Off keeps the map while a file still names it, so Nginx can load it.
  const named = !on && swapped.some(({ result }) => result.includes(VISITOR_IP));
  const maps = on || named ? mapsContent(paths) : null;
  const mapsChange = reload && !foreign && maps !== existing;
  // Nothing to change opens no transaction, so a file it would not touch is never checked.
  if (edited.length === 0 && !mapsChange) return false;
  return withNginxTransaction(null, { nginx: paths.nginx, systemctl: paths.systemctl }, run, (changes) => {
    for (const file of edited) {
      const change = nginxFileChange(paths[file], null, paths.rootUid);
      change.content = swap(change.backup.content!, file, on);
      changes.push(change);
    }
    if (mapsChange) changes.push(nginxFileChange(paths.maps, maps, paths.rootUid));
  }, { reload }).changed;
}

export function applyVisitorIp(on: boolean, options: VisitorIpOptions = {}): boolean {
  return apply(on, options, true, ["nginxConf", "fastcgiParams"]);
}

/** Gives one dpkg conffile its package text back, without a reload, so an upgrade can replace it. */
export function releaseVisitorIp(file: keyof typeof EDITS, options: VisitorIpOptions = {}): boolean {
  return apply(false, options, false, [file]);
}

/** Saved preference, defaulting to true so sites behind Cloudflare see real visitor IPs out of the box. */
export function readVisitorIpEnabled(options: VisitorIpOptions = {}): boolean {
  const paths = { ...DEFAULT_VISITOR_IP_PATHS, ...options.paths };
  const stored = readState<{ version?: unknown; enabled?: unknown } | null>(paths.stateFile, paths.rootUid, () => null);
  return stored?.version === STATE_VERSION && typeof stored.enabled === "boolean" ? stored.enabled : true;
}

function writeVisitorIpEnabled(enabled: boolean, paths: Paths): void {
  writeState(paths.stateFile, { version: STATE_VERSION, enabled }, paths.rootUid);
}

export function visitorIpState(options: VisitorIpOptions = {}): VisitorIpState {
  return { ...visitorIpStatus(options), enabled: readVisitorIpEnabled(options) };
}

export function setVisitorIpEnabled(enabled: boolean, options: VisitorIpOptions = {}): VisitorIpState {
  const paths = { ...DEFAULT_VISITOR_IP_PATHS, ...options.paths };
  return withFileLockSync(paths.lockFile, 30, "another Cloudflare visitor IP change is running", () => {
    if (!enabled && addonLocked("firewall", options.locks?.file, options.locks?.rootUid)) {
      failAction(lockRefusal("firewall"));
    }
    applyVisitorIp(enabled, options);
    writeVisitorIpEnabled(enabled, paths);
    return { ...visitorIpStatus(options), enabled };
  });
}

/** Reapplies visitor IPs during repair and when CloudPanel rewrites `/etc/nginx/cloudflare/ips`. */
export function keepVisitorIp(options: VisitorIpOptions = {}): string | null {
  const paths = { ...DEFAULT_VISITOR_IP_PATHS, ...options.paths };
  return withFileLockSync(paths.lockFile, 30, "another Cloudflare visitor IP change is running", () => {
    if (!readVisitorIpEnabled(options)) return null;
    return applyVisitorIp(true, options) ? "Cloudflare visitor IPs reapplied" : null;
  });
}

export function restoreVisitorIp(options: VisitorIpOptions = {}): void {
  const paths = { ...DEFAULT_VISITOR_IP_PATHS, ...options.paths };
  withFileLockSync(paths.lockFile, 30, "another Cloudflare visitor IP change is running", () => {
    if (readVisitorIpEnabled(options)) applyVisitorIp(true, options);
  });
}

export function withdrawVisitorIp(options: VisitorIpOptions = {}): void {
  const paths = { ...DEFAULT_VISITOR_IP_PATHS, ...options.paths };
  withFileLockSync(paths.lockFile, 30, "another Cloudflare visitor IP change is running", () => {
    applyVisitorIp(false, options);
  });
}
