/**
 * Instatic containers reach the server's Postfix through a listener on the
 * gateway of their own Docker network. See "Email" in docs/decisions/instatic.md.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { writeFileAtomic } from "../../lib/atomic-write";
import { commandOutput, runCommand, type CommandResult } from "../../lib/command";
import { CLI_BIN, SYSTEMD_DIR } from "../../lib/paths";

export const MAIL_NETWORK = "clp-instatic";
export const MAIL_PORT = 2525;
/** The name a container's SMTP connector uses for the listener. */
export const MAIL_HOST = "smtp-relay";
const SOCKET_UNIT = "clp-addons-instatic-mail.socket";
const SERVICE_UNIT = "clp-addons-instatic-mail@.service";

type Run = (command: string, args: string[]) => CommandResult;
const systemRun: Run = (command, args) => runCommand(command, args, 30_000);

export interface MailBridgeOptions {
  run?: Run;
  systemdDir?: string;
}

/** The network's gateway address, or null while the network does not exist. */
export function mailGateway(run: Run = systemRun): string | null {
  const result = run("docker", ["network", "inspect", MAIL_NETWORK, "--format", "{{range .IPAM.Config}}{{.Gateway}} {{end}}"]);
  if (!result.ok) return null;
  return result.stdout.trim().split(/\s+/).find((address) => isIP(address) === 4) ?? null;
}

/** Creates the network on first use; its bridge interface has the network's name, which the firewall rule names. */
export function ensureMailNetwork(run: Run = systemRun): string {
  const existing = mailGateway(run);
  if (existing) return existing;
  const created = run("docker", [
    "network", "create", "--driver", "bridge", "--label", "clp-addon=instatic",
    "--opt", `com.docker.network.bridge.name=${MAIL_NETWORK}`,
    // Instatic containers have no business with each other, and an admin's connector could otherwise reach them.
    "--opt", "com.docker.network.bridge.enable_icc=false", MAIL_NETWORK,
  ]);
  const gateway = mailGateway(run);
  if (!gateway) throw new Error(`docker could not create the ${MAIL_NETWORK} network: ${commandOutput(created) || "no gateway"}`);
  return gateway;
}

export function mailUnits(gateway: string): { socket: string; service: string } {
  return {
    socket: `[Unit]
Description=CloudPanel Addons mail from Instatic containers
After=docker.service

[Socket]
ListenStream=${gateway}:${MAIL_PORT}
FreeBind=yes
Accept=yes

[Install]
WantedBy=sockets.target
`,
    service: `[Unit]
Description=CloudPanel Addons mail from an Instatic container

[Service]
ExecStart=${CLI_BIN} instatic-mail
StandardInput=socket
StandardOutput=socket
StandardError=journal
`,
  };
}

function ufwActive(run: Run): boolean {
  return /^Status: active/m.test(run("ufw", ["status"]).stdout);
}

function ufwRule(gateway: string): string[] {
  return ["in", "on", MAIL_NETWORK, "to", gateway, "port", String(MAIL_PORT), "proto", "tcp"];
}

/** ufw drops what containers send to the host unless a rule lets it in; CloudPanel's Firewall page rebuilds ufw without it. */
export function syncMailFirewall(run: Run = systemRun): string | null {
  const gateway = mailGateway(run);
  if (!gateway || !ufwActive(run)) return null;
  const result = run("ufw", ["allow", ...ufwRule(gateway), "comment", "clp-addons instatic mail"]);
  if (!result.ok) throw new Error(`ufw refused the Instatic mail rule: ${commandOutput(result)}`);
  return /^Rule(s)? added/m.test(result.stdout) ? `ufw lets containers reach ${gateway}:${MAIL_PORT} again` : null;
}

function writeUnit(path: string, body: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === body) return false;
  writeFileAtomic(path, body, { mode: 0o644, createParent: true });
  return true;
}

function listenedAddress(socketFile: string): string | null {
  if (!existsSync(socketFile)) return null;
  return /^ListenStream=([\d.]+):\d+$/m.exec(readFileSync(socketFile, "utf8"))?.[1] ?? null;
}

/** The network, the listener on its gateway and the firewall rule. Returns the gateway. */
export function ensureMailBridge(options: MailBridgeOptions = {}): string {
  const run = options.run ?? systemRun;
  const dir = options.systemdDir ?? SYSTEMD_DIR;
  const gateway = ensureMailNetwork(run);
  const bridge = run("docker", ["network", "inspect", MAIL_NETWORK, "--format", '{{index .Options "com.docker.network.bridge.name"}}']).stdout.trim();
  if (bridge !== MAIL_NETWORK) {
    throw new Error(`the ${MAIL_NETWORK} Docker network was not made by clp-addons (its bridge is ${bridge || "unnamed"}); remove it so it can be made again`);
  }
  const socketFile = join(dir, SOCKET_UNIT);
  const previous = listenedAddress(socketFile);
  if (previous && previous !== gateway && ufwActive(run)) run("ufw", ["delete", "allow", ...ufwRule(previous)]);
  const units = mailUnits(gateway);
  const changed = [writeUnit(socketFile, units.socket), writeUnit(join(dir, SERVICE_UNIT), units.service)].some(Boolean);
  if (changed) run("systemctl", ["daemon-reload"]);
  const enabled = run("systemctl", ["enable", "--now", SOCKET_UNIT]);
  if (!enabled.ok) throw new Error(`systemd could not start ${SOCKET_UNIT}: ${commandOutput(enabled)}`);
  // A socket already listening keeps its old address until it starts again.
  if (changed && previous) run("systemctl", ["restart", SOCKET_UNIT]);
  syncMailFirewall(run);
  return gateway;
}

/** Leaves the network, which running containers are attached to. */
export function withdrawMailBridge(options: MailBridgeOptions = {}): void {
  const run = options.run ?? systemRun;
  const dir = options.systemdDir ?? SYSTEMD_DIR;
  const socketFile = join(dir, SOCKET_UNIT);
  const previous = listenedAddress(socketFile);
  if (!previous) return;
  run("systemctl", ["disable", "--now", SOCKET_UNIT]);
  rmSync(socketFile, { force: true });
  rmSync(join(dir, SERVICE_UNIT), { force: true });
  run("systemctl", ["daemon-reload"]);
  if (ufwActive(run)) run("ufw", ["delete", "allow", ...ufwRule(previous)]);
}

const SEED_SCRIPT = `
import { Database } from "bun:sqlite";
const db = new Database(String(process.env.DATABASE_URL ?? "sqlite:/app/data/instatic.db").replace(/^sqlite:/, ""));
db.exec("PRAGMA busy_timeout = 10000");
const tables = db.query("select name from sqlite_master where type = 'table' and name in ('mail_connectors', 'mail_settings')").all();
if (tables.length < 2) { console.log("no-mail"); process.exit(0); }
if (db.query("select 1 from mail_connectors limit 1").get() || db.query("select 1 from mail_settings limit 1").get()) { console.log("configured"); process.exit(0); }
const id = crypto.randomUUID();
const now = new Date().toISOString();
db.transaction(() => {
  db.run("insert into mail_connectors (id, kind, label, config_json, created_at, updated_at) values (?, 'smtp', 'SMTP Relay', ?, ?, ?)",
    [id, JSON.stringify({ host: process.env.CLP_MAIL_HOST, port: Number(process.env.CLP_MAIL_PORT), username: "" }), now, now]);
  db.run("insert into mail_settings (id, default_connector_id, from_address, from_name, reply_to, updated_at) values ('default', ?, ?, '', '', ?)",
    [id, process.env.CLP_MAIL_FROM, now]);
})();
console.log("seeded");
`;

export type SeedResult = "seeded" | "configured" | "no-mail";

/**
 * Inside the running container, as its site user: makes the bridge Instatic's
 * default connector, sending as noreply@<domain>, unless its mail is already
 * set up. An Instatic without mail tables answers "no-mail".
 */
export function seedRelayConnector(container: string, domain: string, run: Run = systemRun): SeedResult {
  const result = run("docker", [
    "exec", "-e", `CLP_MAIL_HOST=${MAIL_HOST}`, "-e", `CLP_MAIL_PORT=${MAIL_PORT}`, "-e", `CLP_MAIL_FROM=noreply@${domain}`,
    container, "bun", "-e", SEED_SCRIPT,
  ]);
  const said = result.stdout.trim().split("\n").at(-1) ?? "";
  if (!result.ok || !["seeded", "configured", "no-mail"].includes(said)) {
    throw new Error(commandOutput(result) || "the container did not answer");
  }
  return said as SeedResult;
}
