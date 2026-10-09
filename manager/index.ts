// The manager's own API: update status, enable, disable, update, and
// following the job each mutation starts.
import type { Server } from "bun";
import { guardMutation, jsonResponse, safeDecodePathSegment } from "../lib/app-http";
import { streamGatewayAction } from "../lib/gateway-client";
import { jobEventStream, type JobWatcher } from "../lib/job-stream";
import { ADDON_NAMES } from "../cli/addon-catalog";
import { JOB_ID_RE } from "../cli/job-store";
import type { ManagerJobView } from "../cli/manager-action";
import type { CliUpdateInfo } from "../lib/update-check";
import { indexPage, updatePage } from "./views";
import { latestManagerJobView, managerAction } from "./service";

function managerJson(body: unknown, status = 200): Response {
  return jsonResponse(body, { status });
}

/**
 * The manager's own API: update status, enable, disable, update, and following
 * the job each mutation starts.
 *
 * Every route here is already behind the SSO gate and the administrator gate at
 * the socket boundary; `guardMutation` adds the same origin and CSRF check the
 * addons use, so a page on another origin cannot spend an administrator's
 * session on a binary replacement.
 *
 * Returns null when the path is not one of these, so the caller can carry on.
 */
export async function handleManagerRoute(
  req: Request,
  path: string,
  server: Server<unknown>,
  update: CliUpdateInfo | null = null,
): Promise<Response | null> {
  if (path === "/api/update" && req.method === "GET") {
    return managerJson({ ok: true, data: update });
  }

  const addonRoute = path.match(/^\/api\/addons\/([^/]+)\/(enable|disable)$/);
  if (addonRoute && req.method === "POST") {
    const denied = guardMutation(req);
    if (denied) return denied;
    const name = safeDecodePathSegment(addonRoute[1]!);
    if (!name) return managerJson({ ok: false, error: "invalid addon name" }, 400);
    if (!ADDON_NAMES.includes(name)) return managerJson({ ok: false, error: "unknown addon" }, 404);
    const result = await managerAction(addonRoute[2]!, [`--addon=${name}`]);
    return managerJson(result, result.ok ? 200 : 400);
  }

  if (path === "/api/update" && req.method === "POST") {
    const denied = guardMutation(req);
    if (denied) return denied;
    const result = await managerAction("update");
    return managerJson(result, result.ok ? 200 : 400);
  }

  const jobRoute = path.match(/^\/api\/jobs\/([^/]+?)(\/events)?$/);
  if (jobRoute && req.method === "GET") {
    const id = safeDecodePathSegment(jobRoute[1]!);
    if (!id || !JOB_ID_RE.test(id)) return managerJson({ ok: false, error: "not a valid job id" }, 400);
    const getJob = (jobId: string) => managerAction<{ job: ManagerJobView; log: string }>("job", [`--id=${jobId}`]);
    const watchJob = (jobId: string, handlers: Parameters<JobWatcher<ManagerJobView>>[1]) => {
      let ended = false;
      const close = (error?: string) => {
        if (ended) return;
        ended = true;
        handlers.onClose(error);
      };
      return streamGatewayAction<{ job: ManagerJobView; log: string }>({
        addon: "manager",
        verb: "watch-job",
        args: [`--id=${jobId}`],
        onReply(reply) {
          if (reply.ok && reply.data) handlers.onSnapshot(reply.data);
          else if (!reply.ok) close(reply.error);
          else close("gateway returned an empty job snapshot");
        },
        onClose: close,
      });
    };
    if (jobRoute[2] || req.headers.get("accept")?.includes("text/event-stream")) {
      return jobEventStream({ id, req, server, getJob, watchJob });
    }
    const result = await getJob(id);
    return managerJson(result, result.ok ? 200 : 404);
  }

  return null;
}
