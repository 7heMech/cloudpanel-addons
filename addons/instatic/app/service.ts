// Every privileged action goes through the wrapper. The app deliberately has
// no docker access of its own: membership in the docker group is equivalent to
// root, which would make the wrapper's argument validation decorative.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { instanceRepo, type InstanceRecord } from "./db";
import { getNextAvailablePort, readSnapshot, snapshotAgeSeconds, type PanelSnapshot } from "../../../lib/snapshot-reader";

const execFileAsync = promisify(execFile);

const WRAPPER_BIN = process.env.INSTATIC_WRAPPER || "/usr/local/lib/clp-addons/clp-action-instatic";
const SUDO_BIN = "/usr/bin/sudo";

// create pulls an image and waits on a health check, so it needs the longest
// budget. Everything else is quick.
const TIMEOUTS: Record<string, number> = {
  create: 300_000,
  update: 300_000,
  // recreate does not pull, but it does chown the instance's data and then
  // wait on the same health check as create.
  recreate: 180_000,
  delete: 180_000,
  snapshot: 120_000,
};
const DEFAULT_TIMEOUT = 60_000;

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
      // No JSON on stdout means the wrapper never got far enough to answer.
      // Surface its stderr rather than a bare exec error.
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

// Mirrors the wrapper's own validation. Not a substitute for it: the wrapper
// is the boundary and re-checks everything. This exists so the UI can reject
// bad input with a useful message instead of a generic wrapper error.
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const TAG_RE = /^\d+\.\d+\.\d+$/;

export function validateDomain(d: unknown): string | null {
  return typeof d === "string" && d.length <= 253 && DOMAIN_RE.test(d) ? d : null;
}

export function validateTag(t: unknown): string | null {
  return typeof t === "string" && TAG_RE.test(t) ? t : null;
}

export interface InstanceView extends InstanceRecord {
  state: string;
}

export const instaticService = {
  snapshot(): { snap: PanelSnapshot; ageSeconds: number } {
    const snap = readSnapshot();
    return { snap, ageSeconds: snapshotAgeSeconds(snap) };
  },

  panelSites(): PanelSnapshot["sites"] {
    return readSnapshot().sites;
  },

  nextPort(): number {
    return getNextAvailablePort();
  },

  // Live container state comes from the wrapper's status verb, one call per
  // instance. The stored status is a cache and the wrapper is the truth.
  async listInstances(): Promise<InstanceView[]> {
    const records = instanceRepo.getAll();
    const views: InstanceView[] = [];
    for (const r of records) {
      const res = await callWrapper<{ state: string }>("status", ["--domain", r.domain]);
      const state = res.ok ? (res.data?.state ?? "unknown") : "unknown";
      if (state !== r.status) instanceRepo.updateStatus(r.domain, state);
      views.push({ ...r, status: state, state });
    }
    return views;
  },

  async createInstance(domain: string, tag: string): Promise<WrapperResult> {
    if (instanceRepo.getByDomain(domain)) {
      return { ok: false, error: `an instance for ${domain} already exists` };
    }

    const port = this.nextPort();
    const res = await callWrapper<{ container: string; siteUser: string }>("create", [
      "--domain", domain,
      "--port", String(port),
      "--tag", tag,
    ]);
    if (!res.ok) return res;

    const now = new Date().toISOString();
    instanceRepo.insert({
      domain,
      port,
      tag,
      container_name: res.data?.container ?? `instatic-${domain}`,
      site_user: res.data?.siteUser ?? "",
      status: "running",
      created_at: now,
      updated_at: now,
    });
    return res;
  },

  async updateInstance(domain: string, tag: string): Promise<WrapperResult> {
    const res = await callWrapper("update", ["--domain", domain, "--tag", tag]);
    if (res.ok) instanceRepo.updateTag(domain, tag);
    return res;
  },

  /**
   * `recreate` is in here rather than beside `update` because it changes no
   * version: it rebuilds the container from the tag already recorded. Docker
   * bakes a container's configuration in at creation, so an instance created
   * by an older release keeps that configuration through any number of
   * restarts, and rebuilding is the only way to pick up a change such as the
   * uid the container runs as.
   */
  async lifecycle(domain: string, verb: "start" | "stop" | "restart" | "recreate"): Promise<WrapperResult> {
    const res = await callWrapper(verb, ["--domain", domain]);
    if (res.ok) instanceRepo.updateStatus(domain, verb === "stop" ? "exited" : "running");
    return res;
  },

  async deleteInstance(domain: string): Promise<WrapperResult> {
    // --confirm must equal --domain; the wrapper enforces it too.
    const res = await callWrapper("delete", ["--domain", domain, "--confirm", domain]);
    if (res.ok) instanceRepo.delete(domain);
    return res;
  },

  async snapshotInstance(domain: string): Promise<WrapperResult> {
    return callWrapper("snapshot", ["--domain", domain]);
  },

  async getLogs(domain: string): Promise<WrapperResult<{ logs: string }>> {
    return callWrapper<{ logs: string }>("logs", ["--domain", domain]);
  },
};
