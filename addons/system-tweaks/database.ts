/**
 * Who can reach CloudPanel's MySQL (or MariaDB): the addresses it listens on,
 * whether the loaded firewall rules let anyone at them, and whether root still logs in with a
 * default password. Binding it to loopback is one option file read after
 * CloudPanel's own and a restart, undone if the server does not come back.
 * See "Database exposure" in docs/decisions/system-tweaks.md.
 */
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { failAction, runCommand, type CommandResult } from "../../cli/action-common";
import { ROOT_UID, STATE_DIR } from "../../cli/paths";
import { inputVerdict, otherInputHooks, parseFilterTable } from "./input-rules";
import { writeFileAtomic } from "../../lib/atomic-write";

export const DATABASE_MARKER = "# Managed by clp-addons System Tweaks: MySQL accepts connections from this server only.";
const LOOPBACK = "127.0.0.1";
export const DATABASE_FILE = [
  DATABASE_MARKER,
  "[mysqld]",
  `bind-address = ${LOOPBACK}`,
  // MySQL's X Protocol port; MariaDB has none and only warns about a loose option.
  `loose-mysqlx-bind-address = ${LOOPBACK}`,
  "",
].join("\n");
/** How long a password check stands before the page asks the server again. */
const CHECK_TTL_MS = 15 * 60_000;
/** The default passwords looked for: CloudPanel's package install sets root's to `root`. */
const DEFAULTS = ["root", ""] as const;

export interface DatabasePaths {
  /** The directories MySQL and MariaDB read last on Debian and Ubuntu; the first that exists is used. */
  confDirs: string[];
  fileName: string;
  /** The last password check's outcome, never a password. */
  checkFile: string;
  /** The client the check runs, `mariadb` first because MariaDB 11 may not ship `mysql`. */
  clients: string[];
  service: string;
  rootUid: number;
}

export const DEFAULT_DATABASE_PATHS: DatabasePaths = {
  confDirs: ["/etc/mysql/mariadb.conf.d", "/etc/mysql/mysql.conf.d", "/etc/mysql/conf.d"],
  fileName: "zz-clp-addons-loopback.cnf",
  checkFile: `${STATE_DIR}/system-tweaks/database-check.json`,
  clients: ["/usr/bin/mariadb", "/usr/bin/mysql"],
  service: "mysql",
  rootUid: ROOT_UID,
};

export interface DatabaseOptions {
  paths?: Partial<DatabasePaths>;
  run?: (command: string, args: string[]) => CommandResult;
  /** Whether a MySQL server greets a connection on that address. */
  probe?: (host: string, port: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  healthTimeoutMs?: number;
}

/** Where root logged in with a default password: over loopback, or as any other host would. */
export interface DefaultPassword { from: "loopback" | "other hosts"; password: "root" | "empty" }

export interface DatabaseStatus {
  /** Whether a MySQL or MariaDB server is listening on TCP here. */
  running: boolean;
  /** Its listeners beyond loopback, as `*:3306`. */
  exposed: string[];
  /**
   * The loaded firewall rules for its exposed ports: "on" when they drop
   * connections from outside, apart from `openTo`; "off" when they accept them;
   * "unknown", with why, when they cannot be read.
   */
  firewall: { state: "on" | "off" | "unknown"; openTo: string[]; reason?: string };
  /** Addresses beyond loopback connected to it right now. */
  remoteClients: string[];
  defaultPassword: DefaultPassword[] | { error: string };
  /** Whether this addon's option file is in place. */
  fileInPlace: boolean;
}

interface Context {
  paths: DatabasePaths;
  run: (command: string, args: string[]) => CommandResult;
  probe: (host: string, port: number) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  healthTimeoutMs: number;
}

function contextOf(options: DatabaseOptions): Context {
  return {
    paths: { ...DEFAULT_DATABASE_PATHS, ...options.paths },
    run: options.run ?? ((command, args) => runCommand(command, args, 120_000)),
    probe: options.probe ?? greets,
    sleep: options.sleep ?? ((ms) => Bun.sleep(ms)),
    now: options.now ?? Date.now,
    healthTimeoutMs: options.healthTimeoutMs ?? 60_000,
  };
}

/** A server's first packet is its handshake (protocol 10) or an error; either way it is up. */
function greets(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(3_000, () => done(false));
    socket.once("data", (data) => done(data.length > 4 && (data[4] === 0x0a || data[4] === 0xff)));
    socket.once("error", () => done(false));
  });
}

// --- Sockets -------------------------------------------------------------

interface Endpoint { host: string; port: number; text: string }

function endpoint(text: string): Endpoint | null {
  const at = text.lastIndexOf(":");
  if (at < 0) return null;
  const port = Number(text.slice(at + 1));
  const host = text.slice(0, at).replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  return Number.isInteger(port) && port > 0 ? { host, port, text } : null;
}

function isLoopback(host: string): boolean {
  return /^127\./.test(host) || host === "::1" || /^::ffff:127\./i.test(host);
}

function isWildcard(host: string): boolean {
  return host === "*" || host === "0.0.0.0" || host === "::";
}

const SERVER_PROCESS = /users:\(\("(?:mysqld|mariadbd)"/;

/** The TCP listeners `ss -Hltnp` shows for mysqld or mariadbd. */
export function parseListeners(ss: string): Endpoint[] {
  return ss.split("\n").filter((line) => SERVER_PROCESS.test(line)).flatMap((line) => {
    const local = endpoint(line.trim().split(/\s+/)[3] ?? "");
    return local ? [local] : [];
  });
}

/** Peers beyond loopback with a connection open to one of `ports`, from `ss -Htn state established`. */
export function parseRemoteClients(ss: string, ports: number[]): string[] {
  const peers = new Set<string>();
  for (const line of ss.split("\n")) {
    const [local, peer] = line.trim().split(/\s+/).slice(2, 4).map((field) => endpoint(field ?? ""));
    if (local && peer && ports.includes(local.port) && !isLoopback(peer.host)) peers.add(peer.host);
  }
  return [...peers];
}

/** The classic protocol's port: 3306, or failing that any but the X Protocol's. */
function classicPort(all: Endpoint[]): number {
  return (all.find((listener) => listener.port === 3306) ?? all.find((listener) => listener.port !== 33060) ?? all[0]!).port;
}

function listeners(ctx: Context): Endpoint[] {
  const shown = ctx.run("ss", ["-Hltnp"]);
  return shown.ok ? parseListeners(shown.stdout) : [];
}

// --- The firewall --------------------------------------------------------

/**
 * What the rules loaded now do with a new connection from outside to each
 * exposed port, not what ufw's files say: those can be on while nothing is
 * loaded. Another nftables table cannot let in what these drop, since every
 * input hook must accept a packet, but it can drop what these accept.
 */
function firewallFor(ctx: Context, exposed: Endpoint[]): DatabaseStatus["firewall"] {
  if (!exposed.length) return { state: "on", openTo: [] };
  const ports = [...new Set(exposed.map((listener) => listener.port))];
  const families: [string, boolean][] = [
    // A wildcard, `::` included, also takes IPv4 unless the server set IPV6_V6ONLY.
    ["iptables-save", exposed.some((listener) => isWildcard(listener.host) || /^\d+\./.test(listener.host))],
    ["ip6tables-save", exposed.some((listener) => listener.host === "*" || listener.host.includes(":"))],
  ];
  const openTo = new Set<string>();
  let open = false;
  for (const [tool, wanted] of families) {
    if (!wanted) continue;
    const saved = ctx.run(tool, ["-t", "filter"]);
    if (!saved.ok) return { state: "unknown", openTo: [], reason: `${tool} failed: ${(saved.stderr || saved.stdout).trim().split("\n")[0] || `exit ${saved.exitCode ?? "unknown"}`}` };
    const table = parseFilterTable(saved.stdout);
    // No filter table loaded: iptables filters nothing for this family.
    if (!table) { open = true; continue; }
    for (const port of ports) {
      const verdict = inputVerdict(table, port);
      if (verdict.verdict === "unknown") return { state: "unknown", openTo: [], reason: verdict.reason };
      if (verdict.verdict === "accept") open = true;
      else for (const opening of verdict.openTo) openTo.add(opening);
    }
  }
  if (!open) return { state: "on", openTo: [...openTo] };
  const chains = ctx.run("nft", ["list", "chains"]);
  const others = chains.ok ? otherInputHooks(chains.stdout) : [];
  if (others.length) {
    return { state: "unknown", openTo: [], reason: `iptables lets it in, but nftables also filters incoming traffic in ${others.join(", ")}` };
  }
  return { state: "off", openTo: [] };
}

// --- The default password --------------------------------------------------

interface StoredCheck { at: number; key: string; result: DatabaseStatus["defaultPassword"] }

function readCheck(ctx: Context, key: string): StoredCheck["result"] | null {
  try {
    const info = lstatSync(ctx.paths.checkFile);
    if (!info.isFile() || info.uid !== ctx.paths.rootUid) return null;
    const stored = JSON.parse(readFileSync(ctx.paths.checkFile, "utf8")) as StoredCheck;
    return stored.key === key && ctx.now() - stored.at < CHECK_TTL_MS ? stored.result : null;
  } catch {
    return null;
  }
}

/** A global address of this box, which the server sees as another host's. */
function ownAddress(ctx: Context, exposed: Endpoint[]): string | null {
  const named = exposed.find((listener) => !isWildcard(listener.host));
  if (named) return named.host;
  const shown = ctx.run("ip", ["-o", "-4", "addr", "show", "scope", "global"]);
  for (const line of shown.ok ? shown.stdout.split("\n") : []) {
    const match = /^\d+:\s+(\S+)\s+inet\s+([0-9.]+)\//.exec(line);
    if (match && !/^(?:docker|br-|veth)/.test(match[1]!)) return match[2]!;
  }
  return null;
}

/**
 * Tries root with each default password, as a client would: over loopback,
 * and from this box's own public address, which matches the accounts any
 * other host would. The passwords tried are the public defaults; nothing
 * the server or the panel stores is read.
 */
function checkDefaults(ctx: Context, all: Endpoint[], exposed: Endpoint[]): DatabaseStatus["defaultPassword"] {
  const client = ctx.paths.clients.find((path) => existsSync(path));
  if (!client) return { error: "no mysql or mariadb client is installed" };
  const mysqlClient = !/MariaDB/i.test(ctx.run(client, ["--version"]).stdout);
  const port = classicPort(all);
  const targets: [DefaultPassword["from"], string][] = [];
  if (all.some((listener) => listener.port === port && (isLoopback(listener.host) || isWildcard(listener.host)))) {
    targets.push(["loopback", LOOPBACK]);
  }
  const own = exposed.length ? ownAddress(ctx, exposed) : null;
  if (own) targets.push(["other hosts", own]);
  const found: DefaultPassword[] = [];
  for (const [from, host] of targets) {
    for (const password of DEFAULTS) {
      const tried = ctx.run(client, [
        "--no-defaults", "--protocol=TCP", `--host=${host}`, `--port=${port}`, "--user=root",
        ...(password ? [`--password=${password}`] : []), "--connect-timeout=5",
        ...(mysqlClient ? ["--get-server-public-key"] : []), "--batch", "--skip-column-names", "--execute=SELECT 1",
      ]);
      if (tried.ok) {
        found.push({ from, password: password ? "root" : "empty" });
        continue;
      }
      // Wrong password, or no root account for that host.
      if (/ERROR (?:1045|1130|1698)\b/.test(tried.stderr)) continue;
      const reason = tried.stderr.split("\n").find((line) => /ERROR/.test(line)) ?? `exit ${tried.exitCode ?? "unknown"}`;
      return { error: `logging in to ${host} failed: ${reason.trim()}` };
    }
  }
  return found;
}

function defaultPasswords(ctx: Context, all: Endpoint[], exposed: Endpoint[]): DatabaseStatus["defaultPassword"] {
  const key = all.map((listener) => listener.text).sort().join(" ");
  const cached = readCheck(ctx, key);
  if (cached) return cached;
  const result = checkDefaults(ctx, all, exposed);
  try {
    writeFileAtomic(ctx.paths.checkFile, `${JSON.stringify({ at: ctx.now(), key, result })}\n`, { mode: 0o600, createParent: true });
  } catch {
    // Unsaved only means the next page load asks again.
  }
  return result;
}

// --- The option file ---------------------------------------------------------

function optionFile(ctx: Context): string | null {
  const dir = ctx.paths.confDirs.find((path) => existsSync(path));
  return dir ? join(dir, ctx.paths.fileName) : null;
}

function current(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

export function databaseStatus(options: DatabaseOptions = {}): DatabaseStatus {
  const ctx = contextOf(options);
  const all = listeners(ctx);
  const exposed = all.filter((listener) => !isLoopback(listener.host));
  const ports = [...new Set(all.map((listener) => listener.port))];
  const established = ctx.run("ss", ["-Htn", "state", "established"]);
  const file = optionFile(ctx);
  return {
    running: all.length > 0,
    exposed: exposed.map((listener) => listener.text),
    firewall: firewallFor(ctx, exposed),
    remoteClients: established.ok ? parseRemoteClients(established.stdout, ports) : [],
    defaultPassword: all.length ? defaultPasswords(ctx, all, exposed) : [],
    fileInPlace: file !== null && current(file) === DATABASE_FILE,
  };
}

/** The bind-address the server will start with: null when none is set, undefined when no tool here can say. */
function effectiveBindAddress(ctx: Context): string | null | undefined {
  for (const tool of ["my_print_defaults", "mariadb-print-defaults"]) {
    const shown = ctx.run(tool, ["mysqld", "server", "mariadb", "mariadbd"]);
    if (!shown.ok) continue;
    const values = [...shown.stdout.matchAll(/^--bind[-_]address=(.*)$/gm)].map((match) => match[1]!.trim());
    return values.at(-1) ?? null;
  }
  return undefined;
}

/** Why the server is not yet serving as wanted, or null once it is. */
async function unhealthy(ctx: Context, loopbackOnly: boolean): Promise<string | null> {
  const state = ctx.run("systemctl", ["is-active", ctx.paths.service]).stdout.trim();
  if (state !== "active") return `${ctx.paths.service} is ${state || "not running"}`;
  const all = listeners(ctx);
  if (!all.length) return "it is not listening on TCP";
  const exposed = all.filter((listener) => !isLoopback(listener.host));
  if (loopbackOnly && exposed.length) return `it still listens on ${exposed.map((listener) => listener.text).join(", ")}`;
  const port = classicPort(all);
  const local = all.some((listener) => listener.port === port && (isLoopback(listener.host) || isWildcard(listener.host)));
  if (local && !(await ctx.probe(LOOPBACK, port))) return `it does not answer on ${LOOPBACK}:${port}`;
  return null;
}

async function waitHealthy(ctx: Context, loopbackOnly: boolean): Promise<string | null> {
  const deadline = ctx.now() + ctx.healthTimeoutMs;
  let problem = await unhealthy(ctx, loopbackOnly);
  while (problem && ctx.now() < deadline) {
    await ctx.sleep(1_000);
    problem = await unhealthy(ctx, loopbackOnly);
  }
  return problem;
}

function put(path: string, content: string | null): void {
  if (content === null) rmSync(path, { force: true });
  else writeFileAtomic(path, content, { mode: 0o644, createParent: false });
}

function restart(ctx: Context): void {
  const result = ctx.run("systemctl", ["restart", ctx.paths.service]);
  if (!result.ok) failAction(`restarting ${ctx.paths.service} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode ?? "unknown"}`}`);
}

/**
 * Adds or removes the option file and restarts the server onto it. Turning it
 * on when the server already listens on loopback alone needs no restart. A
 * server that does not come back gets the previous file and another restart.
 */
export async function setDatabaseLoopback(on: boolean, options: DatabaseOptions = {}): Promise<void> {
  const ctx = contextOf(options);
  const file = optionFile(ctx);
  if (!file) failAction(`no MySQL or MariaDB config directory: looked for ${ctx.paths.confDirs.join(", ")}`);
  const before = current(file);
  if (before !== null && before !== DATABASE_FILE && !before.startsWith(DATABASE_MARKER)) {
    failAction(`${file} is not this addon's; move it away to let System Tweaks manage it`);
  }
  const all = listeners(ctx);
  const exposed = all.some((listener) => !isLoopback(listener.host));
  if (on && before === DATABASE_FILE && !exposed) return;
  if (!on && before === null) return;
  put(file, on ? DATABASE_FILE : null);
  let restarted = false;
  try {
    if (on) {
      const effective = effectiveBindAddress(ctx);
      if (effective !== undefined && effective !== LOOPBACK) {
        failAction(`another MySQL option file sets bind-address after ${file}${effective ? `, to ${effective}` : ""}; remove it there first`);
      }
      if (!exposed) return;
    }
    restarted = true;
    restart(ctx);
    const problem = await waitHealthy(ctx, on);
    if (problem) failAction(`MySQL did not come back ${on ? "on loopback only" : "on its own settings"}: ${problem}`);
  } catch (error) {
    if (!restarted) {
      put(file, before);
      throw error;
    }
    let restored: string;
    try {
      put(file, before);
      ctx.run("systemctl", ["restart", ctx.paths.service]);
      const after = await waitHealthy(ctx, false);
      restored = after ? `the previous settings were put back, but ${after}` : "the previous settings are back";
    } catch (restoreError) {
      restored = `putting the previous settings back failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`;
    }
    failAction(`${error instanceof Error ? error.message : String(error)}; ${restored}`);
  }
}

/**
 * Puts the file back to the saved choice without a restart, so repair never
 * takes the databases down: a server running without it picks it up at its
 * next restart. Returns what changed.
 */
export function reconcileDatabaseFile(on: boolean, options: DatabaseOptions = {}): string | null {
  const ctx = contextOf(options);
  const file = optionFile(ctx);
  if (!file) return null;
  const before = current(file);
  if (on && before !== DATABASE_FILE && (before === null || before.startsWith(DATABASE_MARKER))) {
    put(file, DATABASE_FILE);
    return "MySQL loopback file put back; it applies at MySQL's next restart";
  }
  if (!on && before?.startsWith(DATABASE_MARKER)) {
    put(file, null);
    return "MySQL loopback file removed; MySQL listens on every address after its next restart";
  }
  return null;
}
