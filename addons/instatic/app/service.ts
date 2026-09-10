// Every privileged action goes through the wrapper. The app deliberately has
// no docker access of its own: membership in the docker group is equivalent to
// root, which would make the wrapper's argument validation decorative.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getNextAvailablePort, readSnapshot, snapshotAgeSeconds, type PanelSnapshot } from "../../../lib/snapshot-reader";

const execFileAsync = promisify(execFile);

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
  const runningAsRoot = process.getuid?.() === 0;
  const wrapperBin = process.env.INSTATIC_WRAPPER;
  const cliBin = process.env.CLP_ADDONS_BIN || "/usr/local/bin/clp-addons";

  let cmd: string;
  let cmdArgs: string[];

  if (wrapperBin) {
    const argv = [verb, ...args];
    cmd = runningAsRoot ? wrapperBin : SUDO_BIN;
    cmdArgs = runningAsRoot ? argv : ["-n", wrapperBin, ...argv];
  } else {
    const argv = ["action", "instatic", verb, ...args];
    cmd = runningAsRoot ? cliBin : SUDO_BIN;
    cmdArgs = runningAsRoot ? argv : ["-n", cliBin, ...argv];
  }

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

/**
 * An instance as the wrapper reports it.
 *
 * There is no second copy of this anywhere. The manager used to keep its own
 * SQLite table beside the wrapper's meta.json files, and the two drifted
 * whenever anything touched an instance without going through the manager --
 * an instance created by calling the wrapper directly never showed up here, and
 * a delete that failed part-way left a row describing something that no longer
 * existed. The files on disk and the container are the state; this is a view of
 * them.
 */
export interface InstanceView {
  domain: string;
  port: number;
  tag: string;
  container: string;
  siteUser: string;
  createdAt: string;
  state: string;
  panelSite?: boolean | null;
}

export const instaticService = {
  snapshot(): { snap: PanelSnapshot; ageSeconds: number } {
    const snap = readSnapshot();
    return { snap, ageSeconds: snapshotAgeSeconds(snap) };
  },


  async nextPort(): Promise<number> {
    // The snapshot is rewritten by the root CLI on install and repair, so
    // between reconciliation runs it does not know about instances created
    // since. The wrapper does.
    const instances = await this.listInstancesOrThrow();
    return getNextAvailablePort(readSnapshot(), instances.map((i) => i.port));
  },

  async listInstances(): Promise<InstanceView[]> {
    const res = await callWrapper<{ instances: InstanceView[] }>("list", []);
    if (!res.ok) {
      console.error("[instatic] could not list instances:", res.error);
      return [];
    }
    return res.data?.instances ?? [];
  },

  /**
   * The same list, but a wrapper failure is an error rather than an empty one.
   *
   * A dashboard can render "no instances" and be read by someone who knows the
   * difference. An allocator cannot: an empty list means every port in use
   * silently disappears from the calculation, and the next create is handed one
   * that is already spoken for. So the two readers ask different questions.
   */
  async listInstancesOrThrow(): Promise<InstanceView[]> {
    const res = await callWrapper<{ instances: InstanceView[] }>("list", []);
    if (!res.ok) throw new Error(res.error ?? "the Instatic wrapper could not list instances");
    return res.data?.instances ?? [];
  },

  async createInstance(domain: string, tag: string, tls = false): Promise<WrapperResult> {
    const existing = await this.listInstancesOrThrow();
    if (existing.some((i) => i.domain === domain)) {
      return { ok: false, error: `an instance for ${domain} already exists` };
    }

    // Nothing is recorded afterwards: the wrapper writes meta.json, which is
    // what the next list reads. The wrapper re-checks the port too, and holds
    // a lock while it does, so this allocation is a proposal rather than a
    // reservation.
    const port = getNextAvailablePort(readSnapshot(), existing.map((i) => i.port));
    return callWrapper<{ container: string; siteUser: string }>("create", [
      "--domain", domain,
      "--port", String(port),
      "--tag", tag,
      "--tls", tls ? "yes" : "no",
    ]);
  },

  async updateInstance(domain: string, tag: string): Promise<WrapperResult> {
    return callWrapper("update", ["--domain", domain, "--tag", tag]);
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
    return callWrapper(verb, ["--domain", domain]);
  },

  async deleteInstance(domain: string): Promise<WrapperResult> {
    // --confirm must equal --domain; the wrapper enforces it too.
    return callWrapper("delete", ["--domain", domain, "--confirm", domain]);
  },

  async snapshotInstance(domain: string): Promise<WrapperResult> {
    return callWrapper("snapshot", ["--domain", domain]);
  },

  async getLogs(domain: string): Promise<WrapperResult<{ logs: string }>> {
    return callWrapper<{ logs: string }>("logs", ["--domain", domain]);
  },
};
