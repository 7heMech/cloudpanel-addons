import { readdirSync, readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { PANEL_CACHE_POOL_DIR } from "../cli/paths";

const CACHE_SCAN_MAX_FILES = 512;
const CACHE_ITEM_MAX_BYTES = 8 * 1024;

/**
 * The address CloudPanel prints in its own site information, read from the
 * panel's cache rather than resolved here.
 *
 * CloudPanel asks an external service for the instance's public IPv4 and caches
 * the answer for an hour; there is no column for it. A site-scoped addon page
 * reproduces the panel's site information, and the only honest value to print
 * there is the one the panel is currently serving from that cache. Anything
 * this function cannot read or that has expired returns "", and the caller
 * leaves the field out rather than showing an address the panel would not.
 */
export function readPanelPublicIp(poolDir = PANEL_CACHE_POOL_DIR): string {
  let budget = CACHE_SCAN_MAX_FILES;
  const walk = (directory: string): string => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return "";
    }
    for (const entry of entries) {
      if (budget <= 0) return "";
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        const nested = walk(full);
        if (nested) return nested;
        continue;
      }
      if (!entry.isFile()) continue;
      budget--;
      let raw: string;
      try {
        if (statSync(full).size > CACHE_ITEM_MAX_BYTES) continue;
        raw = readFileSync(full, "latin1");
      } catch {
        continue;
      }
      // Symfony's filesystem pool writes the expiry, then the item key, then
      // the serialized value, one per line.
      const [expiry, key, ...rest] = raw.split("\n");
      if (key !== "ipv4_public_ip") continue;
      const expiresAt = Number.parseInt(expiry ?? "", 10);
      if (!Number.isInteger(expiresAt) || (expiresAt !== 0 && expiresAt * 1000 < Date.now())) return "";
      for (const [, value] of rest.join("\n").matchAll(/s:\d+:"([^"]*)"/g)) {
        if (value && isIP(value)) return value;
      }
      return "";
    }
    return "";
  };
  return walk(poolDir);
}
