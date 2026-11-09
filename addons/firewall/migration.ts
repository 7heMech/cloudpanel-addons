/** Moves System Tweaks' firewall protocols to Firewall, after `cloudflare-ips` was renamed `firewall`. */
import { errorMessage } from "../../lib/errors";
import { addonConfigFile, addonStateDir } from "../../lib/paths";
import { existsSync, lstatSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { writeFileAtomic } from "../../lib/atomic-write";
import { isTrustedFile } from "../../lib/trusted-file";
import { log } from "../../lib/log";
import { DEFAULT_CLOUDFLARE_ACTION_PATHS } from "./action";
import { DEFAULT_FIREWALL_PATHS } from "./protocols";

export const LEGACY_PROTOCOLS_FILE = `${addonStateDir("system-tweaks")}/firewall.json`;

interface SavedFile { path: string; text: string; mode: number; uid: number; gid: number }
function snapshot(path: string): SavedFile | null {
  if (!existsSync(path)) return null;
  const info = lstatSync(path);
  if (!isTrustedFile(info, process.getuid?.() ?? 0)) throw new Error(`refusing untrusted migration file ${path}`);
  return { path, text: readFileSync(path, "utf8"), mode: info.mode & 0o777, uid: info.uid, gid: info.gid };
}
function restore(file: SavedFile): void {
  writeFileAtomic(file.path, file.text, { mode: file.mode, owner: { uid: file.uid, gid: file.gid }, createParent: true });
}

/**
 * Returns an undo kept in memory only, or null when there was nothing to move.
 * Firewall is enabled where System Tweaks was applying a protocol, so those
 * rules keep their UDP. Enabling it then must not start Cloudflare-only on new
 * sites from a policy left behind while Cloudflare IP Access was disabled.
 */
export function migrateFirewallProtocols(enable: () => void): (() => void) | null {
  let source: SavedFile | null;
  try {
    source = snapshot(LEGACY_PROTOCOLS_FILE);
  } catch (error) {
    log.warn(`System Tweaks' firewall protocols were not moved to Firewall: ${errorMessage(error)}`);
    return null;
  }
  if (!source) return null;
  const target = DEFAULT_FIREWALL_PATHS.stateFile;
  if (existsSync(target)) {
    log.warn(`System Tweaks' firewall protocols were not moved: ${target} exists. Keep the current one, remove ${source.path}, then run 'clp-addons repair'`);
    return null;
  }
  let stored: Record<string, unknown> | null = null;
  try { stored = JSON.parse(source.text) as Record<string, unknown>; } catch { stored = null; }
  const held = (value: unknown) => value !== null && typeof value === "object" && Object.keys(value).length > 0;
  const applied = existsSync(addonConfigFile("system-tweaks")) && stored?.withdrawn !== true
    && (held(stored?.protocols) || held(stored?.managed));

  const targetDir = addonStateDir("firewall");
  const directoryExisted = existsSync(targetDir);
  const configPath = addonConfigFile("firewall");
  const policyPath = DEFAULT_CLOUDFLARE_ACTION_PATHS.policyFile;
  const originals = new Map<string, SavedFile | null>();
  const keep = (path: string) => { if (!originals.has(path)) originals.set(path, snapshot(path)); };
  const undo = () => {
    for (const [path, before] of [...originals].reverse()) {
      if (before) restore(before); else rmSync(path, { force: true });
    }
    if (!directoryExisted && existsSync(targetDir)) rmdirSync(targetDir);
  };
  try {
    keep(target);
    restore({ ...source, path: target });
    keep(source.path);
    rmSync(source.path);
    if (applied && !existsSync(configPath)) {
      const policy = snapshot(policyPath);
      const parsed = policy ? JSON.parse(policy.text) as Record<string, unknown> : null;
      if (parsed?.autoEnableNewSites === true) {
        keep(policyPath);
        restore({ ...policy!, text: `${JSON.stringify({ ...parsed, autoEnableNewSites: false }, null, 2)}\n` });
        log.warn("Firewall's Enable on new sites was switched off: it was saved while Cloudflare IP Access was disabled");
      }
      keep(configPath);
      enable();
    }
    return undo;
  } catch (error) {
    undo();
    log.warn(`System Tweaks' firewall protocols were not moved to Firewall: ${errorMessage(error)}`);
    return null;
  }
}
