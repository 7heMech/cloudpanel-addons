import {
  errorBlock, htmlResponse, jsonResponse, newCsrfToken, readMutation,
} from "../../../lib/app-http";
import type { ActionResult } from "../../../lib/gateway-client";
import { FIREWALL_PROTOCOLS, ruleKey, type FirewallProtocol, type FirewallStatus } from "../protocols";
import { firewallService } from "./service";
import { dashboardView, layout } from "./views";


function validMutationBody(body: unknown): body is { enabled: boolean } {
  return typeof body === "object" && body !== null && typeof (body as { enabled?: unknown }).enabled === "boolean";
}

/** What CloudPanel's Firewall pages read: whether to show a protocol, and each rule's. */
function protocolsReply(result: ActionResult<FirewallStatus>): Response {
  if (!result.ok || !result.data) return jsonResponse({ ok: false, error: result.error ?? "the firewall protocols are unavailable" }, 400);
  return jsonResponse({ ok: true, enabled: result.data.enabled, protocols: result.data.protocols });
}

export async function handle(
  req: Request,
  path: string,
  updateNotice?: { current: string; latest: string } | null,
): Promise<Response> {
  if (req.method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    try {
      const result = await firewallService.state();
      if (!result.ok || !result.data) throw new Error(result.error ?? "the firewall state is unavailable");
      return htmlResponse(layout("Firewall", dashboardView(result.data), updateNotice), { csrf });
    } catch (error) {
      return htmlResponse(layout("Firewall", errorBlock(error), updateNotice), { status: 500, csrf });
    }
  }

  // CloudPanel's Firewall pages: the protocols, and a CSRF cookie for the page that sets one.
  if (req.method === "GET" && path === "/api/session") return jsonResponse({ ok: true }, { csrf: newCsrfToken() });
  if (req.method === "GET" && path === "/api/protocols") return protocolsReply(await firewallService.protocols());

  if (req.method === "GET" && path === "/api/sites") {
    const result = await firewallService.state();
    return jsonResponse(result.ok && result.data ? { ...result, html: dashboardView(result.data) } : result, result.ok ? 200 : 500);
  }

  if (req.method === "POST" && path === "/api/sites") {
    const body = await readMutation(req);
    if (body instanceof Response) return body;
    const values = body as { domains?: unknown; enabled?: unknown };
    if (!Array.isArray(values.domains) || values.domains.length === 0 ||
        !values.domains.every((domain: unknown) => typeof domain === "string") || typeof values.enabled !== "boolean") {
      return jsonResponse({ ok: false, error: "domains must be a non-empty string array and enabled must be boolean" }, 400);
    }
    const result = await firewallService.setSites(values.domains, values.enabled);
    return jsonResponse(result, result.ok ? 200 : 400);
  }

  if (req.method === "POST" && path === "/api/policy") {
    const body = await readMutation(req);
    if (body instanceof Response) return body;
    if (!validMutationBody(body)) return jsonResponse({ ok: false, error: "enabled must be boolean" }, 400);
    const result = await firewallService.setAutomatic(body.enabled);
    return jsonResponse(result, result.ok ? 200 : 400);
  }

  if (req.method === "POST" && path === "/api/protocols") {
    const body = await readMutation(req);
    if (body instanceof Response) return body;
    if (!validMutationBody(body)) return jsonResponse({ ok: false, error: "enabled must be boolean" }, 400);
    const result = await firewallService.setProtocols(body.enabled);
    return jsonResponse(result, result.ok ? 200 : 400);
  }

  if (req.method === "POST" && path === "/api/protocols/rule") {
    const body = await readMutation(req, 1024);
    if (body instanceof Response) return body;
    const { portRange, source, protocol, id } = body;
    if (typeof portRange !== "string" || typeof source !== "string" || !ruleKey(portRange, source)) {
      return jsonResponse({ ok: false, error: "Port Range must be a port or a range such as 8000-8100, and Source an address or a CIDR" }, 400);
    }
    if (!FIREWALL_PROTOCOLS.includes(protocol as FirewallProtocol) || (id !== undefined && !Number.isSafeInteger(id))) {
      return jsonResponse({ ok: false, error: "a protocol of tcp, udp or both is required" }, 400);
    }
    return protocolsReply(await firewallService.setProtocol({ portRange, source, protocol: protocol as string, id: id as number | undefined }));
  }

  if (req.method === "POST" && path === "/api/hetzner/token") {
    const body = await readMutation(req, 1024);
    if (body instanceof Response) return body;
    if (typeof body.token !== "string" || !body.token.trim()) return jsonResponse({ ok: false, error: "Paste the API token Hetzner showed you" }, 400);
    const result = await firewallService.connectHetzner(body.token);
    return jsonResponse(result, result.ok ? 200 : 400);
  }

  if (req.method === "POST" && path === "/api/hetzner/token/remove") {
    const body = await readMutation(req);
    if (body instanceof Response) return body;
    const result = await firewallService.disconnectHetzner();
    return jsonResponse(result, result.ok ? 200 : 400);
  }

  if (req.method === "POST" && path === "/api/hetzner/switch") {
    const body = await readMutation(req, 1024);
    if (body instanceof Response) return body;
    const { role, enabled, confirm } = body;
    if ((role !== "web" && role !== "panel") || typeof enabled !== "boolean" || (confirm !== undefined && typeof confirm !== "string")) {
      return jsonResponse({ ok: false, error: "role must be web or panel, and enabled boolean" }, 400);
    }
    const result = await firewallService.setHetzner(role, enabled, confirm as string | undefined);
    return jsonResponse(result, result.ok ? 200 : 400);
  }

  return jsonResponse({ ok: false, error: "not found" }, 404);
}
