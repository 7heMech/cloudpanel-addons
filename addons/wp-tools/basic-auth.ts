import { nginxServers, type NginxBlock } from "../../cli/nginx-config";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { join } from "node:path";
import { normalizeMappedIpv4 } from "../../lib/ip-address";
import { ActionFailure, failAction, runCommand, type CommandResult } from "../../cli/action-common";
import { openPanelDatabase, trustedVhost, withNginxTransactionAsync } from "../../cli/nginx-transaction";

export interface BasicAuthPaths {
  panelDb: string;
  nginxVhostDir: string;
  nginx: string;
  systemctl: string;
  vhostUid: number;
}

interface BasicAuthRow {
  id: number;
  is_active: number;
  whitelisted_ips: string | null;
}

function settings(db: Database, domain: string): BasicAuthRow | null {
  return db.query<BasicAuthRow, [string]>(`
    SELECT b.id, b.is_active, b.whitelisted_ips FROM site s
    JOIN basic_auth b ON b.id = s.basic_auth_id WHERE s.domain_name = ?
  `).get(domain);
}

function entries(value: string | null): string[] {
  return value ? value.split(",").map((ip) => ip.trim()).filter(Boolean) : [];
}

function normalizedEntries(value: string | null): string[] {
  return entries(value).map((entry) => entry.includes("/") ? entry : normalizeMappedIpv4(entry));
}

function allows(value: string | null, ip: string): boolean {
  if (!ip) return false;
  ip = normalizeMappedIpv4(ip);
  let allowed = false;
  for (const entry of entries(value)) {
    const [rawAddress, prefix, extra] = entry.split("/");
    const address = prefix === undefined ? normalizeMappedIpv4(rawAddress!) : rawAddress!;
    const version = isIP(address);
    if (!version || extra !== undefined || (prefix !== undefined && !/^\d+$/.test(prefix))) {
      failAction("CloudPanel's basic-auth IP allowlist contains an invalid address");
    }
    try {
      const family = version === 4 ? "ipv4" : "ipv6";
      const entryList = new BlockList();
      if (prefix === undefined) {
        // A stored mapped host needs an approved rewrite before it admits IPv4 in Nginx.
        if (address !== rawAddress && isIP(ip) === 4) continue;
        entryList.addAddress(address, family);
      } else {
        entryList.addSubnet(address, Number(prefix), family);
      }
      if (version === 6 && isIP(ip) === 4) continue;
      if (entryList.check(ip, isIP(ip) === 4 ? "ipv4" : "ipv6")) allowed = true;
    } catch {
      failAction("CloudPanel's basic-auth IP allowlist contains an invalid network");
    }
  }
  return allowed;
}

export function basicAuthBlocks(paths: BasicAuthPaths, domain: string, ip: string): boolean {
  const db = openPanelDatabase(paths.panelDb, true, 1000);
  try {
    const row = settings(db, domain);
    return Boolean(row?.is_active && !allows(row.whitelisted_ips, ip));
  } finally {
    db.close();
  }
}

/** Whether `basicAuthVhost` could add an IP to this site's block, so the offer is never one that is then refused. */
export function basicAuthRewritable(paths: BasicAuthPaths, domain: string): boolean {
  const db = openPanelDatabase(paths.panelDb, true, 1000);
  try {
    const row = settings(db, domain);
    if (!row) return false;
    const { content } = trustedVhost(join(paths.nginxVhostDir, `${domain}.conf`), paths.vhostUid);
    basicAuthVhost(content, domain, row.whitelisted_ips, [...normalizedEntries(row.whitelisted_ips), "192.0.2.1"]);
    return true;
  } catch (error) {
    if (error instanceof ActionFailure) return false;
    throw error;
  } finally {
    db.close();
  }
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Only replace the block CloudPanel renders from basic_auth, preserving the rest of the vhost.
export function basicAuthVhost(content: string, domain: string, previous: string | null, next: string[]): string {
  const before = entries(previous);
  const block = [
    ...(before.length ? ["satisfy any;", ...before.map((ip) => `allow ${ip};`), "deny all;"] : []),
    'auth_basic "Restricted Area";',
    `auth_basic_user_file /etc/nginx/basic-auth/${domain};`,
  ];
  const pattern = new RegExp(block.map((line) => `^[ \\t]*${escaped(line)}[ \\t]*$`).join("\\r?\\n"), "gm");
  const matches = [...content.matchAll(pattern)];
  const refuse = () => failAction("the site's CloudPanel basic-auth block is missing, customized or ambiguous; use Security → Basic Authentication");
  if (matches.length !== 1) refuse();
  const match = matches[0]!;
  const blockStart = match.index;
  const blockEnd = blockStart + match[0].length;
  let servers: NginxBlock[];
  try { servers = nginxServers(content); }
  catch { return refuse(); }
  const server = servers.find((server) => server.open <= blockStart && server.end >= blockEnd);
  if (!server) return refuse();
  const scopes = [...servers];
  for (const scope of scopes) scopes.push(...scope.children);
  const authRules = scopes.flatMap((scope) => scope.directives)
    .filter(({ words }) => words[0] === "auth_basic" && words[1] !== "off");
  if (authRules.length !== 1) refuse();
  if (!server.directives.some(({ words, start }) => words[0] === "auth_basic" && start >= blockStart && start < blockEnd)) refuse();
  const accessRules = new Set(["satisfy", "allow", "deny", "auth_basic", "auth_basic_user_file"]);
  const safeIncludes = new Set([
    "/etc/nginx/global_settings", "/etc/nginx/clp-addons-maintenance.conf",
    "fastcgi_params", "/etc/nginx/fastcgi_params",
  ]);
  const affected = [server];
  // Where `satisfy all;` goes in, so a closed location stays closed to a visitor with the password.
  const closing: number[] = [];
  for (const scope of affected) {
    affected.push(...scope.children);
    const authOff = scope.directives.some(({ words }) => words[0] === "auth_basic" && words[1] === "off");
    if (scope !== server && authOff) continue;
    // CloudPanel's templates close `.git` and `xmlrpc.php` with a lone `deny all`.
    // That location's own rules replace the server's, but it inherits `satisfy any`,
    // which would let the password through; `satisfy all` keeps it denied.
    const rules = scope.directives.filter(({ words }) => accessRules.has(words[0]!)).map(({ words }) => words.join(" "));
    const deny = scope.directives.find(({ words }) => words.join(" ") === "deny all");
    const closed = scope !== server && deny !== undefined
      && (rules.length === 1 || (rules.length === 2 && rules.includes("satisfy all")));
    if (closed && !rules.includes("satisfy all")) closing.push(deny.start);
    for (const { words, start, end } of scope.directives) {
      if (accessRules.has(words[0]!) && !closed && (start < blockStart || end > blockEnd)) refuse();
      if (words[0] === "include" && !safeIncludes.has(words[1]!)) refuse();
    }
  }
  let closedContent = content;
  for (const at of closing.sort((a, b) => b - a)) {
    const indent = /[ \t]*$/.exec(closedContent.slice(0, at))![0];
    closedContent = `${closedContent.slice(0, at)}satisfy all;\n${indent}${closedContent.slice(at)}`;
  }
  const replacement = ["satisfy any;", ...next.map((ip) => `allow ${ip};`), "deny all;", ...block.slice(-2)]
    .map((line) => `  ${line}`).join("\n");
  return closedContent.replace(pattern, () => replacement);
}

export async function reloadNginx(
  signal: () => void,
  pidFile = "/run/nginx.pid",
  procDir = "/proc",
  timeoutMs = 3_000,
): Promise<void> {
  const master = readFileSync(pidFile, "utf8").trim();
  if (!/^[1-9]\d*$/.test(master)) failAction("Nginx's master PID could not be read");
  const workers = () => {
    const children = readFileSync(join(procDir, master, "task", master, "children"), "utf8").trim().split(/\s+/);
    return new Set(children.filter((pid) => {
      if (!/^[1-9]\d*$/.test(pid)) return false;
      try {
        return readFileSync(join(procDir, pid, "cmdline"), "utf8").replaceAll("\0", " ").trim() === "nginx: worker process";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    }));
  };
  const previous = workers();
  if (!previous.size) failAction("Nginx has no active workers; use Security → Basic Authentication");
  signal();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const active = workers();
    if (active.size && [...active].every((pid) => !previous.has(pid))) return;
    await Bun.sleep(25);
  }
  failAction("Nginx did not finish handing requests to its reloaded workers");
}

export async function withBasicAuthBypass(
  paths: BasicAuthPaths,
  domain: string,
  ip: string,
  run: (command: string, args: string[]) => CommandResult = (command, args) => runCommand(command, args, 2_000),
  reload: typeof reloadNginx = reloadNginx,
): Promise<void> {
  ip = normalizeMappedIpv4(ip);
  const db = openPanelDatabase(paths.panelDb, false, 1000);
  try {
    await withNginxTransactionAsync(db, paths, run, (changes) => {
      const row = settings(db, domain);
      if (!row?.is_active || allows(row.whitelisted_ips, ip)) return;
      const path = join(paths.nginxVhostDir, `${domain}.conf`);
      const backup = trustedVhost(path, paths.vhostUid);
      const next = [...new Set([...normalizedEntries(row.whitelisted_ips), ip])];
      const content = basicAuthVhost(backup.content, domain, row.whitelisted_ips, next);
      db.query("UPDATE basic_auth SET whitelisted_ips = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(next.join(","), row.id);
      changes.push({ backup, content });
    }, reload);
  } finally {
    db.close();
  }
}
