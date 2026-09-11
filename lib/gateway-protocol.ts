// Protocol definitions for the root gateway daemon.
// This module has zero imports and zero cyclical dependencies.

export const GATEWAY_SOCKET_PATH = "/run/clp-addons/auth.sock";
export const DEFAULT_CLI_BIN = "/usr/local/bin/clp-addons";
export const MAX_GATEWAY_INPUT_BYTES = 1024 * 1024; // 1 MB max input (for clone credentials, etc.)
export const DEFAULT_GATEWAY_TIMEOUT_MS = 60_000;

export const STAGER_ALLOWED_VERBS = new Set([
  "sites",
  "clone",
  "describe",
  "jobs",
  "prune",
  "job",
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
]);

export type GatewayRequest =
  | { kind: "auth"; sessionId: string }
  | {
      kind: "action";
      addon: string;
      verb: string;
      args?: string[];
      input?: string;
      timeoutMs?: number;
    };

export interface ActionResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export type GatewayResponse<T = unknown> = ActionResult<T>;

/**
 * Parses an incoming line from the gateway socket.
 * Supports both JSON request frames and legacy raw `<sessionId>\n` lines.
 */
export function parseGatewayRequest(raw: string): GatewayRequest | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj !== "object" || obj === null) return null;
      if (obj.kind === "auth" && typeof obj.sessionId === "string") {
        return { kind: "auth", sessionId: obj.sessionId };
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
