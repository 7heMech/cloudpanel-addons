/**
 * `clp-addons terminal-pty`: the site user's half of a terminal.
 *
 * Started by `runuser` as the site's user, with the gateway's pipes as its
 * stdin and stdout. It owns the pseudo-terminal, so it is the only process
 * that decodes what the browser sent; nothing above it does. Everything it
 * writes is treated as hostile by the manager, because a site can replace
 * what runs here through its own login files.
 *
 * Both directions are NDJSON:
 *   out  {"ready":{"user","dir"}}  {"o":"<base64>"}  {"exit":{"code","signal"}}
 *   in   {"i":"<text>"}  {"r":[cols,rows]}
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { constants, userInfo } from "node:os";
import { MAX_TERMINAL_SIZE } from "./action";

export const MAX_INPUT_LINE_BYTES = 64 * 1024;
const COALESCE_MS = 8;
const COALESCE_BYTES = 32 * 1024;
/** How long output still draining from the terminal may follow the shell's exit. */
const DRAIN_AFTER_EXIT_MS = 500;

const signalNumbers = constants.signals as Record<string, number>;

export type PtyMessage = { input: string } | { resize: [number, number] };

function clamp(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(MAX_TERMINAL_SIZE, Math.max(1, Math.trunc(value)));
}

/** One line from the manager, or null when it is not a message this accepts. */
export function parsePtyMessage(line: string): PtyMessage | null {
  if (Buffer.byteLength(line, "utf8") > MAX_INPUT_LINE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1) return null;
  const message = value as { i?: unknown; r?: unknown };
  if (typeof message.i === "string") return { input: message.i };
  if (Array.isArray(message.r) && message.r.length === 2) {
    const cols = clamp(message.r[0]);
    const rows = clamp(message.r[1]);
    if (cols !== null && rows !== null) return { resize: [cols, rows] };
  }
  return null;
}

export function parsePtySize(value: string | undefined): [number, number] {
  const match = value?.match(/^(\d{1,4})x(\d{1,4})$/);
  if (!match) return [80, 24];
  return [clamp(Number(match[1])) ?? 80, clamp(Number(match[2])) ?? 24];
}

/** The box's default locale, which `runuser --login` does not set. */
function systemLang(path = "/etc/default/locale"): string | null {
  try {
    const match = readFileSync(path, "utf8").match(/^\s*LANG=["']?([A-Za-z0-9_.@-]+)["']?\s*$/m);
    return match ? match[1]! : null;
  } catch {
    return null;
  }
}

/** The shell's environment: the login one, without what this addon passed down. */
export function shellEnvironment(env: Record<string, string | undefined>, lang = systemLang()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !name.startsWith("CLP_")) out[name] = value;
  }
  out.TERM = "xterm-256color";
  if (!out.LANG && lang) out.LANG = lang;
  return out;
}

function directory(candidate: string | undefined, home: string): string {
  try {
    if (candidate && candidate.startsWith("/") && statSync(candidate).isDirectory()) return candidate;
  } catch {}
  return home;
}

export async function runTerminalPty(argv: string[]): Promise<number> {
  if (argv.length > 0) {
    process.stderr.write("terminal-pty takes no arguments\n");
    return 2;
  }
  if (process.getuid?.() === 0) {
    process.stderr.write("terminal-pty does not run as root\n");
    return 2;
  }
  const account = userInfo();
  const home = process.env.HOME && existsSync(process.env.HOME) ? process.env.HOME : account.homedir;
  const shell = process.env.SHELL?.startsWith("/") ? process.env.SHELL : "/bin/bash";
  const dir = directory(process.env.CLP_SITE_DIR, home);
  const [cols, rows] = parsePtySize(process.env.CLP_PTY_SIZE);

  const out = Bun.stdout.writer();
  const send = (message: unknown) => {
    out.write(`${JSON.stringify(message)}\n`);
    void out.flush();
  };

  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flushOutput = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (pendingBytes === 0) return;
    send({ o: Buffer.concat(pending, pendingBytes).toString("base64") });
    pending = [];
    pendingBytes = 0;
  };

  let ptyClosed: () => void = () => {};
  const ptyDone = new Promise<void>((resolve) => { ptyClosed = resolve; });
  const proc = Bun.spawn([shell, "-i"], {
    cwd: dir,
    env: shellEnvironment(process.env),
    terminal: {
      cols,
      rows,
      data(_terminal, data) {
        pending.push(data);
        pendingBytes += data.byteLength;
        if (pendingBytes >= COALESCE_BYTES) flushOutput();
        else if (!timer) timer = setTimeout(flushOutput, COALESCE_MS);
      },
      exit() {
        ptyClosed();
      },
    },
  });
  const terminal = proc.terminal!;
  send({ ready: { user: account.username, dir } });

  // Closing the master is a hangup: the shell gets SIGHUP, as when an SSH
  // connection drops.
  const hangUp = () => {
    try { if (!terminal.closed) terminal.close(); } catch {}
  };
  process.on("SIGTERM", hangUp);
  process.on("SIGHUP", hangUp);

  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of Bun.stdin.stream()) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
          const message = parsePtyMessage(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (!message) return hangUp();
          if ("input" in message) terminal.write(message.input);
          else terminal.resize(message.resize[0], message.resize[1]);
        }
        if (Buffer.byteLength(buffer, "utf8") > MAX_INPUT_LINE_BYTES) return hangUp();
      }
    } catch {}
    hangUp();
  })();

  const code = await proc.exited;
  await Promise.race([ptyDone, Bun.sleep(DRAIN_AFTER_EXIT_MS)]);
  flushOutput();
  hangUp();
  send({ exit: { code: proc.signalCode ? null : code, signal: proc.signalCode ?? null } });
  await out.end();
  // The shell's status, so the worker's audit line reports how the shell ended.
  return proc.signalCode ? 128 + (signalNumbers[proc.signalCode] ?? 0) : code;
}
