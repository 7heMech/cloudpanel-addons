import type { SetupCheck, SetupStep } from "../../lib/addon-definition";
import { loginJailsStatus, PANEL_JAIL, type LoginJailsStatus } from "./login-jails";
import { panelCertStatus, type PanelCertStatus } from "./panel-cert";
import { phpMyAdminStatus, type PhpMyAdminStatus } from "./phpmyadmin";
import { realIpStatus, type RealIpStatus } from "./real-ip";
import { updatesStatus, type UpdatesStatus } from "./updates";

const PAGE = "/addons/system-tweaks/";

export function panelCertCheck(status: PanelCertStatus): SetupCheck {
  if (status.problem) return { state: "todo", reason: status.problem };
  if (status.kind === "unknown") return { state: "na", reason: "No panel certificate CloudPanel serves on 8443 was found" };
  if (status.kind === "shared") return { state: "todo", reason: "The panel serves the certificate every CloudPanel ships with" };
  return { state: "done", reason: status.kind === "own" ? "The panel serves a certificate of its own" : "The panel serves a certificate made for this server" };
}

export function loginJailsCheck(status: LoginJailsStatus): SetupCheck {
  if (status.panelLog === null) return { state: "na", reason: "This CloudPanel has no panel Nginx to watch" };
  if (status.missing.length) return { state: "todo", reason: `${status.missing.join(" and ")} ${status.missing.length > 1 ? "are" : "is"} not installed` };
  if (status.service !== "active") return { state: "todo", reason: "fail2ban is not running" };
  if (!status.running.includes(PANEL_JAIL) || !status.panelLog) return { state: "todo", reason: "The panel's login jail is off" };
  return { state: "done", reason: status.running.includes("sshd") ? "Failed panel and SSH logins are banned" : "Failed panel logins are banned" };
}

export function realIpCheck(status: RealIpStatus): SetupCheck {
  if (status.problem) return { state: "todo", reason: status.problem };
  return status.trustsAnyAddress
    ? { state: "todo", reason: "Any visitor can claim another address in X-Real-IP" }
    : { state: "done", reason: "X-Real-IP is trusted only from the proxies that set it" };
}

export function phpMyAdminCheck(status: PhpMyAdminStatus): SetupCheck {
  if (status.problem) return { state: "todo", reason: status.problem };
  return status.active
    ? { state: "done", reason: "phpMyAdmin answers signed-in panel users only" }
    : { state: "todo", reason: "phpMyAdmin answers anyone who reaches it" };
}

export function updatesCheck(status: Pick<UpdatesStatus, "installed" | "enabled">): SetupCheck {
  if (!status.installed) return { state: "todo", reason: "unattended-upgrades is not installed" };
  return status.enabled
    ? { state: "done", reason: "Security updates install daily" }
    : { state: "todo", reason: "Updates are installed by hand" };
}

export const SYSTEM_TWEAKS_SETUP: SetupStep[] = [
  { id: "panel-cert", level: "secure", title: "Panel certificate", href: `${PAGE}#tweak-replacePanelCert`, check: () => panelCertCheck(panelCertStatus()) },
  { id: "login-jails", level: "secure", title: "Login jails", href: `${PAGE}#st-failed-logins`, check: () => loginJailsCheck(loginJailsStatus()) },
  { id: "real-ip", level: "secure", title: "Forged visitor IPs", href: `${PAGE}#tweak-blockForgedRealIp`, check: () => realIpCheck(realIpStatus()) },
  { id: "phpmyadmin", level: "secure", title: "phpMyAdmin rules", href: `${PAGE}#tweak-protectPhpMyAdmin`, check: () => phpMyAdminCheck(phpMyAdminStatus()) },
  { id: "updates", level: "secure", title: "Automatic updates", href: `${PAGE}#st-updates`, check: () => updatesCheck(updatesStatus()) },
];
