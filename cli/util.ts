import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, renameSync, chmodSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";

const color = process.stdout.isTTY === true;
const paint = (c: string, s: string) => (color ? `${c}${s}${RESET}` : s);

export const log = {
  step: (m: string) => console.log(`${paint(DIM, "›")} ${m}`),
  ok: (m: string) => console.log(`${paint(GREEN, "✓")} ${m}`),
  warn: (m: string) => console.warn(`${paint(YELLOW, "!")} ${m}`),
  err: (m: string) => console.error(`${paint(RED, "✗")} ${m}`),
  plain: (m = "") => console.log(m),
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

/** Run a command, returning success rather than throwing. */
export function tryRun(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: run(cmd, args).trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: (e.stderr || e.stdout || e.message || "").trim() };
  }
}

export function have(cmd: string): boolean {
  return tryRun("command", ["-v", cmd]).ok || tryRun("/usr/bin/which", [cmd]).ok;
}

/**
 * Write a file atomically. Callers that install privileged files rely on the
 * target never existing in a half-written state.
 */
export function writeAtomic(path: string, content: string | Buffer, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, content, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (err) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw err;
  }
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
