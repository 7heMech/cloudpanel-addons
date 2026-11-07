/**
 * Who can reach CloudPanel's MySQL (or MariaDB): the addresses it listens on,
 * whether the loaded firewall rules let anyone at them, and whether root still logs in with a
 * default password. Binding it to loopback is one option file read after
 * CloudPanel's own and a restart, undone if the server does not come back.
 * See "Database exposure" in docs/decisions/system-tweaks.md.
 */
import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { failAction } from "../../lib/action";
import { runCommand, type CommandResult } from "../../lib/command";
import { ROOT_UID, STATE_DIR } from "../../lib/paths";
import { inputVerdict, otherInputHooks, parseFilterTable } from "./input-rules";
import { writeFileAtomic } from "../../lib/atomic-write";
import { COMMAND_MS, DATABASE_SERVICE_MS } from "./limits";
import {
  DATABASE_SOCKET_FILE, DATABASE_SOCKET_UNIT, parseSocketBindings, putSocketFile, readSocketFile, renderSocketFile,
  type SocketBindings,
} from "./database-socket";

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
  /** Server programs to inspect when the service is stopped. */
  servers: string[];
  procRoot: string;
  socketFile: string;
  service: string;
  rootUid: number;
}

export const DEFAULT_DATABASE_PATHS: DatabasePaths = {
  confDirs: ["/etc/mysql/mariadb.conf.d", "/etc/mysql/mysql.conf.d", "/etc/mysql/conf.d"],
  fileName: "zz-clp-addons-loopback.cnf",
  checkFile: `${STATE_DIR}/system-tweaks/database-check.json`,
  clients: ["/usr/bin/mariadb", "/usr/bin/mysql"],
  servers: ["/usr/sbin/mariadbd", "/usr/sbin/mysqld"],
  procRoot: "/proc",
  socketFile: DATABASE_SOCKET_FILE,
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
  /** Why its listeners could not be read; the fields about them are then empty. */
  listenersUnknown?: string;
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
  /** MariaDB's activation socket; changes need both this unit and MySQL restarted. */
  socketUnit?: string;
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
    run: options.run ?? ((command, args) => runCommand(command, args,
      command === "systemctl" && ["stop", "start", "restart"].includes(args[0] ?? "") ? DATABASE_SERVICE_MS : COMMAND_MS)),
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

const SERVER_PROCESS = /users:\(.*\("(?:mysqld|mariadbd)"/;
const SYSTEMD_PROCESS = /users:\(.*\("(?:systemd|init)",pid=1,/;

/** The TCP listeners `ss -Hltnp` shows for mysqld or mariadbd. */
export function parseListeners(ss: string, socketPorts: number[] = []): Endpoint[] {
  return ss.split("\n").flatMap((line) => {
    const local = endpoint(line.trim().split(/\s+/)[3] ?? "");
    return local && (SERVER_PROCESS.test(line) || (SYSTEMD_PROCESS.test(line) && socketPorts.includes(local.port))) ? [local] : [];
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

function listeners(ctx: Context, socketPorts: number[] = []): Endpoint[] | { error: string } {
  const shown = ctx.run("ss", ["-Hltnp"]);
  if (shown.ok) return parseListeners(shown.stdout, socketPorts);
  return { error: `ss failed: ${(shown.stderr || shown.stdout).trim().split("\n")[0] || `exit ${shown.exitCode ?? "unknown"}`}` };
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

interface ServiceState { id: string; pid: string; active: boolean; sockets: string[] }
interface SocketState {
  unit: typeof DATABASE_SOCKET_UNIT;
  active: boolean;
  service: ServiceState;
  bindings: SocketBindings;
}

function property(output: string, key: string): string | undefined {
  return output.split("\n").find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);
}

function serviceState(ctx: Context): ServiceState {
  const shown = ctx.run("systemctl", ["show", ctx.paths.service, "--property=Id", "--property=MainPID", "--property=TriggeredBy", "--property=ActiveState"]);
  const id = property(shown.stdout, "Id");
  const pid = property(shown.stdout, "MainPID");
  const state = property(shown.stdout, "ActiveState");
  if (!shown.ok || !id?.endsWith(".service") || !pid || !/^\d+$/.test(pid) || !["active", "inactive", "failed"].includes(state ?? "")) {
    failAction(`could not inspect a settled ${ctx.paths.service} service; MySQL has not been restarted`);
  }
  return { id, pid, active: state === "active", sockets: (property(shown.stdout, "TriggeredBy") ?? "").split(/\s+/).filter((unit) => unit.endsWith(".socket")) };
}

/** Only the standard, single MariaDB activation socket belongs to this setting. */
function socketState(ctx: Context, service: ServiceState, managed: string | null, force = false): SocketState | null {
  for (const unit of service.sockets.filter((name) => name !== DATABASE_SOCKET_UNIT)) {
    const state = ctx.run("systemctl", ["is-active", unit]).stdout.trim();
    if (state !== "inactive" && state !== "failed") failAction(`MySQL uses unsupported activation socket ${unit}; it was left unchanged`);
  }
  if (!service.sockets.includes(DATABASE_SOCKET_UNIT) && managed === null && !force) return null;
  const shown = ctx.run("systemctl", ["show", DATABASE_SOCKET_UNIT, "--property=Id", "--property=LoadState", "--property=ActiveState", "--property=Accept", "--property=Triggers", "--property=Listen"]);
  const state = property(shown.stdout, "ActiveState");
  const load = property(shown.stdout, "LoadState");
  // Masked or removed, it activates nothing: a drop-in of ours left behind is simply removed.
  if (!force && !service.sockets.includes(DATABASE_SOCKET_UNIT) && (load === "masked" || load === "not-found") && (state === "inactive" || state === "failed")) return null;
  if (!shown.ok || load !== "loaded" || property(shown.stdout, "Id") !== DATABASE_SOCKET_UNIT ||
    !["active", "inactive", "failed"].includes(state ?? "")) failAction(`could not inspect a settled ${DATABASE_SOCKET_UNIT}; MySQL has not been restarted`);
  if (state !== "active" && managed === null && !force) return null;
  if (property(shown.stdout, "Accept") !== "no" || property(shown.stdout, "Triggers") !== service.id) {
    failAction(`${DATABASE_SOCKET_UNIT} does not exclusively activate ${service.id} with Accept=no; it was left unchanged`);
  }
  const parsed = parseSocketBindings(shown.stdout);
  if (!parsed.ports.length) failAction(`${DATABASE_SOCKET_UNIT} has no TCP listener to restrict`);
  return { unit: DATABASE_SOCKET_UNIT, active: state === "active", service, bindings: parsed };
}

export function databaseStatus(options: DatabaseOptions = {}): DatabaseStatus {
  const ctx = contextOf(options);
  let socket: SocketState | null = null;
  let socketFile: string | null = null;
  let socketKnown = true;
  try {
    socketFile = readSocketFile(ctx.paths.socketFile, ctx.paths.rootUid);
    socket = socketState(ctx, serviceState(ctx), socketFile);
  } catch {
    // Do not claim a complete persistent setting when its socket file or unit cannot be checked.
    socketKnown = false;
  }
  const shown = listeners(ctx, socket?.active ? socket.bindings.ports : []);
  const file = optionFile(ctx);
  const fileInPlace = socketKnown && file !== null && current(file) === DATABASE_FILE && (!socket || socketFile === renderSocketFile(socket.bindings.loopback));
  const socketInfo = socket ? { socketUnit: socket.unit } : {};
  if ("error" in shown) {
    return {
      running: false, listenersUnknown: shown.error, exposed: [], firewall: { state: "unknown", openTo: [], reason: shown.error },
      remoteClients: [], defaultPassword: [], fileInPlace, ...socketInfo,
    };
  }
  const all = shown;
  const exposed = all.filter((listener) => !isLoopback(listener.host));
  const ports = [...new Set(all.map((listener) => listener.port))];
  const established = ctx.run("ss", ["-Htn", "state", "established"]);
  return {
    running: all.length > 0,
    exposed: exposed.map((listener) => listener.text),
    firewall: firewallFor(ctx, exposed),
    remoteClients: established.ok ? parseRemoteClients(established.stdout, ports) : [],
    defaultPassword: all.length ? defaultPasswords(ctx, all, exposed) : [],
    fileInPlace, ...socketInfo,
  };
}

/**
 * An option file cannot override a daemon command line. Refuse those overrides
 * before changing the file or restarting.
 * Only option names are reported; other arguments can contain credentials.
 */
function serverPrograms(ctx: Context, { pid }: ServiceState): string[] {
  if (pid === "0") return ctx.paths.servers;
  let args: string[];
  let program: string;
  try {
    args = readFileSync(join(ctx.paths.procRoot, pid, "cmdline"), "utf8").split("\0").slice(1);
    program = readlinkSync(join(ctx.paths.procRoot, pid, "exe")).replace(/ \(deleted\)$/, "");
  } catch {
    failAction(`could not inspect the running MySQL command; MySQL has not been restarted`);
  }
  for (const arg of args) {
    const name = arg.split("=", 1)[0]!.replaceAll("_", "-");
    if (/^--(?:(?:loose-)?(?:skip-)?(?:bind-address|mysqlx-bind-address)|defaults-(?:file|extra-file|group-suffix)|no-defaults)$/.test(name)) {
      failAction(`MySQL starts with ${name}; adjust that startup option before using MySQL on this server only`);
    }
  }
  if (!/\/(?:mysqld|mariadbd)$/.test(program)) {
    failAction(`could not identify the running MySQL server program; MySQL has not been restarted`);
  }
  return [program];
}

/**
 * Ask the daemon itself to parse its options. my_print_defaults with guessed
 * groups misses version-specific sections and does not apply skip-bind-address.
 * Help mode does not start another server or open its listening sockets.
 */
function checkBindAddresses(ctx: Context, programs: string[], file: string): void {
  for (const program of programs) {
    const shown = ctx.run(program, ["--verbose", "--help"]);
    if (!shown.ok) continue;
    const bind = /^bind-address\s+(\S+)\s*$/m.exec(shown.stdout)?.[1];
    if (!bind) continue;
    if (bind !== LOOPBACK) {
      failAction(`MySQL's effective bind-address is ${bind} after reading ${file}; another server option overrides it or the directory is not included`);
    }
    const xBind = /^mysqlx-bind-address\s+(\S+)\s*$/m.exec(shown.stdout)?.[1];
    if (xBind && xBind !== LOOPBACK) {
      failAction(`MySQL's effective mysqlx-bind-address is ${xBind} after reading ${file}; another server option overrides it`);
    }
    return;
  }
  failAction(`could not verify MySQL's effective bind-address with the server's --verbose --help; MySQL has not been restarted`);
}

/** Why the server is not yet serving as wanted, or null once it is. */
async function unhealthy(ctx: Context, loopbackOnly: boolean, socket?: SocketState | null): Promise<{ reason: string; final?: boolean } | null> {
  const state = ctx.run("systemctl", ["is-active", ctx.paths.service]).stdout.trim();
  const waitingForActivation = socket?.active && !socket.service.active && state === "inactive";
  if (state !== "active" && !waitingForActivation) return { reason: `${ctx.paths.service} is ${state || "not running"}` };
  if (socket?.active && ctx.run("systemctl", ["is-active", socket.unit]).stdout.trim() !== "active") {
    return { reason: `${socket.unit} is not active` };
  }
  const all = listeners(ctx, socket?.active ? socket.bindings.ports : []);
  if ("error" in all) return { reason: all.error };
  if (!all.length) return { reason: "it is not listening on TCP" };
  const port = classicPort(all);
  const local = all.some((listener) => listener.port === port && (isLoopback(listener.host) || isWildcard(listener.host)));
  if (local && !waitingForActivation && !(await ctx.probe(LOOPBACK, port))) return { reason: `it does not answer on ${LOOPBACK}:${port}` };
  const exposed = all.filter((listener) => !isLoopback(listener.host));
  // Once an active server answers, waiting cannot change its startup binding.
  if (loopbackOnly && exposed.length) return { reason: `it still listens on ${exposed.map((listener) => listener.text).join(", ")}`, final: true };
  if (socket?.active) {
    for (const stream of socket.bindings.streams.filter((value) => !value.startsWith("/") && !value.startsWith("@"))) {
      const expected = endpoint(stream)!;
      if (!all.some((actual) => actual.port === expected.port && (actual.host === expected.host || (isWildcard(actual.host) && isWildcard(expected.host))))) {
        return { reason: `it is not listening on ${stream}`, final: true };
      }
    }
  }
  return null;
}

async function waitHealthy(ctx: Context, loopbackOnly: boolean, socket?: SocketState | null): Promise<string | null> {
  const deadline = ctx.now() + ctx.healthTimeoutMs;
  let problem = await unhealthy(ctx, loopbackOnly, socket);
  while (problem && !problem.final && ctx.now() < deadline) {
    await ctx.sleep(1_000);
    problem = await unhealthy(ctx, loopbackOnly, socket);
  }
  return problem?.reason ?? null;
}

function put(path: string, content: string | null): void {
  if (content === null) rmSync(path, { force: true });
  else writeFileAtomic(path, content, { mode: 0o644, createParent: false });
}

function restart(ctx: Context): void {
  const result = ctx.run("systemctl", ["restart", ctx.paths.service]);
  if (!result.ok) failAction(`restarting ${ctx.paths.service} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode ?? "unknown"}`}`);
}

function socketCommand(ctx: Context, args: string[]): void {
  const result = ctx.run("systemctl", args);
  if (!result.ok) failAction(`systemctl ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode ?? "unknown"}`}`);
}

function reloadSocket(ctx: Context, socket: SocketState, expected?: string[]): SocketState {
  socketCommand(ctx, ["daemon-reload"]);
  const updated = socketState(ctx, socket.service, readSocketFile(ctx.paths.socketFile, ctx.paths.rootUid), true)!;
  if (expected && JSON.stringify(updated.bindings.streams) !== JSON.stringify(expected)) {
    failAction(`another ${socket.unit} setting overrides the managed listeners; MySQL has not been restarted`);
  }
  // daemon-reload changes the configuration, not the active descriptors or the original desired states.
  return { ...updated, active: socket.active };
}

function stopSocketAndService(ctx: Context, socket: SocketState): void {
  // One transaction queues both stop jobs, preventing socket reactivation while the service stops.
  socketCommand(ctx, ["stop", ctx.paths.service, socket.unit]);
}

function startPreviousUnits(ctx: Context, socket: SocketState): void {
  const units = [...(socket.active ? [socket.unit] : []), ...(socket.service.active ? [ctx.paths.service] : [])];
  // The socket's implicit Before= ordering ensures the new descriptors reach MariaDB.
  if (units.length) socketCommand(ctx, ["start", ...units]);
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
  const socketBefore = readSocketFile(ctx.paths.socketFile, ctx.paths.rootUid);
  if (!on && before === null && socketBefore === null) return;
  // Read ss first: a failed query must not lead to any configuration changes.
  const initial = listeners(ctx);
  if ("error" in initial) failAction(`could not tell where MySQL listens: ${initial.error}`);
  const service = serviceState(ctx);
  const socket = socketState(ctx, service, socketBefore);
  const all = socket?.active ? listeners(ctx, socket.bindings.ports) : initial;
  if ("error" in all) failAction(`could not tell where MySQL listens: ${all.error}`);
  const exposed = all.some((listener) => !isLoopback(listener.host));
  const socketAfter = on && socket ? renderSocketFile(socket.bindings.loopback) : null;
  if (on && before === DATABASE_FILE && socketBefore === socketAfter && !exposed) return;
  const programs = on ? serverPrograms(ctx, service) : [];
  let restarted = false;
  let reloaded = false;
  try {
    put(file, on ? DATABASE_FILE : null);
    if (socketBefore !== socketAfter) putSocketFile(ctx.paths.socketFile, socketAfter, ctx.paths.rootUid);
    if (on) {
      checkBindAddresses(ctx, programs, file);
    }
    let appliedSocket = socket;
    if (socket && (socketBefore !== socketAfter || exposed || !on)) {
      reloaded = true;
      appliedSocket = reloadSocket(ctx, socket, on ? socket.bindings.loopback : undefined);
    }
    if (on && !exposed) return;
    // A stopped server, and its activation socket if any, stay stopped; the files apply at its next start.
    if (!service.active && !socket?.active) return;
    restarted = true;
    if (socket) {
      stopSocketAndService(ctx, socket);
      startPreviousUnits(ctx, socket);
    } else restart(ctx);
    const problem = await waitHealthy(ctx, on, appliedSocket);
    if (problem) failAction(`MySQL did not come back ${on ? "on loopback only" : "on its own settings"}: ${problem}`);
  } catch (error) {
    let restored: string;
    try {
      put(file, before);
      if (socketBefore !== socketAfter) putSocketFile(ctx.paths.socketFile, socketBefore, ctx.paths.rootUid);
      let restoredSocket = socket;
      if (socket && reloaded) restoredSocket = reloadSocket(ctx, socket);
      if (!restarted) throw error;
      if (socket) {
        stopSocketAndService(ctx, socket);
        startPreviousUnits(ctx, socket);
      } else restart(ctx);
      const after = await waitHealthy(ctx, false, restoredSocket);
      restored = after ? `the previous settings were put back, but ${after}` : "the previous settings are back";
    } catch (restoreError) {
      if (restoreError === error) throw error;
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
  const before = file ? current(file) : null;
  const socketBefore = readSocketFile(ctx.paths.socketFile, ctx.paths.rootUid);
  if (on && (!file || (before !== null && !before.startsWith(DATABASE_MARKER)))) return null;
  const socket = on ? socketState(ctx, serviceState(ctx), socketBefore) : null;
  const socketAfter = on && socket ? renderSocketFile(socket.bindings.loopback) : null;
  const after = on ? DATABASE_FILE : (before?.startsWith(DATABASE_MARKER) ? null : before);
  if (after === before && socketBefore === socketAfter) return null;
  let reloaded = false;
  try {
    if (file && after !== before) put(file, after);
    if (socketBefore !== socketAfter) {
      putSocketFile(ctx.paths.socketFile, socketAfter, ctx.paths.rootUid);
      reloaded = true;
      socketCommand(ctx, ["daemon-reload"]);
      if (socket && on) {
        const checked = socketState(ctx, socket.service, socketAfter)!;
        if (JSON.stringify(checked.bindings.streams) !== JSON.stringify(socket.bindings.loopback)) {
          failAction(`another ${socket.unit} setting overrides the managed listeners`);
        }
      }
    }
  } catch (error) {
    if (file && before !== after) put(file, before);
    if (socketBefore !== socketAfter) putSocketFile(ctx.paths.socketFile, socketBefore, ctx.paths.rootUid);
    if (reloaded) socketCommand(ctx, ["daemon-reload"]);
    throw error;
  }
  if (socket || socketBefore !== null) {
    return `MySQL loopback files ${on ? "put back" : "removed"}; ${on ? "the restriction applies" : "MySQL uses its own settings"} after MySQL and ${DATABASE_SOCKET_UNIT} are next stopped and started together`;
  }
  return on ? "MySQL loopback file put back; it applies at MySQL's next restart"
    : "MySQL loopback file removed; MySQL uses its own settings after its next restart";
}
