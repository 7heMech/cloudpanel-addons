import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../cli/action-common";
import {
  DATABASE_FILE, databaseStatus, parseListeners, parseRemoteClients, reconcileDatabaseFile, setDatabaseLoopback,
  type DatabaseOptions,
} from "../addons/system-tweaks/database";
import { inputVerdict, otherInputHooks, parseFilterTable } from "../addons/system-tweaks/input-rules";
import { dashboardView } from "../addons/system-tweaks/app/views";
import { updatesStatus } from "../addons/system-tweaks/updates";
import { executeSystemTweaksAction, type SystemTweaksState } from "../addons/system-tweaks/action";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const WIDE = [
  'LISTEN 0      512                *:3306             *:*    users:(("mysqld",pid=1155,fd=47))',
  'LISTEN 0      70                 *:33060            *:*    users:(("mysqld",pid=1155,fd=20))',
  'LISTEN 0      511          0.0.0.0:80          0.0.0.0:*    users:(("nginx",pid=900,fd=6))',
].join("\n");
const LOCAL = [
  'LISTEN 0      512        127.0.0.1:3306       0.0.0.0:*    users:(("mysqld",pid=2000,fd=47))',
  'LISTEN 0      70         127.0.0.1:33060      0.0.0.0:*    users:(("mysqld",pid=2000,fd=20))',
].join("\n");
/** Staging's loaded rules: ufw on, with CloudPanel's ports and Docker's chains. */
const UFW4 = readFileSync(join(import.meta.dir, "fixtures", "ufw-iptables-save.txt"), "utf8");
const UFW6 = readFileSync(join(import.meta.dir, "fixtures", "ufw-ip6tables-save.txt"), "utf8");
const FLUSHED = "*filter\n:INPUT ACCEPT [0:0]\n:FORWARD ACCEPT [0:0]\n:OUTPUT ACCEPT [0:0]\nCOMMIT\n";
/** Adds rules to a chain of a saved table, after its last rule or at its start. */
function withRules(save: string, chain: string, rules: string[], first = false): string {
  const lines = save.split("\n");
  const own = lines.map((line, index) => (line.startsWith(`-A ${chain} `) ? index : -1)).filter((index) => index >= 0);
  const at = first ? (own[0] ?? lines.indexOf("COMMIT")) : (own.at(-1) ?? lines.indexOf("COMMIT") - 1) + 1;
  lines.splice(at, 0, ...rules.map((rule) => `-A ${chain} ${rule}`));
  return lines.join("\n");
}
const ok = (stdout = ""): CommandResult => ({ ok: true, stdout, stderr: "" });
const denied: CommandResult = { ok: false, stdout: "", stderr: "ERROR 1045 (28000): Access denied for user 'root'@'localhost' (using password: YES)\n", exitCode: 1 };

interface Server {
  dir: string;
  conf: string;
  file: string;
  calls: string[][];
  /** What `ss -Hltnp` shows; restarts read the option file to decide. */
  listening: string;
  /** Passwords root accepts, by host tried. */
  accepts: Record<string, string[]>;
  restartFails?: boolean;
  /** Another file's bind-address that my_print_defaults reports after ours. */
  laterBind?: string;
  /** What iptables-save, ip6tables-save and nft list chains print, or null to fail. */
  rules: { v4: string | null; v6: string | null; nft: string | null };
  options: DatabaseOptions;
}

function server(listening = WIDE): Server {
  const dir = mkdtempSync(join(tmpdir(), "clp-db-"));
  dirs.push(dir);
  const conf = join(dir, "mysql.conf.d");
  mkdirSync(conf);
  writeFileSync(join(dir, "mysql"), "");
  const s: Server = {
    dir, conf, file: join(conf, "zz-clp-addons-loopback.cnf"), calls: [], listening, accepts: {}, rules: { v4: UFW4, v6: UFW6, nft: null },
    options: {},
  };
  const run = (command: string, args: string[]): CommandResult => {
    s.calls.push([command, ...args]);
    if (command === "ss" && args[0] === "-Hltnp") return ok(s.listening);
    if (command === "ss") return ok("0      0      46.225.93.37:3306   203.0.113.24:51234\n0      0      127.0.0.1:3306   127.0.0.1:40000\n");
    if (command === "ip") return ok("2: eth0    inet 46.225.93.37/32 brd 46.225.93.37 scope global eth0\n3: docker0    inet 172.17.0.1/16 scope global docker0\n");
    if (command === "iptables-save" || command === "ip6tables-save" || command === "nft") {
      const out = s.rules[command === "iptables-save" ? "v4" : command === "ip6tables-save" ? "v6" : "nft"];
      return out === null ? { ok: false, stdout: "", stderr: `${command}: command not found`, exitCode: 127 } : ok(out);
    }
    if (command === "my_print_defaults") {
      const binds = existsSync(s.file) ? ["--bind-address=127.0.0.1"] : [];
      if (s.laterBind) binds.push(`--bind-address=${s.laterBind}`);
      return ok(["--datadir=/home/mysql/", ...binds].join("\n"));
    }
    if (command === "systemctl" && args[0] === "restart") {
      if (s.restartFails) return { ok: false, stdout: "", stderr: "Job failed", exitCode: 1 };
      s.listening = existsSync(s.file) ? LOCAL : WIDE;
      return ok();
    }
    if (command === "systemctl" && args[0] === "is-active") return ok("active\n");
    if (command.endsWith("mysql") && args[0] === "--version") return ok("mysql  Ver 8.0.36-28 for Linux on x86_64 (Percona Server (GPL))");
    if (command.endsWith("mysql")) {
      const host = args.find((arg) => arg.startsWith("--host="))!.slice(7);
      const password = args.find((arg) => arg.startsWith("--password="))?.slice(11) ?? "";
      return (s.accepts[host] ?? []).includes(password) ? ok("1\n") : denied;
    }
    return { ok: false, stdout: "", stderr: `unexpected ${command}`, exitCode: 1 };
  };
  s.options = {
    run,
    probe: async () => true,
    sleep: async () => {},
    healthTimeoutMs: 0,
    paths: {
      confDirs: [join(dir, "mariadb.conf.d"), conf], checkFile: join(dir, "check.json"), clients: [join(dir, "mysql")],
      rootUid: process.getuid!(),
    },
  };
  return s;
}

test("the server's listeners and the clients connected from elsewhere come from ss", () => {
  expect(parseListeners(WIDE).map((listener) => listener.text)).toEqual(["*:3306", "*:33060"]);
  expect(parseListeners('LISTEN 0 80 [::ffff:127.0.0.1]:3306 [::]:* users:(("mariadbd",pid=1,fd=2))')[0]!.host).toBe("::ffff:127.0.0.1");
  const established = "0 0 46.225.93.37:3306 203.0.113.24:5000\n0 0 [::1]:3306 [::1]:5001\n0 0 46.225.93.37:22 198.51.100.1:5002\n";
  expect(parseRemoteClients(established, [3306])).toEqual(["203.0.113.24"]);
});

test("staging's loaded ufw rules drop MySQL's ports from outside and accept the panel's", () => {
  const v4 = parseFilterTable(UFW4)!;
  const v6 = parseFilterTable(UFW6)!;
  expect(inputVerdict(v4, 3306)).toEqual({ verdict: "drop", openTo: [] });
  expect(inputVerdict(v4, 33060)).toEqual({ verdict: "drop", openTo: [] });
  expect(inputVerdict(v6, 3306)).toEqual({ verdict: "drop", openTo: [] });
  expect(inputVerdict(v4, 8443)).toEqual({ verdict: "accept" });
  expect(inputVerdict(v6, 22)).toEqual({ verdict: "accept" });
});

test("rules for the port, for some sources, and ufw's limit are read as the kernel would", () => {
  const open = (rules: string[], first = false) => inputVerdict(parseFilterTable(withRules(UFW4, first ? "INPUT" : "ufw-user-input", rules, first))!, 3306);
  expect(open(["-p tcp -m tcp --dport 3306 -j ACCEPT"])).toEqual({ verdict: "accept" });
  expect(open(["-p tcp -m multiport --dports 3000:4000 -j ACCEPT"])).toEqual({ verdict: "accept" });
  expect(open(["-s 10.0.0.5/32 -j ACCEPT", "-s 198.51.100.0/24 -p tcp -m multiport --dports 80,3306 -j ACCEPT", "-i eth1 -p tcp -m tcp --dport 3306 -j ACCEPT"]))
    .toEqual({ verdict: "drop", openTo: ["3306 from 10.0.0.5", "3306 from 198.51.100.0/24", "3306 on eth1"] });
  // `ufw limit 3306/tcp`: rate-limited, but open.
  expect(open([
    "-p tcp -m tcp --dport 3306 -m conntrack --ctstate NEW -m recent --set --name DEFAULT --mask 255.255.255.255 --rsource",
    "-p tcp -m tcp --dport 3306 -m conntrack --ctstate NEW -m recent --update --seconds 30 --hitcount 6 --name DEFAULT --mask 255.255.255.255 --rsource -j ufw-user-limit",
    "-p tcp -m tcp --dport 3306 -j ufw-user-limit-accept",
  ])).toEqual({ verdict: "accept" });
  // Rules for other ports, protocols and loopback leave it closed.
  expect(open(["-p udp -m udp --dport 3306 -j ACCEPT", "-p tcp -m tcp --dport 3307 -j ACCEPT", "-s 127.0.0.1/32 -j ACCEPT"]))
    .toEqual({ verdict: "drop", openTo: [] });
  // Inserted ahead of ufw.
  expect(open(['-p tcp -m tcp --dport 3306 -m comment --comment "db for the office" -j ACCEPT'], true)).toEqual({ verdict: "accept" });
  // A rule it cannot read: harmless when it drops, unknown when it could accept.
  expect(open(["-m set --match-set blocklist src -j DROP"], true)).toEqual({ verdict: "drop", openTo: [] });
  expect(open(["-p tcp -j NFQUEUE --queue-num 0"], true)).toEqual({ verdict: "unknown", reason: 'the loaded rule "INPUT -p tcp -j NFQUEUE --queue-num 0" goes to NFQUEUE' });
  expect(open(["-m geoip --src-cc NL -j ACCEPT"]).verdict).toBe("unknown");
});

test("rules flushed or never loaded let everything in", () => {
  expect(inputVerdict(parseFilterTable(FLUSHED)!, 3306)).toEqual({ verdict: "accept" });
  expect(parseFilterTable("")).toBeNull();
});

test("only input hooks outside iptables-nft's tables are reported", () => {
  const chains = [
    "table ip filter {", "\tchain INPUT {", "\t\ttype filter hook input priority filter; policy drop;", "\t}", "}",
    "table inet clp_addons_php_pools {", "\tchain output {", "\t\ttype filter hook output priority filter; policy accept;", "\t}", "}",
    "table inet firewalld {", "\tchain filter_INPUT {", "\t\ttype filter hook input priority filter + 10; policy accept;", "\t}", "}",
  ].join("\n");
  expect(otherInputHooks(chains)).toEqual(["inet firewalld filter_INPUT"]);
});

test("the status reports a wide listener behind the loaded rules, a remote client and root's default password", () => {
  const s = server();
  s.accepts = { "127.0.0.1": ["root"] };
  const status = databaseStatus(s.options);
  expect(status).toEqual({
    running: true, exposed: ["*:3306", "*:33060"], firewall: { state: "on", openTo: [] },
    remoteClients: ["203.0.113.24"], defaultPassword: [{ from: "loopback", password: "root" }], fileInPlace: false,
  });
  // Root is tried over loopback and from the box's own public address, never the Docker bridge, and nothing stored is read.
  const tried = s.calls.filter((call) => call[0]!.endsWith("mysql") && call[1] !== "--version");
  expect(tried.map((call) => call.find((arg) => arg.startsWith("--host=")))).toEqual([
    "--host=127.0.0.1", "--host=127.0.0.1", "--host=46.225.93.37", "--host=46.225.93.37",
  ]);
  expect(tried.every((call) => call[1] === "--no-defaults" && call.includes("--user=root") && call.includes("--get-server-public-key"))).toBe(true);
  expect(readFileSync(s.options.paths!.checkFile!, "utf8")).not.toContain("password=");

  // The outcome stands for a while, so page loads do not keep logging in.
  s.calls.length = 0;
  databaseStatus(s.options);
  expect(s.calls.some((call) => call[0]!.endsWith("mysql"))).toBe(false);
});

test("the firewall state comes from the loaded rules, not ufw's files", () => {
  const s = server();
  s.rules.v4 = FLUSHED;
  expect(databaseStatus(s.options).firewall).toEqual({ state: "off", openTo: [] });
  // Another nftables input hook could still drop what iptables lets in.
  s.rules.nft = "table inet firewalld {\n\tchain filter_INPUT {\n\t\ttype filter hook input priority filter + 10; policy accept;\n\t}\n}\n";
  expect(databaseStatus(s.options).firewall).toEqual({
    state: "unknown", openTo: [], reason: "iptables lets it in, but nftables also filters incoming traffic in inet firewalld filter_INPUT",
  });
  s.rules.v4 = null;
  expect(databaseStatus(s.options).firewall).toEqual({ state: "unknown", openTo: [], reason: "iptables-save failed: iptables-save: command not found" });
  // Listening on IPv4 only, IPv6's rules are not asked.
  s.rules = { v4: UFW4, v6: null, nft: null };
  s.listening = WIDE.replaceAll("*:", "0.0.0.0:");
  expect(databaseStatus(s.options).firewall).toEqual({ state: "on", openTo: [] });
  // Nothing beyond loopback: no firewall to ask.
  s.listening = LOCAL;
  s.calls.length = 0;
  expect(databaseStatus(s.options).firewall).toEqual({ state: "on", openTo: [] });
  expect(s.calls.some((call) => call[0]!.includes("tables-save"))).toBe(false);
});

test("an unexpected login error is reported rather than taken as no default", () => {
  const s = server();
  const base = s.options.run!;
  s.options.run = (command, args) => command.endsWith("mysql") && args[0] !== "--version"
    ? { ok: false, stdout: "", stderr: "ERROR 2003 (HY000): Can't connect to MySQL server on '127.0.0.1:3306' (111)\n", exitCode: 1 }
    : base(command, args);
  expect(databaseStatus(s.options).defaultPassword).toEqual({ error: "logging in to 127.0.0.1 failed: ERROR 2003 (HY000): Can't connect to MySQL server on '127.0.0.1:3306' (111)" });
});

test("switching on writes the file, restarts and needs loopback only; off removes it and restarts", async () => {
  const s = server();
  await setDatabaseLoopback(true, s.options);
  expect(readFileSync(s.file, "utf8")).toBe(DATABASE_FILE);
  expect(s.listening).toBe(LOCAL);
  expect(s.calls.filter((call) => call[1] === "restart")).toHaveLength(1);

  // Already applied: nothing to restart.
  await setDatabaseLoopback(true, s.options);
  expect(s.calls.filter((call) => call[1] === "restart")).toHaveLength(1);

  await setDatabaseLoopback(false, s.options);
  expect(existsSync(s.file)).toBe(false);
  expect(s.listening).toBe(WIDE);
  expect(s.calls.filter((call) => call[1] === "restart")).toHaveLength(2);
});

test("a settings file it cannot trust stops the switch before MySQL restarts", async () => {
  const s = server();
  const paths = { settingsFile: join(s.dir, "settings.json"), lockFile: join(s.dir, "lock"), rootUid: process.getuid!() };
  const act = (enabled: boolean) => executeSystemTweaksAction(["set-database-loopback"], {
    processUid: 0, paths, database: s.options, input: JSON.stringify({ enabled }),
  });

  writeFileSync(paths.settingsFile, "{}\n");
  chmodSync(paths.settingsFile, 0o666);
  await expect(act(true)).rejects.toThrow("not a trusted regular file");
  expect(s.calls.some((call) => call[1] === "restart")).toBe(false);
  expect(existsSync(s.file)).toBe(false);
  expect(s.listening).toBe(WIDE);
});

test("a server already on loopback gets the file without a restart", async () => {
  const s = server(LOCAL);
  await setDatabaseLoopback(true, s.options);
  expect(existsSync(s.file)).toBe(true);
  expect(s.calls.some((call) => call[1] === "restart")).toBe(false);
});

test("a later bind-address elsewhere is refused before any restart", async () => {
  const s = server();
  s.laterBind = "0.0.0.0";
  await expect(setDatabaseLoopback(true, s.options)).rejects.toThrow("sets bind-address after");
  expect(existsSync(s.file)).toBe(false);
  expect(s.calls.some((call) => call[1] === "restart")).toBe(false);
});

test("a server that does not come back gets its previous settings and another restart", async () => {
  const s = server();
  s.options.probe = async () => false;
  await expect(setDatabaseLoopback(true, s.options)).rejects.toThrow(
    "MySQL did not come back on loopback only: it does not answer on 127.0.0.1:3306; the previous settings were put back, but it does not answer");
  expect(existsSync(s.file)).toBe(false);
  expect(s.calls.filter((call) => call[1] === "restart")).toHaveLength(2);
  expect(s.listening).toBe(WIDE);
});

test("a file of the same name that is not the addon's is left alone", async () => {
  const s = server();
  writeFileSync(s.file, "[mysqld]\nmax_connections = 10\n");
  await expect(setDatabaseLoopback(true, s.options)).rejects.toThrow("is not this addon's");
  expect(reconcileDatabaseFile(true, s.options)).toBeNull();
  expect(readFileSync(s.file, "utf8")).toBe("[mysqld]\nmax_connections = 10\n");
});

test("repair puts the file back to the saved choice without restarting", () => {
  const s = server();
  expect(reconcileDatabaseFile(true, s.options)).toContain("next restart");
  expect(readFileSync(s.file, "utf8")).toBe(DATABASE_FILE);
  expect(reconcileDatabaseFile(true, s.options)).toBeNull();
  expect(reconcileDatabaseFile(false, s.options)).toContain("removed");
  expect(existsSync(s.file)).toBe(false);
  expect(s.calls.some((call) => call[1] === "restart")).toBe(false);
});

test("the page says where MySQL listens, what reaches it, and how to change a default root password", () => {
  const database = {
    running: true, exposed: ["*:3306"], loopback: false, fileInPlace: false, firewall: { state: "off" as const, openTo: [] },
    remoteClients: ["203.0.113.24"], defaultPassword: [{ from: "other hosts" as const, password: "root" as const }],
  };
  const state = {
    updates: updatesStatus({ run: () => ({ ok: false, stdout: "", stderr: "" }), paths: { aptConfDir: "/nonexistent", aptConf: "/nonexistent" } }),
    settings: { enabled: false, nginx: true, database: false, panel: false, reboot: false, rebootTime: "now" },
    uploadProgress: { guard: true, fpms: [] }, realIp: { blockForged: true, trustsAnyAddress: false, problem: "" },
    phpMyAdmin: { enabled: true, active: true, problem: "" },
    vhostGuard: { enabled: true, active: true, stored: [], homeLogs: [], ownLogrotate: [] }, phpPools: { enabled: true, active: true, problem: "" },
    fileManagerGuard: { enabled: true, active: true }, panelCert: { kind: "generated" as const, replace: true },
    panelPhp: { error: "" }, firewall: { error: "" }, loginJails: { error: "" }, database,
  } satisfies SystemTweaksState;
  const open = dashboardView(state);
  expect(open).toContain("The firewall rules loaded now let anyone reach it");
  expect(dashboardView({ ...state, database: { ...database, firewall: { state: "unknown", openTo: [], reason: "the loaded rule \"INPUT -j NFQUEUE\" goes to NFQUEUE" } } }))
    .toContain("Whether the loaded firewall rules block it is unclear: the loaded rule &quot;INPUT -j NFQUEUE&quot; goes to NFQUEUE.");
  expect(open).toContain("Connected now from 203.0.113.24.");
  expect(open).toContain("logs in with the password root from other hosts");
  expect(open).toContain('href="/admin/database-servers"');
  expect(open).toContain('onchange="setDatabaseLoopback(this)"');

  const pending = dashboardView({ ...state, database: { ...database, loopback: true, fileInPlace: true, defaultPassword: [] } });
  expect(pending).toContain("at MySQL's next restart");
  expect(pending).toContain("Root does not log in with a default password.");
  const local = dashboardView({ ...state, database: { ...database, exposed: [], loopback: true, fileInPlace: true, remoteClients: [] } });
  expect(local).toContain("accepts connections on 127.0.0.1 only");
});
