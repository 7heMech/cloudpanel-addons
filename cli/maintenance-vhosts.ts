import { nginxServers, type NginxBlock } from "./nginx-config";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeIdentityHostname } from "./action-common";
import { trustedVhost, type NginxChange } from "./nginx-transaction";

export const MAINTENANCE_INCLUDE_PATH = "/etc/nginx/clp-addons-maintenance.conf";
const START = "# clp-addons:maintenance-include:start";
const END = "# clp-addons:maintenance-include:end";
const BLOCK = /\r?\n[ \t]*# clp-addons:maintenance-include:start\r?\n[ \t]*include [^\r\n]+;\r?\n[ \t]*# clp-addons:maintenance-include:end[ \t]*\r?\n/g;

function servingBlock(content: string, domain: string): NginxBlock {
  const candidates = nginxServers(content).filter((block) => block.directives.some(({ words }) =>
    words[0] === "server_name" && (words[1] === domain || words[1] === "{{server_name}}")) &&
    !block.directives.some(({ words }) => words[0] === "return" && /^30[1278]$/.test(words[1] ?? "")));
  const backends = candidates.filter((block) => block.directives.some(({ words }) =>
    words[0] === "listen" && /^(?:.*:)?8080$/.test(words[1] ?? "")));
  const selected = backends.length ? backends : candidates;
  if (selected.length !== 1) throw new Error(`${domain}: serving Nginx server block is missing or ambiguous`);
  return selected[0]!;
}

/** A vhost that names global_settings, by including it or by saying why it does not, has made its own choice. */
function optedOut(content: string): boolean {
  return content.includes("global_settings");
}

function includes(block: NginxBlock, path: string): boolean {
  return block.directives.some(({ words }) => words[0] === "include" && words[1] === path);
}

export function transformMaintenanceVhost(content: string, domain: string, enabled: boolean, includePath = MAINTENANCE_INCLUDE_PATH): string {
  const clean = content.replace(BLOCK, "");
  if (clean.includes(START) || clean.includes(END)) throw new Error(`${domain}: malformed maintenance include marker`);
  if (!enabled || optedOut(clean)) return clean;
  const block = servingBlock(clean, domain);
  if (includes(block, includePath)) throw new Error(`${domain}: unmanaged maintenance include`);
  const newline = clean.includes("\r\n") ? "\r\n" : "\n";
  const injected = ["", `  ${START}`, `  include ${includePath};`, `  ${END}`, ""].join(newline);
  return clean.slice(0, block.open) + injected + clean.slice(block.open);
}

interface SiteRow { domain_name: string; vhost_template: string }

function maintenanceSites(db: Database): SiteRow[] {
  return db.query<SiteRow, []>("SELECT domain_name, vhost_template FROM site ORDER BY domain_name;").all();
}

function siteDomain(site: SiteRow): string {
  const domain = normalizeIdentityHostname(site.domain_name);
  if (!domain || domain !== site.domain_name) throw new Error("CloudPanel returned an invalid site domain");
  return domain;
}

export function stageMaintenanceVhosts(db: Database, changes: NginxChange[], paths: {
  nginxVhostDir: string; vhostUid: number; includePath: string;
}, enabled: boolean): void {
  for (const site of maintenanceSites(db)) {
    // A site this cannot place the check in is left as it is and reported by sitesWithoutMaintenance.
    let staged: { template: string; change: NginxChange | null; domain: string };
    try {
      const domain = siteDomain(site);
      const template = transformMaintenanceVhost(site.vhost_template, domain, enabled, paths.includePath);
      const path = join(paths.nginxVhostDir, `${domain}.conf`);
      let rendered: string | null;
      try { rendered = readFileSync(path, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        rendered = null;
      }
      let change: NginxChange | null = null;
      if (rendered !== null && transformMaintenanceVhost(rendered, domain, enabled, paths.includePath) !== rendered) {
        const backup = trustedVhost(path, paths.vhostUid);
        change = { backup, content: transformMaintenanceVhost(backup.content, domain, enabled, paths.includePath) };
      }
      staged = { template, change, domain };
    } catch {
      continue;
    }
    if (staged.change) changes.push(staged.change);
    if (staged.template !== site.vhost_template) {
      db.query("UPDATE site SET vhost_template = ?, updated_at = CURRENT_TIMESTAMP WHERE domain_name = ?;").run(staged.template, staged.domain);
    }
  }
}

interface CoveragePaths { nginxVhostDir: string; includePath: string; settingsMissing?: boolean }

/**
 * Why Nginx does not run the maintenance check for a site, or null when it
 * does. With `settingsMissing`, a vhost that includes the absent
 * global_settings is not covered by it.
 */
function siteGap(site: SiteRow, paths: CoveragePaths): { reason: string; optedOut?: true } | null {
  let domain: string;
  let rendered: string;
  try {
    domain = siteDomain(site);
    rendered = readFileSync(join(paths.nginxVhostDir, `${domain}.conf`), "utf8");
  } catch { return { reason: "Nginx has no vhost for it yet" }; }
  if (optedOut(rendered) && !rendered.includes("include /etc/nginx/global_settings")) {
    return { reason: "its vhost opts out of Nginx's global settings", optedOut: true };
  }
  try {
    return [rendered, site.vhost_template].every((content) => {
      const block = servingBlock(content, domain);
      const viaSettings = includes(block, "/etc/nginx/global_settings");
      return paths.settingsMissing ? !viaSettings && includes(block, paths.includePath) : viaSettings !== includes(block, paths.includePath);
    }) ? null : { reason: "its vhost does not include the check" };
  } catch { return { reason: "its vhost has no single server block for it" }; }
}

/** Why Nginx runs no maintenance check for one site, or null when it does or the site is unknown. */
export function maintenanceGap(db: Database, domain: string, paths: CoveragePaths): string | null {
  const site = db.query<SiteRow, [string]>("SELECT domain_name, vhost_template FROM site WHERE lower(domain_name) = ? LIMIT 1;").get(domain);
  return site ? siteGap(site, paths)?.reason ?? null : null;
}

/** Every site Nginx runs no maintenance check for, opted-out ones included, with why. */
export function maintenanceGaps(db: Database, paths: CoveragePaths): Map<string, string> {
  const gaps = new Map<string, string>();
  for (const site of maintenanceSites(db)) {
    const gap = siteGap(site, paths);
    if (gap) gaps.set(site.domain_name, gap.reason);
  }
  return gaps;
}

/** The sites status reports as uncovered: a vhost that opted out made its own choice. */
export function sitesWithoutMaintenance(db: Database, paths: CoveragePaths): string[] {
  return maintenanceSites(db).filter((site) => {
    const gap = siteGap(site, paths);
    return gap !== null && !gap.optedOut;
  }).map((site) => site.domain_name);
}
