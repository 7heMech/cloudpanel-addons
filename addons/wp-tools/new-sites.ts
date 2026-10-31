// A new site becomes ready for WordPress Tools in steps, and each step is an
// event: CloudPanel writes its vhost, installs WordPress and lands the browser
// on its "WordPress installed" page, and later writes its certificate. Each of
// those re-checks the sites still pending here and queues the checks that have
// become possible, for those sites only. Nothing runs between events, and the
// 15-minute pass stays the backstop for whatever no event reports.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../lib/atomic-write";
/** The checks a new site can be owed, each its policy's ordinary check limited to that site. */
export type NewSiteCheck = "varnish-check" | "mainwp-check";

/** A site still pending this long after it appeared is left to the 15-minute pass. */
export const NEW_SITE_PENDING_MS = 60 * 60 * 1000;

export interface NewSite {
  domain: string;
  /** When the addon first saw it, in milliseconds. */
  since: number;
  /** CloudPanel's "WordPress installed" page said its installation finished. */
  installed?: boolean;
  /** How ready the site was when each check was last queued; a check is queued again only once that changes. */
  tried: Partial<Record<NewSiteCheck, string>>;
}

export interface NewSitesState {
  /** Every domain the panel had last time. */
  known: string[];
  /** New sites automation may still owe a check. */
  pending: NewSite[];
}

/** Null when there is none yet, or it is unreadable: either way the next look starts afresh. */
export function readNewSitesState(path: string): NewSitesState | null {
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as NewSitesState;
    const site = (value: NewSite) => Boolean(value) && typeof value.domain === "string" && Number.isSafeInteger(value.since)
      && (value.installed === undefined || typeof value.installed === "boolean")
      && Boolean(value.tried) && typeof value.tried === "object" && !Array.isArray(value.tried)
      && Object.values(value.tried).every((ready) => typeof ready === "string");
    if (!Array.isArray(state.known) || !state.known.every((domain) => typeof domain === "string")
      || !Array.isArray(state.pending) || !state.pending.every(site)) {
      return null;
    }
    return { known: state.known, pending: state.pending };
  } catch {
    return null;
  }
}

export function saveNewSitesState(path: string, state: NewSitesState): void {
  writeFileAtomic(path, `${JSON.stringify(state)}\n`, { mode: 0o600, createParent: true });
}

/** Records the panel's domains; returns the ones it did not have last time, now pending. */
export function noteSites(state: NewSitesState, domains: string[], now: number): string[] {
  const known = new Set(state.known);
  const current = new Set(domains);
  const added = domains.filter((domain) => !known.has(domain));
  state.known = [...domains];
  state.pending = state.pending.filter((site) => current.has(site.domain));
  for (const domain of added) state.pending.push({ domain, since: now, tried: {} });
  return added;
}

/**
 * Which certificate the site's vhost serves, as CloudPanel last wrote it: a new
 * site starts on a self-signed one and the file is replaced in place when a
 * real one is installed, so a changed stamp is a new certificate.
 */
export function certificateStamp(dir: string, domain: string): string {
  try {
    const file = statSync(join(dir, `${domain}.crt`));
    return `${Math.trunc(file.mtimeMs)}-${file.size}`;
  } catch {
    return "none";
  }
}
