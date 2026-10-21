import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeIdentityHostname } from "./action-common";
import { trustedVhost, type NginxChange } from "./nginx-transaction";

export const MAINTENANCE_INCLUDE_PATH = "/etc/nginx/clp-addons-maintenance.conf";
const START = "# clp-addons:maintenance-include:start";
const END = "# clp-addons:maintenance-include:end";
const BLOCK = /\r?\n[ \t]*# clp-addons:maintenance-include:start\r?\n[ \t]*include [^\r\n]+;\r?\n[ \t]*# clp-addons:maintenance-include:end[ \t]*\r?\n/g;

interface Directive {
  words: string[];
}
interface Block {
  words: string[];
  open: number;
  directives: Directive[];
}

function servers(content: string): Block[] {
  const tokens = /\s+|#[^\n]*|\{\{[^}]*\}\}|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:\$\{[^}]+\}|\\.|[^\s{};#"'\\])+|[{};]/gy;
  const stack: Block[] = [];
  const result: Block[] = [];
  let words: string[] = [];
  while (tokens.lastIndex < content.length) {
    const token = tokens.exec(content);
    if (!token) throw new Error("could not parse Nginx vhost");
    const value = token[0];
    if (/^\s|^#/.test(value)) continue;
    if (value.startsWith("{{") && words.length === 0) {
      if (value === "{{server_name}}") stack.at(-1)?.directives.push({ words: ["server_name", value] });
      continue;
    }
    if (value === "{") {
      stack.push({ words, open: token.index + 1, directives: [] });
      words = [];
    } else if (value === "}") {
      const block = stack.pop();
      if (!block) throw new Error("unbalanced Nginx vhost");
      if (stack.length === 0 && block.words.join(" ") === "server") result.push(block);
      words = [];
    } else if (value === ";") {
      stack.at(-1)?.directives.push({ words });
      words = [];
    } else words.push(value.replace(/^(["'])(.*)\1$/s, "$2"));
  }
  if (stack.length || words.length) throw new Error("incomplete Nginx vhost");
  return result;
}

function servingBlock(content: string, domain: string): Block {
  const candidates = servers(content).filter((block) => block.directives.some(({ words }) =>
    words[0] === "server_name" && (words[1] === domain || words[1] === "{{server_name}}")) &&
    !block.directives.some(({ words }) => words[0] === "return" && /^30[1278]$/.test(words[1] ?? "")));
  const backends = candidates.filter((block) => block.directives.some(({ words }) =>
    words[0] === "listen" && /^(?:.*:)?8080$/.test(words[1] ?? "")));
  const selected = backends.length ? backends : candidates;
  if (selected.length !== 1) throw new Error(`${domain}: serving Nginx server block is missing or ambiguous`);
  return selected[0]!;
}

function includes(block: Block, path: string): boolean {
  return block.directives.some(({ words }) => words[0] === "include" && words[1] === path);
}

export function transformMaintenanceVhost(content: string, domain: string, enabled: boolean, includePath = MAINTENANCE_INCLUDE_PATH): string {
  const clean = content.replace(BLOCK, "");
  if (clean.includes(START) || clean.includes(END)) throw new Error(`${domain}: malformed maintenance include marker`);
  if (!enabled) return clean;
  const block = servingBlock(clean, domain);
  if (includes(block, "/etc/nginx/global_settings")) return clean;
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
    const domain = siteDomain(site);
    const template = transformMaintenanceVhost(site.vhost_template, domain, enabled, paths.includePath);
    const path = join(paths.nginxVhostDir, `${domain}.conf`);
    let rendered: string | null;
    try { rendered = readFileSync(path, "utf8"); }
    catch (error) {
      if (enabled || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      rendered = null;
    }
    if (rendered !== null && transformMaintenanceVhost(rendered, domain, enabled, paths.includePath) !== rendered) {
      const backup = trustedVhost(path, paths.vhostUid);
      changes.push({ backup, content: transformMaintenanceVhost(backup.content, domain, enabled, paths.includePath) });
    }
    if (template !== site.vhost_template) {
      db.query("UPDATE site SET vhost_template = ?, updated_at = CURRENT_TIMESTAMP WHERE domain_name = ?;").run(template, domain);
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
      return [rendered, site.vhost_template].every((content) => {
        const block = servingBlock(content, domain);
        return includes(block, "/etc/nginx/global_settings") !== includes(block, paths.includePath);
      }) ? [] : [domain];
    } catch { return [site.domain_name]; }
  });
}
