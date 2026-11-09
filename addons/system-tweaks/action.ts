import { LOCK_DIR, addonStateDir, ROOT_UID } from "../../lib/paths";
import { SYSTEM_TWEAKS_VERBS } from "./verbs";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { replyToAction, failAction, readJsonRequest } from "../../lib/action";
import { errorMessage } from "../../lib/errors";
import { withFileLock, withFileLockSync } from "../../lib/file-lock";
import { writeFileAtomic } from "../../lib/atomic-write";
import { isTrustedFile } from "../../lib/trusted-file";
import { log } from "../../lib/log";
import { runCommand, type CommandResult } from "../../lib/command";
import { RECONCILE_SERVICE } from "../../lib/paths";
import { COMMAND_MS } from "./limits";
import { changeLock, lockFailure, type LockFiles } from "../../lib/lock-addon";
import { addonLocked, declaresLock, lockRefusal, lockedAddons } from "../../lib/root-locks";
import { removePoolIsolation, syncPoolIsolation } from "./pool-isolation";
import { syncFirewall } from "./firewall";
import {
  LOCK_SETTINGS, REPAIR, RESTORE, STATE, TWEAKS, UPKEEP, WITHDRAW, type SystemTweaksSettings, type SystemTweaksState, type TweakOptions,
} from "./registry";
import type { SystemTweaksVerb, TweakContext, VerbContext } from "./tweak";
import { BACKUP_COMPRESSION_TWEAK } from "./backup-compression";
import { MOTD_TWEAK } from "./motd";
import { PHPMYADMIN_TWEAK } from "./phpmyadmin";
import { VHOST_GUARD_TWEAK } from "./vhost-guard";

const SETTINGS_VERSION = 1;
const MAX_INPUT_BYTES = 4 * 1024;

export interface SystemTweaksPaths {
  settingsFile: string;
  lockFile: string;
  rootUid: number;
}

const DEFAULT_SYSTEM_TWEAKS_PATHS: SystemTweaksPaths = {
  settingsFile: `${addonStateDir("system-tweaks")}/settings.json`,
  lockFile: `${LOCK_DIR}/system-tweaks.lock`,
  rootUid: ROOT_UID,
};

export type SystemTweaksOptions = TweakOptions & {
  paths?: Partial<SystemTweaksPaths>;
  input?: string;
  emitReply?: boolean;
  processUid?: number;
  /** Tests only: root's lock file, owned by them; production reads ROOT_LOCKS_FILE. */
  locks?: LockFiles;
  /** How a failed withdrawal starts repair. */
  reconcile?: { run?: (command: string, args: string[]) => CommandResult };
};

type Context = TweakContext<SystemTweaksSettings, TweakOptions>;

function pathsFor(options: SystemTweaksOptions): SystemTweaksPaths {
  return { ...DEFAULT_SYSTEM_TWEAKS_PATHS, ...options.paths };
}

const DEFAULTS = Object.assign({}, ...TWEAKS.map((tweak) => "defaults" in tweak ? tweak.defaults : {})) as SystemTweaksSettings;

export function readSettings(paths: SystemTweaksPaths): SystemTweaksSettings {
  const settings = structuredClone(DEFAULTS);
  if (!existsSync(paths.settingsFile)) return settings;
  if (!isTrustedFile(lstatSync(paths.settingsFile), paths.rootUid)) {
    failAction("the system tweaks settings file is not a trusted regular file");
  }
  let stored: Record<string, unknown>;
  try {
    stored = JSON.parse(readFileSync(paths.settingsFile, "utf8"));
  } catch {
    return settings;
  }
  if (stored?.version !== SETTINGS_VERSION) return settings;
  for (const tweak of TWEAKS) {
    if (!("defaults" in tweak)) continue;
    if ("read" in tweak) {
      tweak.read(stored, settings);
      continue;
    }
    const own = settings as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(tweak.defaults)) {
      if (typeof value === "boolean" && typeof stored[key] === "boolean") own[key] = stored[key];
    }
  }
  return settings;
}

function writeSettings(paths: SystemTweaksPaths, settings: SystemTweaksSettings): void {
  writeFileAtomic(
    paths.settingsFile,
    `${JSON.stringify({ version: SETTINGS_VERSION, ...settings }, null, 2)}\n`,
    { mode: 0o600, createParent: true },
  );
}

/** The tweaks' view of the settings: read now, or for a step outside the lock only once it asks. */
function contextFor(options: SystemTweaksOptions, paths: SystemTweaksPaths, read: "now" | "lazily"): Context {
  let settings = read === "now" ? readSettings(paths) : null;
  return {
    options,
    get settings() { return settings ??= readSettings(paths); },
    save: (patch) => writeSettings(paths, { ...readSettings(paths), ...patch }),
  };
}

/** The settings root's lock holds on: each switch whose verb `verbs.ts` says the lock covers. */
function lockedKeys(): string[] {
  return TWEAKS.flatMap((tweak) => "switch" in tweak && declaresLock("system-tweaks", tweak.switch.verb) ? [tweak.switch.key] : []);
}

/**
 * Each locked switch at its default or on, whichever is safer: what System
 * Tweaks enabled under a lock starts from. MySQL on this server only and the
 * SSH jail are off by default.
 */
function raisedToDefaults(settings: SystemTweaksSettings): SystemTweaksSettings {
  const raised: Record<string, unknown> = { ...settings };
  for (const tweak of TWEAKS) if ("raise" in tweak) Object.assign(raised, tweak.raise(settings, DEFAULTS));
  const own = settings as unknown as Record<string, unknown>;
  for (const key of lockedKeys()) raised[key] = own[key] || (DEFAULTS as unknown as Record<string, unknown>)[key];
  return raised as SystemTweaksSettings;
}

function lockedByRoot(options: SystemTweaksOptions): boolean {
  return addonLocked("system-tweaks", options.locks?.file, options.locks?.rootUid);
}

/** Root's lock lets a lockable switch go on, never off; asked under the settings lock, so `lock-settings` cannot be undone behind it. */
function holdToLock(options: SystemTweaksOptions, verb: SystemTweaksVerb, values: unknown[]): void {
  if (declaresLock("system-tweaks", verb) && values.some((value) => value !== true) && lockedByRoot(options)) {
    failAction(lockRefusal("system-tweaks"));
  }
}

/** Whether the operator switched the PHP upload-progress guard off here; settings that cannot be trusted leave it on. */
export function systemTweaksPhpGuardOff(options: SystemTweaksOptions = {}): boolean {
  try {
    return !readSettings(pathsFor(options)).uploadProgressGuard;
  } catch {
    return false;
  }
}

async function stateOf(options: SystemTweaksOptions): Promise<SystemTweaksState> {
  const ctx = { options, settings: readSettings(pathsFor(options)) };
  const state = {};
  for (const tweak of STATE) Object.assign(state, await tweak.state(ctx));
  return state as SystemTweaksState;
}

const SETTINGS_BUSY = "another system tweaks change is still running";

/**
 * Written while withdrawing still holds the settings lock, and removed when
 * the addon is turned on again. The config goes only after that lock is let
 * go, so a web change that waited on it would otherwise run on an addon that
 * nothing maintains or withdraws any more.
 */
function withdrawnMark(paths: SystemTweaksPaths): string {
  return join(dirname(paths.settingsFile), "withdrawn");
}

/** `web`: a change from the panel, refused once the addon is withdrawn; repair still runs, to put back a disable that failed. */
function settingsLock<T>(paths: SystemTweaksPaths, body: () => Promise<T>, web = false): Promise<T> {
  return withFileLock(paths.lockFile, 15, SETTINGS_BUSY, async () => {
    if (web && existsSync(withdrawnMark(paths))) failAction("System Tweaks is disabled");
    return body();
  });
}

/** Runs `body` under the settings lock, with the settings read once it is taken; `hold` asks root's lock before that. */
function locked<T>(
  options: SystemTweaksOptions, body: (ctx: Context) => T | Promise<T>, hold?: { verb: SystemTweaksVerb; values: unknown[] }, web = false,
): Promise<T> {
  const paths = pathsFor(options);
  return settingsLock(paths, async () => {
    if (hold) holdToLock(options, hold.verb, hold.values);
    return body(contextFor(options, paths, "now"));
  }, web);
}

function lockedSync<T>(options: SystemTweaksOptions, body: (ctx: Context) => T): T {
  const paths = pathsFor(options);
  return withFileLockSync(paths.lockFile, 15, SETTINGS_BUSY, () => body(contextFor(options, paths, "now")));
}

function verbContext(options: SystemTweaksOptions): VerbContext<SystemTweaksSettings, TweakOptions> {
  return {
    options,
    body: () => readJsonRequest(options.input, MAX_INPUT_BYTES),
    locked: (body, hold) => locked(options, body, hold, true),
    lockRefusal: () => lockedByRoot(options) ? lockRefusal("system-tweaks") : null,
    exclusive: (body) => settingsLock(pathsFor(options), body, true),
    state: (patch) => stateOf({ ...options, ...patch }),
  };
}

type Handler = (ctx: VerbContext<SystemTweaksSettings, TweakOptions>) => Promise<unknown>;

/** How Lock settings turns a tweak on: its own way, or its switch. */
export function lockSettingsStep(tweak: (typeof LOCK_SETTINGS.first)[number]): { verb: SystemTweaksVerb; blocked?(options: TweakOptions): string | null; run(ctx: Context): unknown } {
  if ("lockOn" in tweak) return tweak.lockOn;
  return { verb: tweak.switch.verb, run: (ctx) => tweak.switch.set(ctx, true) };
}

/**
 * Every lockable switch on, then root's lock on System Tweaks, under the
 * settings lock throughout, so no change slips in between. A switch that does
 * not come on leaves nothing locked: the lock never holds one off.
 */
async function lockSettings(ctx: VerbContext<SystemTweaksSettings, TweakOptions>): Promise<unknown> {
  const options = ctx.options as SystemTweaksOptions;
  const files = options.locks;
  // First, so a lock file root cannot trust stops it before anything changes.
  try { lockedAddons(files?.file, files?.rootUid); } catch (error) { failAction(lockFailure(error, files?.file)); }
  for (const tweak of [...LOCK_SETTINGS.first, ...LOCK_SETTINGS.last]) {
    const blocked = lockSettingsStep(tweak).blocked?.(options);
    if (blocked) failAction(`nothing was changed or locked: ${blocked}`);
  }
  const paths = pathsFor(options);
  await settingsLock(paths, async () => {
    const failed: string[] = [];
    const turnOn = async (tweaks: readonly (typeof LOCK_SETTINGS.first)[number][]) => {
      for (const tweak of tweaks) {
        const { verb, run } = lockSettingsStep(tweak);
        try { await run(contextFor(options, paths, "now")); } catch (error) { failed.push(`${verb.replace(/^set-/, "")}: ${errorMessage(error)}`); }
      }
    };
    await turnOn(LOCK_SETTINGS.first);
    if (!failed.length) await turnOn(LOCK_SETTINGS.last);
    if (failed.length) failAction(`nothing was locked, because not every setting could be switched on: ${failed.join("; ")}`);
    try { changeLock("system-tweaks", true, files); } catch (error) { failAction(lockFailure(error, files?.file)); }
  }, true);
  return ctx.state();
}

/** Every verb's handler: `state`, `lock-settings`, each tweak's switch, and each tweak's other verbs. */
function verbHandlers(): Record<SystemTweaksVerb, Handler> {
  const handlers: Partial<Record<SystemTweaksVerb, Handler>> = { state: (ctx) => ctx.state(), "lock-settings": lockSettings };
  const add = (verb: SystemTweaksVerb, handler: Handler) => {
    if (handlers[verb]) throw new Error(`two system tweaks handle ${verb}`);
    handlers[verb] = handler;
  };
  for (const tweak of TWEAKS) {
    if ("switch" in tweak) {
      const { verb, set } = tweak.switch;
      add(verb, async (ctx) => {
        const { enabled } = await ctx.body();
        if (typeof enabled !== "boolean") failAction("enabled must be true or false");
        await ctx.locked((locked) => set(locked, enabled), { verb, values: [enabled] });
        return ctx.state();
      });
    }
    if ("verbs" in tweak) {
      for (const [verb, handler] of Object.entries(tweak.verbs)) add(verb as SystemTweaksVerb, handler as Handler);
    }
  }
  const missing = Object.keys(SYSTEM_TWEAKS_VERBS).filter((verb) => !handlers[verb as SystemTweaksVerb]);
  const extra = Object.keys(handlers).filter((verb) => !Object.hasOwn(SYSTEM_TWEAKS_VERBS, verb));
  if (missing.length || extra.length) throw new Error(`system tweaks verbs without a handler: ${missing.join(", ")}; handled but not declared: ${extra.join(", ")}`);
  return handlers as Record<SystemTweaksVerb, Handler>;
}

export const SYSTEM_TWEAKS_HANDLERS = verbHandlers();

function parseVerb(argv: string[]): SystemTweaksVerb {
  const [rawVerb, ...rest] = argv;
  const verb = (Object.keys(SYSTEM_TWEAKS_VERBS) as SystemTweaksVerb[]).find((known) => known === rawVerb);
  if (!verb) failAction(`unknown system tweaks verb '${rawVerb ?? ""}'`);
  if (rest.length > 0) failAction(`unexpected argument '${rest[0]}'`);
  return verb;
}

export async function executeSystemTweaksAction(argv: string[], options: SystemTweaksOptions = {}): Promise<unknown> {
  if ((options.processUid ?? process.getuid?.()) !== 0) failAction("system tweaks actions must run as root");
  const verb = parseVerb(argv);
  return SYSTEM_TWEAKS_HANDLERS[verb](verbContext(options));
}

export async function runSystemTweaksAction(argv: string[], options: SystemTweaksOptions = {}): Promise<number> {
  return replyToAction("system-tweaks", options.emitReply !== false, () => executeSystemTweaksAction(argv, options));
}

/** One repair step now, for the hooks that run it on its own; the step must not wait on anything. */
function repairNow(step: { locked: boolean; run(ctx: Context): string | null | false }, options: SystemTweaksOptions): string | null {
  return (step.locked ? lockedSync(options, (ctx) => step.run(ctx)) : step.run(contextFor(options, pathsFor(options), "lazily"))) || null;
}

export async function systemTweaksMaintenance(options: SystemTweaksOptions = {}): Promise<string | null> {
  const lines: string[] = [];
  const failures: string[] = [];
  for (const step of REPAIR) {
    try {
      // Read under the lock, so a switch-off running beside it is not undone.
      const line = step.locked
        ? await locked(options, (ctx) => step.run(ctx))
        : await step.run(contextFor(options, pathsFor(options), "lazily"));
      if (line) lines.push(line);
    } catch (error) {
      failures.push(step.label === null ? errorMessage(error) : `${step.label}: ${errorMessage(error)}`);
    }
  }
  if (failures.length) throw new Error([...failures, ...lines].join("; "));
  return lines.join("; ") || null;
}

/** Repair's quick reconciliations: updates, visitor-IP trust, the login jails and MySQL's file. */
export function systemTweaksUpkeep(options: SystemTweaksOptions = {}): string | null {
  return repairNow(UPKEEP, options);
}

/** Also the fast repair's when CloudPanel rewrites its vhost. */
export function systemTweaksPhpMyAdmin(options: SystemTweaksOptions = {}): string | null {
  return repairNow(PHPMYADMIN_TWEAK.repair.rules, options);
}

/** Also the fast repair's after a CloudPanel upgrade puts its login banner back. */
export function systemTweaksMotd(options: SystemTweaksOptions = {}): string | null {
  return repairNow(MOTD_TWEAK.repair.message, options);
}

/** Also the fast repair's after a CloudPanel update replaces the backup command. */
export function systemTweaksBackupCompression(options: SystemTweaksOptions = {}): string | null {
  return repairNow(BACKUP_COMPRESSION_TWEAK.repair.command, options);
}

/** Also the new-site watcher's: every site's Varnish backend comes from its checked include. */
export function systemTweaksVarnish(options: SystemTweaksOptions = {}): string | null {
  return repairNow(VHOST_GUARD_TWEAK.repair.varnish, options);
}

/**
 * Runs the steps in order; when one fails, the ones already done put their
 * protection back, latest first, and the failure is thrown. A put-back that
 * fails is thrown in its place, once the rest have run.
 */
function withdrawInOrder(steps: readonly { withdraw: { run(ctx: Context): void; putBack?(ctx: Context): void } }[], ctx: Context): void {
  const done: typeof steps[number][] = [];
  for (const step of steps) {
    try {
      step.withdraw.run(ctx);
    } catch (error) {
      putBack(done, ctx, error);
    }
    done.push(step);
  }
}

function putBack(done: readonly { withdraw: { putBack?(ctx: Context): void } }[], ctx: Context, error: unknown): never {
  let thrown = error;
  for (const step of [...done].reverse()) {
    try { step.withdraw.putBack?.(ctx); }
    catch (putBackError) { thrown = putBackError; }
  }
  throw thrown;
}

/**
 * After a step under the lock fails, the addon stays enabled with some of its
 * protections already withdrawn, so repair runs now rather than at its next
 * turn and puts back whatever the settings ask for. Best effort: the timer's
 * repair still comes, and this must not hide the failure.
 */
function queueRepair(options: SystemTweaksOptions): void {
  const run = options.reconcile?.run ?? ((command, args) => runCommand(command, args, COMMAND_MS));
  try { run("systemctl", ["start", "--no-block", RECONCILE_SERVICE]); } catch { /* the repair timer runs it */ }
}

export function withdrawSystemTweaks(options: SystemTweaksOptions = {}): void {
  const outside = contextFor(options, pathsFor(options), "lazily");
  withdrawInOrder(WITHDRAW.first, outside);
  try {
    lockedSync(options, (ctx) => {
      try {
        withdrawInOrder(WITHDRAW.locked, ctx);
        writeFileAtomic(withdrawnMark(pathsFor(options)), "", { mode: 0o600, createParent: true });
      } catch (error) {
        queueRepair(options);
        throw error;
      }
    });
  } catch (error) {
    putBack(WITHDRAW.first, outside, error);
  }
  for (const tweak of WITHDRAW.last) {
    try { tweak.withdraw.run(outside); }
    catch (error) { log.warn(tweak.withdraw.warning(errorMessage(error))); }
  }
}

export function restoreSystemTweaks(options: SystemTweaksOptions = {}, wasEnabled = false): void {
  const outside = contextFor(options, pathsFor(options), "lazily");
  try {
    lockedSync(options, (stored) => {
      rmSync(withdrawnMark(pathsFor(options)), { force: true });
      // Turned on under root's lock, it starts from its defaults and nothing it had switched off.
      // Already on, as when the installer runs again, the switches stay as root locked them.
      const settings = !wasEnabled && lockedByRoot(options) ? raisedToDefaults(stored.settings) : stored.settings;
      if (JSON.stringify(settings) !== JSON.stringify(stored.settings)) stored.save(settings);
      const ctx: Context = { options, settings, save: stored.save };
      for (const tweak of RESTORE.locked) {
        const { run, warning } = tweak.restore;
        try { run(ctx); }
        catch (error) {
          if (!warning) throw error;
          log.warn(warning(errorMessage(error)));
        }
      }
    });
  } finally {
    for (const tweak of RESTORE.always) tweak.restore.run(outside);
  }
  for (const tweak of RESTORE.after) {
    try {
      if ("defaults" in tweak) lockedSync(options, (ctx) => tweak.restore.run(ctx));
      else tweak.restore.run(outside);
    } catch (error) {
      log.warn(tweak.restore.warning(errorMessage(error)));
    }
  }
}

/** What the firewall watcher runs whenever ufw's rule files change. */
export function systemTweaksFirewall(options: SystemTweaksOptions = {}): string | null {
  return syncFirewall("apply", options.firewall);
}

/**
 * What every PHP-FPM unit runs before it starts, and before and after it
 * reloads. It reads the setting without the lock: a change on the page can be
 * what reloaded PHP-FPM.
 */
export function systemTweaksPhpPools(options: SystemTweaksOptions = {}, beforeReload = false): boolean {
  const paths = pathsFor(options);
  if (!readSettings(paths).isolatePhpPools) return false;
  const changed = syncPoolIsolation(options.phpPools, beforeReload);
  // Switched off meanwhile: the switch-off may have removed the table before this loaded it.
  if (!readSettings(paths).isolatePhpPools) removePoolIsolation(options.phpPools);
  return changed;
}
