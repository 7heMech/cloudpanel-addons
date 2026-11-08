/** Transfer the unreleased System Tweaks memory policy without rewriting its hardening settings. */
import { errorMessage } from "../../lib/errors";
import { addonConfigFile, addonStateDir, SYSTEMD_DIR } from "../../lib/paths";
import { existsSync, lstatSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { writeFileAtomic } from "../../lib/atomic-write";
import { isTrustedFile } from "../../lib/trusted-file";
import { log } from "../../lib/log";
import { DEFAULT_MEMORY, validMemorySettings, type MemorySettings } from "./memory";

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

/** A file that cannot be trusted leaves both sides as they were, and the next repair tries again. */
const skipped = (why: string) => {
  log.warn(`System Tweaks' memory settings were not moved to Resource Limits: ${why}`);
  return null;
};

/**
 * A rollback is kept in memory only: no old-id aliases or backups remain on the box.
 *
 * Settings that cannot move cleanly -- invalid, or different from Resource
 * Limits' own -- are dropped from System Tweaks with one warning naming them:
 * Resource Limits never reads them, and kept they would warn on every repair.
 */
export function migrateResourceMemory(enable: () => void): (() => void) | null {
  let source: SavedFile | null;
  let stored: Record<string, unknown> | null = null;
  let runtime: SavedFile | null;
  try {
    source = snapshot(`${addonStateDir("system-tweaks")}/settings.json`);
    runtime = snapshot(`${addonStateDir("system-tweaks")}/memory.json`);
  } catch (error) {
    return skipped(errorMessage(error));
  }
  // System Tweaks itself ignores a settings file it cannot parse.
  try { stored = source ? JSON.parse(source.text) as Record<string, unknown> : null; } catch { stored = null; }
  const hasMemory = stored?.version === 1 && Object.hasOwn(stored, "memory");
  // Early dev installs could have applied the default without ever saving settings.
  const defaultOom = [`${SYSTEMD_DIR}/nginx.service.d/zz-clp-addons-oom.conf`]
    .some((path) => existsSync(path) && readFileSync(path, "utf8").includes("clp-addons System Tweaks:"));
  // The policy may already have moved before a restart, with upkeep still to
  // rewrite the old drop-in comment. Do not mistake that for an unsaved default.
  if (!hasMemory && !runtime && existsSync(`${addonStateDir("resource-limits")}/settings.json`)) return null;
  if (!hasMemory && !runtime && !defaultOom) return null;
  const valid = !hasMemory || validMemorySettings(stored!.memory);
  const savedMemory = hasMemory && valid ? stored!.memory as MemorySettings : { ...DEFAULT_MEMORY };
  const targetDir = addonStateDir("resource-limits");
  const directoryExisted = existsSync(targetDir);
  const settingsPath = `${targetDir}/settings.json`;
  const runtimePath = `${targetDir}/memory.json`;
  const configPath = addonConfigFile("resource-limits");
  const sourceEnabled = existsSync(addonConfigFile("system-tweaks"));
  // PHP may have been enabled while System Tweaks was off. Combining the addons
  // must not silently reactivate the disabled source's saved memory switches.
  const memory = !sourceEnabled && existsSync(configPath)
    ? { ...savedMemory, mysql: false, redis: false, oom: false } : savedMemory;
  const originals = new Map<string, SavedFile | null>();
  const keep = (path: string) => { if (!originals.has(path)) originals.set(path, snapshot(path)); };
  const undo = () => {
    for (const [path, before] of [...originals].reverse()) {
      if (before) restore(before); else rmSync(path, { force: true });
    }
    if (!directoryExisted && existsSync(targetDir)) rmdirSync(targetDir);
  };
  const dropped: string[] = [];
  try {
    const target = snapshot(settingsPath);
    let targetSettings: { version?: unknown; memory?: Record<string, unknown> } | null = null;
    try { targetSettings = target ? JSON.parse(target.text) : null; } catch { targetSettings = null; }
    const existingMemory = targetSettings?.memory;
    // A previous attempt's identical copy is the same policy, not a conflict.
    const same = !!target && targetSettings?.version === 1 && validMemorySettings(existingMemory)
      && (["profile", "mysql", "redis", "oom"] as const).every((key) => existingMemory![key] === memory[key]);
    let moved = false;
    if (!valid) dropped.push(`${JSON.stringify(stored!.memory)} is not valid`);
    else if (target && !same) dropped.push(`${JSON.stringify(memory)} differs from Resource Limits' own`);
    else {
      keep(settingsPath);
      if (!target) writeFileAtomic(settingsPath, `${JSON.stringify({ version: 1, memory }, null, 2)}\n`, { mode: 0o600, createParent: true });
      moved = true;
    }
    if (runtime) {
      const existing = snapshot(runtimePath);
      keep(runtime.path);
      if (existing && existing.text !== runtime.text) dropped.push("its runtime state differs from Resource Limits' own");
      else if (!existing) { keep(runtimePath); restore({ ...runtime, path: runtimePath }); }
      rmSync(runtime.path);
    }
    if (moved && sourceEnabled && (memory.mysql || memory.redis || memory.oom) && !existsSync(configPath)) {
      keep(configPath); enable();
    }
    if (source && hasMemory) {
      keep(source.path);
      delete stored!.memory;
      restore({ ...source, text: `${JSON.stringify(stored, null, 2)}\n` });
    }
    if (dropped.length) {
      log.warn(`System Tweaks' memory settings were dropped, not moved: ${dropped.join("; ")}. Resource Limits keeps its own; check them on its page`);
    }
    return undo;
  } catch (error) {
    undo();
    return skipped(errorMessage(error));
  }
}
