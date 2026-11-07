import { errorMessage } from "../../../lib/errors";
import {
  guardMutation, htmlResponse, jsonResponse, newCsrfToken, policyResponse, policyHeaders, safeDecodePathSegment, SECURITY_HEADERS, validateDomain, readBody, readMutation,
} from "../../../lib/app-http";
import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
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

export interface RootAccessView { granted: boolean; problem: string | null; unreadable?: true }

/** How long the header's answer is reused; the worker checks for itself either way. */
const ROOT_ACCESS_TTL_MS = 60_000;
const rootAccessCache = new Map<string, { at: number; access: RootAccessView }>();

/**
 * Asked of root, which reads the grants itself; any failure offers nothing.
 * Every panel page's header asks, so the answer is kept a minute per user
 * rather than starting a root process for each page; the Terminal page asks
 * afresh.
 */
async function rootAccessOf(user: string | undefined, sessionId: string | null, fresh = false): Promise<RootAccessView> {
  if (!user || !sessionId) return { granted: false, problem: null };
  const cached = rootAccessCache.get(user);
  if (!fresh && cached && Date.now() - cached.at < ROOT_ACCESS_TTL_MS) return cached.access;
  let reply: ActionResult<RootAccessView>;
  try {
    reply = await callGatewayAction("terminal", "root-access", [], undefined, { sessionId }) as ActionResult<RootAccessView>;
  } catch (error) {
    reply = { ok: false, error: errorMessage(error) };
  }
  // A failed check is not an answer: it is not cached, and it does not say root never allowed this account.
  if (!reply.ok || !reply.data) return { granted: false, problem: `Root terminal access could not be checked: ${reply.error ?? "no answer"}` };
  const access = { granted: reply.data.granted, problem: reply.data.problem };
  // Nor is root's own read that failed, such as while CloudPanel holds its database.
  if (!reply.data.unreadable) rootAccessCache.set(user, { at: Date.now(), access });
  return access;
}

function size(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_TERMINAL_SIZE ? value as number : null;
}

export async function handle(
  req: Request,
  path: string,
  updateNotice?: { current: string; latest: string } | null,
  _server?: unknown,
  auth?: { user: string; roles: string[] } | null,
): Promise<Response> {
  const method = req.method;

  if (method === "GET" && path === "/") {
    try {
      const [info, root] = await Promise.all([fetchPanelInfo(), rootAccessOf(auth?.user, panelSessionId(req), true)]);
      const sites = [...info.sites].sort((a, b) => a.domain.localeCompare(b.domain));
      return htmlResponse(layout("Terminal", dashboardView(sites, root, auth?.user ?? ""), updateNotice), { csrf: newCsrfToken() });
    } catch (error) {
      const message = errorMessage(error);
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
  if (method === "GET" && (popup || path === "/root")) {
    const domain = popup ? validateDomain(safeDecodePathSegment(popup[1]!)) : null;
    if (popup && !domain) return NOT_FOUND();
    return htmlResponse(popupPage(domain), {
      csrf: newCsrfToken(),
      headers: { "Content-Security-Policy": popupCsp() },
    });
  }

  // What the header's root shell control asks before it shows itself.
  if (method === "GET" && path === "/api/root-access") return json({ ok: true, data: await rootAccessOf(auth?.user, panelSessionId(req)) });

  if (!path.startsWith("/api/sessions")) return NOT_FOUND();
  // The manager's gate has already decided this is an administrator; a
  // session also belongs to the one sign-in that opened it.
  const sessionId = panelSessionId(req);
  if (!auth?.user || !sessionId) return NOT_FOUND();
  const owner = ownerOf(auth.user, sessionId);

  if (path === "/api/sessions" && method === "POST") {
    const body = await readMutation(req, 4 * 1024);
    if (body instanceof Response) return body;
    // Root decides whether this user may have a root shell; the manager only asks.
    const root = body.root === true && body.domain === undefined;
    const domain = root ? null : validateDomain(body.domain);
    const cols = size(body.cols);
    const rows = size(body.rows);
    if ((!root && !domain) || cols === null || rows === null) return json({ ok: false, error: "a domain and a terminal size are required" }, 400);
    const result = await terminalSessions.open(owner, { domain, cols, rows, sessionId });
    return result.ok
      ? json({ ok: true, data: { id: result.id, user: result.user } })
      : json({ ok: false, error: result.error }, 400);
  }

  const match = path.match(/^\/api\/sessions\/([A-Za-z0-9_-]{22})(\/events|\/input)?$/);
  if (!match) return NOT_FOUND();
  const id = match[1]!;

  if (match[2] === "/events" && method === "GET") {
    return terminalSessions.attach(id, owner, req) ?? NOT_FOUND();
  }

  const denied = guardMutation(req);
  if (denied) return denied;

  if (match[2] === "/input" && method === "POST") {
    const body = await readBody(req);
    if (body instanceof Response) return body;
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
