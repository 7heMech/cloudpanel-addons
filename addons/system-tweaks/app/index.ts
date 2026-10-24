import {
  bodyErrorResponse, guardMutation, htmlResponse, jsonResponse, newCsrfToken, readJsonObject,
} from "../../../lib/app-http";
import type { ActionResult } from "../../../lib/gateway-client";
import { validRebootTime } from "../updates";
import type { SystemTweaksState } from "../action";
import { systemTweaksService } from "./service";
import { dashboardView, layout } from "./views";

function json(body: unknown, status = 200): Response {
  return jsonResponse(body, { status });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Every change answers with the page it leaves behind, so the browser repaints instead of reloading. */
function repaint(result: ActionResult<SystemTweaksState>): Response {
  if (!result.ok || !result.data) return json(result, 400);
  return json({ ok: true, html: dashboardView(result.data) });
}

export async function handle(
  req: Request,
  path: string,
  updateNotice?: { current: string; latest: string } | null,
): Promise<Response> {
  if (req.method === "GET" && path === "/health") return json({ ok: true, service: "system-tweaks-manager" });

  if (req.method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    try {
      const result = await systemTweaksService.state();
      if (!result.ok || !result.data) throw new Error(result.error ?? "the system state is unavailable");
      return htmlResponse(layout("System Tweaks", dashboardView(result.data), updateNotice), { csrf });
    } catch (error) {
      return htmlResponse(
        layout("System Tweaks", `<div class="alert" role="alert">${Bun.escapeHTML(errorMessage(error))}</div>`, updateNotice),
        { status: 500, csrf },
      );
    }
  }

  if (req.method !== "POST") return json({ ok: false, error: "not found" }, 404);
  const denied = guardMutation(req);
  if (denied) return denied;

  if (path === "/api/install-updates") return repaint(await systemTweaksService.installUpdates());

  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(req, 1024);
  } catch (error) {
    return bodyErrorResponse(error);
  }

  if (path === "/api/updates") {
    const wanted: Record<string, boolean | string | null> = {};
    for (const [key, value] of Object.entries(body)) {
      if (key === "rebootTime") {
        if (!validRebootTime(value)) return json({ ok: false, error: "rebootTime must be null, now or HH:MM (00:00–23:59)" }, 400);
        wanted[key] = value;
        continue;
      }
      if (typeof value !== "boolean") return json({ ok: false, error: `${key} must be true or false` }, 400);
      wanted[key] = value;
    }
    return repaint(await systemTweaksService.setUpdates(wanted));
  }

  if (path === "/api/upload-guard") {
    if (typeof body.enabled !== "boolean") return json({ ok: false, error: "enabled must be true or false" }, 400);
    return repaint(await systemTweaksService.setUploadGuard(body.enabled));
  }

  if (path === "/api/real-ip") {
    if (typeof body.enabled !== "boolean") return json({ ok: false, error: "enabled must be true or false" }, 400);
    return repaint(await systemTweaksService.setRealIp(body.enabled));
  }

  return json({ ok: false, error: "not found" }, 404);
}
