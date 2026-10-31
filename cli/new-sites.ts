// What the new-site watcher runs, and how it knows a site has finished arriving.
//
// CloudPanel writes a new site's vhost first and commits its row in the panel
// database afterwards, half a second later on staging even for a WordPress
// site, whose files come after the row; later on a busy box, where the panel's
// database is held by other writers. It deletes a site the same way round: the
// vhost goes, then the row. The vhost wakes this; while a vhost and the rows
// disagree, a second watcher on the database's directory wakes it again at the
// commit. That watcher runs only while a site is between the two, or while an
// addon says a new site still waits for a later step of the same request,
// because the panel writes its database every few seconds even when idle.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../lib/atomic-write";
import type { AddonSpec } from "./addon-catalog";
import { newSitesWaiting, runNewSiteWork } from "./maintenance";
import { DISTRO_NGINX_SITES_DIR, NEW_SITE_ROWS_PATH, NEW_SITES_SEEN_FILE, PANEL_DB } from "./paths";
import { log, tryRun } from "./util";

/**
 * A vhost and the rows that still disagree this long after the vhosts last
 * changed are not a site on its way, and no addon waits for a site longer than
 * this after the sites last changed.
 */
export const NEW_SITE_ROW_WAIT_MS = 60 * 60 * 1000;

export interface NewSiteWatchPaths {
  panelDb: string;
  vhostDir: string;
  /** The sites the hooks last ran for. */
  seenFile: string;
}

export const DEFAULT_NEW_SITE_WATCH_PATHS: NewSiteWatchPaths = {
  panelDb: PANEL_DB,
  vhostDir: DISTRO_NGINX_SITES_DIR,
  seenFile: NEW_SITES_SEEN_FILE,
};

export interface NewSiteWatchOps {
  /** Every installed addon's `newSites`. */
  runHooks: () => Promise<void>;
  /** Whether an addon still waits for a new site. */
  waiting: () => Promise<boolean>;
  /** Start or stop watching the panel database for a row that is still to come. */
  watchRows: (on: boolean) => void;
  now?: () => number;
}

/**
 * The panel's sites as `<domain> <id>`, the domain lower-cased, sorted; null
 * when the database cannot be read. With the id, a site deleted and added again
 * at its domain is a change even when the deletion went unseen.
 */
export function panelSites(panelDb: string): string[] | null {
  try {
    // Read-only, so closing it is not a write the row watcher would see.
    const db = new Database(panelDb, { readonly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000;");
      return [...new Set(db.query<{ id: unknown; domain_name: unknown }, []>("SELECT id, domain_name FROM site").all()
        .flatMap((row) => typeof row.domain_name === "string" ? [`${row.domain_name.toLowerCase()} ${row.id}`] : []))].sort();
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Sites CloudPanel is part-way through creating or deleting: a vhost written
 * within the last hour with no row yet, or a row whose vhost has gone within
 * the last hour, as the directory's own change time tells. A site's vhost is
 * `<domain>.conf`; CloudPanel's own and ours, such as `default.conf`, have no
 * dot in their name.
 */
export function sitesInFlight(vhostDir: string, domains: string[], now: number): string[] {
  let names: string[];
  let dirChanged: number;
  try {
    names = readdirSync(vhostDir);
    dirChanged = statSync(vhostDir).mtimeMs;
  } catch {
    return [];
  }
  if (now - dirChanged >= NEW_SITE_ROW_WAIT_MS) return [];
  const rows = new Set(domains);
  // Domain to file name: the name is matched without case, but read as it is.
  const vhosts = new Map(names.flatMap((name) => {
    const domain = name.endsWith(".conf") ? name.slice(0, -".conf".length).toLowerCase() : "";
    return domain.includes(".") ? [[domain, name] as const] : [];
  }));
  const created = [...vhosts].flatMap(([domain, name]) => {
    if (rows.has(domain)) return [];
    try {
      return now - statSync(join(vhostDir, name)).mtimeMs < NEW_SITE_ROW_WAIT_MS ? [domain] : [];
    } catch {
      return [];
    }
  });
  return [...created, ...domains.filter((domain) => !vhosts.has(domain))];
}

function readSeen(file: string): string[] | null {
  try {
    const seen = JSON.parse(readFileSync(file, "utf8")) as { sites?: unknown };
    return Array.isArray(seen.sites) && seen.sites.every((site) => typeof site === "string") ? seen.sites : null;
  } catch {
    return null;
  }
}

const sameSites = (a: string[], b: string[] | null) =>
  b !== null && a.length === b.length && a.every((site, i) => site === b[i]);

/** Whether the hooks last ran, for a change to the sites, within the hour. */
function sitesChangedRecently(seenFile: string, now: number): boolean {
  try {
    return now - statSync(seenFile).mtimeMs < NEW_SITE_ROW_WAIT_MS;
  } catch {
    return false;
  }
}

/**
 * Run the hooks when the panel's sites differ from the last time they ran, then
 * watch for the row of any site whose vhost has come or gone without it, and
 * keep watching while an addon waits for a new site. Hooks that ran for a set
 * of sites do not run again for it, whether they succeeded or not: the row
 * watcher wakes this on every panel write, and a hook that keeps failing is the
 * 15-minute pass's to retry. Addons that wait are asked again on every wake.
 *
 * A path unit does not start its service again for a change made while the
 * service runs, so after arming the watcher this looks once more: a row that
 * arrived while the hooks ran, or the write an addon waits for, is handled now
 * rather than at the next write.
 */
export async function syncNewSites(ops: NewSiteWatchOps, paths: NewSiteWatchPaths = DEFAULT_NEW_SITE_WATCH_PATHS): Promise<void> {
  const now = ops.now ?? Date.now;
  let seen = readSeen(paths.seenFile);
  let lookedAgain = false;
  for (;;) {
    const sites = panelSites(paths.panelDb);
    if (sites === null) {
      // Nothing to compare with: run as the watcher always did, and let the hooks
      // report the problem. Whatever held the database, such as a long write,
      // ends in a write, which the rows watcher turns into another look.
      await ops.runHooks();
      ops.watchRows(true);
      return;
    }
    if (!sameSites(sites, seen)) {
      await ops.runHooks();
      writeFileAtomic(paths.seenFile, `${JSON.stringify({ sites })}\n`, { mode: 0o600, createParent: true });
      seen = sites;
    }
    const domains = sites.map((site) => site.slice(0, site.lastIndexOf(" ")));
    const inFlight = sitesInFlight(paths.vhostDir, domains, now()).length > 0;
    const waiting = sitesChangedRecently(paths.seenFile, now()) && await ops.waiting();
    ops.watchRows(inFlight || waiting);
    if (!inFlight && !waiting) return;
    if (!sameSites(panelSites(paths.panelDb) ?? sites, sites)) continue;
    if (!waiting || lookedAgain) return;
    lookedAgain = true;
  }
}

/** `clp-addons sync-sites`, as the new-site watchers run it. */
export async function runSyncSites(installed: AddonSpec[]): Promise<void> {
  await syncNewSites({
    runHooks: () => runNewSiteWork(installed),
    waiting: () => newSitesWaiting(installed),
    watchRows: (on) => {
      const result = tryRun("systemctl", [on ? "start" : "stop", NEW_SITE_ROWS_PATH]);
      if (!result.ok) log.warn(`could not ${on ? "start" : "stop"} ${NEW_SITE_ROWS_PATH}: ${result.out}`);
    },
  });
}
