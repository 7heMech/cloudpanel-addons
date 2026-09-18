/**
 * Every fact about an addon, in one place, declared beside the addon.
 *
 * Adding an addon used to mean editing unrelated modules: the registry in
 * `cli/paths.ts`, the handler map in `cli/index.ts`, the action conditionals in
 * `cmdAction`, and repair's hardcoded per-addon upkeep calls. Four edits, in
 * four files that share nothing but the addon's name, is four chances to add
 * three of them.
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
import { CLOUDFLARE_IPS_ADDON } from "../addons/cloudflare-ips/addon";
import { INSTATIC_ADDON } from "../addons/instatic/addon";
import { LOGIN_THEME_ADDON } from "../addons/login-theme/addon";
import { MAINTENANCE_ADDON } from "../addons/maintenance/addon";
import { PHP_RESOURCES_ADDON } from "../addons/php-resources/addon";
import { REDIRECTS_ADDON } from "../addons/redirects/addon";
import { STAGER_ADDON } from "../addons/stager/addon";

export type { AddonTarget };

export type AddonHandler = (
  req: Request,
  path: string,
  updateNotice?: { current: string; latest: string } | null,
  server?: Server<unknown> | null,
) => Promise<Response>;

/** Upkeep this addon wants during `repair`. */
export interface AddonMaintenance {
  /** How it is named when it reports or fails. */
  label: string;
  /** Returns a line worth printing, or null when there was nothing to do. */
  run: (options?: Record<string, unknown>) => string | null | Promise<string | null>;
}

/** What an addon declares about itself. Paths are derived, not declared. */
export interface AddonDefinition {
  name: string;
  title: string;
  description: string;
  /** systemd units this addon cannot work without, such as `docker`. */
  requiresUnits?: string[];
  targets: AddonTarget[];
  /** The manager routes this addon mounts, if it has any. */
  handler?: AddonHandler;
  /** The privileged verbs this addon runs as root, if it has any. */
  action?: (argv: string[], options?: Record<string, unknown>) => Promise<number> | number;
  maintenance?: AddonMaintenance;
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

/** Order is the order addons are listed and installed; keep it deliberate. */
const DEFINITIONS: AddonDefinition[] = [
  CLOUDFLARE_IPS_ADDON,
  INSTATIC_ADDON,
  STAGER_ADDON,
  MAINTENANCE_ADDON,
  PHP_RESOURCES_ADDON,
  REDIRECTS_ADDON,
  LOGIN_THEME_ADDON,
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

/** The installed addons that want upkeep during repair, in catalog order. */
export function addonMaintenance(installed: AddonSpec[]): AddonSpec[] {
  return installed.filter((spec) => spec.maintenance !== undefined);
}
