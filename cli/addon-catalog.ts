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
import type { Server } from "bun";
import { CONFIG_DIR, STATE_DIR, TEMPLATES_DIR } from "./paths";
import type { AddonTarget } from "../lib/addon-target";
import { compareSemver } from "../lib/semver";
import { CLOUDFLARE_IPS_ADDON } from "../addons/cloudflare-ips/addon";
import { DNS_ADDON } from "../addons/dns/addon";
import { GIT_ADDON } from "../addons/git/addon";
import { INSTATIC_ADDON } from "../addons/instatic/addon";
import { MAINTENANCE_ADDON } from "../addons/maintenance/addon";
import { PANEL_TWEAKS_ADDON } from "../addons/panel-tweaks/addon";
import { SYSTEM_TWEAKS_ADDON } from "../addons/system-tweaks/addon";
import { WP_TOOLS_ADDON } from "../addons/wp-tools/addon";
import { PHP_RESOURCES_ADDON } from "../addons/php-resources/addon";
import { STAGER_ADDON } from "../addons/stager/addon";
import { SMTP_ADDON } from "../addons/smtp/addon";
import { TERMINAL_ADDON } from "../addons/terminal/addon";
import { SECURITY_KEYS_ADDON } from "../addons/security-keys/addon";

export type { AddonTarget };

export type AddonHandler = (
  req: Request,
  path: string,
  updateNotice?: { current: string; latest: string } | null,
  server?: Server<unknown> | null,
  /** The session behind the request, for the few routes a non-admin reaches. */
  auth?: { user: string; roles: string[] } | null,
) => Promise<Response>;

/** Work an addon hands the platform to run at one of its moments. */
export interface AddonHook {
  /** How it is named when it reports or fails. */
  label: string;
  /** Returns a line worth printing, or null when there was nothing to do. */
  run: (options?: Record<string, unknown>) => string | null | Promise<string | null>;
}

/** Work for sites CloudPanel has just created. */
export interface AddonNewSites extends AddonHook {
  /**
   * Run on every wake of the new-site watcher for an hour after the sites last
   * changed: queues what a new site's latest step of creation allows, and says
   * whether one still waits for a later step. While one does, the watcher
   * keeps waking on panel writes.
   */
  resumePending?: (options?: Record<string, unknown>) => Promise<{ waiting: boolean; line: string | null }>;
}

/** What an addon declares about itself. Paths are derived, not declared. */
export interface AddonDefinition {
  name: string;
  title: string;
  description: string;
  /** systemd units this addon cannot work without, such as `docker`. */
  requiresUnits?: string[];
  /** The release it first shipped in, such as `2.0.0-rc.1`; the Addons page marks it New for boxes updated past it. */
  added?: string;
  /** What changed in one release, shown as Changed on the same terms as `added`. */
  changed?: { in: string; note: string };
  /** Ticked when the installer asks which addons to install. */
  preselected?: boolean;
  targets: AddonTarget[];
  /** The manager routes this addon mounts, if it has any. */
  handler?: AddonHandler;
  /** The privileged verbs this addon runs as root, if it has any. */
  action?: (argv: string[], options?: Record<string, unknown>) => Promise<number> | number;
  /** Withdraw changes outside addon state before disabling or uninstalling. */
  deactivate?: () => void;
  /** Stop what is still running once the config is gone and nothing new can start. */
  withdrawn?: () => void;
  /** Reapply the kept state outside addon state once enabled again. */
  activate?: () => void;
  /**
   * Whether a `ROLE_SITE_MANAGER` session reaches this addon's routes.
   *
   * CloudPanel does not narrow that role's site list, so an addon whose pages
   * are about sites is already the right page for it. Declared here because
   * who an addon is for is a fact about the addon, and the gate that reads it
   * is one place for every addon that says so.
   */
  siteManager?: boolean;
  /**
   * Routes under the mount, as `METHOD /path`, that any signed-in panel user
   * reaches. Each scopes itself: its handler decides whom it answers for and
   * calls only verbs declared `panel-user`, `site-manager` or `own-account`,
   * which the manager holds it to.
   */
  selfScopedRoutes?: string[];
  /**
   * Requests under `prefix` (of the path past `/addons`) answered before the
   * session gate, on a credential root checks. `handle` returns null to leave
   * the request to the gate, and may call only `pre-gate` verbs.
   */
  preGate?: { prefix: string; handle: (req: Request, path: string) => Promise<Response | null> };
  /** Upkeep run by `repair` and its fifteen-minute timer. */
  repair?: AddonHook;
  /** Work for sites CloudPanel has just created, run seconds after it writes their vhost. */
  newSites?: AddonNewSites;
  /** Work for sites whose certificate CloudPanel has just written. */
  certificates?: AddonHook;
}

/**
 * The addon's platform-facing shape: the definition plus the paths the platform
 * derives from its name. Kept as a distinct type because provisioning, repair
 * and uninstall care about the files, not about the handler.
 */
export interface AddonSpec extends AddonDefinition {
  configFile: string;
  stateDir: string;
}

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
  PHP_RESOURCES_ADDON,
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
    configFile: `${CONFIG_DIR}/${definition.name}.conf`,
    stateDir: `${STATE_DIR}/${definition.name}`,
  };
}

export const ADDONS: Record<string, AddonSpec> = Object.fromEntries(
  DEFINITIONS.map((definition) => [definition.name, specOf(definition)]),
);

export const ADDON_NAMES: string[] = DEFINITIONS.map((definition) => definition.name);

/** What the Addons page says is new about an addon since the box's previous release, keyed by the release that declared it. */
export interface AddonNews {
  kind: "new" | "changed";
  /** `dns@2.0.0-rc.1`: opening the addon reads this notice only. */
  key: string;
  note?: string;
}

/** The notice declared after `since` and no later than `version`; New wins over Changed. */
export function addonNews(name: string, version: string, since: string): AddonNews | null {
  const spec = ADDONS[name];
  if (!spec) return null;
  const pending = (release: string) => compareSemver(release, since) > 0 && compareSemver(release, version) <= 0;
  if (spec.added && pending(spec.added)) return { kind: "new", key: `${name}@${spec.added}` };
  if (spec.changed && pending(spec.changed.in)) return { kind: "changed", key: `${name}@${spec.changed.in}`, note: spec.changed.note };
  return null;
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

/** The installed addons that want upkeep during repair, in catalog order. */
export function addonRepairs(installed: AddonSpec[]): AddonSpec[] {
  return installed.filter((spec) => spec.repair !== undefined);
}
