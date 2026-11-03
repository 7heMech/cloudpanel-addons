/**
 * CloudPanel fills a site's `{{varnish_proxy_pass}}` from
 * `~/.varnish-cache/settings.json`, which the site's own user can write, so a
 * shell user or the site's PHP could put nginx directives into the vhost. Each
 * site's stored vhost names a root-owned include in its place instead, and
 * before nginx starts or reloads, `clp-addons sync-varnish` writes that include
 * from the file: the line CloudPanel would render when the server passes the
 * guard's rule, otherwise CloudPanel's own backend without Varnish.
 */
import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { failAction, normalizeIdentityHostname, runCommand, type CommandResult } from "../../cli/action-common";
import { trustedVhost, withNginxTransaction, type NginxChange } from "../../cli/nginx-transaction";
import { openPanelDatabase, withPanelDb } from "../../cli/panel-db";
import { CLI_BIN, DISTRO_NGINX_SITES_DIR, PANEL_DB, ROOT_UID, SYSTEMD_DIR } from "../../cli/paths";
import { learnVhostMapContent, renderVhostBodyResult } from "../../cli/site-vhost";
import { writeFileAtomic } from "../../lib/atomic-write";
import { readVarnishSettings, VHOST_VALUE_RULES } from "./vhost-values";

export const VARNISH_PLACEHOLDER = "{{varnish_proxy_pass}}";
/** What CloudPanel renders when Varnish is off for a site. */
const NO_VARNISH = "proxy_pass http://127.0.0.1:8080;";

export const DEFAULT_VARNISH_BACKEND_PATHS = {
  panelDb: PANEL_DB,
  homeRoot: "/home",
  vhostDir: DISTRO_NGINX_SITES_DIR,
  includeDir: "/etc/nginx/clp-addons-varnish",
  dropIn: `${SYSTEMD_DIR}/nginx.service.d/zz-clp-addons-varnish.conf`,
  unit: "nginx.service",
  bin: CLI_BIN,
  vhostUid: ROOT_UID,
};

export type VarnishBackendPaths = typeof DEFAULT_VARNISH_BACKEND_PATHS;

export interface VarnishBackendOptions {
  paths?: Partial<VarnishBackendPaths>;
  run?: (command: string, args: string[]) => CommandResult;
}

interface Context {
  paths: VarnishBackendPaths;
  run: (command: string, args: string[]) => CommandResult;
}

function contextOf(options: VarnishBackendOptions): Context {
  return {
    paths: { ...DEFAULT_VARNISH_BACKEND_PATHS, ...options.paths },
    run: options.run ?? ((command, args) => runCommand(command, args, 60_000)),
  };
}

interface Site { domain: string; user: string; varnish: boolean; template: string }

function sites(db: Database): Site[] {
  return db.query<{ domain_name: unknown; user: unknown; varnish_cache: unknown; vhost_template: unknown }, []>(
    "SELECT domain_name, user, varnish_cache, vhost_template FROM site ORDER BY domain_name",
  ).all().flatMap((row) => {
    const domain = String(row.domain_name ?? "");
    // No glob characters: nginx reads `*` in an include path as a mask.
    if (normalizeIdentityHostname(domain) !== domain || !/^[a-z0-9.-]+$/.test(domain) || typeof row.vhost_template !== "string") return [];
    return [{ domain, user: String(row.user ?? ""), varnish: Number(row.varnish_cache) === 1, template: row.vhost_template }];
  });
}

export function varnishIncludeLine(includeDir: string, domain: string): string {
  return `include ${includeDir}/${domain}.conf;`;
}

/** The line CloudPanel's VarnishProxyPass renders for these settings, and whether the server was refused. */
export function varnishBackend(varnish: boolean, settings: Record<string, unknown> | null): { line: string; refused: boolean } {
  if (!varnish) return { line: "", refused: false };
  const server = settings?.server;
  if (settings?.enabled !== true || server === undefined || server === null) return { line: NO_VARNISH, refused: false };
  if (typeof server !== "string" || !VHOST_VALUE_RULES.varnishServer(server)) return { line: NO_VARNISH, refused: true };
  return { line: `proxy_pass http://${server.replace(/^\/+|\/+$/g, "")};`, refused: false };
}

function includeContent(domain: string, line: string): string {
  return `# Managed by clp-addons System Tweaks: ${domain}'s Varnish backend, rewritten before nginx loads.\n${line ? `${line}\n` : ""}`;
}

function regularText(path: string): string | null {
  try {
    return lstatSync(path).isFile() ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/** Whether nginx loads this site's include: its stored or its rendered vhost names it. */
function usesInclude(site: Site, paths: VarnishBackendPaths): boolean {
  const line = varnishIncludeLine(paths.includeDir, site.domain);
  return site.template.includes(VARNISH_PLACEHOLDER) || site.template.includes(line)
    || (regularText(join(paths.vhostDir, `${site.domain}.conf`))?.includes(line) ?? false);
}

/**
 * Write every site's include from its settings file as it is now; what nginx
 * loads is only ever these root-owned lines. Returns the sites whose Varnish
 * server was refused.
 */
export function syncVarnishBackends(options: VarnishBackendOptions = {}): string[] {
  const { paths } = contextOf(options);
  const all = withPanelDb(paths.panelDb, sites);
  mkdirSync(paths.includeDir, { recursive: true, mode: 0o755 });
  const kept = new Set<string>();
  const refused: string[] = [];
  for (const site of all) {
    if (!usesInclude(site, paths)) continue;
    const backend = varnishBackend(site.varnish, readVarnishSettings(paths.homeRoot, site.user));
    if (backend.refused) refused.push(site.domain);
    const file = join(paths.includeDir, `${site.domain}.conf`);
    kept.add(file);
    const content = includeContent(site.domain, backend.line);
    if (regularText(file) !== content) writeFileAtomic(file, content, { mode: 0o644 });
  }
  for (const name of readdirSync(paths.includeDir).filter((entry) => entry.endsWith(".conf"))) {
    const file = join(paths.includeDir, name);
    const domain = name.replace(/\.conf$/, "");
    if (kept.has(file) || regularText(join(paths.vhostDir, name))?.includes(varnishIncludeLine(paths.includeDir, domain))) continue;
    rmSync(file, { force: true });
  }
  return refused;
}

/** The unit's own `ExecStartPre=` and `ExecReload=` lines, which the drop-in runs after the sync. */
function unitLines(ctx: Context): { startPre: string; reload: string } {
  const shown = ctx.run("systemctl", ["show", "-p", "FragmentPath", "--value", ctx.paths.unit]);
  const fragment = shown.ok ? regularText(shown.stdout.trim()) : null;
  const lines = fragment?.split("\n") ?? [];
  const only = (key: string) => {
    const found = lines.filter((line) => line.startsWith(`${key}=`));
    return found.length === 1 && !found[0]!.endsWith("\\") && found[0] !== `${key}=` ? found[0]! : null;
  };
  const startPre = only("ExecStartPre");
  const reload = only("ExecReload");
  if (!startPre || !reload) failAction(`${ctx.paths.unit} is not the nginx unit this addon knows`);
  return { startPre, reload };
}

export function varnishDropIn(bin: string, startPre: string, reload: string): string {
  return [
    "# Managed by clp-addons System Tweaks: writes each site's checked Varnish backend before nginx loads the vhosts.",
    "[Service]",
    "ExecStartPre=",
    `ExecStartPre=-${bin} sync-varnish`,
    startPre,
    "ExecReload=",
    `ExecReload=-${bin} sync-varnish`,
    reload,
    "",
  ].join("\n");
}

function daemonReload(ctx: Context): void {
  const reloaded = ctx.run("systemctl", ["daemon-reload"]);
  if (!reloaded.ok) failAction(`systemctl daemon-reload failed: ${(reloaded.stderr || reloaded.stdout).trim()}`);
}

function expectedDropIn(ctx: Context): string {
  const { startPre, reload } = unitLines(ctx);
  return varnishDropIn(ctx.paths.bin, startPre, reload);
}

/**
 * Swap the placeholder for the site's include in each stored vhost, or back.
 * A rendered vhost follows when its placeholders can be read back from it;
 * otherwise CloudPanel renders it from the stored one on its next save.
 */
function stageVhosts(db: Database, changes: NginxChange[], paths: VarnishBackendPaths, enabled: boolean): void {
  for (const site of sites(db)) {
    const line = varnishIncludeLine(paths.includeDir, site.domain);
    const template = enabled ? site.template.replaceAll(VARNISH_PLACEHOLDER, line) : site.template.replaceAll(line, VARNISH_PLACEHOLDER);
    const path = join(paths.vhostDir, `${site.domain}.conf`);
    if (enabled && template !== site.template && existsSync(path)) {
      let backup: ReturnType<typeof trustedVhost> | null = null;
      try { backup = trustedVhost(path, paths.vhostUid); } catch { /* left for CloudPanel to render */ }
      const learned = backup ? learnVhostMapContent(site.template, backup.content).map : null;
      const rendered = learned ? renderVhostBodyResult(template, learned).value : null;
      if (backup && rendered !== null) changes.push({ backup, content: rendered + (backup.content.endsWith("\n") ? "\n" : "") });
    }
    if (!enabled && regularText(path)?.includes(line)) {
      // Refused when it is not root's alone, since the include it names is about to go.
      const backup = trustedVhost(path, paths.vhostUid);
      const backend = varnishBackend(site.varnish, readVarnishSettings(paths.homeRoot, site.user));
      changes.push({ backup, content: backup.content.replaceAll(line, backend.line) });
    }
    if (template !== site.template) {
      db.query("UPDATE site SET vhost_template = ?, updated_at = CURRENT_TIMESTAMP WHERE domain_name = ?").run(template, site.domain);
    }
  }
}

function withVhosts(ctx: Context, enabled: boolean): boolean {
  const db = openPanelDatabase(ctx.paths.panelDb);
  try {
    return withNginxTransaction(db, { nginx: "nginx", systemctl: "systemctl" }, ctx.run,
      (changes) => stageVhosts(db, changes, ctx.paths, enabled)).changed;
  } finally {
    db.close();
  }
}

/**
 * Write the includes, run the sync before every nginx start and reload, then
 * point each site's vhost at its include. Returns whether anything changed.
 */
export function installVarnishBackends(options: VarnishBackendOptions = {}): boolean {
  const ctx = contextOf(options);
  const dropIn = expectedDropIn(ctx);
  syncVarnishBackends(options);
  let changed = false;
  if (regularText(ctx.paths.dropIn) !== dropIn) {
    writeFileAtomic(ctx.paths.dropIn, dropIn, { mode: 0o644, createParent: true });
    daemonReload(ctx);
    changed = true;
  }
  return withVhosts(ctx, true) || changed;
}

/** Put the placeholder back in every vhost, then remove the sync and the includes. */
export function removeVarnishBackends(options: VarnishBackendOptions = {}): boolean {
  const ctx = contextOf(options);
  const dropIn = regularText(ctx.paths.dropIn);
  if (dropIn === null && !existsSync(ctx.paths.includeDir)) return false;
  if (dropIn !== null) {
    rmSync(ctx.paths.dropIn, { force: true });
    daemonReload(ctx);
  }
  try {
    withVhosts(ctx, false);
  } catch (error) {
    if (dropIn !== null) {
      writeFileAtomic(ctx.paths.dropIn, dropIn, { mode: 0o644, createParent: true });
      daemonReload(ctx);
    }
    throw error;
  }
  // A vhost CloudPanel rendered from the old stored one meanwhile still names its include.
  for (const name of existsSync(ctx.paths.includeDir) ? readdirSync(ctx.paths.includeDir) : []) {
    const domain = name.replace(/\.conf$/, "");
    if (!regularText(join(ctx.paths.vhostDir, name))?.includes(varnishIncludeLine(ctx.paths.includeDir, domain))) {
      rmSync(join(ctx.paths.includeDir, name), { recursive: true, force: true });
    }
  }
  if (existsSync(ctx.paths.includeDir) && readdirSync(ctx.paths.includeDir).length === 0) rmSync(ctx.paths.includeDir, { recursive: true });
  return true;
}

/** In force when the sync runs before nginx loads, and no site's vhost is left for CloudPanel to fill from the file. */
export function varnishBackendsActive(options: VarnishBackendOptions = {}): boolean {
  const ctx = contextOf(options);
  try {
    if (regularText(ctx.paths.dropIn) !== expectedDropIn(ctx)) return false;
    return withPanelDb(ctx.paths.panelDb, sites).every((site) => !site.template.includes(VARNISH_PLACEHOLDER)
      && (!site.template.includes(varnishIncludeLine(ctx.paths.includeDir, site.domain)) || existsSync(join(ctx.paths.includeDir, `${site.domain}.conf`))));
  } catch {
    return false;
  }
}
