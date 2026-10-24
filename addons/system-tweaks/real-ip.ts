/**
 * CloudPanel's nginx.conf trusts X-Real-IP from every address. Commenting out
 * that one line leaves loopback and private-network proxies trusted.
 */
import { runCommand, type CommandResult } from "../../cli/action-common";
import { nginxFileChange, trustedVhost, withNginxTransaction } from "../../cli/nginx-transaction";
import { ROOT_UID } from "../../cli/paths";
import { COMMAND_MS } from "./limits";

const MARK = "#clp-addons:untrusted ";
const ANY = /^([ \t]*)(set_real_ip_from[ \t]+(?:0\.0\.0\.0\/0|::\/0)[ \t]*;)[ \t]*$/gm;
const MARKED = new RegExp(`^([ \\t]*)${MARK}(set_real_ip_from[ \\t]+(?:0\\.0\\.0\\.0\\/0|::\\/0)[ \\t]*;)[ \\t]*$`, "gm");

export const DEFAULT_REAL_IP_PATHS = {
  nginxConf: "/etc/nginx/nginx.conf",
  nginx: "nginx",
  systemctl: "systemctl",
  rootUid: ROOT_UID,
};

export interface RealIpOptions {
  paths?: Partial<typeof DEFAULT_REAL_IP_PATHS>;
  run?: (command: string, args: string[]) => CommandResult;
}

export interface RealIpStatus {
  /** Whether nginx.conf still lets any address set the visitor IP. */
  trustsAnyAddress: boolean;
  /** The file could not be read as a trusted root file; `problem` says why. */
  problem: string;
}

export function withoutAnyAddress(content: string): string {
  return content.replace(ANY, (_line, indent: string, directive: string) => `${indent}${MARK}${directive}`);
}

export function withAnyAddress(content: string): string {
  return content.replace(MARKED, (_line, indent: string, directive: string) => `${indent}${directive}`);
}

export function realIpStatus(options: RealIpOptions = {}): RealIpStatus {
  const paths = { ...DEFAULT_REAL_IP_PATHS, ...options.paths };
  try {
    const { content } = trustedVhost(paths.nginxConf, paths.rootUid);
    return { trustsAnyAddress: withoutAnyAddress(content) !== content, problem: "" };
  } catch (error) {
    return { trustsAnyAddress: false, problem: error instanceof Error ? error.message : String(error) };
  }
}

/** Puts nginx.conf in the wanted state, validating and reloading only on a change. */
export function applyRealIp(blockForged: boolean, options: RealIpOptions = {}): boolean {
  const paths = { ...DEFAULT_REAL_IP_PATHS, ...options.paths };
  const run = options.run ?? ((command, args) => runCommand(command, args, COMMAND_MS));
  return withNginxTransaction(null, paths, run, (changes) => {
    const conf = nginxFileChange(paths.nginxConf, null, paths.rootUid);
    if (conf.backup.content === null) return;
    conf.content = blockForged ? withoutAnyAddress(conf.backup.content) : withAnyAddress(conf.backup.content);
    changes.push(conf);
  }).changed;
}
