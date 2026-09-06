// Every path the installer touches, in one place, so an audit of "what does
// this write as root" is a single file.

import { INSTATIC_TARGETS } from "../addons/instatic/inject/targets";

export const REPO = "7heMech/cloudpanel-addons";

/** Immutable release directories plus a `current` symlink, so rollback is a symlink swap. */
export const LIB_DIR = "/usr/local/lib/clp-addons";
export const RELEASES_DIR = `${LIB_DIR}/releases`;
export const CURRENT_LINK = `${LIB_DIR}/current`;

/** The CLI itself, bootstrapped once by the installer then self-updating. */
export const CLI_BIN = "/usr/local/bin/clp-addons";

/**
 * CloudPanel's own database. Read-only, always: it is the source of truth for
 * sites and their users, and writing to it is how you corrupt a panel.
 * Here rather than in each caller so there is one path to change if CloudPanel
 * ever moves it.
 */
export const PANEL_DB = "/home/clp/htdocs/app/data/db.sq3";

/** CloudPanel's Twig templates, and the compiled cache that must be purged after patching them. */
const PANEL_APP = "/home/clp/htdocs/app/files";
export const TEMPLATES_DIR = `${PANEL_APP}/templates`;
export const TWIG_CACHE_DIR = `${PANEL_APP}/var/cache`;

export const CONFIG_DIR = "/etc/clp-addons";
export const STATE_DIR = "/var/lib/clp-addons";
/** Pristine copies of the panel templates addons patch, keyed by template. */
export const TEMPLATE_STATE_DIR = `${STATE_DIR}/templates`;
export const LOCK_DIR = "/run/lock/clp-addons";
export const SYSTEMD_DIR = "/etc/systemd/system";

export const RECONCILE_SERVICE = "clp-addons-reconcile.service";
export const RECONCILE_TIMER = "clp-addons-reconcile.timer";
export const RECONCILE_PATH = "clp-addons-anchor.path";
/**
 * The path unit's own service. Deliberately separate from the full
 * reconciliation: a CloudPanel update rewrites the templates many times while
 * it extracts, and pointing the watch at the full repair meant six wrapper
 * reinstalls, twelve visudo runs and six daemon-reloads inside twenty seconds,
 * in the middle of a package upgrade. Anchors are all the watch needs to fix.
 */
export const ANCHOR_SERVICE = "clp-addons-anchor.service";

/**
 * One patch an addon wants applied to a CloudPanel template.
 *
 * The addon supplies markup and where it goes; the injector owns the markers,
 * the pristine snapshot and the ordering. Declaring targets here rather than
 * having the CLI import an addon's module is what lets a second addon be a
 * registry entry plus its own files.
 */
export interface AddonTarget {
  slug: string;
  /**
   * Template path relative to CloudPanel's templates directory, e.g.
   * `Frontend/Partial/header.html.twig`. Relative because an addon should not
   * need to know where CloudPanel keeps its templates -- the injector resolves
   * it -- and because a value import from here back into an addon would close
   * an import cycle through the registry.
   */
  template: string;
  /** Literal markup the snippet is inserted immediately after. */
  anchorAfter: string;
  /** Markup only. The injector wraps it in markers naming the addon. */
  snippet: (addonUrl: string) => string;
  /** A missing nav entry means the feature is unreachable; a card is a nicety. */
  required: boolean;
}

export interface AddonSpec {
  name: string;
  /** Compiled service binary, as named in the release. */
  appArtifact: string;
  /** Wrapper script, shipped as-is and never compiled (decision 2.13). */
  wrapperArtifact: string;
  /** Absolute path the sudoers line names. Must match exactly. */
  wrapperPath: string;
  unit: string;
  configFile: string;
  /** Loopback port for the service. Outside the instance range on purpose. */
  port: number;
  stateDir: string;
  /** Panel templates this addon patches. */
  targets: AddonTarget[];
}

export const ADDONS: Record<string, AddonSpec> = {
  instatic: {
    name: "instatic",
    appArtifact: "instatic-app-linux-x64",
    wrapperArtifact: "clp-action-instatic",
    wrapperPath: `${LIB_DIR}/clp-action-instatic`,
    unit: "clp-addon-instatic.service",
    configFile: `${CONFIG_DIR}/instatic.conf`,
    // Instances get 39000-39999 (decision 2.11); the manager itself sits
    // outside that block so it can never collide with one.
    port: 38080,
    stateDir: `${STATE_DIR}/instatic`,
    targets: INSTATIC_TARGETS,
  },
};

export const ADDON_NAMES = Object.keys(ADDONS);

/**
 * Panel templates the systemd path unit watches, so a CloudPanel update is
 * repaired in seconds rather than on the next timer tick.
 *
 * Derived from the registry rather than written out by hand. It used to be a
 * literal list of Instatic's two templates, which was correct only for as long
 * as Instatic was the only addon: a second addon patching a third template got
 * no fast repair, and nothing connected the two lists so nothing would have said
 * so. Deduplicated, because two addons patching one template is the normal case.
 */
export function templateWatchPaths(): string[] {
  const paths = new Set<string>();
  for (const spec of Object.values(ADDONS)) {
    for (const t of spec.targets) paths.add(`${TEMPLATES_DIR}/${t.template}`);
  }
  return [...paths].sort();
}

/**
 * Account the Instatic addon used before it moved to the site user CloudPanel
 * creates. Removed on install and repair so an upgraded box does not keep a
 * stray account with a sudoers-adjacent history.
 */
export const LEGACY_USERS = ["instatic-app"];
