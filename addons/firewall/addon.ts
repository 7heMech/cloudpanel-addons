import { handle } from "./app/index";
import {
  DEFAULT_CLOUDFLARE_ACTION_PATHS, reconcileNewSites, runFirewallAction, type CloudflareActionPaths,
} from "./action";
import { FIREWALL_TARGETS } from "./inject/targets";
import { syncFirewall } from "./protocols";
import { syncHetzner } from "./hetzner";
import { keepNetcupTimeSync, syncNetcup } from "./netcup";
import { FIREWALL_ACTIONS, FIREWALL_SETUP } from "./setup";
import { keepPanelGateNginx, panelGateOffLocally, repairPanelGate, withdrawPanelGate } from "./panel-gate";
import {
  DEFAULT_VISITOR_IP_PATHS, UNTRUSTED_LOOPBACK, VISITOR_IP, keepVisitorIp, releaseVisitorIp, restoreVisitorIp, withdrawVisitorIp,
} from "./visitor-ip";
import { CLI_BIN } from "../../lib/paths";
import { runCommand } from "../../lib/command";
import type { AddonDefinition } from "../../lib/addon-definition";
import { errorMessage } from "../../lib/errors";
import { fatal, log } from "../../lib/log";

async function protectNewSites(options?: Record<string, unknown>): Promise<string | null> {
  const paths = { ...DEFAULT_CLOUDFLARE_ACTION_PATHS, ...(options?.paths as Partial<CloudflareActionPaths> | undefined) };
  const result = await reconcileNewSites(paths);
  for (const failure of result.failed) log.warn(`Firewall: ${failure.error}`);
  return result.enabled ? `${result.enabled} new site${result.enabled === 1 ? "" : "s"} allow Cloudflare only` : null;
}

/**
 * Disabling is synchronous and Cloudflare is not, so the gate's Cloudflare
 * objects are deleted by the root action in a child process while the addon's
 * config still exists. What it cannot delete waits for a repair after
 * Firewall is enabled again.
 */
function cleanUpPanelGateNow(): void {
  const result = runCommand(CLI_BIN, ["action", "firewall", "panel-gate-cleanup"], 120_000);
  let reply: { ok?: boolean; error?: string } = {};
  try { reply = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}"); } catch { /* reported below */ }
  if (!result.ok || reply.ok === false) {
    log.warn(`the Panel gate is off, but ${reply.error ?? (result.stderr.trim() || "its Cloudflare objects could not be deleted")}`);
  }
}

/** Repair: new sites, the protocols, the Panel gate, then the Hetzner firewalls and netcup policies, each whatever the others do. */
async function repair(options?: Record<string, unknown>): Promise<string | null> {
  const lines: string[] = [];
  const failures: string[] = [];
  try {
    const line = await protectNewSites(options);
    if (line) lines.push(line);
  } catch (error) { failures.push(`Cloudflare-only sites: ${errorMessage(error)}`); }
  try {
    const changed = keepVisitorIp();
    if (changed) lines.push(changed);
  } catch (error) { failures.push(`Cloudflare visitor IPs: ${errorMessage(error)}`); }
  try {
    const changed = syncFirewall("apply");
    if (changed) lines.push(`protocols: ${changed}`);
  } catch (error) { failures.push(`protocols: ${errorMessage(error)}`); }
  try {
    const changed = await repairPanelGate();
    if (changed) lines.push(changed);
  } catch (error) { failures.push(errorMessage(error)); }
  for (const sync of [syncHetzner, syncNetcup]) {
    try {
      const changed = await sync("repair");
      if (changed) lines.push(changed);
    } catch (error) { failures.push(errorMessage(error)); }
  }
  if (failures.length) throw new Error([...failures, ...lines].join("; "));
  return lines.join("; ") || null;
}

export const FIREWALL_ADDON: AddonDefinition = {
  name: "firewall",
  title: "Firewall",
  description: "Cloudflare-only access and real visitor IPs for every site, a Cloudflare Access gate in front of the panel, Hetzner Cloud or netcup firewalls that admit only Cloudflare, and TCP, UDP or both for each rule on CloudPanel's Firewall page.",
  docs: "docs/firewall.md",
  changed: [
    { in: "2.3.0-rc.1", note: "Cloudflare connections are now shared with DNS and can be managed directly on the Panel gate tab without enabling DNS. Root can now lock Firewall with clp-addons lock firewall." },
    { in: "2.3.0-rc.1", note: "Cloudflare visitor IPs moved here from System Tweaks and are on by default. Enabling Firewall points Nginx's access logs and PHP's REMOTE_ADDR (FastCGI) at the visitor's IP. Where System Tweaks applied visitor IPs, the upgrade enables Firewall to keep them with Enable on new sites off, and carries a System Tweaks root lock to Firewall so visitor IPs stays locked." },
    { in: "2.2.0-rc.3", note: "Firewall now splits into Cloudflare only, Panel gate, Protocols and Cloud firewall tabs. Cloud provider cards are hidden when the server is not on that host and has no saved token." },
    { in: "2.2.0-rc.1", note: "Cloudflare IP Access is now Firewall, which also sets each firewall rule's protocol: TCP, UDP or both." },
    { in: "2.2.0-rc.1", note: "On a Hetzner Cloud server, Firewall can attach Hetzner Cloud Firewalls that let only Cloudflare reach the sites (80, 443) and the panel (8443). Both switches are off until you connect a token and turn one on; off keeps those ports open to anyone." },
    { in: "2.2.0-rc.1", note: "Panel gate, off by default: CloudPanel answers only at its custom domain through Cloudflare, after a Cloudflare Access sign-in, and no longer at the server's IP on port 8443. It needs DNS's token to hold three more permissions. Disabling Firewall turns the gate off." },
    { in: "2.2.0-rc.3", note: "On a netcup server, Firewall can put netcup firewall policies on it that let only Cloudflare reach the sites (80, 443) and the panel (8443). Both switches are off until you connect netcup and turn one on. While any of its policies is on the server, systemd-timesyncd syncs only with time.cloudflare.com and ptbtime1.ptb.de, the NTP servers whose replies the policies let in." },
  ],
  targets: FIREWALL_TARGETS,
  setup: FIREWALL_SETUP,
  actionNeeded: FIREWALL_ACTIONS,
  handler: handle,
  action: runFirewallAction,
  newSites: { label: "Cloudflare-only sites", run: protectNewSites },
  // A site whose vhost was not ready when it was created is tried again here.
  repair: { label: "firewall", run: repair },
  firewall: { label: "firewall protocols", run: () => syncFirewall("apply") },
  // The anchor watcher sees CloudPanel's daily rewrite of /etc/nginx/cloudflare/ips.
  anchors: [
    { label: "Cloudflare visitor IPs", run: () => keepVisitorIp() },
    { label: "Panel gate", run: () => keepPanelGateNginx() },
    { label: "Hetzner firewalls", run: () => syncHetzner("ranges") },
    { label: "netcup policies", run: () => syncNetcup("ranges") },
  ],
  conffiles: [
    { path: DEFAULT_VISITOR_IP_PATHS.nginxConf, marker: [VISITOR_IP, UNTRUSTED_LOOPBACK], release: () => releaseVisitorIp("nginxConf") },
    { path: DEFAULT_VISITOR_IP_PATHS.fastcgiParams, marker: VISITOR_IP, release: () => releaseVisitorIp("fastcgiParams") },
  ],
  commands: {
    firewall: {
      usage: "firewall panel-gate off",
      root: true,
      run: async (argv) => {
        if (argv.join(" ") !== "panel-gate off") fatal("usage: clp-addons firewall panel-gate off");
        log.plain(await panelGateOffLocally());
      },
    },
  },
  // CloudPanel's next change on its Firewall page rebuilds ufw without these rules anyway.
  deactivate: () => {
    try { withdrawVisitorIp(); }
    catch (error) { log.warn(`Cloudflare visitor IPs could not be withdrawn: ${errorMessage(error)}`); }
    try { syncFirewall("withdraw"); }
    catch (error) { log.warn(`ufw still has UDP rules from Firewall: ${errorMessage(error)}`); }
    try {
      if (withdrawPanelGate()) cleanUpPanelGateNow();
    } catch (error) { log.warn(`the Panel gate's Nginx lines stay; run clp-addons firewall panel-gate off: ${errorMessage(error)}`); }
  },
  activate: () => {
    try { restoreVisitorIp(); }
    catch (error) { log.warn(`Cloudflare visitor IPs wait for the next repair: ${errorMessage(error)}`); }
    try { syncFirewall("restore"); }
    catch (error) { log.warn(`firewall protocols wait for the next repair: ${errorMessage(error)}`); }
    // Only a gate still on, as on a re-run of the installer; disabling turned it off.
    try { keepPanelGateNginx(); }
    catch (error) { log.warn(`the Panel gate waits for the next repair: ${errorMessage(error)}`); }
    try { keepNetcupTimeSync(); }
    catch (error) { log.warn(`netcup time sync waits for the next repair: ${errorMessage(error)}`); }
  },
};
