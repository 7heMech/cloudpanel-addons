/**
 * What `session.upload_progress.enabled` each PHP-FPM actually starts with.
 *
 * Read from the files the FPM reads, in the order it reads them: its main
 * `php.ini`, then every `*.ini` in its scan directory in byte order, the last
 * assignment winning. A pool's `php_value`/`php_admin_value` comes after all
 * of them for that pool, so those are reported per pool. Reading the files
 * says who set the value, which asking PHP for it would not.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { runCommand, type CommandResult } from "../../lib/command";
import { PANEL_FPM_UNIT, PHP_FPM_BIN_DIR, PHP_GUARD_INI_NAME, PHP_ROOT } from "../../lib/paths";
import { reconcilePhpGuard, type PhpGuardOptions } from "../../lib/php-guard";
import { saveThenApply, tweak } from "./tweak";
import { badge, stateRow, switchRow } from "./app/rows";

const KEY = "session.upload_progress.enabled";
const VERSION_RE = /^[0-9]+\.[0-9]+$/;

/** First PHP 8.x patch release whose built-in `session.upload_progress.enabled` default is Off (CVE-2026-115560). */
const DEFAULT_OFF_PATCH_8X: Readonly<Record<number, number>> = {
  2: 36,
  3: 37,
  4: 28,
  5: 13,
  6: 0,
};

interface UploadProgressPaths {
  phpRoot: string;
  fpmBinDir: string;
  panelUnit: string;
}

const DEFAULT_UPLOAD_PROGRESS_PATHS: UploadProgressPaths = {
  phpRoot: PHP_ROOT,
  fpmBinDir: PHP_FPM_BIN_DIR,
  panelUnit: PANEL_FPM_UNIT,
};

export interface UploadProgressOptions {
  paths?: Partial<UploadProgressPaths>;
  run?: (command: string, args: string[]) => CommandResult;
}

export interface FpmUploadProgress {
  /** `PHP 8.3`, or `CloudPanel (PHP 8.4)` for the panel's own FPM. */
  label: string;
  version: string;
  enabled: boolean;
  /** Who decided it: this project's drop-in, another config file, or PHP's own default. */
  setBy: "clp-addons" | "config" | "default";
  /** The file that decided it; empty for PHP's default. */
  source: string;
  /** Whether the effective value stays off without this project's drop-in (via operator config or PHP's default). */
  offWithoutGuard: boolean;
  /** When `offWithoutGuard` is true, whether an operator config file or PHP's built-in default keeps it off. */
  offWithoutGuardBy?: "config" | "default";
  /** Pools that turn it back on for themselves. */
  poolsOn: string[];
}

/**
 * PHP's built-in default for `session.upload_progress.enabled` for an installed
 * Debian `phpX.Y-fpm` package version. Fails safe to `true` (On) when the
 * package version is missing or unparseable.
 */
export function phpDefaultUploadProgress(packageVersion: string | undefined): boolean {
  if (!packageVersion) return true;
  const match = /^(?:[0-9]+:)?([0-9]+)\.([0-9]+)\.([0-9]+)(?:(~)|$|[+.-])/.exec(packageVersion.trim());
  if (!match) return true;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const prerelease = match[4] === "~";
  if (major > 8 || (major === 8 && minor >= 7)) return false;
  if (major < 8) return true;
  const minPatch = DEFAULT_OFF_PATCH_8X[minor];
  if (minPatch === undefined) return true;
  return !(patch > minPatch || (patch === minPatch && !prerelease));
}

/** PHP's own reading of an ini boolean: on/yes/true, or any non-zero number. */
export function iniBoolean(value: string): boolean {
  const lower = value.trim().toLowerCase();
  if (["on", "yes", "true"].includes(lower)) return true;
  const number = Number.parseInt(lower, 10);
  return Number.isFinite(number) && number !== 0;
}

function iniValue(raw: string): string {
  const value = raw.trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    return end > 0 ? value.slice(1, end) : value.slice(1);
  }
  const comment = value.indexOf(";");
  return (comment >= 0 ? value.slice(0, comment) : value).trim();
}

/** The last value an ini file gives the key outside a `[PATH=]` or `[HOST=]` section. */
export function iniSetting(text: string): string | undefined {
  let value: string | undefined;
  let scoped = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      scoped = /^\[(PATH|HOST)=/i.test(line);
      continue;
    }
    if (scoped) continue;
    const eq = line.indexOf("=");
    if (eq > 0 && line.slice(0, eq).trim() === KEY) value = iniValue(line.slice(eq + 1));
  }
  return value;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The main ini, then the scan directory's `*.ini` in the byte order PHP sorts them in. */
function iniFiles(mainIni: string, scanDir: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(scanDir).filter((name) => name.endsWith(".ini")).sort();
  } catch {}
  return [mainIni, ...names.map((name) => join(scanDir, name))];
}

function decide(files: string[]): { value: string | undefined; source: string } {
  let value: string | undefined;
  let source = "";
  for (const file of files) {
    const text = readText(file);
    if (text === null) continue;
    const setting = iniSetting(text);
    if (setting === undefined) continue;
    value = setting;
    source = file;
  }
  return { value, source };
}

function poolsTurningOn(poolDir: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(poolDir).filter((name) => name.endsWith(".conf")).sort();
  } catch {}
  const pools: string[] = [];
  for (const name of names) {
    const text = readText(join(poolDir, name)) ?? "";
    let pool = "";
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      const section = /^\[([^\]]+)\]$/.exec(line);
      if (section) { pool = section[1]!; continue; }
      const match = /^php_(?:admin_)?(?:value|flag)\[session\.upload_progress\.enabled\]\s*=\s*(.*)$/.exec(line);
      if (match && iniBoolean(iniValue(match[1]!)) && pool && !pools.includes(pool)) pools.push(pool);
    }
  }
  return pools;
}

function inspect(
  label: string,
  version: string,
  mainIni: string,
  scanDir: string,
  poolDir: string,
  defaultEnabled: boolean,
): FpmUploadProgress {
  const files = iniFiles(mainIni, scanDir);
  const ours = join(scanDir, PHP_GUARD_INI_NAME);
  const all = decide(files);
  const without = decide(files.filter((file) => file !== ours));
  const enabled = all.value === undefined ? defaultEnabled : iniBoolean(all.value);
  const offWithoutGuard = without.value === undefined ? !defaultEnabled : !iniBoolean(without.value);
  const offWithoutGuardBy = offWithoutGuard ? (without.value === undefined ? "default" : "config") : undefined;
  return {
    label,
    version,
    enabled,
    setBy: all.value === undefined ? "default" : all.source === ours ? "clp-addons" : "config",
    source: all.source,
    offWithoutGuard,
    ...(offWithoutGuardBy ? { offWithoutGuardBy } : {}),
    poolsOn: poolsTurningOn(poolDir),
  };
}

/** Installed Debian package versions for each `php<ver>-fpm`, in one `dpkg-query` call. */
function fpmPackageVersions(versions: string[], run: NonNullable<UploadProgressOptions["run"]>): Map<string, string> {
  const found = new Map<string, string>();
  const unique = [...new Set(versions)];
  if (unique.length === 0) return found;
  const query = run("dpkg-query", ["-W", "-f=${Package}\t${Status}\t${Version}\n", ...unique.map((version) => `php${version}-fpm`)]);
  // `dpkg-query` exits non-zero when any requested package is missing, while
  // still writing every found package to stdout, so parse stdout whenever
  // present; missing or unparseable entries fail safe to PHP's old default On.
  if (!query.stdout) return found;
  for (const line of query.stdout.split(/\r?\n/)) {
    const [pkg = "", status = "", version = ""] = line.split("\t");
    const minor = /^php([0-9]+\.[0-9]+)-fpm$/.exec(pkg.trim())?.[1];
    if (!minor || !status.trim().endsWith(" installed") || !version.trim()) continue;
    found.set(minor, version.trim());
  }
  return found;
}

/** The binary, `-c` and `-y` of the panel's FPM, from its unit as systemd resolved it. */
function panelFpm(paths: UploadProgressPaths, run: NonNullable<UploadProgressOptions["run"]>): { version: string; ini: string; conf: string } | null {
  const exec = run("systemctl", ["show", paths.panelUnit, "-p", "ExecStart", "--value"]);
  const argv = /argv\[\]=([^;]*)/.exec(exec.stdout)?.[1]?.trim().split(/\s+/);
  const version = argv && /php-fpm([0-9]+\.[0-9]+)$/.exec(argv[0] ?? "")?.[1];
  if (!exec.ok || !argv || !version) return null;
  const flag = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] ?? "" : "";
  };
  return { version, ini: flag("-c") || join(paths.phpRoot, version, "fpm", "php.ini"), conf: flag("-y") };
}

export function uploadProgressStatus(options: UploadProgressOptions = {}): FpmUploadProgress[] {
  const paths = { ...DEFAULT_UPLOAD_PROGRESS_PATHS, ...options.paths };
  const run = options.run ?? ((command, args) => runCommand(command, args, 10_000));
  const versions = existsSync(paths.fpmBinDir)
    ? readdirSync(paths.fpmBinDir)
      .map((name) => /^php-fpm([0-9]+\.[0-9]+)$/.exec(name)?.[1] ?? "")
      .filter((version) => VERSION_RE.test(version) && existsSync(join(paths.phpRoot, version, "fpm", "conf.d")))
      .sort((a, b) => {
        const [aMajor = 0, aMinor = 0] = a.split(".").map(Number);
        const [bMajor = 0, bMinor = 0] = b.split(".").map(Number);
        return aMajor - bMajor || aMinor - bMinor;
      })
    : [];
  const panel = panelFpm(paths, run);
  const pkgVersions = fpmPackageVersions(panel ? [...versions, panel.version] : versions, run);
  const rows = versions.map((version) => {
    const fpm = join(paths.phpRoot, version, "fpm");
    return inspect(
      `PHP ${version}`,
      version,
      join(fpm, "php.ini"),
      join(fpm, "conf.d"),
      join(fpm, "pool.d"),
      phpDefaultUploadProgress(pkgVersions.get(version)),
    );
  });
  if (panel) {
    rows.push(inspect(
      `CloudPanel (PHP ${panel.version})`,
      panel.version,
      panel.ini,
      join(paths.phpRoot, panel.version, "fpm", "conf.d"),
      panel.conf ? join(dirname(panel.conf), "pool.d") : "",
      phpDefaultUploadProgress(pkgVersions.get(panel.version)),
    ));
  }
  return rows;
}


interface UploadGuardState { guard: boolean; fpms: FpmUploadProgress[] }

function uploadProgressSource(row: FpmUploadProgress): string {
  const file = row.source.includes("/conf.d/") ? row.source.slice(row.source.lastIndexOf("/") + 1) : row.source;
  const pools = row.poolsOn.length ? ` On in pool${row.poolsOn.length === 1 ? "" : "s"} ${row.poolsOn.join(", ")}.` : "";
  if (!row.enabled && row.setBy === "clp-addons") {
    const also = !row.offWithoutGuard ? ""
      : row.offWithoutGuardBy === "default" ? " (also PHP's default)"
      : " and your own config";
    return `Set by clp-addons${also}.${pools}`;
  }
  if (!row.enabled && row.setBy === "default") return `PHP's default.${pools}`;
  if (!row.enabled) return `Set by your config in ${file}.${pools}`;
  return `${row.setBy === "default" ? "PHP's default" : `Set in ${file}`}.${pools}`;
}

function uploadProgressDetails(fpms: FpmUploadProgress[]): string {
  if (!fpms.length) return `<p class="st-status hint">No PHP-FPM is installed.</p>`;
  const on = fpms.filter((row) => row.enabled).length;
  const pools = fpms.reduce((total, row) => total + row.poolsOn.length, 0);
  const count = `${fpms.length} PHP-FPM${fpms.length === 1 ? "" : "s"}`;
  const summary = on === 0 ? `Off on ${fpms.length === 1 ? "its one PHP-FPM" : `all ${count}`}` : `On in ${on} of ${count}`;
  const poolText = pools ? `, on again in ${pools} pool${pools === 1 ? "" : "s"}` : "";
  return `
          <details class="st-fold">
            <summary>${badge(on || pools ? "Check" : "Off", on || pools ? "warn" : "ok")} ${summary}${poolText}</summary>
            <div class="table-scroll"><table class="st-table"><thead><tr><th>PHP-FPM</th><th class="st-state">Upload progress</th></tr></thead>
              <tbody>${fpms.map((row) => stateRow(row.label, uploadProgressSource(row),
                row.enabled ? badge("On", "bad") : row.poolsOn.length ? badge("Partly", "warn") : badge("Off", "ok"))).join("")}</tbody></table></div>
          </details>`;
}

type Options = { uploadProgress?: UploadProgressOptions; phpGuard?: PhpGuardOptions };

/** The platform's PHP upload-progress guard, which every install has; switching it off here is the only opt-out. */
export const UPLOAD_GUARD_TWEAK = tweak<{ uploadProgressGuard: boolean }, Options, { uploadProgress: UploadGuardState }>()({
  defaults: { uploadProgressGuard: true },
  state: ({ options, settings }) => ({ uploadProgress: { guard: settings.uploadProgressGuard, fpms: uploadProgressStatus(options.uploadProgress) } }),
  switch: {
    verb: "set-upload-guard",
    key: "uploadProgressGuard",
    set: saveThenApply("uploadProgressGuard", (on, options: Options) => reconcilePhpGuard(true, true, { ...options.phpGuard, optedOut: !on })),
  },
  restore: {
    run: ({ options, settings }) => {
      if (!settings.uploadProgressGuard) reconcilePhpGuard(true, false, { ...options.phpGuard, optedOut: true });
    },
  },
  row: ({ uploadProgress }, locked) => switchRow("set-upload-guard", {
    key: "uploadProgressGuard",
    title: "PHP upload-progress mitigation",
    description: `Turns PHP's session upload progress, a route into CVE-2026-109619 and CVE-2026-115560, off on every PHP-FPM with ${PHP_GUARD_INI_NAME}. Off removes only that file.`,
    checked: uploadProgress.guard,
    extra: uploadProgressDetails(uploadProgress.fpms),
  }, locked),
});
