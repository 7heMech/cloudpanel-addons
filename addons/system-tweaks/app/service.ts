import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import type { WebVerb } from "../../../lib/gateway-protocol";
import type { SystemTweaksState } from "../action";
import type { BackupCompressionSettings } from "../backup-compression";
import type { FirewallStatus } from "../firewall";
import {
  BACKUP_COMPRESSION_GATEWAY_TIMEOUT_MS, CLPCTL_GUARD_GATEWAY_TIMEOUT_MS, DATABASE_GATEWAY_TIMEOUT_MS, INSTALL_GATEWAY_TIMEOUT_MS, LOGIN_JAILS_GATEWAY_TIMEOUT_MS, PANEL_CERT_GATEWAY_TIMEOUT_MS, PANEL_PHP_GATEWAY_TIMEOUT_MS, PHP_POOLS_GATEWAY_TIMEOUT_MS, POOL_GUARD_GATEWAY_TIMEOUT_MS, REAL_IP_GATEWAY_TIMEOUT_MS, TELEMETRY_GATEWAY_TIMEOUT_MS,
} from "../limits";

function call(verb: WebVerb<"system-tweaks">, input?: string, timeout?: number): Promise<ActionResult<SystemTweaksState>> {
  return callGatewayAction("system-tweaks", verb, [], input, timeout ? { timeout } : undefined);
}

export const systemTweaksService = {
  state(): Promise<ActionResult<SystemTweaksState>> {
    return call("state");
  },

  setUpdates(wanted: Record<string, boolean | string>): Promise<ActionResult<SystemTweaksState>> {
    return call("set-updates", JSON.stringify(wanted));
  },

  installUpdates(): Promise<ActionResult<SystemTweaksState>> {
    return call("install-updates", undefined, INSTALL_GATEWAY_TIMEOUT_MS);
  },

  setUploadGuard(enabled: boolean): Promise<ActionResult<SystemTweaksState>> {
    return call("set-upload-guard", JSON.stringify({ enabled }));
  },

  setPanelPhp(php: string): Promise<ActionResult<SystemTweaksState>> {
    return call("set-panel-php", JSON.stringify({ php }), PANEL_PHP_GATEWAY_TIMEOUT_MS);
  },

  setRealIp(enabled: boolean): Promise<ActionResult<SystemTweaksState>> {
    return call("set-real-ip", JSON.stringify({ enabled }), REAL_IP_GATEWAY_TIMEOUT_MS);
  },

  setPhpMyAdmin(enabled: boolean): Promise<ActionResult<SystemTweaksState>> {
    return call("set-phpmyadmin", JSON.stringify({ enabled }), REAL_IP_GATEWAY_TIMEOUT_MS);
  },

  setPanelCert(enabled: boolean): Promise<ActionResult<SystemTweaksState>> {
    return call("set-panel-cert", JSON.stringify({ enabled }), PANEL_CERT_GATEWAY_TIMEOUT_MS);
  },

  setDatabaseLoopback(enabled: boolean): Promise<ActionResult<SystemTweaksState>> {
    return call("set-database-loopback", JSON.stringify({ enabled }), DATABASE_GATEWAY_TIMEOUT_MS);
  },

  firewall(): Promise<ActionResult<FirewallStatus>> {
    return callGatewayAction("system-tweaks", "firewall", []);
  },

  setFirewallProtocol(rule: { portRange: string; source: string; protocol: string; id?: number }): Promise<ActionResult<FirewallStatus>> {
    return callGatewayAction("system-tweaks", "set-firewall-protocol", [], JSON.stringify(rule));
  },

  setPhpPools(enabled: boolean): Promise<ActionResult<SystemTweaksState>> {
    return call("set-php-pools", JSON.stringify({ enabled }), PHP_POOLS_GATEWAY_TIMEOUT_MS);
  },

  setVhostGuard(enabled: boolean): Promise<ActionResult<SystemTweaksState>> {
    return call("set-vhost-guard", JSON.stringify({ enabled }), POOL_GUARD_GATEWAY_TIMEOUT_MS);
  },

  setFileManagerGuard(enabled: boolean): Promise<ActionResult<SystemTweaksState>> {
    return call("set-file-manager-guard", JSON.stringify({ enabled }), POOL_GUARD_GATEWAY_TIMEOUT_MS);
  },

  setLoginJails(wanted: { panel?: boolean; ssh?: boolean }): Promise<ActionResult<SystemTweaksState>> {
    return call("set-login-jails", JSON.stringify(wanted), LOGIN_JAILS_GATEWAY_TIMEOUT_MS);
  },

  installFail2ban(): Promise<ActionResult<SystemTweaksState>> {
    return call("install-fail2ban", undefined, INSTALL_GATEWAY_TIMEOUT_MS);
  },

  unban(jail: string, ip: string): Promise<ActionResult<SystemTweaksState>> {
    return call("unban", JSON.stringify({ jail, ip }));
  },

  setClpctlGuard(enabled: boolean): Promise<ActionResult<SystemTweaksState>> {
    return call("set-clpctl-guard", JSON.stringify({ enabled }), CLPCTL_GUARD_GATEWAY_TIMEOUT_MS);
  },

  setTelemetry(enabled: boolean): Promise<ActionResult<SystemTweaksState>> {
    return call("set-telemetry", JSON.stringify({ enabled }), TELEMETRY_GATEWAY_TIMEOUT_MS);
  },

  setMotd(enabled: boolean): Promise<ActionResult<SystemTweaksState>> {
    return call("set-motd", JSON.stringify({ enabled }));
  },

  /** Answers with the saved settings; the page comes from `state()`. */
  setBackupCompression(settings: BackupCompressionSettings): Promise<ActionResult<SystemTweaksState>> {
    return call("set-backup-compression", JSON.stringify(settings), BACKUP_COMPRESSION_GATEWAY_TIMEOUT_MS);
  },

};
