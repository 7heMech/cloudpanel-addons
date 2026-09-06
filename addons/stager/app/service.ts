// Every privileged action goes through the wrapper. The app has no clpctl
// access, no database access and no write access to any site's files: it can
// only ask for one of a closed set of verbs, with arguments the wrapper
// re-validates before acting.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

async function callWrapper<T = unknown>(verb: string, args: string[]): Promise<WrapperResult<T>> {
  const argv = [verb, ...args];
  const runningAsRoot = process.getuid?.() === 0;
  const cmd = runningAsRoot ? WRAPPER_BIN : SUDO_BIN;
  const cmdArgs = runningAsRoot ? argv : ["-n", WRAPPER_BIN, ...argv];

  let stdout = "";
  let stderr = "";
  try {
    const r = await execFileAsync(cmd, cmdArgs, {
      timeout: TIMEOUTS[verb] ?? DEFAULT_TIMEOUT,
      maxBuffer: 8 * 1024 * 1024,
    });
    stdout = r.stdout;
    stderr = r.stderr;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? "";
    if (!stdout.trim()) {
      console.error(`[wrapper] ${verb} failed without a JSON reply:`, stderr || e.message);
      return { ok: false, error: stderr.trim() || e.message || `wrapper ${verb} failed` };
    }
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

export interface SiteSummary {
  domain: string;
  siteUser: string;
  phpVersion: string;
  application: string;
  databases: number;
}

export interface SiteDetail extends Omit<SiteSummary, "databases"> {
  rootDirectory: string;
  database: string;
  sizeMb: number;
}

export interface JobResult {
  siteUser: string;
  phpVersion: string;
  vhostTemplate: string;
  database: { source: string; name: string; user: string; password: string } | null;
  notes: string[];
}

export interface JobView {
  id: string;
  source: string;
  target: string;
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

  async startClone(source: string, target: string, tls: boolean): Promise<WrapperResult<{ job: string }>> {
    return callWrapper<{ job: string }>("clone", [
      "--source", source,
      "--target", target,
      "--tls", tls ? "yes" : "no",
    ]);
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
