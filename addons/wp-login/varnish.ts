import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../../lib/atomic-write";
import { siteAccountProblem } from "../../lib/site-accounts";

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
  uid: number;
  gid: number;
  home: string;
  phpVersion: string;
  eligible: boolean;
}

export interface WpCommand {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface VarnishOptions {
  /** Tests can substitute the site-user command, never supplied by requests. */
  runWpCommand?: (command: WpCommand) => Promise<string>;
  now?: () => Date;
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

export function saveVarnishState(path: string, state: WpVarnishState): void {
  writeFileAtomic(path, `${JSON.stringify(state)}\n`, { mode: 0o600, createParent: true });
}

// WordPress itself resolves its plugin directory and multisite state. This
// PHP, wp-config.php and must-use plugins all run after dropping root.
const STATUS_PHP = `
if (!function_exists('get_plugins')) { require_once ABSPATH . 'wp-admin/includes/plugin.php'; }
$plugin = 'clp-varnish-cache/clp-varnish-cache.php';
$plugins = get_plugins();
echo wp_json_encode(array(
  'multisite' => is_multisite(),
  'status' => !isset($plugins[$plugin]) ? 'missing' : (is_plugin_active($plugin) ? 'active' : 'inactive')
));`;

async function commandOutput(command: WpCommand): Promise<string> {
  const child = Bun.spawn(command.argv, {
    cwd: command.cwd, env: command.env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const reader = stream.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 64 * 1024) throw new Error("WP-CLI returned too much output");
        chunks.push(chunk.value);
      }
    } catch (error) {
      child.kill();
      throw error;
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  const [stdout, stderr, code] = await Promise.all([read(child.stdout), read(child.stderr), child.exited]);
  if (code !== 0) {
    // PHP errors can disclose site configuration; retain only a bounded summary.
    throw new Error(code === 124 || code === 137 ? "WP-CLI timed out" : `WP-CLI failed: ${(stderr || stdout).trim().slice(0, 500) || `exit ${code}`}`);
  }
  return stdout.trim();
}

async function wp(site: VarnishSite, args: string[], options: VarnishOptions, deadline: number): Promise<string> {
  const problem = siteAccountProblem(site);
  if (problem) throw new Error(problem);
  if (!/^\d+\.\d+$/.test(site.phpVersion)) throw new Error("the site's PHP version is unavailable");
  const php = `/usr/bin/php${site.phpVersion}`;
  const executable = existsSync("/usr/bin/wp") ? "/usr/bin/wp" : "/usr/local/bin/wp";
  if (!options.runWpCommand && (!existsSync(php) || !existsSync(executable))) {
    throw new Error(`WP-CLI and PHP ${site.phpVersion} must be installed on this server`);
  }
  const seconds = Math.min(60, Math.floor((deadline - Date.now()) / 1000));
  if (seconds < 1) throw new Error("the Varnish check reached its time limit; check again to continue");
  return (options.runWpCommand ?? commandOutput)({
    argv: ["/usr/sbin/runuser", "-u", site.user, "--", "/usr/bin/timeout", "--signal=KILL", String(seconds),
      php, executable, `--path=${site.root}`, `--url=https://${site.domain}`, "--skip-plugins", "--skip-themes",
      "--skip-packages", "--no-color", ...args],
    cwd: "/",
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: site.home, WP_CLI_CONFIG_PATH: "/dev/null" },
  });
}

async function status(site: VarnishSite, options: VarnishOptions, deadline: number): Promise<VarnishPluginStatus> {
  const reply = JSON.parse(await wp(site, ["eval", STATUS_PHP], options, deadline)) as { multisite?: unknown; status?: unknown };
  if (typeof reply.multisite !== "boolean" || typeof reply.status !== "string" || !["active", "inactive", "missing"].includes(reply.status)) {
    throw new Error("WP-CLI returned an invalid plugin status");
  }
  // A shared network needs an activation policy of its own. Do not install or
  // activate globally on behalf of just one CloudPanel domain.
  return reply.multisite ? "unsupported" : reply.status as VarnishPluginStatus;
}

export async function syncVarnish(
  path: string,
  sites: VarnishSite[],
  options: VarnishOptions = {},
  explicitDomain?: string,
): Promise<VarnishSyncResult> {
  const state = readVarnishState(path);
  const result: VarnishSyncResult = { installed: 0, checked: 0, pending: 0, failed: [] };
  if (!state.enabled && !explicitDomain) return result;
  const candidates = sites.filter((site) => site.eligible && !state.excluded.includes(site.domain)
    && (!explicitDomain || site.domain === explicitDomain));
  if (explicitDomain && candidates.length !== 1) throw new Error("that site is not eligible for Varnish installation or is excluded");
  // Rotate through the least recently checked sites, keeping repair bounded
  // even when one site's PHP or external download stalls.
  candidates.sort((a, b) => (state.sites[a.domain]?.checkedAt ?? "").localeCompare(state.sites[b.domain]?.checkedAt ?? ""));
  const deadline = Date.now() + 90_000;
  for (const site of candidates) {
    if (Date.now() > deadline - 1_000) { result.pending++; continue; }
    const previous = state.sites[site.domain];
    const record: VarnishSiteRecord = {
      status: "error", seen: previous?.seen ?? false, checkedAt: (options.now?.() ?? new Date()).toISOString(), error: "",
    };
    try {
      record.status = await status(site, options, deadline);
      if (record.status === "active" || record.status === "inactive") record.seen = true;
      const install = record.status === "missing" && (!record.seen || explicitDomain);
      const activate = record.status === "inactive" && explicitDomain;
      if (install || activate) {
        // Mark intent before execution. If interrupted after installing, the
        // next sweep must not mistake a manual removal for a new site.
        record.seen = true;
        state.sites[site.domain] = record;
        saveVarnishState(path, state);
        await wp(site, install
          ? ["plugin", "install", CLP_VARNISH_PLUGIN, "--activate"]
          : ["plugin", "activate", CLP_VARNISH_PLUGIN], options, deadline);
        record.status = await status(site, options, deadline);
        if (record.status !== "active") throw new Error("CLP Varnish Cache was not activated; check the site in WordPress");
        result.installed++;
      }
    } catch (error) {
      record.status = "error";
      record.error = error instanceof Error ? error.message : String(error);
      result.failed.push(`${site.domain}: ${record.error}`);
    }
    state.sites[site.domain] = record;
    saveVarnishState(path, state);
    result.checked++;
  }
  return result;
}
