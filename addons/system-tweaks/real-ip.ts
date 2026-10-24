/**
 * CloudPanel's two nginx.conf files, the sites' and the panel's, trust the
 * client IP header from every address. Commenting out that one line in each
 * leaves loopback and private-network proxies trusted.
 */
import { existsSync, readFileSync } from "node:fs";
import { runCommand, type CommandResult } from "../../cli/action-common";
import { nginxFileChange, trustedVhost, withNginxTransaction } from "../../cli/nginx-transaction";
import { ROOT_UID, nginxLayout } from "../../cli/paths";
import { panelUserUid } from "../../lib/sso-auth";
import { COMMAND_MS } from "./limits";

export const REAL_IP_MARKER = "#clp-addons:untrusted ";
const MARK = REAL_IP_MARKER;
const ANY = /^([ \t]*)(set_real_ip_from[ \t]+(?:0\.0\.0\.0\/0|::\/0)[ \t]*;)[ \t]*$/gm;
const MARKED = new RegExp(`^([ \\t]*)${MARK}(set_real_ip_from[ \\t]+(?:0\\.0\\.0\\.0\\/0|::\\/0)[ \\t]*;)[ \\t]*$`, "gm");

export const DEFAULT_REAL_IP_PATHS = {
  nginxConf: "/etc/nginx/nginx.conf",
  /** CloudPanel 6's own Nginx; null on the older layout, where the panel shares the sites' instance. */
  panelConf: nginxLayout().configFile as string | null,
  panelUid: null as number | null,
  nginx: "nginx",
  systemctl: "systemctl",
  rootUid: ROOT_UID,
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
  uid: number;
  groupWritable: boolean;
  config?: string;
  service?: string;
}

export function withoutAnyAddress(content: string): string {
  return content.replace(ANY, (_line, indent: string, directive: string) => `${indent}${MARK}${directive}`);
}

export function withAnyAddress(content: string): string {
  return content.replace(MARKED, (_line, indent: string, directive: string) => `${indent}${directive}`);
}

function instances(options: RealIpOptions): { sites: Instance; panel: Instance | null } {
  const paths = { ...DEFAULT_REAL_IP_PATHS, ...options.paths };
  const sites = { conf: paths.nginxConf, uid: paths.rootUid, groupWritable: false };
  if (!paths.panelConf || !existsSync(paths.panelConf)) return { sites, panel: null };
  // The panel's files belong to its own account, mode 770.
  const uid = paths.panelUid ?? panelUserUid() ?? paths.rootUid;
  return { sites, panel: { conf: paths.panelConf, uid, groupWritable: true, config: paths.panelConf, service: "clp-nginx" } };
}

export function realIpStatus(options: RealIpOptions = {}): RealIpStatus {
  const { sites, panel } = instances(options);
  const problems: string[] = [];
  let trustsAnyAddress = false;
  for (const instance of panel ? [sites, panel] : [sites]) {
    try {
      const { content } = trustedVhost(instance.conf, instance.uid, instance.groupWritable);
      if (withoutAnyAddress(content) !== content) trustsAnyAddress = true;
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
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
  // Nothing to change needs no trust check, validation or reload.
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

/** Puts both files in the wanted state, validating and reloading each instance only on a change. */
export function applyRealIp(blockForged: boolean, options: RealIpOptions = {}): boolean {
  const { sites, panel } = instances(options);
  const wanted = blockForged ? withoutAnyAddress : withAnyAddress;
  const before = existsSync(sites.conf) ? readFileSync(sites.conf, "utf8") : null;
  const changed = applyTo(sites, wanted, options, true);
  try {
    return (panel ? applyTo(panel, wanted, options, true) : false) || changed;
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
