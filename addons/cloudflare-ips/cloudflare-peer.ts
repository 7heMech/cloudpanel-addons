import { isIP } from "node:net";
import { readFileSync } from "node:fs";
import { failAction, runCommand, type CommandResult } from "../../cli/action-common";
import { nginxFileChange, trustedVhost, withNginxTransaction } from "../../cli/nginx-transaction";
import { CLOUDFLARE_IPS_PATH } from "../../cli/paths";
import { COMMAND_MS } from "./limits";

const START = "# clp-addons:cloudflare-peer:start";
const END = "# clp-addons:cloudflare-peer:end";
const GEO_MARKER = "# clp-addons:cloudflare-peer-geo\n";
export const CLOUDFLARE_PEER_BLOCK = `${START}
if ($clp_system_cf_peer = 0) {
    return 403;
}
${END}
`;

export interface CloudflarePeerOptions {
  paths?: Partial<typeof DEFAULT_CLOUDFLARE_PEER_PATHS>;
  run?: (command: string, args: string[]) => CommandResult;
}

export const DEFAULT_CLOUDFLARE_PEER_PATHS = {
  ips: CLOUDFLARE_IPS_PATH,
  geo: "/etc/nginx/sites-enabled/00-clp-addons-cloudflare-peer.conf",
  nginx: "nginx",
  systemctl: "systemctl",
  rootUid: 0,
};

export interface CloudflarePeerStatus {
  wanted: boolean;
  configured: boolean;
  available: boolean;
  problem: string;
}

function withoutBlock(content: string): string {
  if (!content.includes(START) && !content.includes(END)) return content;
  if (!content.startsWith(CLOUDFLARE_PEER_BLOCK) ||
      content.slice(CLOUDFLARE_PEER_BLOCK.length).includes(START) ||
      content.slice(CLOUDFLARE_PEER_BLOCK.length).includes(END)) {
    failAction("the clp-addons Cloudflare block has changed; restore it before changing this setting");
  }
  return content.slice(CLOUDFLARE_PEER_BLOCK.length);
}

export function cloudflarePeerRanges(content: string): string[] {
  const ranges: string[] = [];
  let denied = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    if (line === "deny all;" && !denied) { denied = true; continue; }
    const match = /^allow\s+([0-9a-fA-F.:]+)(?:\/(\d+))?\s*;$/.exec(line);
    const family = match ? isIP(match[1]!) : 0;
    const prefix = match?.[2] === undefined ? null : Number(match[2]);
    if (!match || !family || denied || (prefix !== null && prefix > (family === 4 ? 32 : 128))) {
      failAction("the Cloudflare IP list has custom or invalid rules; expected IP ranges followed by deny all");
    }
    ranges.push(`${match[1]}${prefix === null ? "" : `/${prefix}`}`);
  }
  if (!ranges.length || !denied) failAction("the Cloudflare IP list is empty or missing deny all");
  return [...new Set(ranges)];
}

export function cloudflarePeerGeo(ranges: string[]): string {
  return `${GEO_MARKER}geo $realip_remote_addr $clp_system_cf_peer {
    default 0;
${ranges.map((range) => `    ${range} 1;`).join("\n")}
}
`;
}

export function cloudflarePeerStatus(wanted: boolean, options: CloudflarePeerOptions = {}): CloudflarePeerStatus {
  const paths = { ...DEFAULT_CLOUDFLARE_PEER_PATHS, ...options.paths };
  try {
    const content = trustedVhost(paths.ips, paths.rootUid).content;
    const ranges = cloudflarePeerRanges(withoutBlock(content));
    const geo = nginxFileChange(paths.geo, null, paths.rootUid).backup.content;
    if (geo !== null && !geo.startsWith(GEO_MARKER)) failAction("the Cloudflare peer lookup file belongs to another configuration");
    const configured = content.startsWith(CLOUDFLARE_PEER_BLOCK) && geo === cloudflarePeerGeo(ranges);
    return { wanted, configured, available: true, problem: wanted && !configured ? "Configuration has drifted; run clp-addons repair." : "" };
  } catch (error) {
    return { wanted, configured: false, available: false, problem: error instanceof Error ? error.message : String(error) };
  }
}

export function applyCloudflarePeer(enabled: boolean, options: CloudflarePeerOptions = {}): boolean {
  const paths = { ...DEFAULT_CLOUDFLARE_PEER_PATHS, ...options.paths };
  if (!enabled) {
    const read = (path: string): string => {
      try { return readFileSync(path, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      }
    };
    const ips = read(paths.ips);
    if (!ips.includes(START) && !ips.includes(END) && !read(paths.geo).startsWith(GEO_MARKER)) return false;
  }
  const run = options.run ?? ((command, args) => runCommand(command, args, COMMAND_MS));
  return withNginxTransaction(null, paths, run, (changes) => {
    const ips = nginxFileChange(paths.ips, null, paths.rootUid);
    const geo = nginxFileChange(paths.geo, null, paths.rootUid);
    if (geo.backup.content !== null && !geo.backup.content.startsWith(GEO_MARKER)) {
      failAction("the Cloudflare peer lookup file belongs to another configuration");
    }
    const original = ips.backup.content;
    const clean = original === null ? null : withoutBlock(original);
    if (enabled) {
      if (clean === null) failAction("CloudPanel's Cloudflare IP list is missing");
      geo.content = cloudflarePeerGeo(cloudflarePeerRanges(clean));
      ips.content = CLOUDFLARE_PEER_BLOCK + clean;
    } else ips.content = clean;
    changes.push(geo, ips);
  }).changed;
}
