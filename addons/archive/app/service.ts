import { callGatewayAction, type ActionResult, type GatewayStream } from "../../../lib/gateway-client";
import { watchGatewayJob, type JobWatcher } from "../../../lib/job-stream";
import type { ArchiveJobView, ArchiveState } from "../action";

export const archiveService = {
  state: (): Promise<ActionResult<ArchiveState>> => callGatewayAction<ArchiveState>("archive", "list", [], undefined, { timeout: 60_000 }),
  start: (verb: "archive" | "restore" | "delete", body: unknown): Promise<ActionResult<{ job: ArchiveJobView }>> =>
    callGatewayAction<{ job: ArchiveJobView }>("archive", verb, [], JSON.stringify(body), { timeout: 60_000 }),
  getJob: (id: string): Promise<ActionResult<{ job: ArchiveJobView; log: string }>> => callGatewayAction("archive", "job", [`--job=${id}`]),
  watchJob: (id: string, handlers: Parameters<JobWatcher<ArchiveJobView>>[1]): GatewayStream => watchGatewayJob<ArchiveJobView>("archive", id, handlers),
};
