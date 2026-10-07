import type { Server } from "bun";
import {
  bodyErrorResponse, guardMutation, htmlResponse, jsonResponse, newCsrfToken, policyResponse, readJsonObject,
  policyHeaders, safeDecodePathSegment, SECURITY_HEADERS, validateDomain,
} from "../../../lib/app-http";
import { fetchPanelInfo } from "../../../lib/snapshot-reader";
import { panelSessionId } from "../../../lib/sso-auth";

import { MAX_TERMINAL_SIZE } from "../action";
import { ownerOf, TerminalSessions } from "./sessions";
import { dashboardView, inventoryUnavailableView, layout, popupPage, XTERM_ASSETS } from "./views";

import XTERM_JS from "./vendor/xterm.js" with { type: "text" };
import XTERM_CSS from "./vendor/xterm.css" with { type: "text" };
import FIT_JS from "./vendor/addon-fit.js" with { type: "text" };

const ASSET_BODIES: Record<keyof typeof XTERM_ASSETS, string> = {
  "xterm-6.0.0/xterm.js": XTERM_JS,
  "xterm-6.0.0/xterm.css": XTERM_CSS,
  "addon-fit-0.11.0/addon-fit.js": FIT_JS,
};

// The popup is the one page that loads scripts and a stylesheet from this
// origin rather than inline: xterm.js is half a megabyte, and cached.
function popupCsp(): string {
  return SECURITY_HEADERS["Content-Security-Policy"]!
    .replace("style-src 'unsafe-inline'", "style-src 'self' 'unsafe-inline'")
    .replace("script-src 'unsafe-inline'", "script-src 'self' 'unsafe-inline'");
}

export const terminalSessions = new TerminalSessions();

function json(body: unknown, status = 200): Response {
  return jsonResponse(body, { status });
}

const NOT_FOUND = () => json({ ok: false, error: "not found" }, 404);

function size(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_TERMINAL_SIZE ? value as number : null;
}

export async function handle(
  req: Request,
  path: string,
  updateNotice?: { current: string; latest: string } | null,
  server?: Server<unknown> | null,
  auth?: { user: string; roles: string[] } | null,
): Promise<Response> {
  const method = req.method;

  if (method === "GET" && path === "/") {
    try {
      const info = await fetchPanelInfo();
      const sites = [...info.sites].sort((a, b) => a.domain.localeCompare(b.domain));
      return htmlResponse(layout("Terminal", dashboardView(sites), updateNotice), { csrf: newCsrfToken() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return htmlResponse(layout("Terminal", inventoryUnavailableView(message), updateNotice), { status: 500 });
    }
  }

  const asset = method === "GET" && path.startsWith("/assets/") ? path.slice("/assets/".length) : null;
  if (asset !== null) {
    if (!Object.hasOwn(XTERM_ASSETS, asset)) return NOT_FOUND();
    const name = asset as keyof typeof XTERM_ASSETS;
    return policyResponse(ASSET_BODIES[name], XTERM_ASSETS[name], {
      headers: { "Cache-Control": "public, max-age=31536000, immutable" },
    });
  }

  const popup = path.match(/^\/sites\/([^/]+)$/);
  if (method === "GET" && popup) {
    const domain = validateDomain(safeDecodePathSegment(popup[1]!));
    if (!domain) return NOT_FOUND();
    return htmlResponse(popupPage(domain), {
      csrf: newCsrfToken(),
      headers: { "Content-Security-Policy": popupCsp() },
    });
  }

  if (!path.startsWith("/api/sessions")) return NOT_FOUND();
  // The manager's gate has already decided this is an administrator; a
  // session also belongs to the one sign-in that opened it.
  const sessionId = panelSessionId(req);
  if (!auth?.user || !sessionId) return NOT_FOUND();
  const owner = ownerOf(auth.user, sessionId);

  if (path === "/api/sessions" && method === "POST") {
    const denied = guardMutation(req);
    if (denied) return denied;
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(req, 4 * 1024);
    } catch (error) {
      return bodyErrorResponse(error);
    }
    const domain = validateDomain(body.domain);
    const cols = size(body.cols);
    const rows = size(body.rows);
    if (!domain || cols === null || rows === null) return json({ ok: false, error: "a domain and a terminal size are required" }, 400);
    const result = await terminalSessions.open(owner, { domain, cols, rows, sessionId });
    return result.ok
      ? json({ ok: true, data: { id: result.id, user: result.user } })
      : json({ ok: false, error: result.error }, 400);
  }

  const match = path.match(/^\/api\/sessions\/([A-Za-z0-9_-]{22})(\/events|\/input)?$/);
  if (!match) return NOT_FOUND();
  const id = match[1]!;

  if (match[2] === "/events" && method === "GET") {
    return terminalSessions.attach(id, owner, req, server) ?? NOT_FOUND();
  }

  const denied = guardMutation(req);
  if (denied) return denied;

  if (match[2] === "/input" && method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(req);
    } catch (error) {
      return bodyErrorResponse(error);
    }
    const data = body.data;
    const resize = body.size;
    if (data !== undefined && typeof data !== "string") return json({ ok: false, error: "data must be text" }, 400);
    let dimensions: [number, number] | undefined;
    if (resize !== undefined) {
      const pair = Array.isArray(resize) && resize.length === 2 ? [size(resize[0]), size(resize[1])] : [null, null];
      if (pair[0] === null || pair[1] === null) return json({ ok: false, error: "size must be [cols, rows]" }, 400);
      dimensions = [pair[0]!, pair[1]!];
    }
    let batch: { writer: string; seq: number } | undefined;
    if (body.writer !== undefined || body.seq !== undefined) {
      if (typeof body.writer !== "string" || !/^[a-z0-9]{1,32}$/.test(body.writer)
        || !Number.isSafeInteger(body.seq) || (body.seq as number) < 1) {
        return json({ ok: false, error: "writer and seq must name one batch" }, 400);
      }
      batch = { writer: body.writer, seq: body.seq as number };
    }
    return terminalSessions.input(id, owner, { data, size: dimensions, batch })
      ? new Response(null, { status: 204, headers: policyHeaders(null) })
      : NOT_FOUND();
  }

  if (match[2] === undefined && method === "DELETE") {
    return terminalSessions.close(id, owner) ? new Response(null, { status: 204, headers: policyHeaders(null) }) : NOT_FOUND();
  }

  return NOT_FOUND();
}
