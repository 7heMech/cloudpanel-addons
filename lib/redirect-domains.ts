/**
 * Redirects' domains as DNS needs them, read from Redirects' saved state so DNS
 * never imports the addon: each redirect's source and the hosts it answers
 * for, to warn on DNS rows, and which redirects Redirects serves at
 * Cloudflare's edge, whose stand-in sites DNS leaves out.
 */
import { getDomain } from "tldts";
import { dnsName } from "./dns-name";
import { addonStateDir } from "./paths";
import { readState } from "./root-state";
import { LEGACY_DNS_STAND_INS_FILE, STAND_INS_FILE } from "./stand-ins";

export const REDIRECTS_POLICY_FILE = `${addonStateDir("redirects")}/policy.json`;
export const REDIRECTS_STATUS_FILE = `${addonStateDir("redirects")}/status.json`;

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
  statusFile?: string;
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

/** Every host a redirect answers for. */
export function coveredHosts(redirect: RedirectDomain): string[] {
  return redirect.hosts ?? standInHosts(redirect.source);
}

/**
 * Read whether or not Redirects is enabled. Untrusted or malformed state reads
 * as no redirects.
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

/**
 * The sources whose redirect Redirects serves at Cloudflare's edge: its last
 * plan found the source's Cloudflare zone, or it still tracks a rule there.
 * Null when the status is there but cannot be trusted or read.
 */
export function readEdgeSources(paths: RedirectDomainPaths): Set<string> | null {
  let raw: unknown;
  try {
    raw = readState<unknown>(paths.statusFile ?? REDIRECTS_STATUS_FILE, paths.rootUid, () => ({}));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const status = raw as Record<string, unknown>;
  const edge = new Set<string>();
  for (const key of ["plans", "redirectRules"] as const) {
    const entries = status[key];
    if (entries === undefined) continue;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return null;
    for (const [domain, entry] of Object.entries(entries as Record<string, unknown>)) {
      const source = host(domain);
      if (!source || !entry || typeof entry !== "object") continue;
      if (key === "redirectRules" || (entry as { zone?: unknown }).zone) edge.add(source);
    }
  }
  return edge;
}
