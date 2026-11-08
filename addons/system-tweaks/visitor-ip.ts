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
import { errorMessage } from "../../lib/errors";
import { readFileSync } from "node:fs";
import { runCommand, type CommandResult } from "../../lib/command";
import { cloudflareRanges, nginxFileChange, trustedVhost, withNginxTransaction } from "../../lib/nginx-transaction";
import { CLOUDFLARE_IPS_PATH, ROOT_UID } from "../../lib/paths";
import { cloudflareVisitorMaps } from "../../lib/visitor-ip";
import { COMMAND_MS, REAL_IP_GATEWAY_TIMEOUT_MS } from "./limits";
import { applyThenSave, tweak } from "./tweak";
import { badge, statusLine, switchRow } from "./app/rows";
import { esc } from "../../lib/app-http";

export const VISITOR_IP = "$clp_visitor_ip";
const MAPS_MARKER = "# clp-addons:visitor-ip";

export const DEFAULT_VISITOR_IP_PATHS = {
  nginxConf: "/etc/nginx/nginx.conf",
  fastcgiParams: "/etc/nginx/fastcgi_params",
  maps: "/etc/nginx/sites-enabled/00-clp-addons-visitor-ip.conf",
  cloudflareIps: CLOUDFLARE_IPS_PATH,
  nginx: "nginx",
  systemctl: "systemctl",
  rootUid: ROOT_UID,
};

type Paths = typeof DEFAULT_VISITOR_IP_PATHS;

export interface VisitorIpOptions {
  paths?: Partial<Paths>;
  run?: (command: string, args: string[]) => CommandResult;
}

const UNTRUSTED_LOOPBACK = "#clp-addons:hop ";

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

const line = (edit: Edit, text: string) => new RegExp(`${edit.lead.source}${literal(text)}(?=[ \\t;']|$)`, "m");

function swap(content: string, file: keyof typeof EDITS, on: boolean): string {
  return EDITS[file].reduce((text, edit) => {
    const [from, to] = on ? [edit.off, edit.on] : [edit.on, edit.off];
    return text.replace(line(edit, from), (_match, start: string) => `${start}${to}`);
  }, content);
}

function mapsContent(paths: Paths): string {
  return `${MAPS_MARKER}\n${cloudflareVisitorMaps("clp_visitor", cloudflareRanges(paths.cloudflareIps), "$remote_addr")}`;
}

function read(path: string): string | null {
  try { return readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export interface VisitorIpStatus {
  /** Whether the map is current and nothing that could use it still uses the plain address. */
  applied: boolean;
  problem: string;
}

export function visitorIpStatus(options: VisitorIpOptions = {}): VisitorIpStatus {
  const paths = { ...DEFAULT_VISITOR_IP_PATHS, ...options.paths };
  try {
    let applied = read(paths.maps) === mapsContent(paths);
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
  return withNginxTransaction(null, { nginx: paths.nginx, systemctl: paths.systemctl }, run, (changes) => {
    for (const file of files) {
      if (read(paths[file]) === null) continue;
      const change = nginxFileChange(paths[file], null, paths.rootUid);
      change.content = swap(change.backup.content!, file, on);
      changes.push(change);
    }
    // Off keeps the map while a file still names it, so Nginx can load it.
    const named = !on && changes.some((change) => change.content?.includes(VISITOR_IP));
    if (reload && !foreign) changes.push(nginxFileChange(paths.maps, on || named ? mapsContent(paths) : null, paths.rootUid));
  }, { reload }).changed;
}

export function applyVisitorIp(on: boolean, options: VisitorIpOptions = {}): boolean {
  return apply(on, options, true, ["nginxConf", "fastcgiParams"]);
}

/** Gives one dpkg conffile its package text back, without a reload, so an upgrade can replace it. */
export function releaseVisitorIp(file: keyof typeof EDITS, options: VisitorIpOptions = {}): boolean {
  return apply(false, options, false, [file]);
}

type VisitorIpState = VisitorIpStatus & { enabled: boolean };

function visitorIpLine(state: VisitorIpState): string {
  if (state.problem) return `${badge("Unknown", "warn")} <span>${esc(state.problem)}</span>`;
  if (state.enabled && state.applied) return `${badge("On", "ok")} <span>Behind Cloudflare, sites see the visitor's IP.</span>`;
  if (state.enabled) return `${badge("Not applied", "warn")} <span>Run clp-addons repair.</span>`;
  return `${badge("Off", "plain")} <span>Behind Cloudflare, sites see Cloudflare's or the tunnel's address.</span>`;
}

/** Read the visitor's IP from CF-Connecting-IP when Cloudflare or cloudflared on this server set it. */
export const VISITOR_IP_TWEAK = tweak<{ cloudflareVisitorIp: boolean }, { visitorIp?: VisitorIpOptions }, { visitorIp: VisitorIpState }>()({
  defaults: { cloudflareVisitorIp: true },
  state: ({ options, settings }) => ({ visitorIp: { ...visitorIpStatus(options.visitorIp), enabled: settings.cloudflareVisitorIp } }),
  switch: {
    verb: "set-visitor-ip",
    key: "cloudflareVisitorIp",
    timeout: REAL_IP_GATEWAY_TIMEOUT_MS,
    set: applyThenSave("cloudflareVisitorIp", (on, options: { visitorIp?: VisitorIpOptions }) => applyVisitorIp(on, options.visitorIp)),
  },
  repair: {
    upkeep: {
      label: null,
      locked: true,
      run: ({ options, settings }) => settings.cloudflareVisitorIp && applyVisitorIp(true, options.visitorIp) && "Cloudflare visitor IPs reapplied",
    },
  },
  withdraw: { run: ({ options }) => { applyVisitorIp(false, options.visitorIp); } },
  restore: { run: ({ options, settings }) => { if (settings.cloudflareVisitorIp) applyVisitorIp(true, options.visitorIp); } },
  row: ({ visitorIp }, locked) => switchRow("set-visitor-ip", {
    key: "cloudflareVisitorIp",
    title: "Cloudflare visitor IPs",
    description: [
      "Site access logs and PHP take the visitor's IP from CF-Connecting-IP when Cloudflare's proxy or a Cloudflare Tunnel on this server sent the request. Anyone else's header is ignored, and so is an X-Real-IP sent through a tunnel.",
      "Error logs and Cloudflare-only access still see Cloudflare's or the tunnel's address.",
    ],
    checked: visitorIp.enabled,
    extra: statusLine(visitorIpLine(visitorIp)),
  }, locked),
});
