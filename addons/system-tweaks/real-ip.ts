/**
 * CloudPanel's two nginx.conf files, the sites' and the panel's, trust the
 * client IP header from every address. Commenting out that one line in each
 * leaves loopback and private-network proxies trusted. The panel also trusts
 * Cloudflare: its X-Forwarded-For ends with the address Cloudflare received, so
 * a panel behind Cloudflare keeps its visitors. The sites' X-Real-IP is passed
 * through Cloudflare unchanged, so trusting Cloudflare there would reopen it.
 */
import { errorMessage } from "../../lib/errors";
import { existsSync, readFileSync } from "node:fs";
import { runCommand, type CommandResult } from "../../lib/command";
import {
  cloudflareRanges, nginxFileChange, trustedVhost, withNginxTransaction, type NginxFileOwner, type NginxGroupWrite,
} from "../../lib/nginx-transaction";
import { CLOUDFLARE_IPS_PATH, ROOT_UID, nginxLayout } from "../../lib/paths";
import { panelUserGid, panelUserUid } from "../../lib/sso-auth";
import { COMMAND_MS, REAL_IP_GATEWAY_TIMEOUT_MS } from "./limits";
import { applyThenSave, tweak } from "./tweak";
import { badge, statusLine, switchRow } from "./app/rows";
import { esc } from "../../lib/app-http";

export const REAL_IP_MARKER = "#clp-addons:untrusted ";
const ANY = /^([ \t]*)(set_real_ip_from[ \t]+(?:0\.0\.0\.0\/0|::\/0)[ \t]*;)[ \t]*$/gm;
const MARKED = new RegExp(`^([ \\t]*)${REAL_IP_MARKER}(set_real_ip_from[ \\t]+(?:0\\.0\\.0\\.0\\/0|::\\/0)[ \\t]*;)[ \\t]*$`, "gm");
const PROXIES_START = "# clp-addons:cloudflare-proxies:start";
const PROXIES_END = "# clp-addons:cloudflare-proxies:end";
const PROXIES = new RegExp(`^[ \\t]*${PROXIES_START}\\n(?:.*\\n)*?[ \\t]*${PROXIES_END}\\n`, "gm");

export const DEFAULT_REAL_IP_PATHS = {
  nginxConf: "/etc/nginx/nginx.conf",
  /** CloudPanel 6's own Nginx; null on the older layout, where the panel shares the sites' instance. */
  panelConf: nginxLayout().configFile as string | null,
  panelUid: null as number | null,
  panelGid: null as number | null,
  cloudflareIps: CLOUDFLARE_IPS_PATH,
  nginx: "nginx",
  systemctl: "systemctl",
  rootUid: ROOT_UID,
  rootGid: 0,
};

export interface RealIpOptions {
  paths?: Partial<typeof DEFAULT_REAL_IP_PATHS>;
  run?: (command: string, args: string[]) => CommandResult;
}

export interface RealIpStatus {
  /** Whether either nginx.conf still lets any address set the visitor IP. */
  trustsAnyAddress: boolean;
  /** A file could not be read as a trusted one; says why. */
  problem: string;
}

interface Instance {
  conf: string;
  uid: NginxFileOwner;
  groupWritable: NginxGroupWrite;
  config?: string;
  service?: string;
  /** Proxies trusted in place of every address. */
  proxies: string[];
}

/** Comments out the trust in every address and, after it, trusts `proxies`. */
export function withoutAnyAddress(content: string, proxies: string[] = []): string {
  const marked = content.replace(PROXIES, "")
    .replace(ANY, (_line, indent: string, directive: string) => `${indent}${REAL_IP_MARKER}${directive}`);
  if (proxies.length === 0) return marked;
  return marked.replace(new RegExp(MARKED.source, "m"), (line, indent: string) =>
    [line, `${indent}${PROXIES_START}`, ...proxies.map((proxy) => `${indent}set_real_ip_from ${proxy};`), `${indent}${PROXIES_END}`].join("\n"));
}

export function withAnyAddress(content: string): string {
  return content.replace(PROXIES, "").replace(MARKED, (_line, indent: string, directive: string) => `${indent}${directive}`);
}

function instances(options: RealIpOptions): { sites: Instance; panel: Instance | null } {
  const paths = { ...DEFAULT_REAL_IP_PATHS, ...options.paths };
  const sites = { conf: paths.nginxConf, uid: paths.rootUid, groupWritable: false, proxies: [] };
  if (!paths.panelConf || !existsSync(paths.panelConf)) return { sites, panel: null };
  // CloudPanel's mode 770 is valid with either its own account or root as owner.
  const uid = paths.panelUid ?? panelUserUid() ?? paths.rootUid;
  const gid = paths.panelGid ?? panelUserGid();
  return { sites, panel: {
    conf: paths.panelConf, uid: [uid, paths.rootUid], groupWritable: [paths.rootGid, ...(gid === null ? [] : [gid])],
    config: paths.panelConf, service: "clp-nginx",
    proxies: cloudflareRanges(paths.cloudflareIps),
  } };
}

export function realIpStatus(options: RealIpOptions = {}): RealIpStatus {
  const { sites, panel } = instances(options);
  const problems: string[] = [];
  let trustsAnyAddress = false;
  for (const instance of panel ? [sites, panel] : [sites]) {
    try {
      const { content } = trustedVhost(instance.conf, instance.uid, instance.groupWritable);
      if (new RegExp(ANY.source, "m").test(content)) trustsAnyAddress = true;
    } catch (error) {
      problems.push(errorMessage(error));
    }
  }
  return { trustsAnyAddress, problem: problems.join("; ") };
}

function applyTo(instance: Instance, wanted: (content: string) => string, options: RealIpOptions, reload: boolean): boolean {
  const paths = { ...DEFAULT_REAL_IP_PATHS, ...options.paths };
  let current: string;
  try { current = readFileSync(instance.conf, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (wanted(current) === current) return false;
  const run = options.run ?? ((command, args) => runCommand(command, args, COMMAND_MS));
  const nginx = { nginx: paths.nginx, systemctl: paths.systemctl, config: instance.config, service: instance.service };
  return withNginxTransaction(null, nginx, run, (changes) => {
    const conf = nginxFileChange(instance.conf, null, instance.uid, instance.groupWritable);
    if (conf.backup.content === null) return;
    conf.content = wanted(conf.backup.content);
    changes.push(conf);
  }, { reload }).changed;
}

export function applyRealIp(blockForged: boolean, options: RealIpOptions = {}): boolean {
  const { sites, panel } = instances(options);
  const wanted = (instance: Instance) => blockForged
    ? (content: string) => withoutAnyAddress(content, instance.proxies)
    : withAnyAddress;
  const before = existsSync(sites.conf) ? readFileSync(sites.conf, "utf8") : null;
  const changed = applyTo(sites, wanted(sites), options, true);
  try {
    return (panel ? applyTo(panel, wanted(panel), options, true) : false) || changed;
  } catch (error) {
    // Both or neither: the panel's refusal puts the sites' file back as it was.
    if (changed && before !== null) applyTo(sites, () => before, options, true);
    throw error;
  }
}

/**
 * Gives the sites' nginx.conf, a dpkg conffile, back its package text without a
 * reload, so a package upgrade can replace it. The panel's file is not a conffile.
 */
export function releaseRealIp(options: RealIpOptions = {}): boolean {
  return applyTo(instances(options).sites, withAnyAddress, options, false);
}

type RealIpState = RealIpStatus & { blockForged: boolean };

function realIpLine(state: RealIpState): string {
  if (state.problem) return `${badge("Unknown", "warn")} <span>${esc(state.problem)}</span>`;
  if (!state.trustsAnyAddress) return `${badge("Blocked", "ok")} <span>Only local and private-network proxies can set the visitor IP.</span>`;
  return `${badge("Trusted", state.blockForged ? "warn" : "plain")} <span>Any client can set its own IP with a header.${
    state.blockForged ? " Run clp-addons repair." : ""}</span>`;
}

/** Stop nginx.conf trusting X-Real-IP from every address. */
export const REAL_IP_TWEAK = tweak<{ blockForgedRealIp: boolean }, { realIp?: RealIpOptions }, { realIp: RealIpState }>()({
  defaults: { blockForgedRealIp: true },
  state: ({ options, settings }) => ({ realIp: { ...realIpStatus(options.realIp), blockForged: settings.blockForgedRealIp } }),
  switch: {
    verb: "set-real-ip",
    key: "blockForgedRealIp",
    timeout: REAL_IP_GATEWAY_TIMEOUT_MS,
    set: applyThenSave("blockForgedRealIp", (on, options: { realIp?: RealIpOptions }) => applyRealIp(on, options.realIp)),
  },
  repair: {
    upkeep: {
      label: null,
      locked: true,
      run: ({ options, settings }) => settings.blockForgedRealIp && applyRealIp(true, options.realIp) && "visitor-IP trust narrowed again",
    },
  },
  withdraw: { run: ({ options }) => { applyRealIp(false, options.realIp); } },
  restore: { run: ({ options, settings }) => { if (settings.blockForgedRealIp) applyRealIp(true, options.realIp); } },
  row: ({ realIp }, locked) => switchRow("set-real-ip", {
    key: "blockForgedRealIp",
    title: "Block forged visitor IPs",
    description: [
      "Stops any client from naming its own IP with a header to PHP, logs, basic auth and Cloudflare-only access.",
      "Local proxies stay trusted, and the panel also trusts Cloudflare. Switch it off only behind another public proxy.",
    ],
    checked: realIp.blockForged,
    extra: statusLine(realIpLine(realIp)),
  }, locked),
});
