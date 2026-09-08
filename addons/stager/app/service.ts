// Every privileged action goes through the wrapper. The app has no clpctl
// access, no database access and no write access to any site's files: it can
// only ask for one of a closed set of verbs, with arguments the wrapper
// re-validates before acting.

import { execFile } from "node:child_process";
import type { ExecFileOptions } from "node:child_process";

/**
 * execFile, awaited, with an optional stdin.
 *
 * Written out rather than `promisify(execFile)` because the one credential this
 * addon passes to the wrapper travels on stdin, and the promisified form gives
 * no handle to write to. `execFile` returns the ChildProcess synchronously, so
 * the write happens before anything is awaited.
 */
function runCommand(
  cmd: string,
  args: string[],
  options: ExecFileOptions,
  input?: string
): Promise<{ error: (Error & { code?: number }) | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, options, (error, stdout, stderr) => {
      resolve({
        error: error as (Error & { code?: number }) | null,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
    // Always closed, even with nothing to send: a wrapper verb that read stdin
    // would otherwise wait on a pipe nobody is going to write to.
    child.stdin?.end(input ?? "");
  });
}

const WRAPPER_BIN = process.env.STAGER_WRAPPER || "/usr/local/lib/clp-addons/clp-action-stager";
const SUDO_BIN = "/usr/bin/sudo";

// `clone` only writes a job record and hands the work to systemd, so it
// answers immediately -- the long operation is the job itself, which nothing
// here waits on. `describe` runs du over a whole site, which is the one read
// that can genuinely take a while.
const TIMEOUTS: Record<string, number> = {
  describe: 120_000,
  clone: 60_000,
};
const DEFAULT_TIMEOUT = 30_000;

export interface WrapperResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function callWrapper<T = unknown>(
  verb: string,
  args: string[],
  // On stdin rather than in argv, because the only value that ever needs this
  // is a password and argv is world-readable through /proc.
  input?: string
): Promise<WrapperResult<T>> {
  const argv = [verb, ...args];
  const runningAsRoot = process.getuid?.() === 0;
  const cmd = runningAsRoot ? WRAPPER_BIN : SUDO_BIN;
  const cmdArgs = runningAsRoot ? argv : ["-n", WRAPPER_BIN, ...argv];

  const { error, stdout, stderr } = await runCommand(
    cmd,
    cmdArgs,
    { timeout: TIMEOUTS[verb] ?? DEFAULT_TIMEOUT, maxBuffer: 8 * 1024 * 1024 },
    input
  );
  if (error && !stdout.trim()) {
    console.error(`[wrapper] ${verb} failed without a JSON reply:`, stderr || error.message);
    return { ok: false, error: stderr.trim() || error.message || `wrapper ${verb} failed` };
  }

  if (stderr.trim()) console.error(`[wrapper:${verb}]`, stderr.trim());

  // stdout is a contract: exactly one JSON object. Never scrape the prose on
  // stderr for meaning.
  try {
    return JSON.parse(stdout.trim()) as WrapperResult<T>;
  } catch {
    console.error(`[wrapper] ${verb} produced unparseable stdout:`, stdout.slice(0, 500));
    return { ok: false, error: "wrapper returned a malformed reply" };
  }
}

// Mirrors the wrapper's own validation. Not a substitute for it: the wrapper is
// the boundary and re-checks everything. This exists so the UI can reject bad
// input with a useful message instead of a generic wrapper error.
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const JOB_RE = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;

export function validateDomain(d: unknown): string | null {
  return typeof d === "string" && d.length <= 253 && DOMAIN_RE.test(d) ? d : null;
}

export function validateJobId(j: unknown): string | null {
  return typeof j === "string" && JOB_RE.test(j) ? j : null;
}

/**
 * Expand the shorthand the original script accepted: a bare label becomes a
 * subdomain of the site being cloned.
 *
 * Here rather than in the wrapper because it is a convenience, and the wrapper
 * must not rewrite its input -- a boundary that silently corrects a value is
 * one that eventually corrects it wrong. What crosses the boundary is always a
 * complete hostname.
 */
export function expandTarget(input: string, source: string): string {
  const t = input.trim().toLowerCase().replace(/\.$/, "");
  if (!t) return "";
  return t.includes(".") ? t : `${t}.${source}`;
}

/** The `site.type` values the wrapper will clone. Kept in step with CLONABLE_TYPES. */
export type SiteType = "php" | "static" | "reverse-proxy";

export interface SiteSummary {
  domain: string;
  siteType: SiteType | string;
  siteUser: string;
  /** Empty for anything but a PHP site: the others have no php_settings row. */
  phpVersion: string;
  application: string;
  databases: number;
}

export interface SiteDetail extends Omit<SiteSummary, "databases"> {
  /** True when a reverse-proxy source's backend is an Instatic instance of ours. */
  instatic: boolean;
  rootDirectory: string;
  database: string;
  sizeMb: number;
}

export interface JobResult {
  siteType: SiteType | string;
  siteUser: string;
  phpVersion: string;
  vhostTemplate: string;
  /** Whether the source site's own vhost was reproduced for the clone. */
  vhostCarried: boolean;
  /**
   * How it was reproduced. `template` is CloudPanel's own vhost-template route,
   * available only for PHP; `rendered` is the panel-record write plus a rendered
   * file, which is the only route for every other type; `stock` means it was not
   * carried and the notes say why.
   */
  vhostCarriedBy: "template" | "rendered" | "stock" | string;
  database: { source: string; name: string; user: string; password: string } | null;
  /** The clone's own Instatic instance, when the source was one. */
  instatic: { port: number; tag: string; email: string; password: string } | null;
  notes: string[];
}

export interface JobView {
  id: string;
  source: string;
  target: string;
  /** The Instatic port this clone reserved, or 0 for a clone that needed none. */
  port: number;
  state: "queued" | "running" | "done" | "failed" | string;
  step: string;
  error: string;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
  result: JobResult | null;
}

export const stagerService = {
  async listSites(): Promise<SiteSummary[]> {
    const res = await callWrapper<{ sites: SiteSummary[] }>("sites", []);
    if (!res.ok) {
      console.error("[stager] could not list sites:", res.error);
      return [];
    }
    return res.data?.sites ?? [];
  },

  async describe(domain: string): Promise<WrapperResult<SiteDetail>> {
    return callWrapper<SiteDetail>("describe", ["--domain", domain]);
  },

  /**
   * Start a clone.
   *
   * `instatic` is supplied only when the source is an Instatic site. Its port
   * is allocated here rather than guessed by the wrapper: `getNextAvailablePort`
   * reads the panel snapshot both addons share, so the number that crosses the
   * boundary is one the wrapper only has to re-validate. The password travels on
   * stdin and never as an argument -- argv is readable out of `ps` by every
   * account on the box, and this is another site's administrator password.
   */
  async startClone(
    source: string,
    target: string,
    tls: boolean,
    instatic?: { port: number; email: string; password: string; mfaCode?: string }
  ): Promise<WrapperResult<{ job: string }>> {
    const args = ["--source", source, "--target", target, "--tls", tls ? "yes" : "no"];
    if (instatic) {
      args.push("--port", String(instatic.port), "--email", instatic.email);
      if (instatic.mfaCode) args.push("--mfa", instatic.mfaCode);
    }
    return callWrapper<{ job: string }>("clone", args, instatic ? `${instatic.password}\n` : undefined);
  },

  async getJob(id: string): Promise<WrapperResult<{ job: JobView; log: string }>> {
    return callWrapper<{ job: JobView; log: string }>("job", ["--job", id]);
  },

  async listJobs(): Promise<JobView[]> {
    const res = await callWrapper<{ jobs: JobView[] }>("jobs", []);
    if (!res.ok) {
      console.error("[stager] could not list jobs:", res.error);
      return [];
    }
    return res.data?.jobs ?? [];
  },
};
