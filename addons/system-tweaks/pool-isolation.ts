/**
 * CloudPanel gives each site a PHP-FPM pool on a TCP port on 127.0.0.1, with
 * `listen.allowed_clients = 127.0.0.1`. Any local account can therefore send
 * FastCGI to another site's pool and run PHP as that site's user. An nftables
 * table of its own lets only root (nginx's workers), the panel's user, nginx's
 * user and each pool's own user connect to that pool's port. ufw and CloudPanel's
 * Firewall page manage other tables, so they leave this one in place.
 *
 * The ports change whenever CloudPanel adds, moves or removes a site's pool, and
 * it reloads or restarts that PHP-FPM with systemctl each time. A drop-in on
 * every PHP-FPM unit runs `clp-addons sync-php-pools` before each start, which
 * also covers the first one after a reboot. On a reload it runs before the
 * unit's own reload lines, adding the ports in the pool files to those already
 * closed, so a new port is closed before PHP-FPM binds it. After them, and on
 * every other sync, it drops a port no pool file names once nothing listens on
 * it, since PHP-FPM lets an old port go only after the reload returns. Not after the start:
 * these units are `Type=notify` with a `PIDFile=`, and with a start-post
 * command systemd waits for a PID file PHP-FPM does not write, until the start
 * times out.
 */
import { addonStateDir, CLI_BIN, PANEL_USER, SYSTEMD_DIR } from "../../lib/paths";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { commandOutput, runCommand, type CommandResult } from "../../lib/command";
import { writeFileAtomic, writeOrRemove } from "../../lib/atomic-write";
import { daemonReload } from "../../lib/systemd";
import { regularText } from "../../lib/trusted-file";
import { COMMAND_MS, PHP_POOLS_GATEWAY_TIMEOUT_MS } from "./limits";
import { saveThenApply, tweak } from "./tweak";
import { badge, statusLine, switchRow } from "./app/rows";
import { esc } from "../../lib/app-http";

const POOL_TABLE = "clp_addons_php_pools";
const DROP_IN = "zz-clp-addons-php-pools.conf";

const DEFAULT_POOL_ISOLATION_PATHS = {
  phpRoot: "/etc/php",
  passwdFile: "/etc/passwd",
  nginxConf: "/etc/nginx/nginx.conf",
  systemdDir: SYSTEMD_DIR,
  /** The ruleset last loaded, which is also what `nft -f` reads. */
  rulesFile: `${addonStateDir("system-tweaks")}/php-pools.nft`,
  procNet: "/proc/net",
  bin: CLI_BIN,
  panelUser: PANEL_USER,
};

type PoolIsolationPaths = typeof DEFAULT_POOL_ISOLATION_PATHS;

export interface PoolIsolationOptions {
  paths?: Partial<PoolIsolationPaths>;
  run?: (command: string, args: string[]) => CommandResult;
}

export interface PoolIsolationStatus {
  /** The table is loaded with the pools as they are now, and every PHP-FPM unit refreshes it. */
  active: boolean;
  /** Why it cannot be applied, such as nft missing; empty otherwise. */
  problem: string;
}

export interface Pool { version: string; name: string; port: number; user: string }

function context(options: PoolIsolationOptions) {
  return {
    paths: { ...DEFAULT_POOL_ISOLATION_PATHS, ...options.paths },
    run: options.run ?? ((command: string, args: string[]) => runCommand(command, args, COMMAND_MS)),
  };
}

function versions(paths: PoolIsolationPaths): string[] {
  if (!existsSync(paths.phpRoot)) return [];
  return readdirSync(paths.phpRoot)
    .filter((version) => /^[0-9]+\.[0-9]+$/.test(version) && existsSync(join(paths.phpRoot, version, "fpm", "pool.d")))
    .sort();
}

/**
 * The TCP port a `listen` value names, when it is reachable from this host:
 * `9000`, `127.0.0.1:9000`, `0.0.0.0:9000`, `localhost:9000` or `[::1]:9000`.
 * A Unix socket has file permissions of its own and is left out.
 */
export function listenPort(value: string): number | null {
  const listen = value.trim().replace(/^["']|["']$/g, "");
  const match = /^(?:(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):)?([0-9]{1,5})$/.exec(listen);
  const port = match ? Number(match[1]) : NaN;
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

export function phpPools(options: PoolIsolationOptions = {}): Pool[] {
  const { paths } = context(options);
  const pools: Pool[] = [];
  for (const version of versions(paths)) {
    const dir = join(paths.phpRoot, version, "fpm", "pool.d");
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".conf")).sort()) {
      const text = regularText(join(dir, file));
      if (text === null) continue;
      let current: { name: string; listen?: string; user?: string } | null = null;
      const flush = () => {
        const port = current?.listen === undefined ? null : listenPort(current.listen);
        if (current && current.name !== "global" && port !== null) pools.push({ version, name: current.name, port, user: current.user ?? "" });
      };
      for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith(";") || line.startsWith("#")) continue;
        const section = /^\[([^\]]+)\]$/.exec(line);
        if (section) {
          flush();
          current = { name: section[1]! };
          continue;
        }
        const setting = /^(listen|user)\s*=\s*(.*?)\s*$/.exec(line);
        if (current && setting) current[setting[1] as "listen" | "user"] = setting[2]!.replace(/^["']|["']$/g, "");
      }
      flush();
    }
  }
  return pools;
}

function uids(passwdFile: string): Map<string, number> {
  const users = new Map<string, number>();
  for (const line of (regularText(passwdFile) ?? "").split("\n")) {
    const [name, , uid] = line.split(":");
    if (name && uid !== undefined && /^[0-9]+$/.test(uid)) users.set(name, Number(uid));
  }
  return users;
}

/** nginx's worker user from its `user` line; root when it has none. */
function nginxUser(nginxConf: string): string {
  return /^\s*user\s+([A-Za-z0-9._-]+)/m.exec(regularText(nginxConf) ?? "")?.[1] ?? "root";
}

/**
 * The table: a pool's port accepts root, the panel's and nginx's users, and
 * the pool's own user; any other local account is refused. Only traffic to
 * this host is matched, so a site's PHP still reaches the same port elsewhere.
 */
export function poolRuleset(pools: Pool[], users: Map<string, number>, trusted: string[], also: LoadedSets = { ports: [], owners: [] }): string {
  const poolPorts = new Set(pools.map((pool) => pool.port));
  const ports = [...new Set([...poolPorts, ...also.ports])].sort((a, b) => a - b);
  const trustedUids = [...new Set([0, ...trusted.map((name) => users.get(name)).filter((uid): uid is number => uid !== undefined)])].sort((a, b) => a - b);
  // A port a pool file names admits only that pool's user, never one it had before.
  const owners = [...new Set([...pools.flatMap((pool) => {
    const uid = users.get(pool.user);
    return uid === undefined ? [] : [`${pool.port} . ${uid}`];
  }), ...also.owners.filter((owner) => !poolPorts.has(Number(owner.split(" . ")[0])))])].sort();
  const elements = (values: (string | number)[]) => values.length ? ` elements = { ${values.join(", ")} };` : "";
  return [
    "# Managed by clp-addons System Tweaks: only nginx and each pool's own user reach a PHP-FPM pool's port.",
    `table inet ${POOL_TABLE}`,
    `delete table inet ${POOL_TABLE}`,
    `table inet ${POOL_TABLE} {`,
    `  set ports { type inet_service;${elements(ports)} }`,
    `  set owners { type inet_service . uid;${elements(owners)} }`,
    "  chain output {",
    "    type filter hook output priority 0; policy accept;",
    `    oifname "lo" tcp dport @ports meta skuid { ${trustedUids.join(", ")} } accept`,
    `    oifname "lo" tcp dport . meta skuid @owners accept`,
    `    oifname "lo" tcp dport @ports reject with tcp reset`,
    "  }",
    "}",
    "",
  ].join("\n");
}

/** The ports and port-owner pairs of a ruleset {@link poolRuleset} wrote. */
interface LoadedSets { ports: number[]; owners: string[] }

function loadedSets(rules: string): LoadedSets {
  const elements = (set: string) => new RegExp(`^  set ${set} \\{[^{}]*elements = \\{ ([^{}]*) \\}; \\}$`, "m").exec(rules)?.[1]?.split(", ") ?? [];
  return {
    ports: elements("ports").map(Number).filter((port) => Number.isInteger(port) && port > 0 && port < 65536),
    owners: elements("owners").filter((owner) => /^[0-9]+ \. [0-9]+$/.test(owner)),
  };
}

/** TCP ports something on this host listens on, from /proc/net/tcp and tcp6. */
function listeningPorts(procNet: string): Set<number> {
  const ports = new Set<number>();
  for (const file of ["tcp", "tcp6"]) {
    let text = "";
    try { text = readFileSync(join(procNet, file), "utf8"); } catch { continue; }
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === "0A") ports.add(Number.parseInt(fields[1]?.split(":")[1] ?? "", 16));
    }
  }
  return ports;
}

function stillListening(loaded: LoadedSets, procNet: string): LoadedSets {
  const listening = listeningPorts(procNet);
  return {
    ports: loaded.ports.filter((port) => listening.has(port)),
    owners: loaded.owners.filter((owner) => listening.has(Number(owner.split(" . ")[0]))),
  };
}

function expectedRuleset(paths: PoolIsolationPaths, also?: LoadedSets): string {
  return poolRuleset(phpPools({ paths }), uids(paths.passwdFile), [paths.panelUser, nginxUser(paths.nginxConf)], also);
}

/**
 * The unit's own `ExecReload=` lines as systemd puts them together from its
 * file and drop-ins, without ours; null when they cannot be read.
 */
function unitReloadLines(run: (command: string, args: string[]) => CommandResult, version: string): string[] | null {
  const shown = run("systemctl", ["show", "-p", "FragmentPath", "-p", "DropInPaths", `php${version}-fpm.service`]);
  if (!shown.ok) return null;
  const property = (key: string) => shown.stdout.split("\n").find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1).trim() ?? "";
  const files = [property("FragmentPath"), ...property("DropInPaths").split(/\s+/)].filter((file) => file && basename(file) !== DROP_IN);
  let lines: string[] = [];
  for (const file of files) {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { return null; }
    for (const line of text.split("\n").map((raw) => raw.trimEnd())) {
      if (!line.startsWith("ExecReload=")) continue;
      if (line.endsWith("\\")) return null;
      lines = line === "ExecReload=" ? [] : [...lines, line];
    }
  }
  return lines.length ? lines : null;
}

/**
 * Sync before every start, and on a reload both before the unit's own reload
 * lines and after them. A unit whose reload lines cannot be read gets the sync
 * after its reload only.
 */
function poolDropIn(bin: string, reload: string[] | null): string {
  return [
    "# Managed by clp-addons System Tweaks: refreshes which accounts reach each PHP pool's port.",
    "[Service]",
    `ExecStartPre=-${bin} sync-php-pools`,
    ...(reload ? ["ExecReload=", `ExecReload=-${bin} sync-php-pools --before-reload`, ...reload] : []),
    `ExecReload=-${bin} sync-php-pools`,
    "",
  ].join("\n");
}

function dropInPath(paths: PoolIsolationPaths, version: string): string {
  return join(paths.systemdDir, `php${version}-fpm.service.d`, DROP_IN);
}

function tableLoaded(run: (command: string, args: string[]) => CommandResult): boolean {
  return run("nft", ["list", "table", "inet", POOL_TABLE]).ok;
}

/**
 * Load the table from the pool files as they are now. A port already loaded
 * stays closed before a reload, and afterwards while something still listens
 * on it, since PHP-FPM lets an old port go only after the reload returns.
 * Returns whether anything changed.
 */
export function syncPoolIsolation(options: PoolIsolationOptions = {}, beforeReload = false): boolean {
  const { paths, run } = context(options);
  const inForce = tableLoaded(run);
  const current = regularText(paths.rulesFile);
  const closed = inForce && current !== null ? loadedSets(current) : undefined;
  const rules = expectedRuleset(paths, closed && (beforeReload ? closed : stillListening(closed, paths.procNet)));
  if (current === rules && inForce) return false;
  writeFileAtomic(paths.rulesFile, rules, { mode: 0o600, createParent: true });
  const loaded = run("nft", ["-f", paths.rulesFile]);
  if (!loaded.ok) {
    rmSync(paths.rulesFile, { force: true });
    throw new Error(`nft refused the PHP pool rules: ${commandOutput(loaded)}`);
  }
  return true;
}

/** The table, and the drop-in on every PHP-FPM unit that keeps it current. Returns whether anything changed. */
export function installPoolIsolation(options: PoolIsolationOptions = {}): boolean {
  const { paths, run } = context(options);
  const written = new Map<string, string | null>();
  for (const version of versions(paths)) {
    const file = dropInPath(paths, version);
    const content = poolDropIn(paths.bin, unitReloadLines(run, version));
    const before = regularText(file);
    if (before === content) continue;
    writeFileAtomic(file, content, { mode: 0o644, createParent: true });
    written.set(file, before);
  }
  if (written.size) {
    try {
      daemonReload(run);
    } catch (error) {
      // Each drop-in is compared by its text, so one left in place that systemd
      // never loaded would pass for applied and its reload never be retried.
      for (const [file, before] of written) writeOrRemove(file, before, { mode: 0o644 });
      throw error;
    }
  }
  return syncPoolIsolation(options) || written.size > 0;
}

/** Returns whether anything changed. */
export function removePoolIsolation(options: PoolIsolationOptions = {}): boolean {
  const { paths, run } = context(options);
  let changed = false;
  const dirs = existsSync(paths.systemdDir) ? readdirSync(paths.systemdDir).filter((name) => /^php[0-9]+\.[0-9]+-fpm\.service\.d$/.test(name)) : [];
  for (const dir of dirs) {
    const file = join(paths.systemdDir, dir, DROP_IN);
    if (!existsSync(file)) continue;
    rmSync(file, { force: true });
    changed = true;
  }
  // A unit systemd still runs with the drop-in would load the table again at its next reload.
  if (changed) daemonReload(run);
  if (tableLoaded(run)) {
    const deleted = run("nft", ["delete", "table", "inet", POOL_TABLE]);
    if (!deleted.ok) throw new Error(`nft could not remove the PHP pool rules: ${commandOutput(deleted)}`);
    changed = true;
  }
  if (existsSync(paths.rulesFile)) {
    rmSync(paths.rulesFile, { force: true });
    changed = true;
  }
  return changed;
}

export function poolIsolationStatus(options: PoolIsolationOptions = {}): PoolIsolationStatus {
  const { paths, run } = context(options);
  if (!run("nft", ["--version"]).ok) return { active: false, problem: "nft is not installed." };
  const dropIns = versions(paths).every((version) => regularText(dropInPath(paths, version)) === poolDropIn(paths.bin, unitReloadLines(run, version)));
  // Every pool file's port is closed to the right users; a port kept closed until the next sync is not a gap.
  const current = regularText(paths.rulesFile);
  return { active: dropIns && current !== null && current === expectedRuleset(paths, loadedSets(current)) && tableLoaded(run), problem: "" };
}

type PhpPoolsState = PoolIsolationStatus & { enabled: boolean };

function phpPoolsLine(state: PhpPoolsState): string {
  if (state.problem) return `${badge("Not applied", "warn")} <span>${esc(state.problem)}</span>`;
  if (state.active) return `${badge("On", "ok")} <span>Each pool's port answers only nginx and the pool's own user.</span>`;
  if (state.enabled) return `${badge("Not applied", "warn")} <span>Run clp-addons repair.</span>`;
  return `${badge("Off", "plain")} <span>Any account on the server can run PHP as any site through its pool's port.</span>`;
}

type Options = { phpPools?: PoolIsolationOptions };

/** Let only nginx and each pool's own user connect to a site's PHP-FPM port. */
export const PHP_POOLS_TWEAK = tweak<{ isolatePhpPools: boolean }, Options, { phpPools: PhpPoolsState }>()({
  defaults: { isolatePhpPools: true },
  state: ({ options, settings }) => ({ phpPools: { enabled: settings.isolatePhpPools, ...poolIsolationStatus(options.phpPools) } }),
  switch: {
    verb: "set-php-pools",
    key: "isolatePhpPools",
    timeout: PHP_POOLS_GATEWAY_TIMEOUT_MS,
    // Saved first, so a PHP-FPM reload meanwhile follows the new setting.
    set: saveThenApply("isolatePhpPools", (on, options: Options) => on ? installPoolIsolation(options.phpPools) : removePoolIsolation(options.phpPools)),
  },
  repair: {
    rules: {
      label: "PHP pools",
      locked: true,
      run: ({ options, settings }) => settings.isolatePhpPools && installPoolIsolation(options.phpPools) && "PHP pool ports limited to nginx and each pool's own user",
    },
  },
  withdraw: { run: ({ options }) => { removePoolIsolation(options.phpPools); } },
  restore: { run: ({ options, settings }) => { if (settings.isolatePhpPools) installPoolIsolation(options.phpPools); } },
  row: ({ phpPools }, locked) => switchRow("set-php-pools", {
    key: "isolatePhpPools",
    title: "Isolate PHP pools",
    description: [
      "Lets only nginx and each site's own user connect to the site's PHP-FPM port, so one site's user cannot run PHP as another site's.",
      "A tool that reaches another site's pool from its own account, such as a monitoring agent, stops working.",
    ],
    checked: phpPools.enabled,
    extra: statusLine(phpPoolsLine(phpPools)),
  }, locked),
});
