import { existsSync } from "node:fs";

export interface WpSite {
  domain: string; user: string; root: string; home: string; phpVersion: string;
}
export interface WpOptions {
  runWpCommand?: (command: WpCommand) => Promise<string>;
}

export interface WpCommand {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  /** Root's own limit, a little past the `timeout` the command runs under. */
  timeoutMs: number;
  stdin?: string;
  sensitive?: boolean;
}

const OUTPUT_LIMIT = 64 * 1024;

/**
 * Runs one site-user command with a deadline root enforces itself. The `timeout`
 * inside only reaches the processes that stay in its group; anything the site's
 * own code detaches can hold the pipes open, so on the deadline root kills the
 * child and stops reading rather than waiting for them to close.
 */
export async function commandOutput(command: WpCommand): Promise<string> {
  const child = Bun.spawn(command.argv, {
    cwd: command.cwd, env: command.env, stdin: command.stdin === undefined ? "ignore" : new TextEncoder().encode(command.stdin), stdout: "pipe", stderr: "pipe",
  });
  const readers = [child.stdout.getReader(), child.stderr.getReader()];
  let failure = "";
  const stop = (reason: string) => {
    if (failure) return;
    failure = reason;
    child.kill("SIGKILL");
    for (const reader of readers) reader.cancel().catch(() => {});
  };
  const timer = setTimeout(() => stop("WP-CLI timed out"), command.timeoutMs);
  const read = async (reader: (typeof readers)[number]): Promise<string> => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > OUTPUT_LIMIT) { stop("WP-CLI returned too much output"); break; }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  let stdout: string, stderr: string, code: number;
  try {
    [stdout, stderr, code] = await Promise.all([read(readers[0]!), read(readers[1]!), child.exited]);
  } finally {
    clearTimeout(timer);
  }
  if (failure) throw new Error(failure);
  if (code !== 0) {
    // The site writes this text, PHP errors can disclose its configuration, and
    // it is saved, shown and logged: keep a short summary with no control characters.
    const summary = command.sensitive ? "the WordPress operation failed; check the site in WordPress" : (stderr || stdout).replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").trim().slice(0, 500);
    throw new Error(code === 124 || code === 137 ? "WP-CLI timed out" : `WP-CLI failed: ${summary || `exit ${code}`}`);
  }
  return stdout.trim();
}

export async function runWp(run: { runuser: string }, site: WpSite, args: string[], options: WpOptions, deadline: number, input?: unknown): Promise<string> {
  if (!/^\d+\.\d+$/.test(site.phpVersion)) throw new Error("the site's PHP version is unavailable");
  const php = `/usr/bin/php${site.phpVersion}`;
  const executable = existsSync("/usr/bin/wp") ? "/usr/bin/wp" : "/usr/local/bin/wp";
  if (!options.runWpCommand && (!existsSync(php) || !existsSync(executable))) {
    throw new Error(`WP-CLI and PHP ${site.phpVersion} must be installed on this server`);
  }
  const seconds = Math.min(60, Math.floor((deadline - Date.now()) / 1000));
  if (seconds < 1) throw new Error("the WordPress check reached its time limit; check again to continue");
  return (options.runWpCommand ?? commandOutput)({
    argv: [run.runuser, "-u", site.user, "--", "/usr/bin/timeout", "--signal=KILL", String(seconds),
      php, executable, `--path=${site.root}`, `--url=https://${site.domain}`, "--skip-plugins", "--skip-themes",
      "--skip-packages", "--no-color", ...args],
    cwd: "/",
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: site.home, WP_CLI_CONFIG_PATH: "/dev/null" },
    timeoutMs: (seconds + 5) * 1000,
    ...(input === undefined ? {} : { stdin: JSON.stringify(input), sensitive: true }),
  });
}

export function wpReply<T>(output: string, marker: string): T {
  const line = output.split("\n").findLast((text) => text.startsWith(marker));
  try { return JSON.parse(line?.slice(marker.length) ?? "") as T; }
  catch { throw new Error("WP-CLI returned no status; check that the site loads in WordPress"); }
}
