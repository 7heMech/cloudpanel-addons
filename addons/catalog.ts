/**
 * Every fact about an addon, in one place, declared beside the addon.
 *
 * The catalog is explicit and compiled in. There is no filesystem discovery:
 * this ships as a single binary, and a registry that depended on what happened
 * to be on disk would be a registry that could be wrong.
 *
 * What is *not* here: the manager and the auth gateway. They are platform, not
 * addons -- they have no config file to enable, no mount path of their own and
 * no state to keep -- and giving them addon definitions would only make the
 * catalog describe things that cannot be toggled.
 */
import { existsSync } from "node:fs";
import { TEMPLATES_DIR, addonConfigFile, addonStateDir } from "../lib/paths";
import type { AddonDefinition, AddonHandler, AddonNews, AddonSpec } from "../lib/addon-definition";
import { compareSemver } from "../lib/semver";
import { CLOUDFLARE_IPS_ADDON } from "./cloudflare-ips/addon";
import { DNS_ADDON } from "./dns/addon";
import { GIT_ADDON } from "./git/addon";
import { INSTATIC_ADDON } from "./instatic/addon";
import { MAINTENANCE_ADDON } from "./maintenance/addon";
import { PANEL_TWEAKS_ADDON } from "./panel-tweaks/addon";
import { SYSTEM_TWEAKS_ADDON } from "./system-tweaks/addon";
import { WP_TOOLS_ADDON } from "./wp-tools/addon";
import { RESOURCE_LIMITS_ADDON } from "./resource-limits/addon";
import { STAGER_ADDON } from "./stager/addon";
import { SMTP_ADDON } from "./smtp/addon";
import { TERMINAL_ADDON } from "./terminal/addon";
import { SECURITY_KEYS_ADDON } from "./security-keys/addon";

/**
 * Order is the order addons are listed and installed, and the order their
 * new-site work runs in: DNS before SMTP Relay. Keep it deliberate.
 */
const DEFINITIONS: AddonDefinition[] = [
  CLOUDFLARE_IPS_ADDON,
  DNS_ADDON,
  INSTATIC_ADDON,
  STAGER_ADDON,
  MAINTENANCE_ADDON,
  RESOURCE_LIMITS_ADDON,
  GIT_ADDON,
  PANEL_TWEAKS_ADDON,
  SYSTEM_TWEAKS_ADDON,
  WP_TOOLS_ADDON,
  SMTP_ADDON,
  TERMINAL_ADDON,
  SECURITY_KEYS_ADDON,
];

function specOf(definition: AddonDefinition): AddonSpec {
  return {
    ...definition,
    configFile: addonConfigFile(definition.name),
    stateDir: addonStateDir(definition.name),
  };
}

export const ADDONS: Record<string, AddonSpec> = Object.fromEntries(
  DEFINITIONS.map((definition) => [definition.name, specOf(definition)]),
);

export const ADDON_NAMES: string[] = DEFINITIONS.map((definition) => definition.name);

/** An addon is enabled while its config file exists. */
export function addonEnabled(spec: AddonSpec): boolean {
  return existsSync(spec.configFile);
}

/** The enabled addons, in catalog order. */
export function enabledAddons(): AddonSpec[] {
  return Object.values(ADDONS).filter(addonEnabled);
}

/** Every notice the addon declared after `since` and no later than `version`, read or not. */
export function addonNoticeKeys(name: string, version: string, since: string): string[] {
  const spec = ADDONS[name];
  if (!spec) return [];
  const pending = (release: string) => compareSemver(release, since) > 0 && compareSemver(release, version) <= 0;
  return [spec.added, ...(spec.changed ?? []).map((change) => change.in)]
    .filter((release): release is string => release !== undefined && pending(release))
    .map((release) => `${name}@${release}`);
}

/** The addon's unread notices; an unread New covers its Changed ones. */
export function addonNews(name: string, version: string, since: string, seen: readonly string[] = []): AddonNews | null {
  const spec = ADDONS[name];
  const keys = addonNoticeKeys(name, version, since);
  if (!spec || !keys.some((key) => !seen.includes(key))) return null;
  const newKey = spec.added ? `${name}@${spec.added}` : null;
  if (newKey && keys.includes(newKey) && !seen.includes(newKey)) return { kind: "new", keys, notes: [] };
  const unread = (spec.changed ?? [])
    .filter((change) => keys.includes(`${name}@${change.in}`) && !seen.includes(`${name}@${change.in}`))
    .sort((a, b) => compareSemver(b.in, a.in));
  return { kind: "changed", keys: unread.map((change) => `${name}@${change.in}`), notes: unread.map((change) => change.note) };
}

/** Whether an enabled addon has the platform's PHP upload-progress guard switched off. */
export function phpGuardOptedOut(): boolean {
  return enabledAddons().some((spec) => spec.phpGuardOff?.() ?? false);
}

/** The addon's manager handler, or undefined when it mounts no routes. */
export function addonHandler(name: string): AddonHandler | undefined {
  return ADDONS[name]?.handler;
}

/** Every CloudPanel template some addon injects into. */
export function templateWatchPaths(): string[] {
  const paths = new Set<string>();
  for (const spec of Object.values(ADDONS)) {
    for (const target of spec.targets) paths.add(`${TEMPLATES_DIR}/${target.template}`);
  }
  return [...paths].sort();
}

/** The installed addons with work for new sites, in catalog order. */
export function addonNewSites(installed: AddonSpec[]): AddonSpec[] {
  return installed.filter((spec) => spec.newSites !== undefined);
}

/** The installed addons with work for a certificate CloudPanel has just written, in catalog order. */
export function addonCertificates(installed: AddonSpec[]): AddonSpec[] {
  return installed.filter((spec) => spec.certificates !== undefined);
}

/** The installed addons with work for a change to ufw's rules, in catalog order. */
export function addonFirewall(installed: AddonSpec[]): AddonSpec[] {
  return installed.filter((spec) => spec.firewall !== undefined);
}

/** The installed addons that want upkeep during repair, in catalog order. */
export function addonRepairs(installed: AddonSpec[]): AddonSpec[] {
  return installed.filter((spec) => spec.repair !== undefined);
}
