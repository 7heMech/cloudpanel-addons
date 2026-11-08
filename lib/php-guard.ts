// Platform PHP hardening, applied regardless of which addons are enabled.
// An enabled addon may switch it off (System Tweaks shows it and offers the
// switch); the caller says whether one has.
//
// Session upload progress is one of the confirmed consumers of CVE-2026-109619
// ("php2shell"), is on by default, and needs no session_start(); PHP's advisory
// names disabling it as the administrative mitigation and recommends keeping it
// off even after patching, as a hardly-used, hardly-tested feature. This writes
// that setting on every installed PHP-FPM, including the end-of-life 8.1 the
// panel runs on unless System Tweaks moved it. It does not address
// CVE-2026-109618, whose only real fix is patched PHP; see
// docs/decisions/security.md.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeOrRemove } from "./atomic-write";
import { trustedText } from "./trusted-file";
import { PANEL_FPM_UNIT, PHP_FPM_BIN_DIR, PHP_GUARD_INI_NAME, PHP_ROOT, ROOT_UID } from "./paths";
import { errorMessage } from "./errors";
import { withRecoveryFailures } from "./nginx-transaction";
import { unitActive } from "./systemd";
import { log } from "./log";
import { tryRun } from "./command";

const INI_BODY = "; Managed by clp-addons: CVE-2026-109619 session upload-progress mitigation\nsession.upload_progress.enabled = Off\n";
const VERSION_RE = /^[0-9]+\.[0-9]+$/;

interface PhpGuardPaths {
  phpRoot: string;
  fpmBinDir: string;
  panelFpmUnit: string;
  /** The uid a drop-in must belong to for its contents to be trusted. */
  rootUid: number;
}

const DEFAULT_PHP_GUARD_PATHS: PhpGuardPaths = {
  phpRoot: PHP_ROOT,
  fpmBinDir: PHP_FPM_BIN_DIR,
  panelFpmUnit: PANEL_FPM_UNIT,
  rootUid: ROOT_UID,
};

export interface PhpGuardOptions {
  /** An enabled addon has the guard switched off. */
  optedOut?: boolean;
  paths?: Partial<PhpGuardPaths>;
  run?: (cmd: string, args: string[]) => { ok: boolean; out: string };
  isActive?: (unit: string) => boolean;
}

interface FpmTarget {
  version: string;
  path: string;
  /** False for a version whose FPM package was removed but whose conf.d stayed. */
  present: boolean;
}

function fpmTargets(paths: PhpGuardPaths): FpmTarget[] {
  if (!existsSync(paths.phpRoot)) return [];
  return readdirSync(paths.phpRoot)
    .filter((version) => VERSION_RE.test(version) && existsSync(join(paths.phpRoot, version, "fpm", "conf.d")))
    .sort()
    .map((version) => ({
      version,
      path: join(paths.phpRoot, version, "fpm", "conf.d", PHP_GUARD_INI_NAME),
      present: existsSync(join(paths.fpmBinDir, `php-fpm${version}`)),
    }));
}

function current(path: string, rootUid: number): string | null {
  // Owner and mode, not content alone: a drop-in left group- or world-writable,
  // or replaced by a symlink, is one the next reconcile should rewrite to 0644.
  return trustedText(path, rootUid);
}

interface PhpGuardStatus {
  guarded: string[];
  unguarded: string[];
  /** Switched off by an enabled addon, so a missing drop-in is wanted. */
  optedOut: boolean;
}

export function inspectPhpGuard(options: PhpGuardOptions = {}): PhpGuardStatus {
  const paths = { ...DEFAULT_PHP_GUARD_PATHS, ...options.paths };
  const guarded: string[] = [];
  const unguarded: string[] = [];
  for (const target of fpmTargets(paths)) {
    if (!target.present) continue;
    (current(target.path, paths.rootUid) === INI_BODY ? guarded : unguarded).push(target.version);
  }
  return { guarded, unguarded, optedOut: options.optedOut ?? false };
}

/** The panel's own FPM is reloaded too: it scans the `conf.d` of whichever version runs it. */
export function reconcilePhpSessionGuard(install: boolean, options: PhpGuardOptions = {}): number {
  const paths = { ...DEFAULT_PHP_GUARD_PATHS, ...options.paths };
  const run = options.run ?? ((cmd: string, args: string[]) => tryRun(cmd, args));
  const isActive = options.isActive ?? ((unit: string) => unitActive(unit) === "active");

  const changes = fpmTargets(paths).flatMap((target) => {
    const before = current(target.path, paths.rootUid);
    const after = install && target.present ? INI_BODY : null;
    return before === after ? [] : [{ ...target, before, after }];
  });
  if (changes.length === 0) return 0;

  const write = (path: string, content: string | null) => writeOrRemove(path, content, { mode: 0o644 });
  const written: typeof changes = [];
  const attemptedReloads: string[] = [];
  const reload = (unit: string) => {
    const result = run("systemctl", ["reload", unit]);
    if (!result.ok) throw new Error(`${unit} reload failed: ${result.out}`);
  };

  try {
    for (const change of changes) {
      written.push(change);
      write(change.path, change.after);
    }
    const reloadable = [...new Set(changes.filter((change) => change.present).map((change) => change.version))];
    for (const version of reloadable) {
      const test = run(join(paths.fpmBinDir, `php-fpm${version}`), ["-t"]);
      if (!test.ok) throw new Error(`php-fpm${version} rejected the config: ${test.out}`);
    }
    for (const unit of [...reloadable.map((version) => `php${version}-fpm.service`), paths.panelFpmUnit]) {
      if (!isActive(unit)) continue;
      attemptedReloads.push(unit);
      reload(unit);
    }
  } catch (error) {
    const failures: string[] = [];
    for (const change of written) {
      try { write(change.path, change.before); }
      catch (restoreError) { failures.push(`${change.path}: ${errorMessage(restoreError)}`); }
    }
    if (failures.length === 0) {
      for (const unit of attemptedReloads) {
        try { reload(unit); }
        catch (reloadError) { failures.push(errorMessage(reloadError)); }
      }
    } else if (attemptedReloads.length) failures.push("rollback reloads skipped because file restoration failed");
    throw withRecoveryFailures(error, "PHP guard rollback failed", failures);
  }
  return changes.length;
}

/**
 * After a disable: System Tweaks' opt-out may just have stopped counting. The
 * addon is already gone, so a failure warns and leaves the guard to the repair
 * timer.
 */
export function settlePhpGuard(options: PhpGuardOptions = {}): void {
  try {
    reconcilePhpGuard(true, false, options);
  } catch (error) {
    log.warn(`PHP upload-progress guard not reconciled, repair will retry: ${errorMessage(error)}`);
  }
}

/** `install` is whether any addon is installed; System Tweaks' opt-out can still keep it off. */
export function reconcilePhpGuard(install: boolean, quiet = false, options: PhpGuardOptions = {}): void {
  const wanted = install && !options.optedOut;
  const changed = reconcilePhpSessionGuard(wanted, options);
  if (changed > 0 && !quiet) {
    log.ok(wanted
      ? `PHP upload-progress disabled (${changed} updated)`
      : install
        ? `PHP upload-progress guard off in System Tweaks (${changed} updated)`
        : `PHP upload-progress guard removed (${changed} updated)`);
  }
}
