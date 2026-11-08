
import { errorMessage } from "../../../lib/errors";
import { instaticService, validateTag } from "./service";
import { validateJobId } from "../../../lib/job-id";
import { layout, dashboardView, newInstanceView, jobView } from "./views";
import {
  errorBlock, guardMutation, validateExactDomain, htmlResponse, jsonResponse, newCsrfToken, safeDecodePathSegment, readBody,
} from "../../../lib/app-http";
import { listAvailableTags } from "./tags";
import { jobApiRoute } from "../../../lib/job-stream";

async function dashboard(): Promise<string> {
  const [instances, jobs, available] = await Promise.all([
    instaticService.listInstancesOrThrow(),
    instaticService.listJobs(),
    listAvailableTags(),
  ]);
  return dashboardView(instances, available, jobs);
}

/** A change that landed is reported as landed, even when redrawing the list afterwards fails. */
async function change(result: { ok: boolean }): Promise<Response> {
  if (!result.ok) return jsonResponse(result, 400);
  try {
    return jsonResponse({ ...result, html: await dashboard() });
  } catch {
    return jsonResponse(result);
  }
}

const MUTATING_VERBS = new Set(["start", "stop", "restart", "recreate", "delete", "snapshot", "update"]);

/** `path` has the mount prefix stripped: /addons/instatic/api/... arrives as /api/... . */
export async function handle(
  req: Request,
  path: string,
  updateNotice?: { current: string; latest: string } | null,
  _server?: unknown,
  auth?: { user: string; roles: string[] } | null,
): Promise<Response> {
  const method = req.method;
  const page = (title: string, content: string) =>
    layout(title, content, updateNotice, auth?.roles.includes("ROLE_ADMIN") !== false);

  // What a job page polls while the manager restarts (JOB_WATCH_JS). It
  // reports nothing about instances.
  if (path === "/health") {
    return jsonResponse({ ok: true, service: "instatic-manager" });
  }

  if (method === "GET" && (path === "/" || path === "/new")) {
    const csrf = newCsrfToken();
    try {
      if (path === "/") {
        return htmlResponse(page("Instatic instances", await dashboard()), { csrf });
      }
      const fromNewSite = new URL(req.url).searchParams.get("from") === "new-site";
      return htmlResponse(page("New Instatic site", newInstanceView(await listAvailableTags(), fromNewSite)), { csrf });
    } catch (err) {
      return htmlResponse(page("Error", errorBlock(err)), { status: 500, csrf });
    }
  }

  const jobPage = path.match(/^\/jobs\/([^/]+)$/);
  if (method === "GET" && jobPage) {
    const decoded = safeDecodePathSegment(jobPage[1]!);
    if (decoded === null) return new Response("Bad request", { status: 400 });
    const id = validateJobId(decoded);
    if (!id) return new Response("Not found", { status: 404 });
    const res = await instaticService.getJob(id);
    if (!res.ok || !res.data) return new Response("Job not found", { status: 404 });
    const csrf = newCsrfToken();
    const job = res.data.job;
    return htmlResponse(page(`${job.kind === "update" ? "Updating" : "Creating"} ${job.domain}`, jobView(job, res.data.log)), { csrf });
  }

  if (path === "/api/instances" && method === "GET") {
    return jsonResponse({ ok: true, instances: await instaticService.listInstances() });
  }

  if (path === "/api/instances" && method === "POST") {
    const blocked = guardMutation(req);
    if (blocked) return blocked;

    const body = await readBody(req);
    if (body instanceof Response) return body;
    const { domain: rawDomain, tag: rawTag, tls } = body;
    const domain = validateExactDomain(rawDomain);
    const tag = validateTag(rawTag);
    if (!domain) return jsonResponse({ ok: false, error: "domain is not a valid hostname" }, 400);
    if (!tag) return jsonResponse({ ok: false, error: "tag must be an exact version such as 0.0.18" }, 400);

    const res = await instaticService.createInstance(domain, tag, tls === true, true);
    return jsonResponse(res, res.ok ? 202 : 400);
  }

  if (path === "/api/dashboard" && method === "GET") {
    try {
      return jsonResponse({ ok: true, html: await dashboard() });
    } catch (error) {
      return jsonResponse({ ok: false, error: errorMessage(error) }, 500);
    }
  }

  // A site that fails is named rather than stopping the rest.
  if (path === "/api/bulk" && method === "POST") {
    const blocked = guardMutation(req);
    if (blocked) return blocked;
    const body = await readBody(req);
    if (body instanceof Response) return body;
    const verb = body.verb;
    if (verb !== "update" && verb !== "restart") return jsonResponse({ ok: false, error: "verb must be update or restart" }, 400);
    const tag = verb === "update" ? validateTag(body.tag) : null;
    if (verb === "update" && !tag) return jsonResponse({ ok: false, error: "tag must be an exact version such as 0.0.18" }, 400);
    if (!Array.isArray(body.domains) || body.domains.length === 0 || body.domains.length > 500) {
      return jsonResponse({ ok: false, error: "choose between 1 and 500 sites" }, 400);
    }
    const domains = body.domains.map((domain) => validateExactDomain(domain));
    if (domains.some((domain) => !domain)) return jsonResponse({ ok: false, error: "a domain is not a valid hostname" }, 400);
    const done: string[] = [];
    const failed: { domain: string; error: string }[] = [];
    for (const domain of domains as string[]) {
      const res = verb === "update" ? await instaticService.updateInstance(domain, tag!) : await instaticService.lifecycle(domain, "restart");
      if (res.ok) done.push(domain);
      else failed.push({ domain, error: res.error ?? "failed" });
    }
    return change({ ok: true, data: { done, failed } } as { ok: boolean });
  }

  if (path === "/api/jobs" && method === "GET") {
    return jsonResponse({ ok: true, jobs: await instaticService.listJobs() });
  }

  const jobApi = await jobApiRoute({
    req,
    path,
    method,
    siteManager: true,
    getJob: (jobId) => instaticService.getJob(jobId),
    watchJob: (jobId, handlers) => instaticService.watchJob(jobId, handlers),
  });
  if (jobApi) return jobApi;

  const m = path.match(/^\/api\/instances\/([^/]+)\/([a-z-]+)$/);
  if (m) {
    const domain = validateExactDomain(safeDecodePathSegment(m[1]!));
    const verb = m[2]!;
    if (!domain) return jsonResponse({ ok: false, error: "domain is not a valid hostname" }, 400);

    if (verb === "logs" && method === "GET") {
      const res = await instaticService.getLogs(domain);
      return jsonResponse(res, res.ok ? 200 : 400);
    }

    if (MUTATING_VERBS.has(verb) && method === "POST") {
      const blocked = guardMutation(req);
      if (blocked) return blocked;

      switch (verb) {
        case "start":
        case "stop":
        case "restart":
        case "recreate": {
          const res = await instaticService.lifecycle(domain, verb);
          return change(res);
        }
        case "snapshot": {
          const res = await instaticService.snapshotInstance(domain);
          return jsonResponse(res, res.ok ? 200 : 400);
        }
        case "delete": {
          const res = await instaticService.deleteInstance(domain);
          return change(res);
        }
        case "update": {
          const body = await readBody(req);
          if (body instanceof Response) return body;
          const tag = validateTag(body.tag);
          if (!tag) return jsonResponse({ ok: false, error: "tag must be an exact version such as 0.0.18" }, 400);
          const res = await instaticService.updateInstance(domain, tag);
          return change(res);
        }
      }
    }

    return jsonResponse({ ok: false, error: `unsupported ${method} on ${verb}` }, 405);
  }

  return jsonResponse({ ok: false, error: "not found" }, 404);
}
