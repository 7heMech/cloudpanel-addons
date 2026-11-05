/** The one socket-activation unit supported by the MySQL loopback setting. */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { isIP } from "node:net";
import { dirname } from "node:path";
import { failAction } from "../../cli/action-common";
import { writeFileAtomic } from "../../lib/atomic-write";

export const DATABASE_SOCKET_UNIT = "mariadb.socket";
export const DATABASE_SOCKET_FILE = "/etc/systemd/system/mariadb.socket.d/zz-clp-addons-loopback.conf";
const MARKER = "# Managed by clp-addons System Tweaks: MariaDB accepts connections from this server only.";

export interface SocketBindings { streams: string[]; loopback: string[]; ports: number[] }

/** Only literal Unix paths/names and TCP addresses can be copied into a unit. */
function binding(value: string): { unix: true } | { port: number; ipv6: boolean } {
  if (/^(?:\/|@)[A-Za-z0-9_./:@+-]+$/.test(value)) return { unix: true };
  const match = /^(?:\[([^\]]+)\]|([\d.]+|\*)):(\d+)$/.exec(value);
  const port = Number(match?.[3]);
  if (!match || port < 1 || port > 65535 || (!isIP(match[1] ?? match[2]!) && match[2] !== "*")) {
    failAction(`unsupported ${DATABASE_SOCKET_UNIT} listener; expected a literal Unix socket or TCP address`);
  }
  return { port, ipv6: Boolean(match[1]) };
}

function bindings(streams: string[]): SocketBindings {
  const loopback: string[] = [];
  const ports = new Set<number>();
  for (const stream of streams) {
    const address = binding(stream);
    if ("unix" in address) loopback.push(stream);
    else {
      ports.add(address.port);
      loopback.push(`127.0.0.1:${address.port}`);
      if (address.ipv6) loopback.push(`[::1]:${address.port}`);
    }
  }
  return { streams: [...new Set(streams)].sort(), loopback: [...new Set(loopback)].sort(), ports: [...ports].sort((a, b) => a - b) };
}

/** systemctl show emits one Listen=<address> (<kind>) line per descriptor. */
export function parseSocketBindings(output: string): SocketBindings {
  const streams = output.split("\n").filter((line) => line.startsWith("Listen=")).map((line) => {
    const match = /^Listen=(\S+) \(Stream\)$/.exec(line);
    if (!match) failAction(`${DATABASE_SOCKET_UNIT} has a listener other than a supported stream socket`);
    return match[1]!;
  });
  if (!streams.length) failAction(`${DATABASE_SOCKET_UNIT} has no readable listeners`);
  return bindings(streams);
}

export function renderSocketFile(streams: string[]): string {
  const body = `[Socket]\nListenStream=\n${[...new Set(streams)].sort().map((stream) => `ListenStream=${stream}\n`).join("")}`;
  return `${MARKER}\n# SHA256: ${createHash("sha256").update(body).digest("hex")}\n${body}`;
}

function trusted(path: string, rootUid: number, directory: boolean): boolean {
  let info;
  try { info = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (info.uid !== rootUid || (info.mode & 0o022) !== 0 || (directory ? !info.isDirectory() : !info.isFile())) {
    failAction(`${path} is not a trusted ${directory ? "directory" : "regular file"}; it was left unchanged`);
  }
  return true;
}

/** Foreign, edited, writable-by-others and symlinked drop-ins are never replaced. */
export function readSocketFile(path: string, rootUid: number): string | null {
  // File first: an operator's own drop-in directory matters only once ours is in it.
  if (!trusted(path, rootUid, false) || !trusted(dirname(path), rootUid, true)) return null;
  const content = readFileSync(path, "utf8");
  const lines = content.split("\n");
  const streams = lines.slice(4, -1).map((line) => line.startsWith("ListenStream=") ? line.slice(13) : "");
  if (!streams.length || lines[0] !== MARKER || content !== renderSocketFile(streams)) {
    failAction(`${path} is not an unchanged System Tweaks socket file; it was left unchanged`);
  }
  const parsed = bindings(streams);
  if (JSON.stringify(parsed.streams) !== JSON.stringify(parsed.loopback)) {
    failAction(`${path} is not an unchanged System Tweaks socket file; it was left unchanged`);
  }
  return content;
}

export function putSocketFile(path: string, content: string | null, rootUid: number): void {
  // Recheck immediately before replacement; the setting also holds its global lock.
  readSocketFile(path, rootUid);
  if (content === null) rmSync(path, { force: true });
  else {
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    trusted(dirname(path), rootUid, true);
    writeFileAtomic(path, content, { mode: 0o644 });
  }
}
