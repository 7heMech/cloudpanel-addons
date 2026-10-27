/**
 * Which CloudPanel sites are DNS's stand-ins: static sites that only serve a
 * redirect while DNS has no Cloudflare connection. They are redirects, not
 * sites, so every addon's site list leaves them out.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { STATE_DIR } from "./paths";

export const STAND_INS_FILE = `${STATE_DIR}/dns/standins.json`;

/** The stand-ins' domains; none when DNS has made none, or the record is not root's own. */
export function standInDomains(file = STAND_INS_FILE): Set<string> {
  try {
    if (!existsSync(file)) return new Set();
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) return new Set();
    return new Set(Object.keys(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>));
  } catch {
    return new Set();
  }
}
