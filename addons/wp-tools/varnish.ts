import { existsSync, readFileSync } from "node:fs";
import { runWp as wp, type WpCommand, type WpProgress } from "./wp-cli";
export { commandOutput, type WpCommand } from "./wp-cli";
import { writeFileAtomic } from "../../lib/atomic-write";
import { leastRecentlyChecked, pruneFleet } from "./fleet";

export const CLP_VARNISH_PLUGIN = "clp-varnish-cache";
export type VarnishPluginStatus = "active" | "inactive" | "missing" | "error";

export interface VarnishSiteRecord {
  status: VarnishPluginStatus;
  /** Once observed, a removed plugin is never automatically put back. */
  seen: boolean;
  checkedAt: string;
  error: string;
  /** A multisite network, where active means network-active. */
  network?: boolean;
}

export interface WpVarnishState {
  enabled: boolean;
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
  /** Called before each site a pass checks. */
  onProgress?: (progress: WpProgress) => void;
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
  /** When the pass stops starting sites; a background job sets a long one. */
  deadline?: number;
}

export interface VarnishSyncResult {
  installed: number;
  checked: number;
  pending: number;
  failed: string[];
}

export function readVarnishState(path: string): WpVarnishState {
  if (!existsSync(path)) return { enabled: false, sites: {} };
  const state = JSON.parse(readFileSync(path, "utf8")) as WpVarnishState & { excluded?: unknown };
  if (typeof state.enabled !== "boolean"
    || !state.sites || typeof state.sites !== "object" || Array.isArray(state.sites)) {
    throw new Error("the WordPress Varnish settings are invalid");
  }
  for (const [domain, record] of Object.entries(state.sites)) {
    if (!record || !["active", "inactive", "missing", "unsupported", "error"].includes(record.status)
      || typeof record.seen !== "boolean" || typeof record.checkedAt !== "string" || typeof record.error !== "string"
      || (record.network !== undefined && typeof record.network !== "boolean")) {
      throw new Error("the WordPress Varnish site record is invalid");
    }
    // Earlier versions skipped multisite networks without trying anything, so
    // the next check starts them afresh.
    if ((record.status as string) === "unsupported") delete state.sites[domain];
  }
  // Sites can no longer be excluded; the next save drops an old list.
  delete state.excluded;
  return state;
}

/** Forgets domains the panel no longer has, so a recreated site starts fresh. */
export function pruneVarnishState(state: WpVarnishState, domains: Set<string>): boolean {
  return Object.keys(pruneFleet(state, domains)).length > 0;
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
$active = is_multisite() ? is_plugin_active_for_network($plugin) : is_plugin_active($plugin);
echo "\\n" . '${STATUS_MARKER}' . wp_json_encode(array(
  'multisite' => is_multisite(),
  'status' => !isset($plugins[$plugin]) ? 'missing' : ($active ? 'active' : 'inactive')
));`;

interface PluginStatus {
  status: Exclude<VarnishPluginStatus, "error">;
  multisite: boolean;
}

// On a multisite network only network activation counts: the plugin reads its
// settings from the site account's ~/.varnish-cache and purges by host and by
// the site's cache-tag prefix, so one activation serves every site in the
// network, and the network is the one CloudPanel site whose files it is.
async function status(run: VarnishRun, site: VarnishSite, options: VarnishOptions, deadline: number): Promise<PluginStatus> {
  const line = (await wp(run, site, ["eval", STATUS_PHP], options, deadline)).split("\n").findLast((text) => text.startsWith(STATUS_MARKER));
  let reply: { multisite?: unknown; status?: unknown } = {};
  try { reply = JSON.parse(line?.slice(STATUS_MARKER.length) ?? ""); } catch { /* reported below */ }
  if (typeof reply.multisite !== "boolean" || typeof reply.status !== "string" || !["active", "inactive", "missing"].includes(reply.status)) {
    throw new Error("WP-CLI returned no plugin status; check that the site loads in WordPress");
  }
  return { status: reply.status as PluginStatus["status"], multisite: reply.multisite };
}

export async function syncVarnish(run: VarnishRun, options: VarnishOptions = {}): Promise<VarnishSyncResult> {
  const state = readVarnishState(run.statePath);
  if (pruneVarnishState(state, run.domains)) saveVarnishState(run.statePath, state);
  const result: VarnishSyncResult = { installed: 0, checked: 0, pending: 0, failed: [] };
  if (!state.enabled && run.dueOnly) return result;
  const candidates = run.sites.filter((site) => site.eligible && (!run.domain || site.domain === run.domain));
  if (run.domain && candidates.length !== 1) throw new Error("that site is not eligible for Varnish installation");
  // Once a plugin has been seen, automation never touches that site again, so
  // the timer leaves it alone; Check now still refreshes what the page shows.
  const due = run.dueOnly ? candidates.filter((site) => !state.sites[site.domain]?.seen) : candidates;
  // Keep periodic passes short; Check now has time to refresh the whole fleet.
  const deadline = run.deadline ?? Date.now() + (run.dueOnly ? 30_000 : 90_000);
  const ordered = leastRecentlyChecked(due, state.sites);
  for (const [index, site] of ordered.entries()) {
    if (Date.now() > deadline - 1_000) { result.pending++; continue; }
    options.onProgress?.({ completed: index, total: ordered.length, site: site.domain });
    const previous = state.sites[site.domain];
    const record: VarnishSiteRecord = {
      status: "error", seen: previous?.seen ?? false, checkedAt: (options.now?.() ?? new Date()).toISOString(), error: "",
    };
    try {
      const found = await status(run, site, options, deadline);
      record.status = found.status;
      if (found.multisite) record.network = true;
      if (record.status === "active" || record.status === "inactive") record.seen = true;
      // With automation off a check only records what each site has.
      const install = record.status === "missing" && ((state.enabled && !record.seen) || Boolean(run.domain));
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
          const network = found.multisite ? ["--activate-network"] : ["--activate"];
          await wp(run, site, install
            ? ["plugin", "install", CLP_VARNISH_PLUGIN, ...network]
            : ["plugin", "activate", CLP_VARNISH_PLUGIN, ...(found.multisite ? ["--network"] : [])], options, deadline);
        } catch (error) {
          record.seen = seenBefore;
          throw error;
        }
        record.status = (await status(run, site, options, deadline)).status;
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
