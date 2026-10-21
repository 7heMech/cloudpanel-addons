import { existsSync, readFileSync } from "node:fs";
import { runWp as wp, type WpCommand } from "./wp-cli";
export { commandOutput, type WpCommand } from "./wp-cli";
import { writeFileAtomic } from "../../lib/atomic-write";
import { leastRecentlyChecked, pruneFleet } from "./fleet";

export const CLP_VARNISH_PLUGIN = "clp-varnish-cache";
export type VarnishPluginStatus = "active" | "inactive" | "missing" | "unsupported" | "error";

export interface VarnishSiteRecord {
  status: VarnishPluginStatus;
  /** Once observed, a removed plugin is never automatically put back. */
  seen: boolean;
  checkedAt: string;
  error: string;
}

export interface WpVarnishState {
  enabled: boolean;
  excluded: string[];
  sites: Record<string, VarnishSiteRecord>;
}

export interface VarnishSite {
  domain: string;
  user: string;
  root: string;
  /** Resolved by the caller, which already refuses the box's own and shared accounts. */
  home: string;
  phpVersion: string;
  eligible: boolean;
}

export interface VarnishOptions {
  /** Tests can substitute the site-user command, never supplied by requests. */
  runWpCommand?: (command: WpCommand) => Promise<string>;
  now?: () => Date;
}

/** One pass: every eligible site, only the ones automation can still act on, or one domain. */
export interface VarnishRun {
  statePath: string;
  runuser: string;
  sites: VarnishSite[];
  /** Every domain the panel has; state for any other is dropped. */
  domains: Set<string>;
  domain?: string;
  dueOnly?: boolean;
}

export interface VarnishSyncResult {
  installed: number;
  checked: number;
  pending: number;
  failed: string[];
}

export function readVarnishState(path: string): WpVarnishState {
  if (!existsSync(path)) return { enabled: false, excluded: [], sites: {} };
  const state = JSON.parse(readFileSync(path, "utf8")) as WpVarnishState;
  if (typeof state.enabled !== "boolean" || !Array.isArray(state.excluded)
    || !state.excluded.every((domain) => typeof domain === "string")
    || !state.sites || typeof state.sites !== "object" || Array.isArray(state.sites)) {
    throw new Error("the WordPress Varnish settings are invalid");
  }
  for (const record of Object.values(state.sites)) {
    if (!record || !["active", "inactive", "missing", "unsupported", "error"].includes(record.status)
      || typeof record.seen !== "boolean" || typeof record.checkedAt !== "string" || typeof record.error !== "string") {
      throw new Error("the WordPress Varnish site record is invalid");
    }
  }
  return state;
}

/** Forgets domains the panel no longer has, so a recreated site starts fresh. */
export function pruneVarnishState(state: WpVarnishState, domains: Set<string>): boolean {
  const excluded = state.excluded.length;
  return Object.keys(pruneFleet(state, domains)).length > 0 || state.excluded.length !== excluded;
}

export function saveVarnishState(path: string, state: WpVarnishState): void {
  writeFileAtomic(path, `${JSON.stringify(state)}\n`, { mode: 0o600, createParent: true });
}

// WordPress itself resolves its plugin directory and multisite state. This
// PHP, wp-config.php and must-use plugins all run after dropping root. The
// marker sets the reply apart from anything the site's own code prints.
const STATUS_MARKER = "CLP-ADDONS-VARNISH-STATUS:";
const STATUS_PHP = `
if (!function_exists('get_plugins')) { require_once ABSPATH . 'wp-admin/includes/plugin.php'; }
$plugin = 'clp-varnish-cache/clp-varnish-cache.php';
$plugins = get_plugins();
echo "\\n" . '${STATUS_MARKER}' . wp_json_encode(array(
  'multisite' => is_multisite(),
  'status' => !isset($plugins[$plugin]) ? 'missing' : (is_plugin_active($plugin) ? 'active' : 'inactive')
));`;

async function status(run: VarnishRun, site: VarnishSite, options: VarnishOptions, deadline: number): Promise<VarnishPluginStatus> {
  const line = (await wp(run, site, ["eval", STATUS_PHP], options, deadline)).split("\n").findLast((text) => text.startsWith(STATUS_MARKER));
  let reply: { multisite?: unknown; status?: unknown } = {};
  try { reply = JSON.parse(line?.slice(STATUS_MARKER.length) ?? ""); } catch { /* reported below */ }
  if (typeof reply.multisite !== "boolean" || typeof reply.status !== "string" || !["active", "inactive", "missing"].includes(reply.status)) {
    throw new Error("WP-CLI returned no plugin status; check that the site loads in WordPress");
  }
  // A shared network needs an activation policy of its own. Do not install or
  // activate globally on behalf of just one CloudPanel domain.
  return reply.multisite ? "unsupported" : reply.status as VarnishPluginStatus;
}

export async function syncVarnish(run: VarnishRun, options: VarnishOptions = {}): Promise<VarnishSyncResult> {
  const state = readVarnishState(run.statePath);
  if (pruneVarnishState(state, run.domains)) saveVarnishState(run.statePath, state);
  const result: VarnishSyncResult = { installed: 0, checked: 0, pending: 0, failed: [] };
  if (!state.enabled && !run.domain) return result;
  const candidates = run.sites.filter((site) => site.eligible && !state.excluded.includes(site.domain)
    && (!run.domain || site.domain === run.domain));
  if (run.domain && candidates.length !== 1) throw new Error("that site is not eligible for Varnish installation or is excluded");
  // Once a plugin has been seen, automation never touches that site again, so
  // the timer leaves it alone; Check now still refreshes what the page shows.
  const due = run.dueOnly
    ? candidates.filter((site) => !state.sites[site.domain]?.seen && state.sites[site.domain]?.status !== "unsupported")
    : candidates;
  // Keep periodic passes short; Check now has time to refresh the whole fleet.
  const deadline = Date.now() + (run.dueOnly ? 30_000 : 90_000);
  for (const site of leastRecentlyChecked(due, state.sites)) {
    if (Date.now() > deadline - 1_000) { result.pending++; continue; }
    const previous = state.sites[site.domain];
    const record: VarnishSiteRecord = {
      status: "error", seen: previous?.seen ?? false, checkedAt: (options.now?.() ?? new Date()).toISOString(), error: "",
    };
    try {
      record.status = await status(run, site, options, deadline);
      if (record.status === "active" || record.status === "inactive") record.seen = true;
      const install = record.status === "missing" && (!record.seen || Boolean(run.domain));
      const activate = record.status === "inactive" && Boolean(run.domain);
      if (install || activate) {
        // Mark intent before execution. If interrupted after installing, the
        // next pass must not mistake a manual removal for a new site. A
        // command that fails outright put nothing there, so it is undone.
        const seenBefore = record.seen;
        record.seen = true;
        state.sites[site.domain] = record;
        saveVarnishState(run.statePath, state);
        try {
          await wp(run, site, install
            ? ["plugin", "install", CLP_VARNISH_PLUGIN, "--activate"]
            : ["plugin", "activate", CLP_VARNISH_PLUGIN], options, deadline);
        } catch (error) {
          record.seen = seenBefore;
          throw error;
        }
        record.status = await status(run, site, options, deadline);
        if (record.status !== "active") throw new Error("CLP Varnish Cache was not activated; check the site in WordPress");
        result.installed++;
      }
    } catch (error) {
      record.status = "error";
      record.error = error instanceof Error ? error.message : String(error);
      result.failed.push(`${site.domain}: ${record.error}`);
    }
    state.sites[site.domain] = record;
    saveVarnishState(run.statePath, state);
    result.checked++;
  }
  return result;
}
