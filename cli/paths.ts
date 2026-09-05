// Every path the installer touches, in one place, so an audit of "what does
// this write as root" is a single file.

export const REPO = "7heMech/cloudpanel-addons";

/** Immutable release directories plus a `current` symlink, so rollback is a symlink swap. */
export const LIB_DIR = "/usr/local/lib/clp-addons";
export const RELEASES_DIR = `${LIB_DIR}/releases`;
export const CURRENT_LINK = `${LIB_DIR}/current`;

/** The CLI itself, bootstrapped once by the installer then self-updating. */
export const CLI_BIN = "/usr/local/bin/clp-addons";

export const CONFIG_DIR = "/etc/clp-addons";
export const STATE_DIR = "/var/lib/clp-addons";
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
 * Panel templates the anchor is injected into. Watched by a systemd path unit
 * so a CloudPanel update is repaired in seconds rather than on the next timer
 * tick. Kept here rather than imported from the addon so that paths.ts stays
 * the single place that lists everything installed on the host.
 */
export const TEMPLATE_WATCH_PATHS = [
  "/home/clp/htdocs/app/files/templates/Frontend/Partial/header.html.twig",
  "/home/clp/htdocs/app/files/templates/Frontend/Site/New/index.html.twig",
];

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
  },
};

export const ADDON_NAMES = Object.keys(ADDONS);

/**
 * Account the Instatic addon used before it moved to the site user CloudPanel
 * creates. Removed on install and repair so an upgraded box does not keep a
 * stray account with a sudoers-adjacent history.
 */
export const LEGACY_USERS = ["instatic-app"];
