import { isIP } from "node:net";
import {
  errorBlock, guardMutation, htmlResponse, jsonResponse, newCsrfToken, readBody,
} from "../../../lib/app-http";
import type { ActionResult } from "../../../lib/gateway-client";
import { REBOOT_TIME_ERROR, validRebootTime } from "../updates";
import type { SystemTweaksState } from "../registry";
import { BACKUP_COMPRESSION_ERROR, validBackupCompression } from "../backup-compression";
import { FIREWALL_PROTOCOLS, ruleKey, type FirewallProtocol, type FirewallStatus } from "../firewall";
import { LOGIN_JAILS } from "../login-jails";
import { lockState } from "../../../lib/root-locks";
import { isSwitchVerb, systemTweaksService } from "./service";
import { dashboardView, layout } from "./views";


function firewallReply(result: ActionResult<FirewallStatus>): Response {
  if (!result.ok || !result.data) return jsonResponse({ ok: false, error: result.error ?? "the firewall protocols are unavailable" }, 400);
  return jsonResponse({ ok: true, protocols: result.data.protocols });
}

/** Every change answers with the page it leaves behind, so the browser repaints instead of reloading. */
function repaint(result: ActionResult<SystemTweaksState>): Response {
  if (!result.ok || !result.data) return jsonResponse(result, 400);
  return jsonResponse({ ok: true, html: dashboardView(result.data, Date.now(), lockState("system-tweaks")) });
}

export async function handle(
  req: Request,
  path: string,
  updateNotice?: { current: string; latest: string } | null,
): Promise<Response> {
  // CloudPanel's Firewall pages: the protocols, and a CSRF cookie for the page that sets one.
  if (req.method === "GET" && path === "/api/session") return jsonResponse({ ok: true }, { csrf: newCsrfToken() });
  if (req.method === "GET" && path === "/api/firewall") return firewallReply(await systemTweaksService.firewall());

  if (req.method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    try {
      const result = await systemTweaksService.state();
      if (!result.ok || !result.data) throw new Error(result.error ?? "the system state is unavailable");
      return htmlResponse(layout("System Tweaks", dashboardView(result.data, Date.now(), lockState("system-tweaks")), updateNotice), { csrf });
    } catch (error) {
      return htmlResponse(
        layout("System Tweaks", errorBlock(error), updateNotice),
        { status: 500, csrf },
      );
    }
  }

  if (req.method !== "POST") return jsonResponse({ ok: false, error: "not found" }, 404);
  const denied = guardMutation(req);
  if (denied) return denied;

  if (path === "/api/install-updates") return repaint(await systemTweaksService.installUpdates());
  if (path === "/api/install-fail2ban") return repaint(await systemTweaksService.installFail2ban());
  if (path === "/api/lock-settings") return repaint(await systemTweaksService.lockSettings());

  const body = await readBody(req, 1024);
  if (body instanceof Response) return body;

  const verb = `set-${path.replace(/^\/api\//, "")}`;
  if (isSwitchVerb(verb)) {
    if (typeof body.enabled !== "boolean") return jsonResponse({ ok: false, error: "enabled must be true or false" }, 400);
    return repaint(await systemTweaksService.setSwitch(verb, body.enabled));
  }

  if (path === "/api/updates") {
    const wanted: Record<string, boolean | string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (key === "rebootTime") {
        if (!validRebootTime(value)) return jsonResponse({ ok: false, error: REBOOT_TIME_ERROR }, 400);
        wanted[key] = value;
        continue;
      }
      if (typeof value !== "boolean") return jsonResponse({ ok: false, error: `${key} must be true or false` }, 400);
      wanted[key] = value;
    }
    return repaint(await systemTweaksService.setUpdates(wanted));
  }

  if (path === "/api/panel-php") {
    if (typeof body.php !== "string") return jsonResponse({ ok: false, error: "php must be a version such as 8.4" }, 400);
    return repaint(await systemTweaksService.setPanelPhp(body.php));
  }

  if (path === "/api/firewall/rule") {
    const { portRange, source, protocol, id } = body;
    if (typeof portRange !== "string" || typeof source !== "string" || !ruleKey(portRange, source)) {
      return jsonResponse({ ok: false, error: "Port Range must be a port or a range such as 8000-8100, and Source an address or a CIDR" }, 400);
    }
    if (!FIREWALL_PROTOCOLS.includes(protocol as FirewallProtocol) || (id !== undefined && !Number.isSafeInteger(id))) {
      return jsonResponse({ ok: false, error: "a protocol of tcp, udp or both is required" }, 400);
    }
    return firewallReply(await systemTweaksService.setFirewallProtocol({ portRange, source, protocol: protocol as string, id: id as number | undefined }));
  }

  if (path === "/api/backup-compression") {
    if (!validBackupCompression(body)) return jsonResponse({ ok: false, error: BACKUP_COMPRESSION_ERROR }, 400);
    return repaint(await systemTweaksService.setBackupCompression(body));
  }

  if (path === "/api/login-jails") {
    const wanted: { panel?: boolean; ssh?: boolean } = {};
    for (const key of ["panel", "ssh"] as const) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== "boolean") return jsonResponse({ ok: false, error: `${key} must be true or false` }, 400);
      wanted[key] = body[key];
    }
    if (!Object.keys(wanted).length) return jsonResponse({ ok: false, error: "no jail was named" }, 400);
    return repaint(await systemTweaksService.setLoginJails(wanted));
  }

  if (path === "/api/unban") {
    if (!(LOGIN_JAILS as readonly unknown[]).includes(body.jail) || typeof body.ip !== "string" || !isIP(body.ip)) {
      return jsonResponse({ ok: false, error: "a jail and an IP address are required" }, 400);
    }
    return repaint(await systemTweaksService.unban(body.jail as string, body.ip));
  }

  return jsonResponse({ ok: false, error: "not found" }, 404);
}
