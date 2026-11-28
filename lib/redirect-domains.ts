/**
 * Redirects' domains as DNS needs them, read from Redirects' saved state so DNS
 * never imports the addon: each redirect's source, where it is served, and the
 * hosts it answers for. DNS gives those domains their Mail role, and points a
 * stand-in's hosts at this server; Redirects owns the redirect itself.
 */
import { getDomain } from "tldts";
import { dnsName } from "./dns-name";
import { addonStateDir } from "./paths";
import { readState } from "./root-state";
import { LEGACY_DNS_STAND_INS_FILE, STAND_INS_FILE } from "./stand-ins";

export const REDIRECTS_POLICY_FILE = `${addonStateDir("redirects")}/policy.json`;

export interface RedirectDomain {
  source: string;
  target: string;
  /** `"local"` keeps the redirect on a stand-in site on this server even where Cloudflare reaches the zone. */
  mode: "auto" | "local";
  /** Redirects has a stand-in site for it on this server, whose hosts must point here. */
  standIn: boolean;
  /** The stand-in's own hosts, when it serves other than `redirectHosts`. */
  hosts?: string[];
}

export interface RedirectDomainPaths {
  policyFile?: string;
  standInsFile?: string;
  rootUid: number;
}

/** The source, and its `www` when the source is its zone's apex. */
export function redirectHosts(source: string, zone: string): string[] {
  return source === zone ? [source, `www.${source}`] : [source];
}

/** The hosts a stand-in site answers for, with no zone to tell the apex by: the registrable domain is one. */
export function standInHosts(source: string): string[] {
  return redirectHosts(source, getDomain(source, { allowPrivateDomains: false }) ?? source);
}

const host = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase().replace(/\.$/, "");
  return dnsName(name) && !name.startsWith("*.") ? name : null;
};

const hostList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const hosts = value.map(host).filter((name): name is string => name !== null);
  return hosts.length ? hosts : undefined;
};

function readObject(path: string, rootUid: number): Record<string, unknown> {
  try {
    const raw = readState<unknown>(path, rootUid, () => null);
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Read whether or not Redirects is enabled, so turning it off for a while does
 * not drop a redirect domain's Mail role. Untrusted or malformed state reads as
 * no redirects.
 */
export function readRedirectDomains(paths: RedirectDomainPaths): RedirectDomain[] {
  const policy = readObject(paths.policyFile ?? REDIRECTS_POLICY_FILE, paths.rootUid);
  const standIns = paths.standInsFile !== undefined
    ? readObject(paths.standInsFile, paths.rootUid)
    : { ...readObject(LEGACY_DNS_STAND_INS_FILE, paths.rootUid), ...readObject(STAND_INS_FILE, paths.rootUid) };
  const seen = new Set<string>();
  const domains: RedirectDomain[] = [];
  for (const entry of Array.isArray(policy.redirects) ? policy.redirects : []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    const source = host(raw.source);
    if (!source || seen.has(source) || typeof raw.target !== "string") continue;
    seen.add(source);
    const record = standIns[source];
    const standInRecord = record && typeof record === "object" && !Array.isArray(record) ? record as Record<string, unknown> : null;
    const hosts = hostList(standInRecord?.hosts) ?? hostList(raw.hosts);
    domains.push({
      source,
      target: raw.target,
      mode: raw.mode === "local" ? "local" : "auto",
      standIn: standInRecord !== null,
      ...hosts && { hosts },
    });
  }
  return domains;
}
