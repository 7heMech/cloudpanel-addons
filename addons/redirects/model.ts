/**
 * What Redirects keeps: redirect domains, whether sync is Automatic, review
 * holds across provider transitions, and Cloudflare zone disambiguation.
 * Everything here is checked the same way whether it arrives from the page or
 * from the saved policy.
 */
import { ActionFailure, failAction } from "../../lib/action";
import { cloudflareId, connectionId, dnsName } from "../../lib/dns-name";

export { cloudflareId, connectionId, dnsName };

export const REDIRECT_STATUSES = [301, 302, 307, 308] as const;
export type RedirectStatus = (typeof REDIRECT_STATUSES)[number];

export const REDIRECT_MODES = ["auto", "local"] as const;
export type RedirectMode = (typeof REDIRECT_MODES)[number];

export const MAX_REDIRECTS = 500;

/** A domain whose HTTP/HTTPS requests Cloudflare, or a local stand-in site on this server, forwards elsewhere. */
export interface Redirect {
  /** A zone apex (which covers its `www` too) or a single host. */
  source: string;
  target: string;
  status: RedirectStatus;
  keepPath: boolean;
  keepQuery: boolean;
  /** `"local"` keeps the redirect on a local stand-in site even when Cloudflare reaches the zone; omitted / `"auto"` prefers Cloudflare. */
  mode?: RedirectMode;
  /** Explicit host list for a local stand-in site (for example, a sub-zone apex migrated from PowerDNS); defaults to `standInHosts(source)`. */
  hosts?: string[];
}

export interface ZoneChoice {
  connectionId: string;
  zoneId: string;
}

export interface Policy {
  version: 1;
  /** Off is Ask first: Redirects reads and shows what differs, and writes nothing until turned on through a review. */
  automatic: boolean;
  redirects: Redirect[];
  /** Redirect domains whose switch between Cloudflare and a local stand-in site waits for an administrator's review. */
  held: string[];
  /** Zone name to the Cloudflare connection and zone that manage it, where more than one could. */
  zoneChoices: Record<string, ZoneChoice>;
}

export function emptyPolicy(): Policy {
  return { version: 1, automatic: false, redirects: [], held: [], zoneChoices: {} };
}

export function hostname(value: unknown, what: string): string {
  if (typeof value !== "string") failAction(`${what} must be a hostname`);
  const name = value.trim().toLowerCase().replace(/\.$/, "");
  if (!dnsName(name) || name.startsWith("*.")) failAction(`${what} must be a hostname`);
  return name;
}

function flag(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") failAction(`${what} must be on or off`);
  return value;
}

/** An absolute http(s) URL with no credentials or fragment; with the path kept, no query either, and no trailing slash. */
function redirectTarget(value: unknown, keepPath: boolean): string {
  if (typeof value !== "string") failAction("The target must be a URL, such as https://example.com");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    failAction("The target must be a URL, such as https://example.com");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.hash || !dnsName(url.hostname)) {
    failAction("The target must be an http or https URL, such as https://example.com");
  }
  if (keepPath && url.search) failAction("A target that keeps the path cannot have a query string");
  const text = url.href;
  if (/["'$;{}\\\s]/.test(text) || text.length > 1024) failAction("The target has characters a redirect cannot carry");
  return keepPath ? text.replace(/\/+$/, "") : text;
}

function parseHosts(value: unknown, source: string): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) failAction("The redirect hosts must be a list");
  if (!value.length) return undefined;
  const allowed = new Set([source, `www.${source}`]);
  const parsed = [...new Set(value.map((entry) => hostname(entry, "A redirect host")))];
  if (!parsed.includes(source) || parsed.some((host) => !allowed.has(host))) {
    failAction(`Redirect hosts for ${source} may only include ${source} and www.${source}`);
  }
  return [source, ...parsed.filter((host) => host !== source)];
}

export function parseRedirect(value: unknown): Redirect {
  if (!value || typeof value !== "object" || Array.isArray(value)) failAction("the redirect is malformed");
  const raw = value as Record<string, unknown>;
  const source = hostname(raw.source, "The redirect's domain");
  const keepPath = flag(raw.keepPath ?? true, "Keep path");
  const target = redirectTarget(raw.target, keepPath);
  const host = new URL(target).hostname;
  if (host === source || host === `www.${source}`) failAction(`${source} cannot redirect to itself`);
  const status = REDIRECT_STATUSES.find((code) => code === Number(raw.status ?? 301));
  if (!status) failAction("The status must be 301, 302, 307 or 308");
  const rawMode = raw.mode == null || raw.mode === "" ? "auto" : raw.mode;
  const mode = REDIRECT_MODES.find((candidate) => candidate === rawMode);
  if (!mode) failAction("The redirect mode must be auto or local");
  const hosts = parseHosts(raw.hosts, source);
  return {
    source,
    target,
    status,
    keepPath,
    keepQuery: flag(raw.keepQuery ?? true, "Keep query string"),
    ...(mode === "local" ? { mode } : {}),
    ...(hosts ? { hosts } : {}),
  };
}

export function parseRedirects(value: unknown): Redirect[] {
  if (value == null) return [];
  if (!Array.isArray(value)) failAction("the redirects must be a list");
  if (value.length > MAX_REDIRECTS) failAction(`at most ${MAX_REDIRECTS} redirect domains`);
  const redirects = value.map(parseRedirect);
  const seen = new Set<string>();
  for (const redirect of redirects) {
    if (seen.has(redirect.source)) failAction(`${redirect.source} is listed as a redirect twice`);
    seen.add(redirect.source);
  }
  return redirects.sort((a, b) => a.source.localeCompare(b.source));
}

export function parsePolicy(value: unknown): Policy {
  const raw = (value ?? {}) as Partial<Policy>;
  if (raw.version !== 1 || typeof raw.automatic !== "boolean") {
    failAction("the Redirects policy is malformed");
  }
  try {
    const redirects = parseRedirects(raw.redirects);
    const sources = new Set(redirects.map((redirect) => redirect.source));
    const zoneChoices: Record<string, ZoneChoice> = {};
    for (const [zone, choice] of Object.entries(raw.zoneChoices ?? {})) {
      if (!choice || typeof choice !== "object" || Array.isArray(choice)) failAction("a zone choice is malformed");
      zoneChoices[hostname(zone, "a zone")] = {
        connectionId: connectionId(choice.connectionId),
        zoneId: cloudflareId(choice.zoneId, "a zone"),
      };
    }
    const held = [...new Set((raw.held ?? []).filter((domain): domain is string => typeof domain === "string" && sources.has(domain)))];
    return { version: 1, automatic: raw.automatic, redirects, held, zoneChoices };
  } catch (error) {
    if (error instanceof ActionFailure) failAction(`the Redirects policy is malformed: ${error.message}`);
    throw error;
  }
}
