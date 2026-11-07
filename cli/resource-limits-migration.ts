/** Transfer the unreleased System Tweaks memory policy without rewriting its hardening settings. */
import { existsSync, lstatSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { CONFIG_DIR, STATE_DIR, SYSTEMD_DIR } from "./paths";
import { writeFileAtomic } from "../lib/atomic-write";
import { DEFAULT_MEMORY, validMemorySettings } from "../addons/resource-limits/memory";

interface SavedFile { path: string; text: string; mode: number; uid: number; gid: number }
function snapshot(path: string): SavedFile | null {
  if (!existsSync(path)) return null;
  const info = lstatSync(path);
  if (!info.isFile() || info.uid !== (process.getuid?.() ?? 0) || (info.mode & 0o022)) throw new Error(`refusing untrusted migration file ${path}`);
  return { path, text: readFileSync(path, "utf8"), mode: info.mode & 0o777, uid: info.uid, gid: info.gid };
}
function restore(file: SavedFile): void {
  writeFileAtomic(file.path, file.text, { mode: file.mode, owner: { uid: file.uid, gid: file.gid }, createParent: true });
}

/** A rollback is kept in memory only: no old-id aliases or backups remain on the box. */
export function migrateResourceMemory(enable: () => void): (() => void) | null {
  const source = snapshot(`${STATE_DIR}/system-tweaks/settings.json`);
  const stored = source ? JSON.parse(source.text) as Record<string, unknown> : null;
  const runtime = snapshot(`${STATE_DIR}/system-tweaks/memory.json`);
  const hasMemory = stored?.version === 1 && Object.hasOwn(stored, "memory");
  // Early dev installs could have applied the default without ever saving settings.
  const defaultOom = [`${SYSTEMD_DIR}/nginx.service.d/zz-clp-addons-oom.conf`]
    .some((path) => existsSync(path) && readFileSync(path, "utf8").includes("clp-addons System Tweaks:"));
  // The policy may already have moved before a restart, with upkeep still to
  // rewrite the old drop-in comment. Do not mistake that for an unsaved default.
  if (!hasMemory && !runtime && existsSync(`${STATE_DIR}/resource-limits/settings.json`)) return null;
  if (!hasMemory && !runtime && !defaultOom) return null;
  if (hasMemory && !validMemorySettings(stored!.memory)) throw new Error("cannot migrate invalid System Tweaks memory settings");
  const savedMemory = hasMemory && validMemorySettings(stored!.memory) ? stored!.memory : { ...DEFAULT_MEMORY };
  const targetDir = `${STATE_DIR}/resource-limits`;
  const directoryExisted = existsSync(targetDir);
  const settingsPath = `${targetDir}/settings.json`;
  const runtimePath = `${targetDir}/memory.json`;
  const configPath = `${CONFIG_DIR}/resource-limits.conf`;
  const sourceEnabled = existsSync(`${CONFIG_DIR}/system-tweaks.conf`);
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
  try {
    // A previous attempt's identical copy is safe; conflicting policies must never be silently discarded.
    const target = snapshot(settingsPath);
    const targetSettings = target ? JSON.parse(target.text) : null;
    const existingMemory = targetSettings?.memory;
    if (target && (targetSettings?.version !== 1 || !validMemorySettings(existingMemory) || (["profile", "mysql", "redis", "oom"] as const).some((key) => existingMemory[key] !== memory[key]))) {
      throw new Error("both addons hold different memory settings; refusing to discard either policy");
    }
    keep(settingsPath);
    if (!target) writeFileAtomic(settingsPath, `${JSON.stringify({ version: 1, memory }, null, 2)}\n`, { mode: 0o600, createParent: true });
    if (runtime) {
      const existing = snapshot(runtimePath);
      if (existing && existing.text !== runtime.text) throw new Error("both addons hold different memory runtime state");
      keep(runtimePath); keep(runtime.path);
      if (!existing) restore({ ...runtime, path: runtimePath });
      rmSync(runtime.path);
    }
    if (sourceEnabled && (memory.mysql || memory.redis || memory.oom) && !existsSync(configPath)) {
      keep(configPath); enable();
    }
    if (source && hasMemory) {
      keep(source.path);
      delete stored!.memory;
      restore({ ...source, text: `${JSON.stringify(stored, null, 2)}\n` });
    }
    return undo;
  } catch (error) { undo(); throw error; }
}
