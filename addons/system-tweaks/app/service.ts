import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import type { WebVerb } from "../../../lib/gateway-protocol";
import { TWEAKS, type SystemTweaksState } from "../registry";
import type { BackupCompressionSettings } from "../backup-compression";
import type { FirewallStatus } from "../firewall";
import {
  BACKUP_COMPRESSION_GATEWAY_TIMEOUT_MS, INSTALL_GATEWAY_TIMEOUT_MS, LOCK_SETTINGS_GATEWAY_TIMEOUT_MS, LOGIN_JAILS_GATEWAY_TIMEOUT_MS, PANEL_PHP_GATEWAY_TIMEOUT_MS,
} from "../limits";

function call(verb: WebVerb<"system-tweaks">, input?: string, timeout?: number): Promise<ActionResult<SystemTweaksState>> {
  return callGatewayAction("system-tweaks", verb, [], input, timeout ? { timeout } : undefined);
}

type Switching = Extract<(typeof TWEAKS)[number], { switch: unknown }>;
type SwitchVerb = Switching["switch"]["verb"];

/** Every on/off switch's verb, and how long its change may take when that is longer than the default. */
const SWITCH_TIMEOUTS = new Map<string, number | undefined>(
  TWEAKS.flatMap((tweak) => "switch" in tweak ? [[tweak.switch.verb, "timeout" in tweak.switch ? tweak.switch.timeout : undefined] as const] : []),
);

export function isSwitchVerb(verb: string): verb is SwitchVerb {
  return SWITCH_TIMEOUTS.has(verb);
}

export const systemTweaksService = {
  setSwitch(verb: SwitchVerb, enabled: boolean): Promise<ActionResult<SystemTweaksState>> {
    return call(verb, JSON.stringify({ enabled }), SWITCH_TIMEOUTS.get(verb));
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

  /** Every lockable switch on, then root's lock; the page comes from its reply. */
  lockSettings(): Promise<ActionResult<SystemTweaksState>> {
    return call("lock-settings", undefined, LOCK_SETTINGS_GATEWAY_TIMEOUT_MS);
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
