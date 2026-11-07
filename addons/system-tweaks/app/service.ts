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

/** Every on/off switch's verb, and how long its change may take when that is longer than the default. */
const SWITCH_TIMEOUTS = {
  "set-upload-guard": undefined,
  "set-real-ip": REAL_IP_GATEWAY_TIMEOUT_MS,
  "set-phpmyadmin": REAL_IP_GATEWAY_TIMEOUT_MS,
  "set-panel-cert": PANEL_CERT_GATEWAY_TIMEOUT_MS,
  "set-database-loopback": DATABASE_GATEWAY_TIMEOUT_MS,
  "set-php-pools": PHP_POOLS_GATEWAY_TIMEOUT_MS,
  "set-vhost-guard": POOL_GUARD_GATEWAY_TIMEOUT_MS,
  "set-file-manager-guard": POOL_GUARD_GATEWAY_TIMEOUT_MS,
  "set-clpctl-guard": CLPCTL_GUARD_GATEWAY_TIMEOUT_MS,
  "set-telemetry": TELEMETRY_GATEWAY_TIMEOUT_MS,
  "set-motd": undefined,
} satisfies Partial<Record<WebVerb<"system-tweaks">, number | undefined>>;

export type SwitchVerb = keyof typeof SWITCH_TIMEOUTS;

export function isSwitchVerb(verb: string): verb is SwitchVerb {
  return Object.hasOwn(SWITCH_TIMEOUTS, verb);
}

export const systemTweaksService = {
  setSwitch(verb: SwitchVerb, enabled: boolean): Promise<ActionResult<SystemTweaksState>> {
    return call(verb, JSON.stringify({ enabled }), SWITCH_TIMEOUTS[verb]);
  },

  state(): Promise<ActionResult<SystemTweaksState>> {
    return call("state");
  },

  setUpdates(wanted: Record<string, boolean | string>): Promise<ActionResult<SystemTweaksState>> {
    return call("set-updates", JSON.stringify(wanted));
  },

  installUpdates(): Promise<ActionResult<SystemTweaksState>> {
    return call("install-updates", undefined, INSTALL_GATEWAY_TIMEOUT_MS);
  },

  setPanelPhp(php: string): Promise<ActionResult<SystemTweaksState>> {
    return call("set-panel-php", JSON.stringify({ php }), PANEL_PHP_GATEWAY_TIMEOUT_MS);
  },

  firewall(): Promise<ActionResult<FirewallStatus>> {
    return callGatewayAction("system-tweaks", "firewall", []);
  },

  setFirewallProtocol(rule: { portRange: string; source: string; protocol: string; id?: number }): Promise<ActionResult<FirewallStatus>> {
    return callGatewayAction("system-tweaks", "set-firewall-protocol", [], JSON.stringify(rule));
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

  /** Answers with the saved settings; the page comes from `state()`. */
  setBackupCompression(settings: BackupCompressionSettings): Promise<ActionResult<SystemTweaksState>> {
    return call("set-backup-compression", JSON.stringify(settings), BACKUP_COMPRESSION_GATEWAY_TIMEOUT_MS);
  },

};
