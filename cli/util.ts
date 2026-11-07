import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { writeFileAtomic } from "../lib/atomic-write";

/** Colored only when that stream is a terminal that wants color. */
export function paint(code: string, text: string, stream: NodeJS.WriteStream = process.stdout): string {
  return stream.isTTY && stream.hasColors(16) ? `\x1b[${code}m${text}\x1b[0m` : text;
}

// A progress line a terminal redraws in place, until the next line ends it.
let redrawing = false;
const endRedraw = () => {
  if (redrawing) process.stdout.write("\n");
  redrawing = false;
};

export const log = {
  step: (m: string) => { endRedraw(); console.log(`${paint("2", "›")} ${m}`); },
  ok: (m: string) => { endRedraw(); console.log(`${paint("32", "✓")} ${m}`); },
  warn: (m: string) => { endRedraw(); console.warn(`${paint("33", "!", process.stderr)} ${m}`); },
  err: (m: string) => { endRedraw(); console.error(`${paint("31", "✗", process.stderr)} ${m}`); },
  plain: (m = "") => { endRedraw(); console.log(m); },
  /** Redrawn in a terminal; elsewhere only the last one is written. */
  progress: (m: string, done: boolean) => {
    if (!process.stdout.isTTY) {
      if (done) log.step(m);
      return;
    }
    process.stdout.write(`\r\x1b[K${paint("2", "›")} ${m}`);
    redrawing = !done;
    if (done) process.stdout.write("\n");
  },
};

export class Fatal extends Error {}

export function fatal(message: string): never {
  throw new Fatal(message);
}

export function requireRoot(verb: string): void {
  if (process.getuid?.() !== 0) {
    fatal(`'${verb}' modifies system state and must run as root`);
  }
}

/** Run a command, capturing output. Never goes through a shell. */
export function run(cmd: string, args: string[], opts: ExecFileSyncOptions = {}): string {
  return execFileSync(cmd, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], ...opts }) as string;
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf-8");
  return value == null ? "" : String(value);
}

function commandFailureMessage(cmd: string, args: string[]): string {
  return `Command failed: ${cmd}${args.length ? ` ${args.join(" ")}` : ""}`;
}

/** Run a command, returning success rather than throwing. */
export function tryRun(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const result = Bun.spawnSync([cmd, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    if (result.success) return { ok: true, out: outputText(result.stdout).trim() };
    const stderr = outputText(result.stderr);
    const stdout = outputText(result.stdout);
    return { ok: false, out: (stderr || stdout || commandFailureMessage(cmd, args)).trim() };
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown; message?: unknown };
    const stderr = outputText(e.stderr);
    const stdout = outputText(e.stdout);
    return { ok: false, out: (stderr || stdout || outputText(e.message) || commandFailureMessage(cmd, args)).trim() };
  }
}

export function have(cmd: string): boolean {
  return Bun.which(cmd, { PATH: process.env.PATH }) !== null;
}

/**
 * Write a file atomically. Callers that install privileged files rely on the
 * target never existing in a half-written state.
 *
 * Root-owned: this is the generic case, for files the installing process should
 * own. Anything that has to preserve another account's ownership passes it
 * explicitly to `writeFileAtomic`.
 */
export function writeAtomic(path: string, content: string | Buffer, mode: number): void {
  writeFileAtomic(path, content, { mode, createParent: true });
}

export function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq === -1) flags[arg.slice(2)] = true;
      else flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}
