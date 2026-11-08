/**
 * Which PHP runs CloudPanel itself: its pages, phpMyAdmin and the root File
 * Manager pool all live in `clp-php-fpm`, which CloudPanel starts on PHP 8.1.
 * A systemd drop-in swaps the binary and keeps CloudPanel's own config and
 * arguments; deleting it is the whole undo. A change is config-tested first and
 * then proven by asking both pools for a page over their sockets, which Nginx's
 * optional basic auth cannot answer for; a failure puts the previous unit back.
 */
import { errorMessage } from "../../lib/errors";
import {
  LOCK_DIR, addonConfigFile, addonStateDir, PANEL_FPM_UNIT, PHP_FPM_BIN_DIR, RECONCILE_SERVICE, SYSTEMD_DIR,
} from "../../lib/paths";
import { existsSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { failAction } from "../../lib/action";
import { requireSuccess, runCommand, type CommandResult } from "../../lib/command";
import { withFileLock, withFileLockSync } from "../../lib/file-lock";
import { writeFileAtomic, writeOrRemove } from "../../lib/atomic-write";
import { fastCgiRequest, type FastCgiResponse } from "../../lib/fastcgi";
import { daemonReload } from "../../lib/systemd";
import { present, trustedText } from "../../lib/trusted-file";
import { waitHealthy } from "./wait-healthy";
import { newerPhp } from "./php-version";
import { tweak } from "./tweak";
import { frozen, settingRow, warning } from "./app/rows";
import { esc } from "../../lib/app-http";
import { sinceText } from "../../lib/app-ui";

const STATE_VERSION = 1;
const VERSION_RE = /^[0-9]+\.[0-9]+$/;
const MARKER = "# Managed by clp-addons System Tweaks: the PHP version CloudPanel runs on.";

interface PanelPhpPaths {
  unit: string;
  dropInFile: string;
  fpmBinDir: string;
  stateFile: string;
  lockFile: string;
  /** System Tweaks' own config, which exists only while the addon is installed. */
  configFile: string;
  panelRoot: string;
  panelSocket: string;
  fileManagerSocket: string;
  procRoot: string;
  rootUid: number;
}

export const DEFAULT_PANEL_PHP_PATHS: PanelPhpPaths = {
  unit: PANEL_FPM_UNIT,
  dropInFile: `${SYSTEMD_DIR}/${PANEL_FPM_UNIT}.d/clp-addons-php.conf`,
  fpmBinDir: PHP_FPM_BIN_DIR,
  stateFile: `${addonStateDir("system-tweaks")}/panel-php.json`,
  lockFile: `${LOCK_DIR}/panel-php.lock`,
  configFile: addonConfigFile("system-tweaks"),
  panelRoot: "/home/clp/htdocs/app/files/public",
  panelSocket: "/run/clp-php-fpm.sock",
  fileManagerSocket: "/run/clp-fm-php-fpm.sock",
  procRoot: "/proc",
  rootUid: 0,
};

export interface PanelPhpOptions {
  paths?: Partial<PanelPhpPaths>;
  run?: (command: string, args: string[]) => CommandResult;
  request?: (socket: string, params: Record<string, string>) => Promise<FastCgiResponse>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** How long a restarted panel gets to answer before the change is undone. */
  healthTimeoutMs?: number;
}

export interface PanelPhpChoice {
  /** `8.4`. */
  version: string;
  /** The installed package version, `8.4.25-1+clp-bookworm`, or "" when the package manager does not say. */
  installed: string;
  /** A newer release the package manager can install, when there is one. */
  available?: string;
}

interface PanelPhpFailure {
  php: string;
  /** The package release that failed, so an upgrade earns another attempt. */
  release: string;
  error: string;
  at: string;
}

export interface PanelPhpStatus {
  /** The version chosen here; "" keeps CloudPanel's own. */
  wanted: string;
  /** The version CloudPanel's unit starts, or null when its unit is not one this recognises. */
  stock: string | null;
  /** The version the running master was started from. */
  running: string | null;
  /** CloudPanel's own version first, then every newer installed PHP-FPM. */
  choices: PanelPhpChoice[];
  /** A drop-in someone else wrote that already sets the binary. */
  overriddenBy?: string;
  failure?: PanelPhpFailure;
}

interface StoredChoice {
  php: string;
  failure?: PanelPhpFailure;
  /** Set while the addon is disabled, so a change queued behind the withdrawal does not undo it. */
  withdrawn?: true;
}

interface BaseUnit {
  stock: string;
  args: string[];
  dropIns: string[];
}

interface Context {
  paths: PanelPhpPaths;
  run: (command: string, args: string[]) => CommandResult;
  request: (socket: string, params: Record<string, string>) => Promise<FastCgiResponse>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  healthTimeoutMs: number;
}

function contextOf(options: PanelPhpOptions): Context {
  return {
    paths: { ...DEFAULT_PANEL_PHP_PATHS, ...options.paths },
    run: options.run ?? ((command, args) => runCommand(command, args, 60_000)),
    request: options.request ?? ((socket, params) => fastCgiRequest(socket, params)),
    sleep: options.sleep ?? ((ms) => Bun.sleep(ms)),
    now: options.now ?? (() => new Date()),
    healthTimeoutMs: options.healthTimeoutMs ?? 20_000,
  };
}

function readChoice(paths: PanelPhpPaths): StoredChoice {
  try {
    const text = trustedText(paths.stateFile, paths.rootUid);
    const parsed = text === null ? null : JSON.parse(text);
    if (parsed?.version !== STATE_VERSION || typeof parsed.php !== "string") return { php: "" };
    const php = VERSION_RE.test(parsed.php) ? parsed.php : "";
    const failure = parsed.failure && typeof parsed.failure.error === "string" ? parsed.failure as PanelPhpFailure : undefined;
    return { php, ...(failure ? { failure } : {}), ...(parsed.withdrawn === true ? { withdrawn: true as const } : {}) };
  } catch {
    return { php: "" };
  }
}

function writeChoice(paths: PanelPhpPaths, choice: StoredChoice): void {
  writeFileAtomic(paths.stateFile, `${JSON.stringify({ version: STATE_VERSION, ...choice }, null, 2)}\n`, {
    mode: 0o600, createParent: true,
  });
}

function baseUnit(ctx: Context): BaseUnit | null {
  const shown = ctx.run("systemctl", ["show", "-p", "FragmentPath", "-p", "DropInPaths", ctx.paths.unit]);
  if (!shown.ok) return null;
  const fields = Object.fromEntries(shown.stdout.split("\n").map((line) => {
    const at = line.indexOf("=");
    return [line.slice(0, at), line.slice(at + 1).trim()];
  }));
  const fragment = fields.FragmentPath ? trustedText(fields.FragmentPath, ctx.paths.rootUid) : null;
  if (!fragment) return null;
  const starts = [...fragment.matchAll(/^ExecStart=(\S+)(.*)$/gm)];
  const binary = starts.at(-1)?.[1] ?? "";
  const stock = new RegExp(`^${ctx.paths.fpmBinDir}/php-fpm([0-9]+\\.[0-9]+)$`).exec(binary)?.[1];
  if (!stock || starts.length !== 1) return null;
  return {
    stock,
    args: starts[0]![2]!.trim().split(/\s+/).filter(Boolean),
    dropIns: (fields.DropInPaths ?? "").split(/\s+/).filter(Boolean),
  };
}

function foreignOverride(ctx: Context, unit: BaseUnit): string | undefined {
  return unit.dropIns.find((path) => path !== ctx.paths.dropInFile
    && /^\s*ExecStart\s*=/m.test(trustedText(path, ctx.paths.rootUid) ?? "ExecStart="));
}

function installedVersions(ctx: Context): string[] {
  if (!existsSync(ctx.paths.fpmBinDir)) return [];
  return readdirSync(ctx.paths.fpmBinDir)
    .map((name) => /^php-fpm([0-9]+\.[0-9]+)$/.exec(name)?.[1])
    .filter((version): version is string => Boolean(version))
    .sort((a, b) => (newerPhp(a, b) ? 1 : newerPhp(b, a) ? -1 : 0));
}

function release(version: string): string {
  return version === "(none)" ? "" : version;
}

/** Installed and candidate releases of each `phpX.Y-fpm`, from one `apt-cache policy`. */
function releases(ctx: Context, versions: string[]): Map<string, { installed: string; candidate: string }> {
  const found = new Map<string, { installed: string; candidate: string }>();
  if (versions.length === 0) return found;
  const policy = ctx.run("apt-cache", ["policy", ...versions.map((version) => `php${version}-fpm`)]);
  if (!policy.ok) return found;
  for (const block of policy.stdout.split(/^(?=php)/m)) {
    const version = /^php([0-9]+\.[0-9]+)-fpm:/.exec(block)?.[1];
    if (!version) continue;
    found.set(version, {
      installed: release(/Installed:\s*(\S+)/.exec(block)?.[1] ?? ""),
      candidate: release(/Candidate:\s*(\S+)/.exec(block)?.[1] ?? ""),
    });
  }
  return found;
}

function runningVersion(ctx: Context): string | null {
  const pid = ctx.run("systemctl", ["show", "-p", "MainPID", "--value", ctx.paths.unit]).stdout.trim();
  if (!/^[1-9][0-9]*$/.test(pid)) return null;
  try {
    return /php-fpm([0-9]+\.[0-9]+)(?: \(deleted\))?$/.exec(readlinkSync(join(ctx.paths.procRoot, pid, "exe")))?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Automatic updates include the PHP packages the panel runs on, and no package
 * script restarts CloudPanel's own unit, so after one the panel keeps running
 * the replaced binary. Its reload re-executes the new one.
 */
function reloadReplaced(ctx: Context): string | null {
  const pid = ctx.run("systemctl", ["show", "-p", "MainPID", "--value", ctx.paths.unit]).stdout.trim();
  if (!/^[1-9][0-9]*$/.test(pid)) return null;
  try {
    if (!readlinkSync(join(ctx.paths.procRoot, pid, "exe")).endsWith(" (deleted)")) return null;
  } catch {
    return null;
  }
  requireSuccess(ctx.run("systemctl", ["reload", ctx.paths.unit]), "reloading the panel's PHP onto its updated binary");
  return "panel PHP reloaded onto its updated binary";
}

function dropInFor(ctx: Context, php: string, unit: BaseUnit): string {
  return [
    MARKER,
    "[Unit]",
    `Description=The CLP PHP ${php} FastCGI Process Manager`,
    "",
    "[Service]",
    "ExecStart=",
    `ExecStart=${join(ctx.paths.fpmBinDir, `php-fpm${php}`)} ${unit.args.join(" ")}`,
    "",
  ].join("\n");
}

/** FastCGI parameters for a plain GET of one of the panel's pages, as Nginx would send it. */
export function panelPageParams(panelRoot: string, script: string, uri: string): Record<string, string> {
  return {
    GATEWAY_INTERFACE: "CGI/1.1",
    SERVER_PROTOCOL: "HTTP/1.1",
    REQUEST_METHOD: "GET",
    REQUEST_URI: uri,
    SCRIPT_NAME: script,
    DOCUMENT_URI: script,
    SCRIPT_FILENAME: panelRoot + script,
    DOCUMENT_ROOT: panelRoot,
    QUERY_STRING: "",
    SERVER_NAME: "127.0.0.1",
    SERVER_ADDR: "127.0.0.1",
    SERVER_PORT: "8443",
    HTTP_HOST: "127.0.0.1:8443",
    HTTPS: "on",
    REMOTE_ADDR: "127.0.0.1",
    REMOTE_PORT: "0",
  };
}

/** Why the panel is not yet serving on `php`, or null once both pools answer. */
async function unhealthy(ctx: Context, php: string): Promise<string | null> {
  if (ctx.run("systemctl", ["is-active", ctx.paths.unit]).stdout.trim() !== "active") return `${ctx.paths.unit} is not running`;
  const running = runningVersion(ctx);
  if (running !== php) return `${ctx.paths.unit} runs PHP ${running ?? "unknown"}, not ${php}`;
  for (const [what, socket, script, uri, accept] of [
    ["the login page", ctx.paths.panelSocket, "/index.php", "/login", (status: number) => status === 200],
    ["the File Manager", ctx.paths.fileManagerSocket, "/file-manager/index.php", "/file-manager/index.php", (status: number) => status < 400],
  ] as const) {
    try {
      const reply = await ctx.request(socket, panelPageParams(ctx.paths.panelRoot, script, uri));
      if (!accept(reply.status)) return `${what} answered ${reply.status}`;
    } catch (error) {
      return errorMessage(error);
    }
  }
  return null;
}

function servesOn(ctx: Context, php: string): Promise<string | null> {
  return waitHealthy(() => unhealthy(ctx, php), {
    now: () => ctx.now().getTime(), sleep: ctx.sleep, timeoutMs: ctx.healthTimeoutMs, intervalMs: 500,
  });
}

function install(ctx: Context, content: string | null): void {
  writeOrRemove(ctx.paths.dropInFile, content, { mode: 0o644, createParent: true });
  daemonReload(ctx.run);
}

/**
 * Returns the version now running, or null when nothing had to change. A
 * failure restores the previous drop-in before it is thrown.
 */
async function apply(ctx: Context, php: string): Promise<string | null> {
  const unit = baseUnit(ctx);
  if (!unit) failAction(`${ctx.paths.unit} is not the CloudPanel PHP-FPM unit this addon knows`);
  const before = trustedText(ctx.paths.dropInFile, ctx.paths.rootUid);
  const override = foreignOverride(ctx, unit);
  if (override) {
    if (php) failAction(`${override} already sets the panel's PHP; remove it to choose the version here`);
    if (present(ctx.paths.dropInFile)) {
      install(ctx, null);
      requireSuccess(ctx.run("systemctl", ["restart", ctx.paths.unit]), `restarting ${ctx.paths.unit} failed`);
    }
    return null;
  }
  const wanted = php && newerPhp(php, unit.stock) ? php : unit.stock;
  // A chosen PHP removed since it was set leaves the unit unable to start at
  // its next restart, so the panel goes back to CloudPanel's own before that.
  const missing = wanted !== unit.stock && !existsSync(join(ctx.paths.fpmBinDir, `php-fpm${wanted}`));
  if (missing && !before?.includes(`php-fpm${wanted}`)) failAction(`PHP ${wanted} is not installed`);
  const target = missing ? unit.stock : wanted;
  const desired = target === unit.stock ? null : dropInFor(ctx, target, unit);
  if (desired === before && (desired !== null || !present(ctx.paths.dropInFile))) return null;

  if (desired !== null) {
    const binary = join(ctx.paths.fpmBinDir, `php-fpm${target}`);
    if (!existsSync(binary)) failAction(`PHP ${target} is not installed`);
    requireSuccess(ctx.run(binary, ["-t", ...unit.args]), `PHP ${target} rejected CloudPanel's FPM config`);
  }
  const previous = before === null ? unit.stock : (/php-fpm([0-9]+\.[0-9]+)/.exec(before)?.[1] ?? unit.stock);
  try {
    install(ctx, desired);
    requireSuccess(ctx.run("systemctl", ["restart", ctx.paths.unit]), `restarting ${ctx.paths.unit} failed`);
    const problem = await servesOn(ctx, target);
    if (problem) failAction(`the panel did not come back on PHP ${target}: ${problem}`);
    if (!missing) return target;
  } catch (error) {
    let restored: string;
    try {
      install(ctx, before);
      ctx.run("systemctl", ["restart", ctx.paths.unit]);
      const after = await servesOn(ctx, previous);
      restored = after ? `PHP ${previous} was restored but is not answering either: ${after}` : `the panel is back on PHP ${previous}`;
    } catch (restoreError) {
      restored = `restoring PHP ${previous} failed: ${errorMessage(restoreError)}`;
    }
    failAction(`${errorMessage(error)}; ${restored}`);
  }
  failAction(`PHP ${wanted} is no longer installed, so the panel is back on PHP ${unit.stock}`);
}

export function panelPhpStatus(options: PanelPhpOptions = {}): PanelPhpStatus {
  const ctx = contextOf(options);
  const choice = readChoice(ctx.paths);
  const unit = baseUnit(ctx);
  const versions = installedVersions(ctx).filter((version) => unit && !newerPhp(unit.stock, version));
  const known = releases(ctx, versions);
  const status: PanelPhpStatus = {
    wanted: choice.php,
    stock: unit?.stock ?? null,
    running: runningVersion(ctx),
    choices: versions.map((version) => {
      const { installed = "", candidate = "" } = known.get(version) ?? {};
      return candidate && installed && candidate !== installed ? { version, installed, available: candidate } : { version, installed };
    }),
  };
  const override = unit ? foreignOverride(ctx, unit) : undefined;
  if (override) status.overriddenBy = override;
  if (choice.failure) status.failure = choice.failure;
  return status;
}

/**
 * `lockRefusal` is asked under the lock, and while it answers, root's lock
 * holds the panel to an installed version newer than the one it runs now.
 */
export async function setPanelPhp(php: string, options: PanelPhpOptions = {}, lockRefusal?: () => string | null): Promise<PanelPhpStatus> {
  const ctx = contextOf(options);
  if (php !== "" && !VERSION_RE.test(php)) failAction("choose a PHP version such as 8.4");
  await withFileLock(ctx.paths.lockFile, 30, "another panel PHP change is still running", async () => {
    // Purging removes the withdrawn mark with the state, but not before the config.
    if (readChoice(ctx.paths).withdrawn || !existsSync(ctx.paths.configFile)) {
      failAction("System Tweaks is disabled; enable it to choose the panel's PHP");
    }
    const refusal = lockRefusal?.();
    if (refusal) {
      // Empty is CloudPanel's own, which can itself be newer than what runs after a fallback.
      const stock = baseUnit(ctx)?.stock;
      const target = php || stock;
      const now = runningVersion(ctx) ?? (readChoice(ctx.paths).php || stock);
      if (!target || !now || !installedVersions(ctx).includes(target) || !newerPhp(target, now)) failAction(refusal);
    }
    await apply(ctx, php);
    writeChoice(ctx.paths, { php });
  });
  return panelPhpStatus(options);
}

/**
 * The repair hook's half: keep the unit to the stored choice. A version that
 * failed is not retried every fifteen minutes; it is retried when its package
 * release changes or the operator chooses again.
 */
export async function reconcilePanelPhp(options: PanelPhpOptions = {}): Promise<string | null> {
  const ctx = contextOf(options);
  // The choice first, so a failed reload cannot keep it from being restored;
  // a restart it makes also leaves nothing to reload.
  let reconciled: string | null = null;
  let failure: unknown = null;
  try {
    reconciled = await reconcileChoice(ctx);
  } catch (error) {
    failure = error;
  }
  let reloaded: string | null = null;
  try {
    if (existsSync(ctx.paths.configFile)) reloaded = reloadReplaced(ctx);
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
  return [reloaded, reconciled].filter(Boolean).join("; ") || null;
}

async function reconcileChoice(ctx: Context): Promise<string | null> {
  if (!readChoice(ctx.paths).php && !present(ctx.paths.dropInFile)) return null;
  return withFileLock(ctx.paths.lockFile, 30, "another panel PHP change is still running", async () => {
    const choice = readChoice(ctx.paths);
    if (choice.withdrawn || !existsSync(ctx.paths.configFile)) return null;
    const current = choice.php ? releases(ctx, [choice.php]).get(choice.php)?.installed ?? "" : "";
    if (choice.failure && choice.failure.php === choice.php && choice.failure.release === current) return null;
    try {
      const running = await apply(ctx, choice.php);
      if (choice.failure) writeChoice(ctx.paths, { php: choice.php });
      return running ? `panel runs on PHP ${running}` : null;
    } catch (error) {
      writeChoice(ctx.paths, { php: choice.php, failure: { php: choice.php, release: current, error: errorMessage(error), at: ctx.now().toISOString() } });
      throw error;
    }
  });
}

/**
 * Disabling the addon gives CloudPanel its own unit back and keeps the choice
 * for later. It runs inside the synchronous disable, so it cannot ask the pools
 * for a page; it config-tests CloudPanel's own PHP first and requires the unit
 * to come back on it, or puts the override back and refuses.
 */
export function withdrawPanelPhp(options: PanelPhpOptions = {}): void {
  const ctx = contextOf(options);
  withFileLockSync(ctx.paths.lockFile, 90, "a panel PHP change is still running", () => {
    const choice = readChoice(ctx.paths);
    writeChoice(ctx.paths, { ...choice, withdrawn: true });
    try {
      withdraw(ctx);
    } catch (error) {
      // Refused: the addon stays enabled, and so does choosing its PHP.
      writeChoice(ctx.paths, choice);
      throw error;
    }
  });
}

/** The binary, arguments and version the unit starts once the addon's drop-in is gone. */
function withoutDropIn(ctx: Context, unit: BaseUnit): { binary: string; args: string[]; version: string } {
  const override = foreignOverride(ctx, unit);
  const start = override ? [...(trustedText(override, ctx.paths.rootUid) ?? "").matchAll(/^ExecStart=(\S+)(.*)$/gm)].at(-1) : undefined;
  const version = start && /php-fpm([0-9]+\.[0-9]+)$/.exec(start[1]!)?.[1];
  if (start && version) return { binary: start[1]!, args: start[2]!.trim().split(/\s+/).filter(Boolean), version };
  return { binary: join(ctx.paths.fpmBinDir, `php-fpm${unit.stock}`), args: unit.args, version: unit.stock };
}

function withdraw(ctx: Context): void {
  if (!present(ctx.paths.dropInFile)) return;
  const unit = baseUnit(ctx);
  const next = unit ? withoutDropIn(ctx, unit) : null;
  if (next) {
    requireSuccess(ctx.run(next.binary, ["-t", ...next.args]),
      `PHP ${next.version} rejected CloudPanel's FPM config, so the panel keeps its PHP override`);
  }
  const before = trustedText(ctx.paths.dropInFile, ctx.paths.rootUid);
  const back = () => ctx.run("systemctl", ["is-active", ctx.paths.unit]).stdout.trim() === "active"
    && (!next || runningVersion(ctx) === next.version);
  let ok = false;
  try {
    install(ctx, null);
    if (ctx.run("systemctl", ["restart", ctx.paths.unit]).ok) {
      const deadline = ctx.now().getTime() + ctx.healthTimeoutMs;
      ok = back();
      while (!ok && ctx.now().getTime() < deadline) {
        Bun.sleepSync(500);
        ok = back();
      }
    }
  } catch {
    ok = false;
  }
  if (ok) return;
  let restored = "";
  if (before !== null) {
    try {
      install(ctx, before);
      restored = ctx.run("systemctl", ["restart", ctx.paths.unit]).ok
        ? "; the override was put back"
        : `; the override was put back, but ${ctx.paths.unit} did not restart on it either`;
    } catch (error) {
      restored = `; putting the override back failed: ${errorMessage(error)}`;
    }
  }
  failAction(`${ctx.paths.unit} did not come back on PHP ${next?.version ?? "CloudPanel's own version"}${restored}`);
}

/** Enabling it again asks the reconcile service to reapply a stored choice. */
export function restorePanelPhp(options: PanelPhpOptions = {}): void {
  const ctx = contextOf(options);
  const { withdrawn: _withdrawn, ...choice } = withFileLockSync(ctx.paths.lockFile, 90, "a panel PHP change is still running", () => {
    const stored = readChoice(ctx.paths);
    if (stored.withdrawn) writeChoice(ctx.paths, { php: stored.php, ...(stored.failure ? { failure: stored.failure } : {}) });
    return stored;
  });
  if (choice.php) ctx.run("systemctl", ["start", "--no-block", RECONCILE_SERVICE]);
}

function panelPhpOrError(options?: PanelPhpOptions): PanelPhpStatus | { error: string } {
  try { return panelPhpStatus(options); }
  catch (error) { return { error: errorMessage(error) }; }
}

function phpOption(choice: PanelPhpChoice, stock: string | null, selected: boolean): string {
  const label = `PHP ${choice.version}${choice.version === stock ? ", CloudPanel's own" : ""}`;
  return `<option value="${choice.version === stock ? "" : esc(choice.version)}"${selected ? " selected" : ""}>${esc(label)}</option>`;
}

export function panelPhpLine(status: PanelPhpStatus): string {
  const lines: string[] = [];
  if (status.overriddenBy) lines.push(`${status.overriddenBy} sets this already. Remove it to choose here.`);
  if (status.running) lines.push(`Running on PHP ${status.running}.`);
  const chosen = status.choices.find((choice) => choice.version === (status.wanted || status.stock));
  if (chosen?.available) lines.push(`${chosen.available} is available; run apt upgrade to install it.`);
  if (status.failure && status.failure.php === status.wanted) {
    lines.push(`PHP ${status.failure.php} failed ${sinceText(status.failure.at)}: ${status.failure.error}`);
  }
  return lines.join(" ");
}

/**
 * While root's lock holds, the version chosen now and those newer than the one
 * running; otherwise every choice. `movable` when one of them is a move
 * `set-panel-php` accepts.
 */
function phpChoices(status: PanelPhpStatus, locked: boolean): { choices: PanelPhpChoice[]; movable: boolean } {
  if (!locked) return { choices: status.choices, movable: true };
  const current = status.wanted || status.stock!;
  const now = status.running ?? current;
  const choices = status.choices.filter((choice) => choice.version === current || newerPhp(choice.version, now));
  return { choices, movable: choices.some((choice) => newerPhp(choice.version, now)) };
}

export function panelPhpRow(status: PanelPhpStatus | { error: string }, locked = false): string {
  const description = "Runs CloudPanel's pages, phpMyAdmin and the File Manager. CloudPanel has not tested newer versions, so a change is undone if the login page or File Manager stops answering.";
  if ("error" in status) {
    return settingRow({ key: "panelPhp", title: "Panel PHP", description, control: "",
      extra: `<div class="alert st-alert" role="alert">${esc(status.error)}</div>` });
  }
  if (status.stock === null) {
    return settingRow({ key: "panelPhp", title: "Panel PHP", description, control: "",
      extra: `<p class="st-status hint">CloudPanel's PHP-FPM unit is not one this addon recognises, so the panel keeps the PHP CloudPanel chose.</p>` });
  }
  const { choices, movable } = phpChoices(status, locked);
  const select = `
            <select id="panel-php" aria-label="Panel PHP" data-current="${esc(status.wanted)}" onchange="setPanelPhp(this)"${status.overriddenBy || !movable ? " disabled" : ""}>${choices
    .map((choice) => phpOption(choice, status.stock, (status.wanted || status.stock) === choice.version)).join("")}${
    status.wanted && !status.choices.some((choice) => choice.version === status.wanted)
      ? `<option value="${esc(status.wanted)}" selected disabled>PHP ${esc(status.wanted)} (unavailable)</option>` : ""}</select>`;
  const newer = status.choices.some((choice) => choice.version !== status.stock);
  const eol = status.stock === "8.1" && !status.wanted && !status.overriddenBy
    ? warning(newer
      ? "The panel runs on PHP 8.1, which no longer gets security fixes. Choose a newer PHP above."
      : "The panel runs on PHP 8.1, which no longer gets security fixes. Install a newer PHP-FPM to choose it here.")
    : "";
  return settingRow({
    key: "panelPhp", title: "Panel PHP", description, control: select,
    extra: `<p class="st-status hint" id="panel-php-status">${esc(panelPhpLine(status))}</p>${eol}`,
  });
}

type Options = { panelPhp?: PanelPhpOptions };

/** The PHP that runs the panel itself; it keeps its own state, so it has no settings here. */
export const PANEL_PHP_TWEAK = tweak<{}, Options, { panelPhp: PanelPhpStatus | { error: string } }>()({
  state: ({ options }) => ({ panelPhp: panelPhpOrError(options.panelPhp) }),
  verbs: {
    async "set-panel-php"(ctx) {
      const body = await ctx.body();
      if (typeof body.php !== "string") failAction("php must be a version such as 8.4, or empty for CloudPanel's own");
      // While root's lock holds, the panel's PHP only moves to a newer version.
      await setPanelPhp(body.php, ctx.options.panelPhp, ctx.lockRefusal);
      return ctx.state();
    },
  },
  repair: {
    choice: { label: "panel PHP", locked: false, run: ({ options }) => reconcilePanelPhp(options.panelPhp) },
  },
  withdraw: {
    // It refuses when CloudPanel's own PHP would not come back.
    run: ({ options }) => withdrawPanelPhp(options.panelPhp),
    // The addon stays enabled, so its panel PHP choice comes back with it.
    putBack: ({ options }) => restorePanelPhp(options.panelPhp),
  },
  restore: { run: ({ options }) => restorePanelPhp(options.panelPhp) },
  row: ({ panelPhp }, locked) => panelPhpRow(panelPhp, frozen("set-panel-php", locked)),
});
