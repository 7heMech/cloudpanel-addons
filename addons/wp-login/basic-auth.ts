import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { join } from "node:path";
import { normalizeMappedIpv4 } from "../../lib/ip-address";
import { failAction, runCommand, type CommandResult } from "../../cli/action-common";
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
  const authLines = [...content.matchAll(/^[ \t]*auth_basic\s+([^;]+);/gm)]
    .filter((match) => match[1]!.trim() !== "off");
  if (matches.length !== 1 || authLines.length !== 1) {
    failAction("the site's CloudPanel basic-auth block is missing, customized or ambiguous; use Security → Basic Authentication");
  }
  const replacement = ["satisfy any;", ...next.map((ip) => `allow ${ip};`), "deny all;", ...block.slice(-2)]
    .map((line) => `  ${line}`).join("\n");
  return content.replace(pattern, () => replacement);
}

export async function reloadNginx(
  signal: () => void,
  pidFile = "/run/nginx.pid",
  procDir = "/proc",
  timeoutMs = 5_000,
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
  run: (command: string, args: string[]) => CommandResult = runCommand,
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
