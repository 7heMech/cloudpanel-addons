import type { Server } from "bun";
import type { AddonTarget } from "./addon-target";
import type { PanelHold } from "./panel-holds";

export type AddonHandler = (
  req: Request,
  path: string,
  updateNotice?: { current: string; latest: string } | null,
  server?: Server<unknown> | null,
  /** The session behind the request, for the few routes a non-admin reaches. */
  auth?: { user: string; roles: string[] } | null,
) => Promise<Response>;

export interface AddonHook {
  /** How it is named when it reports or fails. */
  label: string;
  /** Returns a line worth printing, or null when there was nothing to do. */
  run: (options?: Record<string, unknown>) => string | null | Promise<string | null>;
}

interface AddonNewSites extends AddonHook {
  /**
   * Run on every wake of the new-site watcher for an hour after the sites last
   * changed: queues what a new site's latest step of creation allows, and says
   * whether one still waits for a later step. While one does, the watcher
   * keeps waking on panel writes.
   */
  resumePending?: (options?: Record<string, unknown>) => Promise<{ waiting: boolean; line: string | null }>;
}

interface AddonCommand {
  /** Its line in `clp-addons help`, after `clp-addons `; none for a command only systemd, Postfix or the gateway runs. */
  usage?: string;
  /** Refused to anyone but root, before anything else is checked. */
  root?: true;
  /** Refused while the addon is disabled. */
  enabledOnly?: true;
  run: (argv: string[]) => number | void | Promise<number | void>;
}

/** An edit the addon makes to a dpkg conffile, which an unattended upgrade must find as the package left it. */
export interface ConffileEdit {
  path: string;
  /** Text only this project's edits leave in the file; any one of them marks it edited. */
  marker: string | readonly string[];
  /** Restores the package text without a reload; whether it wrote anything. */
  release: () => boolean;
}

/**
 * A marked block an addon keeps in a file CloudPanel owns: put in while the
 * addon is enabled and taken out when it is not, by install, update, repair,
 * the toggles and self-uninstall.
 */
interface PanelBlock {
  /** Its row in `clp-addons status`. */
  label: string;
  /** False when it could not be put right, having said why. `accept` is `repair --rebaseline`. */
  reconcile: (enabled: boolean, quiet: boolean, accept?: boolean) => boolean;
  /** What `clp-addons status` says of it while the addon is enabled, and what is held if its file changed under it. */
  inspect: () => { ok: boolean; text: string; hold?: PanelHold };
}

/** The Setup checklist's groups, in the order it shows them. */
export const SETUP_LEVELS = {
  domain: "Connect your domain",
  secure: "Secure the server",
  sites: "Run sites",
  provision: "Provision automatically",
} as const;
export type SetupLevel = keyof typeof SETUP_LEVELS;

export interface SetupCheck {
  state: "done" | "todo" | "na";
  /** One line: what was found, or what is missing. */
  reason: string;
}

/** A step the Setup checklist suggests; an administrator may skip any. */
export interface SetupStep {
  /** Unique across addons; a skip is remembered by it. */
  id: string;
  level: SetupLevel;
  title: string;
  /** The page, and card, that sets it up. */
  href: string;
  /** Run as root on every addon page an administrator opens, so it reads local state only. */
  check: (options?: Record<string, unknown>) => SetupCheck | Promise<SetupCheck>;
  /** Also checked while the addon is off, for a step that can be done without it. */
  whileOff?: true;
}

/** Paths are derived from `name`, not declared. */
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
  handler?: AddonHandler;
  /** The privileged verbs this addon runs as root. */
  action?: (argv: string[], options?: Record<string, unknown>) => Promise<number> | number;
  /** Whether the operator switched the platform's PHP upload-progress guard off in this addon. */
  phpGuardOff?: () => boolean;
  /** The mode of its state directory, 0750 unless something outside the addon must reach into it. */
  stateDirMode?: number;
  /** Withdraw changes outside addon state before disabling. */
  deactivate?: () => void;
  /** Stop what is still running once the config is gone and nothing new can start. */
  withdrawn?: () => void;
  /** Reapply the kept state outside addon state once enabled; `wasEnabled` when it already was, as on a re-run of the installer. */
  activate?: (wasEnabled: boolean) => void;
  /**
   * Whether a `ROLE_SITE_MANAGER` session reaches this addon's routes.
   * CloudPanel does not narrow that role's site list, so an addon whose pages
   * are about sites is already the right page for it.
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
  /** Work `repair --anchors-only` runs when CloudPanel rewrites a file the anchor watcher sees, each step reported on its own. */
  anchors?: AddonHook[];
  panelBlock?: PanelBlock;
  /** What the Setup checklist suggests for this addon; listed with Enable while it is off. */
  setup?: SetupStep[];
  /** The conffile edits `apt-hook pre` hands back to dpkg before an unattended upgrade. */
  conffiles?: ConffileEdit[];
  /** Top-level commands, by name, such as `maintenance` or ones systemd runs. */
  commands?: Record<string, AddonCommand>;
  /**
   * Disabling, when it must hold the addon's own locks: takes out what the addon
   * put into sites and calls `removeConfig` while it still holds them, so nothing
   * waiting on them starts again in a site the addon has just left.
   */
  withdraw?: (removeConfig: () => void) => void;
}

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
