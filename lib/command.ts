// Running a command without a shell.
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { ActionCommandFailure } from "./action";

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number | null;
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return value == null ? "" : String(value);
}

export function runCommand(command: string, args: string[], timeoutMs?: number): CommandResult {
  try {
    const result = Bun.spawnSync([command, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    return {
      ok: result.success,
      stdout: outputText(result.stdout),
      stderr: outputText(result.stderr),
      exitCode: result.exitCode,
    };
  } catch (error) {
    const e = error as { stdout?: unknown; stderr?: unknown };
    return { ok: false, stdout: outputText(e.stdout), stderr: outputText(e.stderr), exitCode: null };
  }
}

export function forwardCommandOutput(result: CommandResult): void {
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

export function commandFailure(command: string, result: CommandResult): ActionCommandFailure {
  return new ActionCommandFailure(command, result.stderr || result.stdout);
}

/** Run a command, capturing output. Never goes through a shell. */
export function run(cmd: string, args: string[], opts: ExecFileSyncOptions = {}): string {
  return execFileSync(cmd, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], ...opts }) as string;
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
