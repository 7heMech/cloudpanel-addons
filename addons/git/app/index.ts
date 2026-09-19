// Entry point for the Git addon's manager service.
//
// The manager router strips the /addons/git prefix before dispatching here, so
// a request for /addons/git/api/... arrives as /api/... .

import type { Server } from "bun";
import {
  bodyErrorResponse, guardMutation, htmlResponse, jsonResponse, newCsrfToken, readJsonObject,
  redirectResponse, safeDecodePathSegment,
} from "../../../lib/app-http";
import { jobApiRoute } from "../../../lib/job-stream";
import { embedLandingUrl } from "../../../lib/shadow-embed";
import { fleetView, fragment, layout, siteView } from "./views";
import { gitService, validateDomain, type GitSettings } from "./service";

function html(body: string, csrf: string, status = 200): Response {
  return htmlResponse(body, { status, csrf });
}

function json(body: unknown, status = 200): Response {
  return jsonResponse(body, { status });
}

// A fragment is the first thing an operator who came straight from a site page
// loads from this addon, so it carries the CSRF cookie its own actions echo.
function fragmentJson(body: unknown, csrf: string, status = 200): Response {
  return jsonResponse(body, { status, csrf });
}

function errorBlock(error: unknown): string {
  return `<div class="alert">${Bun.escapeHTML(error instanceof Error ? error.message : String(error))}</div>`;
}

/** The site page's content, and the log of whatever it last deployed. */
async function sitePage(domain: string): Promise<{ title: string; content: string; context: Awaited<ReturnType<typeof gitService.site>>["context"] }> {
  const page = await gitService.site(domain);
  let log = "";
  if (page.site.lastJob) {
    const record = await gitService.getJob(page.site.lastJob.id);
    if (record.ok && record.data) log = record.data.log;
  }
  return { title: `Git — ${domain}`, content: siteView(page.site, log), context: page.context };
}

function settingsFrom(body: Record<string, unknown>): GitSettings | string {
  const text = (field: string): string | null => {
    const value = body[field];
    if (value === undefined || value === null) return "";
    return typeof value === "string" ? value : null;
  };
  const remote = text("remote");
  const branch = text("branch");
  const directory = text("directory");
  const postDeploy = text("postDeploy");
  if (remote === null || branch === null || directory === null || postDeploy === null) {
    return "every setting must be a string";
  }
  if (!remote.trim()) return "enter the repository URL";
  if (!branch.trim()) return "enter the branch to deploy";
  return { remote, branch, directory, postDeploy };
}

/** The one flag the deploy key and the webhook URL both take: mint a new one. */
async function readReplaceFlag(req: Request): Promise<boolean | Response> {
  let body: Record<string, unknown>;
  try { body = await readJsonObject(req, 1024); } catch (error) { return bodyErrorResponse(error); }
  if (body.replace !== undefined && typeof body.replace !== "boolean") {
    return json({ ok: false, error: "replace must be a boolean" }, 400);
  }
  return body.replace === true;
}

export async function handle(
  req: Request,
  path: string,
  updateNotice?: { current: string; latest: string } | null,
  server?: Server<unknown> | null,
): Promise<Response> {
  const method = req.method;
  const url = new URL(req.url);

  if (path === "/health") return json({ ok: true, service: "git-manager" });

  if (method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    const selected = url.searchParams.get("domain");
    // A site-scoped page belongs to the panel's site page. Send a direct visit
    // there and let the injected loader pull this page into it; ?embed=0 keeps
    // the standalone page.
    if (selected && url.searchParams.get("embed") !== "0") {
      const target = validateDomain(selected);
      if (target) return redirectResponse(embedLandingUrl(target, "git"));
    }
    try {
      if (!selected) return html(layout("Git deploy", fleetView(await gitService.listSites()), updateNotice), csrf);
      const domain = validateDomain(selected);
      if (!domain) return html(layout("Invalid site", '<div class="alert">That is not a valid hostname.</div>', updateNotice), csrf, 400);
      const page = await sitePage(domain);
      return html(layout(page.title, page.content, updateNotice, page.context), csrf);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return html(layout("Git deploy", errorBlock(error), updateNotice), csrf, /not found/i.test(message) ? 404 : 500);
    }
  }

  // The same page as GET /?domain=, without a document around it, for the
  // loader injected into CloudPanel's site pages.
  if (method === "GET" && path === "/fragment") {
    const csrf = newCsrfToken();
    const domain = validateDomain(url.searchParams.get("domain") ?? "");
    if (!domain) return json({ ok: false, error: "that is not a valid hostname" }, 400);
    try {
      const page = await sitePage(domain);
      return fragmentJson(fragment(page.title, page.content), csrf);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ ok: false, error: message }, /not found/i.test(message) ? 404 : 500);
    }
  }

  // Read by the link injected into CloudPanel's own site list: Twig cannot see
  // which sites this addon deploys, so the rows ask.
  if (method === "GET" && path === "/api/sites") {
    try {
      return json({ ok: true, domains: await gitService.configuredDomains() });
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  const jobApi = await jobApiRoute({
    req,
    path,
    method,
    server,
    getJob: (id) => gitService.getJob(id),
    watchJob: (id, handlers) => gitService.watchJob(id, handlers),
  });
  if (jobApi) return jobApi;

  const siteRoute = path.match(/^\/api\/sites\/([^/]+)\/(config|key|webhook)$/);
  if (siteRoute) {
    const denied = guardMutation(req);
    if (denied) return denied;
    const decoded = safeDecodePathSegment(siteRoute[1]!);
    const domain = decoded === null ? null : validateDomain(decoded);
    if (!domain) return json({ ok: false, error: "that is not a valid hostname" }, 400);

    if (siteRoute[2] === "config" && method === "PUT") {
      let body: Record<string, unknown>;
      try { body = await readJsonObject(req, 8 * 1024); } catch (error) { return bodyErrorResponse(error); }
      const settings = settingsFrom(body);
      if (typeof settings === "string") return json({ ok: false, error: settings }, 400);
      const result = await gitService.configure(domain, settings);
      return json(result, result.ok ? 200 : 400);
    }
    if (siteRoute[2] === "config" && method === "DELETE") {
      const result = await gitService.forget(domain);
      return json(result, result.ok ? 200 : 400);
    }
    // A mode, not an action: POST mints the URL, DELETE invalidates it, and
    // `replace` is what Rotate sends. The key works the same way.
    if (siteRoute[2] === "webhook" && method === "DELETE") {
      const result = await gitService.setWebhook(domain, false);
      return json(result, result.ok ? 200 : 400);
    }
    if ((siteRoute[2] === "webhook" || siteRoute[2] === "key") && method === "POST") {
      const replace = await readReplaceFlag(req);
      if (replace instanceof Response) return replace;
      const result = siteRoute[2] === "webhook"
        ? await gitService.setWebhook(domain, true, replace)
        : await gitService.generateKey(domain, replace);
      return json(result, result.ok ? 200 : 400);
    }
    return json({ ok: false, error: "method not allowed" }, 405);
  }

  if (path === "/api/deployments") {
    if (method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
    const denied = guardMutation(req);
    if (denied) return denied;
    let body: Record<string, unknown>;
    try { body = await readJsonObject(req, 1024); } catch (error) { return bodyErrorResponse(error); }
    const domain = validateDomain(body.domain);
    if (!domain) return json({ ok: false, error: "that is not a valid hostname" }, 400);
    try {
      const result = await gitService.deploy(domain);
      return json(result, result.ok ? 200 : 400);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[git] deployment request failed:", message);
      return json({ ok: false, error: message }, 500);
    }
  }

  return json({ ok: false, error: "not found" }, 404);
}
