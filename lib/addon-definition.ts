// What an addon declares about itself, and the shape the platform derives from it.
import type { Server } from "bun";
import type { AddonTarget } from "./addon-target";

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
  /** Changes an operator must know about, such as moved settings or new effects on sites, each shown as Changed on the same terms as `added`; not for layout or speed. */
  changed?: { in: string; note: string }[];
  targets: AddonTarget[];
  /** The manager routes this addon mounts, if it has any. */
  handler?: AddonHandler;
  /** The privileged verbs this addon runs as root, if it has any. */
  action?: (argv: string[], options?: Record<string, unknown>) => Promise<number> | number;
  /** Withdraw changes outside addon state before disabling. */
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
  /** Work after ufw's rule files change, which CloudPanel's Firewall page rebuilds. */
  firewall?: AddonHook;
}

/**
 * The addon's platform-facing shape: the definition plus the paths the platform
 * derives from its name. Kept as a distinct type because provisioning, repair
 * and disable care about the files, not about the handler.
 */
export interface AddonSpec extends AddonDefinition {
  configFile: string;
  stateDir: string;
}

/** What the Addons page says is new about an addon until it is read. */
export interface AddonNews {
  kind: "new" | "changed";
  /** The notices the badge stands for, such as `dns@2.0.0-rc.1`; reading the badge reads them all. */
  keys: string[];
  /** What changed, newest first. */
  notes: string[];
}
