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

export function sitesWithoutMaintenance(db: Database, paths: {
  nginxVhostDir: string; vhostUid: number; includePath: string;
}): string[] {
  return maintenanceSites(db).flatMap((site) => {
    try {
      const domain = siteDomain(site);
      const rendered = readFileSync(join(paths.nginxVhostDir, `${domain}.conf`), "utf8");
      if (optedOut(rendered) && !rendered.includes("include /etc/nginx/global_settings")) return [];
      return [rendered, site.vhost_template].every((content) => {
        const block = servingBlock(content, domain);
        return includes(block, "/etc/nginx/global_settings") !== includes(block, paths.includePath);
      }) ? [] : [domain];
    } catch { return [site.domain_name]; }
  });
}
