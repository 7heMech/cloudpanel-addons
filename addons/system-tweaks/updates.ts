/**
 * Automatic updates through the distro's own `unattended-upgrades`.
 *
 * Everything System Tweaks sets is one drop-in under `/etc/apt/apt.conf.d`,
 * named to sort after the distro's `20auto-upgrades` and
 * `50unattended-upgrades`, so it adds origins to their lists and wins their
 * scalars while leaving every later operator file the last word. Deleting it
 * is the whole undo. What the page reports is read back from `apt-config dump`
 * and `apt-cache policy`, never from what this file meant to say.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { failAction, type CommandResult } from "../../cli/action-common";
import { writeFileAtomic } from "../../lib/atomic-write";
import { APT_STEP_MS, COMMAND_MS } from "./limits";

export const CLOUDPANEL_ORIGIN = "packages-v1.cloudpanel.io";
const MARKER = "// Managed by clp-addons System Tweaks. Switching automatic updates off there removes this file.";
const TIMERS = ["apt-daily.timer", "apt-daily-upgrade.timer"];

/** What the operator chose. PHP and the distro's security origin are always in. */
export interface UpdateSettings {
  enabled: boolean;
  nginx: boolean;
  database: boolean;
  panel: boolean;
  reboot: boolean;
}

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = {
  enabled: false,
  nginx: true,
  database: false,
  panel: false,
  reboot: false,
};

export const UPDATE_SETTING_KEYS = Object.keys(DEFAULT_UPDATE_SETTINGS) as (keyof UpdateSettings)[];

export interface UpdatesPaths {
  aptConfDir: string;
  aptConf: string;
  dropIn: string;
  rebootRequired: string;
  logFile: string;
  osRelease: string;
}

export const DEFAULT_UPDATES_PATHS: UpdatesPaths = {
  aptConfDir: "/etc/apt/apt.conf.d",
  aptConf: "/etc/apt/apt.conf",
  dropIn: "/etc/apt/apt.conf.d/52clp-addons-unattended-upgrades",
  rebootRequired: "/var/run/reboot-required",
  logFile: "/var/log/unattended-upgrades/unattended-upgrades.log",
  osRelease: "/etc/os-release",
};

/** A command runner; `timeoutMs` overrides the command's own guard. */
export type Run = (command: string, args: string[], env?: Record<string, string>, timeoutMs?: number) => CommandResult;

export interface UpdatesOptions {
  paths?: Partial<UpdatesPaths>;
  run?: Run;
}

export interface CoverageRow {
  name: string;
  detail: string;
  /** Whether unattended-upgrades would install from it: every, none or some of its components. */
  covered: "all" | "none" | "some";
}

export interface LastRun {
  /** As the log wrote it, in the server's local time. */
  at: string;
  outcome: "upgraded" | "nothing" | "failed" | "unknown";
  packages: string[];
  message: string;
}

export interface UpdatesStatus {
  installed: boolean;
  version: string;
  /** The distro's own name for itself, `Debian` or `Ubuntu`, and its codename. */
  distro: { id: string; codename: string };
  /** System Tweaks' drop-in is in place. */
  managed: boolean;
  /** unattended-upgrades will actually run. */
  enabled: boolean;
  /** The file that turns it on when System Tweaks does not, such as `20auto-upgrades`. */
  outsideSource: string;
  /** A file after System Tweaks' that turns it back off. */
  overriddenBy: string;
  listsUpdated: boolean;
  reboot: boolean;
  rebootTime: string;
  timer: { state: string; next: string };
  coverage: CoverageRow[];
  lastRun: LastRun | null;
  rebootRequired: { since: string; packages: string[] } | null;
}

interface Context {
  paths: UpdatesPaths;
  run: Run;
}

function contextOf(options: UpdatesOptions): Context {
  return {
    paths: { ...DEFAULT_UPDATES_PATHS, ...options.paths },
    run: options.run ?? systemRun,
  };
}

function guardOf(command: string): number {
  return command === "apt-get" ? APT_STEP_MS : COMMAND_MS;
}

/**
 * A runner that holds every command to one deadline: each gets its own guard
 * or what is left, whichever is shorter, and none starts once it has passed.
 */
export function withDeadline(run: Run, deadline: number, now: () => number = Date.now): Run {
  return (command, args, env) => {
    const remaining = deadline - now();
    if (remaining <= 0) failAction("the install ran out of time; try again, or install unattended-upgrades with apt");
    return run(command, args, env, Math.min(guardOf(command), remaining));
  };
}

export function systemRun(command: string, args: string[], env?: Record<string, string>, timeoutMs?: number): CommandResult {
  try {
    const result = Bun.spawnSync([command, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
      timeout: timeoutMs ?? guardOf(command),
      killSignal: "SIGKILL",
    });
    return { ok: result.success, stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode };
  } catch (error) {
    return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: null };
  }
}

// --- reading apt's own view ------------------------------------------------

/** `apt-config dump` as a map; list items (`Key:: "v"`) collect under `Key`. */
export function parseAptConfig(dump: string): Map<string, string[]> {
  const config = new Map<string, string[]>();
  for (const line of dump.split("\n")) {
    const match = /^(\S+?)(::)? "(.*)";$/.exec(line.trim());
    if (!match) continue;
    const [, key, list, value] = match as unknown as [string, string, string | undefined, string];
    if (list) config.set(key, [...(config.get(key) ?? []), value]);
    else config.set(key, [value]);
  }
  return config;
}

function scalar(config: Map<string, string[]>, key: string): string {
  return config.get(key)?.at(-1) ?? "";
}

function truthy(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/** Every pattern unattended-upgrades will allow, the legacy `Allowed-Origins` included, as it converts them. */
export function allowedPatterns(config: Map<string, string[]>): string[] {
  const legacy = (config.get("Unattended-Upgrade::Allowed-Origins") ?? []).map((entry) => {
    const parts = /(?<!\\):/.test(entry) ? entry.split(/(?<!\\):/) : entry.trim().split(/\s+/);
    const [id = "", codename = ""] = parts.map((part) => part.replace(/\\:/g, ":"));
    return `o=${id},a=${codename}`;
  });
  return [...legacy, ...(config.get("Unattended-Upgrade::Origins-Pattern") ?? [])];
}

export interface AptSource {
  origin: string;
  label: string;
  archive: string;
  codename: string;
  component: string;
  site: string;
}

/** The package indexes `apt-cache policy` lists, with their Release fields. */
export function parsePolicy(output: string): AptSource[] {
  const sources: AptSource[] = [];
  const lines = output.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^Pinned packages:/.test(lines[i]!)) break;
    if (!/^\s*-?\d+\s+\S+:\/\/\S+\s+\S+/.test(lines[i]!)) continue;
    const release = /^\s+release (.*)$/.exec(lines[i + 1] ?? "")?.[1];
    if (release === undefined) continue;
    const fields: Record<string, string> = {};
    for (const part of release.split(",")) {
      const eq = part.indexOf("=");
      if (eq > 0) fields[part.slice(0, eq)] = part.slice(eq + 1);
    }
    const site = /^\s+origin (.*)$/.exec(lines[i + 2] ?? "")?.[1]?.trim() ?? "";
    sources.push({
      origin: fields.o ?? "",
      label: fields.l ?? "",
      archive: fields.a ?? "",
      codename: fields.n ?? "",
      component: fields.c ?? "",
      site,
    });
  }
  return sources;
}

/** Python's `fnmatch.fnmatchcase`, which is what unattended-upgrades matches with on Linux. */
export function fnmatch(value: string, pattern: string): boolean {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else if (char === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end < 0) { source += "\\["; continue; }
      let set = pattern.slice(i + 1, end).replace(/\\/g, "\\\\");
      if (set.startsWith("!")) set = `^${set.slice(1)}`;
      source += `[${set}]`;
      i = end;
    } else source += char.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "s").test(value);
}

const MATCH_FIELDS: Record<string, keyof AptSource> = {
  o: "origin", origin: "origin", l: "label", label: "label", a: "archive", suite: "archive", archive: "archive",
  c: "component", component: "component", site: "site", n: "codename", codename: "codename",
};

/** unattended-upgrades' `match_whitelist_string`, with its `${distro_id}` and `${distro_codename}`. */
export function matchesPattern(pattern: string, source: AptSource, distro: { id: string; codename: string }): boolean {
  const text = pattern.trim();
  if (!text) return false;
  for (const token of text.replace(/\\,/g, "%2C").split(",")) {
    const eq = token.indexOf("=");
    if (eq < 0) return false;
    const what = token.slice(0, eq).trim();
    const value = token.slice(eq + 1).trim().replace(/%2C/g, ",")
      .replaceAll("${distro_id}", distro.id).replaceAll("${distro_codename}", distro.codename);
    const field = MATCH_FIELDS[what];
    if (!field || !fnmatch(source[field], value)) return false;
  }
  return true;
}

function sourceName(source: AptSource): { key: string; name: string; detail: string } {
  if (source.origin === CLOUDPANEL_ORIGIN) {
    const component = source.component;
    if (component.startsWith("php-")) return { key: "cp:php", name: "CloudPanel PHP", detail: "" };
    if (component === "main") return { key: "cp:main", name: "CloudPanel", detail: "main" };
    if (component === "nginx") return { key: "cp:nginx", name: "Nginx", detail: "nginx" };
    if (/^(percona|mysql|mariadb)/.test(component)) return { key: `cp:${component}`, name: "MySQL", detail: component };
    return { key: `cp:${component}`, name: component, detail: component };
  }
  // Ubuntu gives every pocket the release's codename and names the pocket in
  // the archive; Debian names it in the codename and gives the archive a role.
  const suite = source.archive.startsWith(source.codename) ? source.archive : source.codename || source.archive;
  return { key: `${source.origin}|${suite}`, name: `${source.origin || source.site} ${suite}`.trim(), detail: "" };
}

/** Each repository, grouped the way an operator thinks of it, and whether it is covered. */
export function coverageOf(sources: AptSource[], patterns: string[], distro: { id: string; codename: string }): CoverageRow[] {
  const groups = new Map<string, { name: string; detail: string; components: Set<string>; covered: number; total: number }>();
  const seen = new Set<string>();
  for (const source of sources) {
    const id = `${source.origin}|${source.archive}|${source.codename}|${source.component}|${source.label}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const { key, name, detail } = sourceName(source);
    const group = groups.get(key) ?? { name, detail, components: new Set<string>(), covered: 0, total: 0 };
    group.components.add(source.component);
    group.total++;
    if (patterns.some((pattern) => matchesPattern(pattern, source, distro))) group.covered++;
    groups.set(key, group);
  }
  const rank = (key: string) => ["cp:php", "cp:nginx", "cp:main"].indexOf(key) + 1 || (key.startsWith("cp:") ? 4 : 5);
  return [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b)).map(([key, group]) => ({
    name: group.name,
    detail: key === "cp:php"
      ? [...group.components].map((component) => component.slice(4)).sort(compareVersions).join(", ")
      : group.detail || [...group.components].filter(Boolean).join(", "),
    covered: group.covered === 0 ? "none" : group.covered === group.total ? "all" : "some",
  }));
}

function compareVersions(a: string, b: string): number {
  const [aMajor = 0, aMinor = 0] = a.split(".").map(Number);
  const [bMajor = 0, bMinor = 0] = b.split(".").map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}

function distroOf(ctx: Context): { id: string; codename: string } {
  const id = ctx.run("lsb_release", ["-i", "-s"]);
  const codename = ctx.run("lsb_release", ["-c", "-s"]);
  if (id.ok && codename.ok && id.stdout.trim()) return { id: id.stdout.trim(), codename: codename.stdout.trim() };
  let text = "";
  try { text = readFileSync(ctx.paths.osRelease, "utf8"); } catch {}
  const field = (name: string) => new RegExp(`^${name}="?([^"\\n]*)"?$`, "m").exec(text)?.[1] ?? "";
  const raw = field("ID");
  return { id: raw === "debian" ? "Debian" : raw === "ubuntu" ? "Ubuntu" : raw, codename: field("VERSION_CODENAME") };
}

/** The pattern for the distro's own security pocket, which Debian and Ubuntu label differently. */
export function securityPattern(distroId: string): string | null {
  if (distroId === "Debian") return "origin=Debian,codename=${distro_codename}-security,label=Debian-Security";
  if (distroId === "Ubuntu") return "origin=Ubuntu,archive=${distro_codename}-security";
  return null;
}

export function dropInFor(settings: UpdateSettings, distroId: string): string {
  const cloudpanel = (component: string) => `origin=${CLOUDPANEL_ORIGIN},codename=\${distro_codename},component=${component}`;
  const patterns = [
    securityPattern(distroId),
    cloudpanel("php-*"),
    ...(settings.nginx ? [cloudpanel("nginx")] : []),
    ...(settings.database ? ["percona-*", "mysql-*", "mariadb-*"].map(cloudpanel) : []),
    ...(settings.panel ? [cloudpanel("main")] : []),
  ].filter((pattern): pattern is string => pattern !== null);
  return [
    MARKER,
    'APT::Periodic::Update-Package-Lists "1";',
    'APT::Periodic::Unattended-Upgrade "1";',
    "Unattended-Upgrade::Origins-Pattern {",
    ...patterns.map((pattern) => `\t"${pattern}";`),
    "};",
    `Unattended-Upgrade::Automatic-Reboot "${settings.reboot ? "true" : "false"}";`,
    "",
  ].join("\n");
}

/** Every apt config file in the order apt reads them, the main file first. */
function configFiles(ctx: Context): string[] {
  const files = existsSync(ctx.paths.aptConf) ? [ctx.paths.aptConf] : [];
  if (!existsSync(ctx.paths.aptConfDir)) return files;
  // apt reads only names made of these characters, in byte order.
  const parts = readdirSync(ctx.paths.aptConfDir).filter((name) => /^[A-Za-z0-9_.-]+$/.test(name) && !name.endsWith(".dpkg-old")
    && !name.endsWith(".dpkg-dist") && !name.endsWith(".ucf-dist") && !name.endsWith(".disabled")).sort();
  return [...files, ...parts.map((name) => join(ctx.paths.aptConfDir, name))];
}

function periodicValues(path: string): string[] {
  let text = "";
  try {
    if (!statSync(path).isFile()) return [];
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*(\/\/|#).*$/gm, "");
  return [...stripped.matchAll(/APT::Periodic::Unattended-Upgrade\s+"([^"]*)"/g)].map((match) => match[1]!);
}

/** Who has the last word on `APT::Periodic::Unattended-Upgrade`, besides this addon. */
function periodicSources(ctx: Context): { outside: string; overriddenBy: string } {
  let outside = "";
  let outsideOn = false;
  let overriddenBy = "";
  let afterOurs = false;
  for (const file of configFiles(ctx)) {
    if (file === ctx.paths.dropIn) { afterOurs = true; continue; }
    for (const value of periodicValues(file)) {
      const on = value !== "" && value !== "0";
      outside = basename(file);
      outsideOn = on;
      if (afterOurs) overriddenBy = on ? "" : basename(file);
    }
  }
  return { outside: outsideOn ? outside : "", overriddenBy };
}

function lastRunIn(text: string): LastRun | null {
  const start = text.lastIndexOf("Starting unattended upgrades script");
  if (start < 0) return null;
  const lineStart = text.lastIndexOf("\n", start) + 1;
  const run = text.slice(lineStart).split("\n");
  const at = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(run[0] ?? "")?.[1] ?? "";
  const packages = run.map((line) => /Packages that will be upgraded: (.*)$/.exec(line)?.[1])
    .filter((list): list is string => Boolean(list)).flatMap((list) => list.trim().split(/\s+/));
  const errors = run.filter((line) => / ERROR /.test(line)).map((line) => line.replace(/^.*? ERROR /, ""));
  if (errors.length) return { at, outcome: "failed", packages, message: [...new Set(errors)].join("\n") };
  if (run.some((line) => line.includes("All upgrades installed"))) return { at, outcome: "upgraded", packages, message: "" };
  if (run.some((line) => line.includes("No packages found that can be upgraded unattended"))) {
    return { at, outcome: "nothing", packages: [], message: "" };
  }
  return { at, outcome: "unknown", packages, message: "" };
}

/** The last run in the log, or in the month before it when logrotate has just emptied it. */
function lastRun(ctx: Context): LastRun | null {
  try {
    const current = lastRunIn(readFileSync(ctx.paths.logFile, "utf8"));
    if (current) return current;
  } catch {}
  try {
    return lastRunIn(new TextDecoder().decode(Bun.gunzipSync(readFileSync(`${ctx.paths.logFile}.1.gz`))));
  } catch {
    return null;
  }
}

function rebootRequired(ctx: Context): UpdatesStatus["rebootRequired"] {
  let since: Date;
  try {
    since = lstatSync(ctx.paths.rebootRequired).mtime;
  } catch {
    return null;
  }
  let packages: string[] = [];
  try {
    packages = [...new Set(readFileSync(`${ctx.paths.rebootRequired}.pkgs`, "utf8").split("\n").map((line) => line.trim()).filter(Boolean))];
  } catch {}
  return { since: since.toISOString(), packages };
}

function timerState(ctx: Context): { state: string; next: string } {
  const states = TIMERS.map((timer) => ctx.run("systemctl", ["is-enabled", timer]).stdout.trim() || "missing");
  const state = states.find((value) => value !== "enabled" && value !== "static") ?? "enabled";
  const next = ctx.run("systemctl", ["show", "apt-daily-upgrade.timer", "-p", "NextElapseUSecRealtime", "--value"]).stdout.trim();
  return { state, next: next === "n/a" ? "" : next };
}

function packageVersion(ctx: Context): string {
  const query = ctx.run("dpkg-query", ["-W", "-f=${Status}\t${Version}", "unattended-upgrades"]);
  const [status = "", version = ""] = query.stdout.split("\t");
  return query.ok && status.endsWith(" installed") ? version.trim() : "";
}

export function unattendedUpgradesInstalled(options: UpdatesOptions = {}): boolean {
  return packageVersion(contextOf(options)) !== "";
}

function managed(ctx: Context): boolean {
  try {
    return readFileSync(ctx.paths.dropIn, "utf8").startsWith(MARKER);
  } catch {
    return false;
  }
}

export function updatesStatus(options: UpdatesOptions = {}): UpdatesStatus {
  const ctx = contextOf(options);
  const version = packageVersion(ctx);
  const distro = distroOf(ctx);
  const dump = ctx.run("apt-config", ["dump"]);
  const config = parseAptConfig(dump.ok ? dump.stdout : "");
  const periodic = scalar(config, "APT::Periodic::Unattended-Upgrade");
  const timer = timerState(ctx);
  const enabled = version !== "" && periodic !== "" && periodic !== "0"
    && scalar(config, "APT::Periodic::Enable") !== "0" && timer.state === "enabled";
  const sources = periodicSources(ctx);
  const policy = ctx.run("apt-cache", ["policy"]);
  const lists = scalar(config, "APT::Periodic::Update-Package-Lists");
  return {
    installed: version !== "",
    version,
    distro,
    managed: managed(ctx),
    enabled,
    outsideSource: sources.outside,
    overriddenBy: sources.overriddenBy,
    listsUpdated: lists !== "" && lists !== "0",
    reboot: truthy(scalar(config, "Unattended-Upgrade::Automatic-Reboot")),
    rebootTime: scalar(config, "Unattended-Upgrade::Automatic-Reboot-Time"),
    timer,
    coverage: coverageOf(policy.ok ? parsePolicy(policy.stdout) : [], allowedPatterns(config), distro),
    lastRun: lastRun(ctx),
    rebootRequired: rebootRequired(ctx),
  };
}

/** The effective `Automatic-Reboot`, so a first switch-on keeps what the operator had. */
export function effectiveReboot(options: UpdatesOptions = {}): boolean {
  const ctx = contextOf(options);
  const dump = ctx.run("apt-config", ["dump"]);
  return truthy(scalar(parseAptConfig(dump.ok ? dump.stdout : ""), "Unattended-Upgrade::Automatic-Reboot"));
}

// --- changing it -------------------------------------------------------------

function readDropIn(ctx: Context): string | null {
  try {
    return readFileSync(ctx.paths.dropIn, "utf8");
  } catch {
    return null;
  }
}

/**
 * Write or remove the drop-in, and have apt parse the result before keeping
 * it. Returns the timers this enabled, which switching off disables again.
 */
export function applyUpdates(settings: UpdateSettings, enabledTimers: string[], options: UpdatesOptions = {}): {
  changed: boolean;
  enabledTimers: string[];
} {
  const ctx = contextOf(options);
  const before = readDropIn(ctx);
  if (!settings.enabled) {
    for (const timer of enabledTimers) ctx.run("systemctl", ["disable", "--now", timer]);
    if (before !== null) rmSync(ctx.paths.dropIn, { force: true });
    return { changed: before !== null || enabledTimers.length > 0, enabledTimers: [] };
  }
  if (!packageVersion(ctx)) failAction("unattended-upgrades is not installed");
  const states = TIMERS.map((timer) => ({ timer, state: ctx.run("systemctl", ["is-enabled", timer]).stdout.trim() }));
  const masked = states.find(({ state }) => state === "masked");
  if (masked) failAction(`${masked.timer} is masked; unmask it to use automatic updates`);

  const after = dropInFor(settings, distroOf(ctx).id);
  const restore = () => {
    if (before === after) return;
    if (before === null) rmSync(ctx.paths.dropIn, { force: true });
    else writeFileAtomic(ctx.paths.dropIn, before, { mode: 0o644 });
  };
  if (before !== after) {
    writeFileAtomic(ctx.paths.dropIn, after, { mode: 0o644 });
    const check = ctx.run("apt-config", ["dump"]);
    if (!check.ok) {
      restore();
      failAction(`apt rejected the configuration: ${(check.stderr || check.stdout).trim()}`);
    }
  }
  const enabledNow: string[] = [];
  for (const { timer, state } of states) {
    if (state !== "disabled") continue;
    const enable = ctx.run("systemctl", ["enable", "--now", timer]);
    if (!enable.ok) {
      for (const done of enabledNow) ctx.run("systemctl", ["disable", "--now", done]);
      restore();
      failAction(`${timer} could not be enabled: ${enable.stderr.trim()}`);
    }
    enabledNow.push(timer);
  }
  const timers = [...new Set([...enabledTimers, ...enabledNow])];
  return { changed: before !== after || timers.length !== enabledTimers.length, enabledTimers: timers };
}

/** apt-get install, with the lists refreshed and tried once more when they are stale. */
export function installUnattendedUpgrades(options: UpdatesOptions = {}): void {
  const ctx = contextOf(options);
  const env = { DEBIAN_FRONTEND: "noninteractive" };
  const install = () => ctx.run("apt-get", ["install", "-y", "-o", "DPkg::Lock::Timeout=120", "unattended-upgrades"], env);
  let result = install();
  if (!result.ok) {
    ctx.run("apt-get", ["update", "-o", "DPkg::Lock::Timeout=120"], env);
    result = install();
  }
  if (!result.ok) {
    const lines = (result.stderr || result.stdout).trim().split("\n");
    failAction(`apt-get could not install unattended-upgrades: ${lines.slice(-3).join(" ")}`);
  }
}
