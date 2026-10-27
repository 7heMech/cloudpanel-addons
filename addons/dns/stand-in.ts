/**
 * Stand-in sites: while DNS has no Cloudflare connection, a redirect domain is
 * served from this server by a CloudPanel static site whose vhost returns the
 * redirect and still answers Let's Encrypt from the site's root.
 *
 * Each is recorded before CloudPanel creates it, so the new-site work of every
 * addon already knows it is not an ordinary site.
 */
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { availableSiteUser, runCommand } from "../../cli/action-common";
import { replaceSiteVhost, type SiteVhostPaths } from "../../cli/site-vhost";
import { ownsStandInSite } from "../../cli/stand-ins";
import type { StandIn, StandIns } from "./engine";
import type { Redirect } from "./model";
import { standInHosts } from "./redirects";
import type { Issue } from "./ssl";
import { readState, writeState } from "./store";

export interface StandInRecord extends StandIn {
  siteUser: string;
  /** CloudPanel's id for the site, once it exists. */
  siteId?: number;
  createdAt: number;
  certificate: { attempts: number; nextAt: number; done: boolean };
}

export interface StandInPaths {
  file: string;
  clpctl: string;
  vhost: SiteVhostPaths;
  rootUid: number;
}

/** Waits after each failed certificate attempt; the last repeats, since the domain may be pointed here any time. */
const CERTIFICATE_DELAYS = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];

export function standInTarget(redirect: StandIn): string {
  const query = redirect.target.includes("?") ? "&$args" : "$is_args$args";
  const path = redirect.keepPath ? (redirect.keepQuery ? "$request_uri" : "$1") : (redirect.keepQuery ? query : "");
  return `${redirect.target}${path}`;
}

/** The path without the query is captured from the raw `$request_uri`: `$uri` is decoded, so an encoded CR/LF would split the response. */
function standInReturn(redirect: StandIn): string {
  const line = `return ${redirect.status} "${standInTarget(redirect)}";`;
  return redirect.keepPath && !redirect.keepQuery ? `if ($request_uri ~ "^([^?]*)") {\n      ${line}\n    }` : line;
}

export function standInBody(source: string, redirect: StandIn): string {
  return `server {
  listen 80;
  listen [::]:80;
  listen 443 quic;
  listen 443 ssl;
  listen [::]:443 quic;
  listen [::]:443 ssl;
  http2 on;
  http3 off;
  {{ssl_certificate_key}}
  {{ssl_certificate}}
  server_name ${standInHosts(source).join(" ")};
  {{root}}

  {{nginx_access_log}}
  {{nginx_error_log}}

  location ^~ /.well-known/acme-challenge/ {
    auth_basic off;
    allow all;
    try_files $uri =404;
  }

  location / {
    ${standInReturn(redirect)}
  }
}`;
}

export function readStandIns(paths: StandInPaths): Record<string, StandInRecord> {
  return readState<Record<string, StandInRecord>>(paths.file, paths.rootUid, () => ({}));
}

function saveStandIns(paths: StandInPaths, records: Record<string, StandInRecord>): void {
  writeState(paths.file, records, paths.rootUid);
}

function panelUsers(panelDb: string): Set<string> {
  const db = new Database(panelDb, { readonly: true });
  try {
    return new Set(db.query<{ user: string }, []>("SELECT user FROM site").all().map((row) => row.user));
  } finally {
    db.close();
  }
}

function clpctl(paths: StandInPaths, args: string[], what: string): void {
  const result = runCommand(paths.clpctl, args, 300_000);
  if (!result.ok) throw new Error(`${what}: ${(result.stderr || result.stdout).trim().split("\n").pop() ?? "clpctl failed"}`);
}

/** Stand-ins through CloudPanel's own CLI. `current` holds those whose site is still the one DNS made. */
export function clpctlStandIns(
  paths: StandInPaths, panelSite: (domain: string) => { id: number; user?: string } | undefined, now: () => number,
): StandIns {
  const records = readStandIns(paths);
  const ours = (domain: string, record = readStandIns(paths)[domain]) => {
    const site = panelSite(domain);
    return site !== undefined && ownsStandInSite(record, site);
  };
  const current: Record<string, StandIn> = {};
  for (const [domain, record] of Object.entries(records)) {
    if (ours(domain, record)) current[domain] = { target: record.target, status: record.status, keepPath: record.keepPath, keepQuery: record.keepQuery };
  }
  const spec = (redirect: Redirect): StandIn => ({ target: redirect.target, status: redirect.status, keepPath: redirect.keepPath, keepQuery: redirect.keepQuery });
  return {
    current,
    async create(redirect) {
      if (panelSite(redirect.source)) throw new Error(`CloudPanel already has a site ${redirect.source}`);
      const taken = panelUsers(paths.vhost.panelDb);
      const siteUser = availableSiteUser(redirect.source, (user) => taken.has(user) || runCommand("id", ["-u", user]).ok);
      const saved = readStandIns(paths);
      saved[redirect.source] = { ...spec(redirect), siteUser, createdAt: now(), certificate: { attempts: 0, nextAt: now(), done: false } };
      saveStandIns(paths, saved);
      // Only a site known to be this one is deleted on failure: another may have taken the domain meanwhile.
      let siteId: number | null = null;
      try {
        clpctl(paths, ["site:add:static", `--domainName=${redirect.source}`, `--siteUser=${siteUser}`,
          `--siteUserPassword=${randomBytes(24).toString("base64url")}`], `CloudPanel did not create ${redirect.source}`);
        const site = panelSite(redirect.source);
        if (site?.user !== siteUser) throw new Error(`CloudPanel does not list ${redirect.source} as the site it created`);
        siteId = site.id;
        const created = readStandIns(paths);
        created[redirect.source] = { ...created[redirect.source]!, siteId };
        saveStandIns(paths, created);
        replaceSiteVhost(paths.vhost, redirect.source, standInBody(redirect.source, redirect));
      } catch (error) {
        if (siteId !== null && panelSite(redirect.source)?.id === siteId) {
          runCommand(paths.clpctl, ["site:delete", `--domainName=${redirect.source}`, "--force"], 300_000);
        }
        const after = readStandIns(paths);
        delete after[redirect.source];
        saveStandIns(paths, after);
        throw error;
      }
    },
    async update(redirect) {
      if (!ours(redirect.source)) throw new Error(`${redirect.source} is no longer DNS's stand-in site`);
      replaceSiteVhost(paths.vhost, redirect.source, standInBody(redirect.source, redirect));
      const saved = readStandIns(paths);
      if (saved[redirect.source]) saved[redirect.source] = { ...saved[redirect.source]!, ...spec(redirect) };
      saveStandIns(paths, saved);
    },
    async remove(source) {
      if (ours(source)) clpctl(paths, ["site:delete", `--domainName=${source}`, "--force"], `CloudPanel did not delete ${source}`);
      const saved = readStandIns(paths);
      delete saved[source];
      saveStandIns(paths, saved);
    },
  };
}

/**
 * Asks Let's Encrypt for each stand-in still on CloudPanel's self-signed
 * certificate, when it is due. It succeeds once the domain points here, which
 * is the operator's to do, so attempts go on daily rather than stopping.
 */
export async function retryStandInCertificates(
  paths: StandInPaths, selfSigned: (domain: string) => boolean | null, issue: Issue, now: number,
): Promise<void> {
  const records = readStandIns(paths);
  for (const [domain, record] of Object.entries(records)) {
    const placeholder = selfSigned(domain);
    if (placeholder === null || record.certificate.done) continue;
    if (!placeholder) {
      record.certificate.done = true;
    } else if (now >= record.certificate.nextAt) {
      record.certificate.attempts++;
      record.certificate.nextAt = now + CERTIFICATE_DELAYS[Math.min(record.certificate.attempts, CERTIFICATE_DELAYS.length) - 1]!;
      saveStandIns(paths, records);
      if (await issue(domain, standInHosts(domain).filter((host) => host !== domain)) && selfSigned(domain) === false) record.certificate.done = true;
    }
    saveStandIns(paths, records);
  }
}
