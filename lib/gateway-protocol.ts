// Protocol definitions for the root gateway daemon.
// This module has zero imports and zero cyclical dependencies.

export const GATEWAY_SOCKET_PATH = "/run/clp-addons/auth.sock";
export const DEFAULT_CLI_BIN = "/usr/local/bin/clp-addons";
export const MAX_GATEWAY_INPUT_BYTES = 1024 * 1024; // 1 MB max input (for clone credentials, etc.)
export const DEFAULT_GATEWAY_TIMEOUT_MS = 60_000;

export const STAGER_ALLOWED_VERBS = new Set([
  "sites",
  "clone",
  "promote",
  "describe",
  "jobs",
  "prune",
  "job",
  "watch-job",
]);

export const INSTATIC_ALLOWED_VERBS = new Set([
  "list",
  "create",
  "update",
  "delete",
  "start",
  "stop",
  "restart",
  "recreate",
  "snapshot",
  "status",
  "logs",
  "job",
  "jobs",
  "watch-job",
]);

/**
 * `run` and `prune` are deliberately absent. `run` is the deployment runner,
 * started only by the transient unit the deploy path launches, and `prune` is
 * retention sweeping the repair timer owns.
 */
export const GIT_ALLOWED_VERBS = new Set([
  "sites",
  "domains",
  "status",
  "configure",
  "forget",
  "keygen",
  "webhook-enable",
  "webhook-disable",
  "hook",
  "deploy",
  "job",
  "jobs",
  "watch-job",
]);

export const MAINTENANCE_ALLOWED_VERBS = new Set([
  "status",
  "enable",
  "disable",
  "get-template",
  "set-template",
  "reset-template",
  "set-bypass",
  "global-status",
  "global-enable",
  "global-disable",
  "global-set-bypass",
]);

/**
 * `reconcile` is deliberately absent, as it is for Cloudflare IP Access: it
 * walks the whole fleet and is the repair path's to run, not a page's.
 */
export const PHP_RESOURCES_ALLOWED_VERBS = new Set([
  "list",
  "site",
  "save-category",
  "delete-category",
  "assign",
  "set-default",
]);

export const PANEL_TWEAKS_ALLOWED_VERBS = new Set([
  "state",
  "set-tweaks",
  "scan",
  "scan-stream",
]);

/**
 * WordPress Tools keeps its stable wp-login identifier. Sign-in credentials,
 * helper removal and optional Varnish installation each have a fixed verb;
 * none accepts paths, plugin names or arbitrary commands.
 */
export const WP_LOGIN_ALLOWED_VERBS = new Set([
  "sites",
  "sign-in",
  "remove",
  "varnish-settings",
  "varnish-site",
  "varnish-install",
  "varnish-sync",
]);

export const CLOUDFLARE_IPS_ALLOWED_VERBS = new Set([
  "list",
  "set",
  "policy",
]);

export const SMTP_ALLOWED_VERBS = new Set([
  "list", "save-profile", "delete-profile", "assign", "set-default", "save-grants", "test",
]);

/**
 * The manager's own privileged verbs: enabling and disabling an addon that
 * already ships inside this binary, and replacing the binary itself.
 *
 * `run` is deliberately absent. It is the job runner, and the only thing
 * allowed to start it is the transient systemd unit that the create path
 * launches, which is what makes "one click, one job" enforceable: reaching
 * `run` through the gateway would bypass the create path's duplicate check.
 */
export const MANAGER_ALLOWED_VERBS = new Set([
  "enable",
  "disable",
  "update",
  "job",
  "watch-job",
  // Rendering the panel's templates again. It belongs to the manager rather
  // than to an addon because one pass regenerates every addon's block in a
  // shared file; an addon that reconciled only its own would strip the others.
  "reconcile",
]);

/**
 * One verb: a shell as a site's user. The gateway checks the session itself
 * before running it, rather than trusting the manager; see
 * docs/decisions/terminal.md.
 */
export const TERMINAL_ALLOWED_VERBS = new Set(["session"]);

export const STREAM_ALLOWED_VERBS = new Set(["watch-job", "scan-stream", "session"]);

/**
 * The `addon:verb` pairs whose socket carries bytes both ways. Only these
 * accept, and require, the CloudPanel session id the gateway checks itself;
 * every other stream ignores what the manager sends after its request line.
 */
export const DUPLEX_STREAM_VERBS = new Set(["terminal:session"]);

/**
 * Set in the environment of a worker the gateway started for a duplex stream,
 * after checking its session. A duplex worker refuses to run without it.
 */
export const DUPLEX_WORKER_MARKER = "CLP_ADDONS_DUPLEX_WORKER";

export interface SanitizedSite {
  domain: string;
  user: string;
  type: string;
  /**
   * Whether CloudPanel has Varnish enabled for this site. Optional because it
   * decides only whether a site-scoped addon page draws the panel's Varnish
   * Cache tab, and an older gateway that does not send it should leave the tab
   * out rather than guess it into the strip.
   */
  varnishCache?: boolean;
}

export interface PanelSnapshot {
  updatedAt: string;
  portRange: { min: number; max: number };
  allocatedPorts: number[];
  sites: SanitizedSite[];
  /**
   * The instance address CloudPanel shows in its own site information, when the
   * panel has one recorded. Optional for the same reason: an addon omits the
   * field rather than print an address the panel itself would not.
   */
  publicIp?: string;
}

export type PanelInfo = PanelSnapshot;

export type GatewayRequest =
  | { kind: "auth"; sessionId: string }
  | { kind: "panel-info" }
  | {
      kind: "action";
      addon: string;
      verb: string;
      args?: string[];
      input?: string;
      timeoutMs?: number;
    }
  | { kind: "stream-action"; addon: string; verb: string; args?: string[]; sessionId?: string };

export interface ActionResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export type GatewayResponse<T = unknown> = ActionResult<T>;

/**
 * Parses an incoming line from the gateway socket.
 * Supports both JSON request frames and legacy raw `<sessionId>\n` lines.
 * Only the first line is the request; what follows it is never parsed here.
 */
export function parseGatewayRequest(raw: string): GatewayRequest | null {
  const newline = raw.indexOf("\n");
  const trimmed = (newline < 0 ? raw : raw.slice(0, newline)).trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj !== "object" || obj === null) return null;
      if (obj.kind === "auth" && typeof obj.sessionId === "string") {
        return { kind: "auth", sessionId: obj.sessionId };
      }
      if (obj.kind === "panel-info") {
        return { kind: "panel-info" };
      }
      if (
        obj.kind === "action" &&
        typeof obj.addon === "string" &&
        typeof obj.verb === "string"
      ) {
        return {
          kind: "action",
          addon: obj.addon,
          verb: obj.verb,
          args: Array.isArray(obj.args) ? obj.args.filter((a: unknown) => typeof a === "string") : undefined,
          input: typeof obj.input === "string" ? obj.input : undefined,
          timeoutMs: typeof obj.timeoutMs === "number" ? obj.timeoutMs : undefined,
        };
      }
      if (
        obj.kind === "stream-action" &&
        typeof obj.addon === "string" &&
        typeof obj.verb === "string"
      ) {
        return {
          kind: "stream-action",
          addon: obj.addon,
          verb: obj.verb,
          args: Array.isArray(obj.args) ? obj.args.filter((a: unknown) => typeof a === "string") : undefined,
          ...(typeof obj.sessionId === "string" ? { sessionId: obj.sessionId } : {}),
        };
      }
    } catch {
      return null;
    }
  }

  // Fallback: legacy raw sessionId line
  if (/^[a-zA-Z0-9,-]{1,128}$/.test(trimmed)) {
    return { kind: "auth", sessionId: trimmed };
  }

  return null;
}
