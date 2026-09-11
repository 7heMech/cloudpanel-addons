import { getNextAvailablePort, readSnapshot, snapshotAgeSeconds, type PanelSnapshot } from "../../../lib/snapshot-reader";
import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
export { type ActionResult };

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

async function callAction<T = unknown>(verb: string, args: string[]): Promise<ActionResult<T>> {
  return callGatewayAction<T>("instatic", verb, args, undefined, {
    timeout: TIMEOUTS[verb] ?? DEFAULT_TIMEOUT,
    maxBuffer: 8 * 1024 * 1024,
  });
}

// Mirrors the action binary's own validation. Not a substitute for it: the
// action binary is the boundary and re-checks everything. This exists so the
// UI can reject bad input with a useful message instead of a generic error
// from the action binary.
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const TAG_RE = /^\d+\.\d+\.\d+$/;

export function validateDomain(d: unknown): string | null {
  return typeof d === "string" && d.length <= 253 && DOMAIN_RE.test(d) ? d : null;
}

export function validateTag(t: unknown): string | null {
  return typeof t === "string" && TAG_RE.test(t) ? t : null;
}

/**
 * An instance as the action binary reports it.
 *
 * There is no second copy of this anywhere. The manager used to keep its own
 * SQLite table beside the action binary's meta.json files, and the two drifted
 * whenever anything touched an instance without going through the manager --
 * an instance created by calling the action binary directly never showed up
 * here, and a delete that failed part-way left a row describing something that no longer
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
    // since. The action binary does.
    const instances = await this.listInstancesOrThrow();
    return getNextAvailablePort(readSnapshot(), instances.map((i) => i.port));
  },

  async listInstances(): Promise<InstanceView[]> {
    const res = await callAction<{ instances: InstanceView[] }>("list", []);
    if (!res.ok) {
      console.error("[instatic] could not list instances:", res.error);
      return [];
    }
    return res.data?.instances ?? [];
  },

  /**
   * The same list, but a call failure is an error rather than an empty one.
   *
   * A dashboard can render "no instances" and be read by someone who knows the
   * difference. An allocator cannot: an empty list means every port in use
   * silently disappears from the calculation, and the next create is handed one
   * that is already spoken for. So the two readers ask different questions.
   */
  async listInstancesOrThrow(): Promise<InstanceView[]> {
    const res = await callAction<{ instances: InstanceView[] }>("list", []);
    if (!res.ok) throw new Error(res.error ?? "the Instatic action could not list instances");
    return res.data?.instances ?? [];
  },

  async createInstance(domain: string, tag: string, tls = false): Promise<ActionResult> {
    const existing = await this.listInstancesOrThrow();
    if (existing.some((i) => i.domain === domain)) {
      return { ok: false, error: `an instance for ${domain} already exists` };
    }

    // Nothing is recorded afterwards: the action binary writes meta.json, which is
    // what the next list reads. The action binary re-checks the port too, and holds
    // a lock while it does, so this allocation is a proposal rather than a
    // reservation.
    const port = getNextAvailablePort(readSnapshot(), existing.map((i) => i.port));
    return callAction<{ container: string; siteUser: string }>("create", [
      "--domain", domain,
      "--port", String(port),
      "--tag", tag,
      "--tls", tls ? "yes" : "no",
    ]);
  },

  async updateInstance(domain: string, tag: string): Promise<ActionResult> {
    return callAction("update", ["--domain", domain, "--tag", tag]);
  },

  /**
   * `recreate` is in here rather than beside `update` because it changes no
   * version: it rebuilds the container from the tag already recorded. Docker
   * bakes a container's configuration in at creation, so an instance created
   * by an older release keeps that configuration through any number of
   * restarts, and rebuilding is the only way to pick up a change such as the
   * uid the container runs as.
   */
  async lifecycle(domain: string, verb: "start" | "stop" | "restart" | "recreate"): Promise<ActionResult> {
    return callAction(verb, ["--domain", domain]);
  },

  async deleteInstance(domain: string): Promise<ActionResult> {
    // --confirm must equal --domain; the action binary enforces it too.
    return callAction("delete", ["--domain", domain, "--confirm", domain]);
  },

  async snapshotInstance(domain: string): Promise<ActionResult> {
    return callAction("snapshot", ["--domain", domain]);
  },

  async getLogs(domain: string): Promise<ActionResult<{ logs: string }>> {
    return callAction<{ logs: string }>("logs", ["--domain", domain]);
  },
};
