import { getNextAvailablePort, readPanelSnapshot, type PanelSnapshot } from "../../../lib/snapshot-reader";
import { callGatewayAction, type ActionResult, type GatewayStream } from "../../../lib/gateway-client";
import type { WebVerb } from "../../../lib/gateway-protocol";
import { watchGatewayJob, type JobWatcher } from "../../../lib/job-stream";
export { type ActionResult };

// create pulls an image and waits on a health check.
const TIMEOUTS: Partial<Record<WebVerb<"instatic">, number>> = {
  create: 300_000,
  update: 300_000,
  // Recreate may snapshot and migrate a legacy instance into its site home.
  recreate: 300_000,
  delete: 180_000,
  snapshot: 120_000,
};
const DEFAULT_TIMEOUT = 60_000;

async function callAction<T = unknown>(verb: WebVerb<"instatic">, args: string[]): Promise<ActionResult<T>> {
  return callGatewayAction("instatic", verb, args, undefined, {
    timeout: TIMEOUTS[verb] ?? DEFAULT_TIMEOUT,
    maxBuffer: 8 * 1024 * 1024,
  });
}

// Mirrors the action's validation for a useful UI message; the action is the
// boundary and re-checks.
const TAG_RE = /^\d+\.\d+\.\d+$/;

export function validateTag(t: unknown): string | null {
  return typeof t === "string" && TAG_RE.test(t) ? t : null;
}

/** A view of the action's meta.json files and container; the manager keeps no copy. */
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

export interface InstaticJobView {
  id: string;
  domain: string;
  port: number;
  tag: string;
  tls: boolean;
  /** What came of the certificate; absent on records written before it was kept. */
  certificate?: "issued" | "failed" | "none";
  /** Absent on records written before updates were jobs, which are creations. */
  kind?: "create" | "update";
  fromTag?: string;
  state: "queued" | "running" | "done" | "failed" | "unknown";
  step: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  event?: string;
}

export const instaticService = {
  async snapshot(): Promise<{ snap: PanelSnapshot; ageSeconds: number }> {
    return readPanelSnapshot();
  },

  async listInstances(): Promise<InstanceView[]> {
    const res = await callAction<{ instances: InstanceView[] }>("list", []);
    if (!res.ok) {
      console.error("[instatic] could not list instances:", res.error);
      return [];
    }
    return res.data?.instances ?? [];
  },

  /** For the port allocator, where an empty list would hand out a port already in use. */
  async listInstancesOrThrow(): Promise<InstanceView[]> {
    const res = await callAction<{ instances: InstanceView[] }>("list", []);
    if (!res.ok) throw new Error(res.error ?? "the Instatic action could not list instances");
    return res.data?.instances ?? [];
  },

  /**
   * @throws If existing instances or panel allocations cannot be read, or no
   * reserved port is free.
   */
  async createInstance(
    domain: string,
    tag: string,
    tls = false,
    isAsync = false
  ): Promise<ActionResult<{ job?: string; domain?: string; port?: number; container?: string; siteUser?: string }>> {
    const existing = await this.listInstancesOrThrow();
    if (existing.some((i) => i.domain === domain)) {
      return { ok: false, error: `an instance for ${domain} already exists` };
    }

    // A proposal, not a reservation: the action re-checks the port under a lock.
    const { snap } = await this.snapshot();
    const port = getNextAvailablePort(snap, existing.map((i) => i.port));
    const args = [
      "--domain", domain,
      "--port", String(port),
      "--tag", tag,
      "--tls", tls ? "yes" : "no",
    ];
    if (isAsync) args.push("--async");
    return callAction<{ job?: string; domain?: string; port?: number; container?: string; siteUser?: string }>("create", args);
  },

  async getJob(id: string): Promise<ActionResult<{ job: InstaticJobView; log: string }>> {
    return callAction<{ job: InstaticJobView; log: string }>("job", ["--job", id]);
  },

  watchJob(id: string, handlers: Parameters<JobWatcher<InstaticJobView>>[1]): GatewayStream {
    return watchGatewayJob<InstaticJobView>("instatic", id, handlers);
  },

  async listJobs(): Promise<InstaticJobView[]> {
    const res = await callAction<{ jobs: InstaticJobView[] }>("jobs", []);
    if (!res.ok) {
      console.error("[instatic] could not list jobs:", res.error);
      return [];
    }
    return res.data?.jobs ?? [];
  },

  async updateInstance(domain: string, tag: string): Promise<ActionResult<{ job?: string }>> {
    return callAction<{ job?: string }>("update", ["--domain", domain, "--tag", tag, "--async"]);
  },

  /**
   * `recreate` rebuilds the container from the recorded tag: Docker bakes a
   * container's configuration in at creation, so that is the only way to pick
   * up a change such as the uid it runs as.
   */
  async lifecycle(domain: string, verb: "start" | "stop" | "restart" | "recreate"): Promise<ActionResult> {
    return callAction(verb, ["--domain", domain]);
  },

  async deleteInstance(domain: string): Promise<ActionResult> {
    return callAction("delete", ["--domain", domain, "--confirm", domain]);
  },

  async snapshotInstance(domain: string): Promise<ActionResult> {
    return callAction("snapshot", ["--domain", domain]);
  },

  async getLogs(domain: string): Promise<ActionResult<{ logs: string }>> {
    return callAction<{ logs: string }>("logs", ["--domain", domain]);
  },
};
