// Protocol definitions for the root gateway daemon. It imports only the
// addons' verb tables, which import nothing.
import { CLOUDFLARE_IPS_VERBS } from "../addons/cloudflare-ips/verbs";
import { DNS_VERBS } from "../addons/dns/verbs";
import { GIT_VERBS } from "../addons/git/verbs";
import { INSTATIC_VERBS } from "../addons/instatic/verbs";
import { MAINTENANCE_VERBS } from "../addons/maintenance/verbs";
import { PANEL_TWEAKS_VERBS } from "../addons/panel-tweaks/verbs";
import { PHP_RESOURCES_VERBS } from "../addons/php-resources/verbs";
import { SECURITY_KEYS_VERBS } from "../addons/security-keys/verbs";
import { SMTP_VERBS } from "../addons/smtp/verbs";
import { STAGER_VERBS } from "../addons/stager/verbs";
import { SYSTEM_TWEAKS_VERBS } from "../addons/system-tweaks/verbs";
import { TERMINAL_VERBS } from "../addons/terminal/verbs";
import { WP_TOOLS_VERBS } from "../addons/wp-tools/verbs";
import { MANAGER_VERBS } from "../manager/verbs";

export const GATEWAY_SOCKET_PATH = "/run/clp-addons/auth.sock";
export const DEFAULT_CLI_BIN = "/usr/local/bin/clp-addons";
export const MAX_GATEWAY_INPUT_BYTES = 1024 * 1024; // 1 MB max input (for clone credentials, etc.)
export const DEFAULT_GATEWAY_TIMEOUT_MS = 60_000;

/** Who may ask root for a verb from the web. */
export type WebAccess =
  /** An administrator, behind the manager's gate. */
  | "admin"
  /** An administrator or a site manager; CloudPanel does not narrow a site manager's sites. */
  | "site-manager"
  /** Any signed-in panel user; the route names a non-administrator with --as-user and root holds them to their own sites. */
  | "panel-user"
  /** Any signed-in panel user, on their own account: the gateway reads whose from the session itself. */
  | "own-account"
  /** Before there is a session, on a credential root checks, such as a webhook token or a passkey's signature. */
  | "pre-gate";

/**
 * One verb of `clp-addons action <addon>`. A root-only verb says why the web
 * may not reach it. A stream's output is copied to the socket as it comes; a
 * duplex stream also gets the socket's bytes on stdin, and the gateway checks
 * its session itself.
 */
export type VerbDeclaration =
  | { readonly web: WebAccess; readonly stream?: "one-way" | "duplex" }
  | { readonly web: false; readonly why: string };

/**
 * Every verb, declared once in its addon's own `verbs.ts`. The gateway's
 * allowlist, the action's verb type and the manager's per-caller check are all
 * read from here. Those files import nothing, so neither does the gateway.
 */
export const ADDON_VERBS = {
  "cloudflare-ips": CLOUDFLARE_IPS_VERBS,
  dns: DNS_VERBS,
  git: GIT_VERBS,
  instatic: INSTATIC_VERBS,
  maintenance: MAINTENANCE_VERBS,
  manager: MANAGER_VERBS,
  "panel-tweaks": PANEL_TWEAKS_VERBS,
  "php-resources": PHP_RESOURCES_VERBS,
  "security-keys": SECURITY_KEYS_VERBS,
  smtp: SMTP_VERBS,
  stager: STAGER_VERBS,
  "system-tweaks": SYSTEM_TWEAKS_VERBS,
  terminal: TERMINAL_VERBS,
  "wp-tools": WP_TOOLS_VERBS,
} as const satisfies Record<string, Record<string, VerbDeclaration>>;

export type GatewayAddon = keyof typeof ADDON_VERBS;
type Verbs<A extends GatewayAddon> = (typeof ADDON_VERBS)[A];
/** Every verb `clp-addons action <addon>` takes. */
export type AddonVerb<A extends GatewayAddon> = keyof Verbs<A> & string;
/** The verbs of an addon the web may ask for; of any addon, when it is not known which. */
export type WebVerb<A extends GatewayAddon> = A extends GatewayAddon
  ? { [V in keyof Verbs<A>]: Verbs<A>[V] extends { web: false } ? never : V }[keyof Verbs<A>] & string
  : never;
/** The verbs of an addon whose output is streamed. */
export type StreamVerb<A extends GatewayAddon> = A extends GatewayAddon
  ? { [V in keyof Verbs<A>]: Verbs<A>[V] extends { stream: string } ? V : never }[keyof Verbs<A>] & string
  : never;

export function isGatewayAddon(addon: string): addon is GatewayAddon {
  return Object.hasOwn(ADDON_VERBS, addon);
}

/**
 * How the web may reach `addon verb`, or null when it may not. The names come
 * off the wire, so only own keys count: `{}["constructor"]` is truthy.
 */
export function webVerb(addon: string, verb: string): Exclude<VerbDeclaration, { web: false }> | null {
  if (!isGatewayAddon(addon)) return null;
  const verbs: Record<string, VerbDeclaration> = ADDON_VERBS[addon];
  if (!Object.hasOwn(verbs, verb)) return null;
  const declared = verbs[verb]!;
  return declared.web === false ? null : declared;
}

/** Whether a caller with these panel roles, or none before the gate, may ask for a verb of this access. */
export function callerMay(access: WebAccess, roles: readonly string[] | null): boolean {
  if (access === "pre-gate") return true;
  if (roles === null) return false;
  if (roles.includes("ROLE_ADMIN")) return true;
  if (access === "site-manager") return roles.includes("ROLE_SITE_MANAGER");
  return access === "panel-user" || access === "own-account";
}

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
      sessionId?: string;
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
 * Requests are JSON frames.
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
          ...(typeof obj.sessionId === "string" ? { sessionId: obj.sessionId } : {}),
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

  return null;
}
