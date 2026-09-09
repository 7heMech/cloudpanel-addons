// Every path the installer touches, in one place, so an audit of "what does
// this write as root" is a single file.

import { INSTATIC_TARGETS } from "../addons/instatic/inject/targets";
export { mountPath } from "../lib/mount";
import { STAGER_TARGETS } from "../addons/stager/inject/targets";

export const REPO = "7heMech/cloudpanel-addons";

/** Immutable release directories plus a `current` symlink, so rollback is a symlink swap. */
export const LIB_DIR = "/usr/local/lib/clp-addons";
export const RELEASES_DIR = `${LIB_DIR}/releases`;
export const CURRENT_LINK = `${LIB_DIR}/current`;

/** The CLI itself, bootstrapped once by the installer then self-updating. */
export const CLI_BIN = "/usr/local/bin/clp-addons";
/**
 * A private copy of the GitHub CLI, placed by install.sh when the box has no gh
 * that can verify attestations. Deliberately not on PATH and deliberately not
 * an apt repository: adding cli.github.com to a panel host's sources changes
 * what every later `apt upgrade` pulls, which is a far larger footprint than
 * one verification justifies.
 */
export const GH_PRIVATE = `${LIB_DIR}/gh`;

/**
 * The one compiled binary this project ships.
 *
 * It is the CLI and every addon's manager in a single artifact, selected by
 * `clp-addons serve <addon>`. Three binaries meant three copies of the Bun
 * runtime: 77.5 MB each, carrying 56 KB, 28 KB and 24 KB of actual code, for a
 * 244 MB download where 81 MB does the same job. Each addon added cost another
 * 77.6 MB rather than a few tens of KB.
 */
export const CLI_ARTIFACT = "clp-addons-linux-x64";

/**
 * The one manager service, and the one loopback port it binds.
 *
 * Every addon used to get a CloudPanel site of its own, which meant a hostname,
 * a certificate, a Basic Auth setup and a site user each. That is four manual
 * steps per addon before the thing is safe to expose, and the isolation it
 * bought -- one compromised manager reaching one wrapper rather than both -- is
 * not worth an operator skipping any of them. So there is one site, one service
 * and one account, and the addons are mounted under it by path.
 *
 * Path routing lives here rather than in nginx because CloudPanel's stock
 * reverse-proxy vhost has exactly one {{reverse_proxy_url}}, and there is no
 * clpctl verb that changes an existing site's vhost -- so a second addon could
 * not be added later without writing site.vhost_template by hand. One process
 * on one port needs none of that.
 */
export const MANAGER_UNIT = "clp-addons.service";
export const MANAGER_PORT = 38080;



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

/**
 * Group that owns the sanitized panel snapshot.
 *
 * The snapshot was `root:<that addon's site user>` 0640, which was correct for
 * exactly one addon and silently wrong for two: installing the second addon
 * chowned the file to its own user and the first addon's app lost the site list
 * it allocates ports against. A system group every addon's site user joins is
 * the smallest thing that fixes it, and the file's contents -- the panel's
 * non-secret site list -- do not justify anything more elaborate.
 */
export const SHARED_GROUP = "clp-addons";

export const CONFIG_DIR = "/etc/clp-addons";
/**
 * The platform's own config: the shared hostname, the manager port and the
 * account it runs as. The per-addon files beside it mark which addons are
 * installed and give each wrapper its own copy of OWN_DOMAIN; this one is the
 * source of truth those are written from, so uninstalling an addon cannot take
 * the platform's hostname with it.
 */
export const PLATFORM_CONFIG = `${CONFIG_DIR}/platform.conf`;
/**
 * The manager's own credential, scrypt-hashed. root:<run-as> 0640, because the
 * service reads it on every request and nothing else has any business doing so.
 * Its absence is what makes the manager refuse to serve, so it is deliberately
 * not created by anything except provisioning.
 */
export const MANAGER_AUTH_FILE = `${CONFIG_DIR}/manager-auth`;
export const STATE_DIR = "/var/lib/clp-addons";
/**
 * Written when this installer created the shared CloudPanel site, so
 * `uninstall --purge` can tell a site it made from one it adopted. Platform
 * level, like the site: it used to sit under whichever addon happened to be
 * installed first, which stopped being meaningful once they shared one.
 */
export const SITE_CREATED_MARKER = `${STATE_DIR}/.site-created-by-addons`;
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
  /** Wrapper script, shipped as-is and never compiled (decision 2.13). */
  wrapperArtifact: string;
  /** Absolute path the sudoers line names. Must match exactly. */
  wrapperPath: string;
  /**
   * Marks the addon installed, and is what its wrapper reads OWN_DOMAIN from.
   * Every one of these carries the same hostname now: there is one site.
   */
  configFile: string;
  /**
   * systemd units that must already be running for this addon to work.
   *
   * Per addon rather than a fixed check in `install`, which required Docker for
   * anything: the Stager addon drives clpctl and tar and would have been
   * refused on a box with no Docker at all, for a dependency it does not have.
   */
  requiresUnits?: string[];
  stateDir: string;
  /**
   * A wrapper verb `repair` calls on every reconciliation, or nothing.
   *
   * Housekeeping an addon needs on a schedule rather than on demand. The Stager
   * addon's job records hold the staging database password, so they expire --
   * and something has to actually run the expiry. The reconciliation timer is
   * already the thing that runs every fifteen minutes; giving the addon a
   * second timer of its own would be two answers to one question.
   */
  maintenanceVerb?: string;
  /** Panel templates this addon patches. */
  targets: AddonTarget[];
}

export const ADDONS: Record<string, AddonSpec> = {
  instatic: {
    name: "instatic",
    wrapperArtifact: "clp-action-instatic",
    wrapperPath: `${LIB_DIR}/clp-action-instatic`,
    configFile: `${CONFIG_DIR}/instatic.conf`,
    requiresUnits: ["docker"],
    stateDir: `${STATE_DIR}/instatic`,
    targets: INSTATIC_TARGETS,
  },
  stager: {
    name: "stager",
    wrapperArtifact: "clp-action-stager",
    wrapperPath: `${LIB_DIR}/clp-action-stager`,
    configFile: `${CONFIG_DIR}/stager.conf`,
    stateDir: `${STATE_DIR}/stager`,
    maintenanceVerb: "prune",
    targets: STAGER_TARGETS,
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

/**
 * Units from before the addons shared one manager.
 *
 * Each addon had a service of its own, ExecStarting `serve <addon>`. That verb
 * takes no argument now, so a leftover unit does not merely sit idle -- it has
 * Restart=always, so it fails and respawns forever, filling the journal and
 * making `systemctl --failed` useless for spotting anything real. Removed on
 * install and on repair, the same way the account they ran as is.
 */
export const LEGACY_UNITS = ["clp-addon-instatic.service", "clp-addon-stager.service"];
