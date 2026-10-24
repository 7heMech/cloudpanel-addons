// A package upgrade wins over this project's edits to its conffiles.
// unattended-upgrades holds back a package whose modified conffile the upgrade
// would replace, since nobody is there to answer dpkg's prompt. So before its
// run, `clp-addons apt-hook pre` gives each edited file its package text back
// when that package has an upgrade waiting, and `apt-hook post` lets repair put
// the edits back on whatever the upgrade installed.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runCommand, type CommandResult } from "./action-common";
import { CONFFILES_RELEASED_FLAG } from "./paths";

/** Only when systemd cannot say whether the upgrade service still runs. */
const STALE_MS = 6 * 60 * 60 * 1000;
const UPGRADE_SERVICE = "apt-daily-upgrade.service";
const COMMAND_MS = 30_000;

export interface ConffileEdit {
  path: string;
  /** Text only this project's edit leaves in the file. */
  marker: string;
  /** Restores the package text without a reload; whether it wrote anything. */
  release: () => boolean;
}

type Run = (command: string, args: string[]) => CommandResult;

const defaultRun: Run = (command, args) => runCommand(command, args, COMMAND_MS);

/** Whether apt would upgrade the package that ships `path`. */
export function upgradePending(path: string, run: Run = defaultRun): boolean {
  const owner = run("dpkg-query", ["-S", path]);
  if (!owner.ok) return false;
  const line = owner.stdout.split("\n").find((entry) => entry.endsWith(`: ${path}`));
  const pkg = line?.slice(0, -`: ${path}`.length).split(",")[0]?.trim();
  if (!pkg) return false;
  const policy = run("apt-cache", ["policy", pkg]);
  if (!policy.ok) return false;
  const installed = /^\s*Installed:\s*(\S+)/m.exec(policy.stdout)?.[1];
  const candidate = /^\s*Candidate:\s*(\S+)/m.exec(policy.stdout)?.[1];
  return !!installed && !!candidate && installed !== "(none)" && candidate !== "(none)" && installed !== candidate;
}

function edited(edit: ConffileEdit): boolean {
  try { return readFileSync(edit.path, "utf8").includes(edit.marker); }
  catch { return false; }
}

/** The paths given back. The flag goes up first, so a watcher woken by the write leaves the file alone. */
export function releaseConffiles(edits: ConffileEdit[], run: Run = defaultRun, flag = CONFFILES_RELEASED_FLAG): string[] {
  const due = edits.filter((edit) => edited(edit) && upgradePending(edit.path, run));
  if (due.length === 0) return [];
  mkdirSync(dirname(flag), { recursive: true, mode: 0o755 });
  writeFileSync(flag, `${due.map((edit) => edit.path).join("\n")}\n`, { mode: 0o644 });
  return due.filter((edit) => edit.release()).map((edit) => edit.path);
}

/**
 * While an upgrade run has the files, repair must not put the edits back,
 * however long it runs. A flag the service left behind when it stopped without
 * `post` holds nothing off.
 */
export function conffilesReleased(flag = CONFFILES_RELEASED_FLAG, run: Run = defaultRun, now = Date.now()): boolean {
  let raised: number;
  try { raised = statSync(flag).mtimeMs; }
  catch { return false; }
  const state = run("systemctl", ["is-active", UPGRADE_SERVICE]).stdout.trim();
  if (["activating", "active", "deactivating", "reloading"].includes(state)) return true;
  if (["inactive", "failed"].includes(state)) return false;
  return now - raised < STALE_MS;
}

/** Whether a release was outstanding; repair may run again either way. */
export function endConffileRelease(flag = CONFFILES_RELEASED_FLAG): boolean {
  try { statSync(flag); }
  catch { return false; }
  rmSync(flag, { force: true });
  return true;
}
