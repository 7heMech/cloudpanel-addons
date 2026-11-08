import { guardMutation, jsonResponse, safeDecodePathSegment } from "../lib/app-http";
import { streamGatewayAction, type ActionResult } from "../lib/gateway-client";
import { jobEventStream, type JobWatcher } from "../lib/job-stream";
import { ADDON_NAMES } from "../addons/catalog";
import { JOB_ID_RE } from "../lib/job-store";
import type { ManagerJobView } from "./action";
import type { CliUpdateInfo } from "../lib/update-check";
import { managerAction } from "./service";

/**
 * Every route here is already behind the SSO gate and the administrator gate at
 * the socket boundary; `guardMutation` adds the same origin and CSRF check the
 * addons use, so a page on another origin cannot spend an administrator's
 * session on a binary replacement.
 */
export async function handleManagerRoute(
  req: Request,
  path: string,
  _server: unknown,
  update: CliUpdateInfo | null = null,
): Promise<Response | null> {
  if (path === "/api/update" && req.method === "GET") {
    return jsonResponse({ ok: true, data: update });
  }

  const addonRoute = path.match(/^\/api\/addons\/([^/]+)\/(enable|disable)$/);
  if (addonRoute && req.method === "POST") {
    const denied = guardMutation(req);
    if (denied) return denied;
    const name = safeDecodePathSegment(addonRoute[1]!);
    if (!name) return jsonResponse({ ok: false, error: "invalid addon name" }, 400);
    if (!ADDON_NAMES.includes(name)) return jsonResponse({ ok: false, error: "unknown addon" }, 404);
    const result = await managerAction(addonRoute[2] === "enable" ? "enable" : "disable", [`--addon=${name}`]);
    return jsonResponse(result, result.ok ? 200 : 400);
  }

  const newsRoute = path.match(/^\/api\/addons(?:\/([^/]+))?\/news-seen$/);
  if (newsRoute && req.method === "POST") {
    const denied = guardMutation(req);
    if (denied) return denied;
    const name = newsRoute[1] === undefined ? "" : safeDecodePathSegment(newsRoute[1]);
    if (name !== "" && (!name || !ADDON_NAMES.includes(name))) return jsonResponse({ ok: false, error: "unknown addon" }, 404);
    const result = await managerAction("mark-news-seen", name ? [`--addon=${name}`] : []);
    return jsonResponse(result, result.ok ? 200 : 400);
  }

  if (path === "/api/update" && req.method === "POST") {
    const denied = guardMutation(req);
    if (denied) return denied;
    const result = await managerAction("update");
    return jsonResponse(result, result.ok ? 200 : 400);
  }

  const jobRoute = path.match(/^\/api\/jobs\/([^/]+?)(\/events)?$/);
  if (jobRoute && req.method === "GET") {
    const id = safeDecodePathSegment(jobRoute[1]!);
    if (!id || !JOB_ID_RE.test(id)) return jsonResponse({ ok: false, error: "not a valid job id" }, 400);
    const getJob = (jobId: string) => managerAction<{ job: ManagerJobView; log: string }>("job", [`--id=${jobId}`]);
    const watchJob = (jobId: string, handlers: Parameters<JobWatcher<ManagerJobView>>[1]) => {
      let ended = false;
      const close = (error?: string) => {
        if (ended) return;
        ended = true;
        handlers.onClose(error);
      };
      return streamGatewayAction({
        addon: "manager",
        verb: "watch-job",
        args: [`--id=${jobId}`],
        onReply(reply: ActionResult<{ job: ManagerJobView; log: string }>) {
          if (reply.ok && reply.data) handlers.onSnapshot(reply.data);
          else if (!reply.ok) close(reply.error);
          else close("gateway returned an empty job snapshot");
        },
        onClose: close,
      });
    };
    if (jobRoute[2] || req.headers.get("accept")?.includes("text/event-stream")) {
      return jobEventStream({ id, req, getJob, watchJob });
    }
    const result = await getJob(id);
    return jsonResponse(result, result.ok ? 200 : 404);
  }

  return null;
}
