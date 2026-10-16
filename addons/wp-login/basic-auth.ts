import { Database } from "bun:sqlite";
import { lstatSync, readFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { join } from "node:path";
import { failAction, runCommand, type CommandResult } from "../../cli/action-common";
import { writeFileAtomic } from "../../lib/atomic-write";

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

function allows(value: string | null, ip: string): boolean {
  if (!ip) return false;
  const list = new BlockList();
  for (const entry of entries(value)) {
    const [address, prefix, extra] = entry.split("/");
    const version = isIP(address!);
    if (!version || extra !== undefined || (prefix !== undefined && !/^\d+$/.test(prefix))) {
      failAction("CloudPanel's basic-auth IP allowlist contains an invalid address");
    }
    try {
      const family = version === 4 ? "ipv4" : "ipv6";
      if (prefix === undefined) list.addAddress(address!, family);
      else list.addSubnet(address!, Number(prefix), family);
    } catch {
      failAction("CloudPanel's basic-auth IP allowlist contains an invalid network");
    }
  }
  return list.check(ip, isIP(ip) === 4 ? "ipv4" : "ipv6");
}

export function basicAuthBlocks(paths: BasicAuthPaths, domain: string, ip: string): boolean {
  const db = new Database(paths.panelDb, { readonly: true });
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
  const pattern = new RegExp(block.map((line) => `[ \\t]*${escaped(line)}[ \\t]*`).join("\\r?\\n"), "g");
  const matches = [...content.matchAll(pattern)];
  const authLines = [...content.matchAll(/^[ \t]*auth_basic[ \t]+(?!off\s*;)/gm)];
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

export async function withBasicAuthBypass<T>(
  paths: BasicAuthPaths,
  domain: string,
  ip: string,
  mint: () => T,
  finish: () => Promise<void>,
  run: (command: string, args: string[]) => CommandResult = runCommand,
  reload: typeof reloadNginx = reloadNginx,
): Promise<T> {
  const db = new Database(paths.panelDb);
  db.exec("PRAGMA busy_timeout = 5000;");
  let backup: { path: string; content: string; mode: number; uid: number; gid: number } | undefined;
  let wrote = false;
  let reloaded = false;
  const check = (command: string, args: string[], label: string) => {
    const result = run(command, args);
    if (!result.ok) throw new Error(`${label}: ${(result.stderr || result.stdout || "command failed").trim()}`);
  };
  try {
    db.exec("BEGIN IMMEDIATE;");
    const row = settings(db, domain);
    if (!row?.is_active || allows(row.whitelisted_ips, ip)) {
      const login = mint();
      await finish();
      db.exec("COMMIT;");
      return login;
    }
    const path = join(paths.nginxVhostDir, `${domain}.conf`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.uid !== paths.vhostUid || (stat.mode & 0o022) !== 0) {
      failAction("refusing an untrusted Nginx vhost");
    }
    backup = { path, content: readFileSync(path, "utf8"), mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid };
    const next = [...entries(row.whitelisted_ips), ip];
    const content = basicAuthVhost(backup.content, domain, row.whitelisted_ips, next);
    db.query("UPDATE basic_auth SET whitelisted_ips = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(next.join(","), row.id);
    writeFileAtomic(path, content, { mode: backup.mode, owner: backup });
    wrote = true;
    check(paths.nginx, ["-t"], "Nginx validation failed");
    const login = mint();
    reloaded = true;
    await reload(() => check(paths.systemctl, ["reload", "nginx"], "Nginx reload failed"));
    await finish();
    db.exec("COMMIT;");
    return login;
  } catch (error) {
    const failures: string[] = [];
    try { db.exec("ROLLBACK;"); } catch (e) { failures.push(String(e)); }
    if (wrote && backup) {
      try {
        writeFileAtomic(backup.path, backup.content, { mode: backup.mode, owner: backup });
        check(paths.nginx, ["-t"], "Nginx rollback validation failed");
        if (reloaded) await reload(() => check(paths.systemctl, ["reload", "nginx"], "Nginx rollback reload failed"));
      } catch (e) { failures.push(String(e)); }
    }
    if (failures.length) throw new Error(`${error instanceof Error ? error.message : error}; rollback failed: ${failures.join("; ")}`);
    throw error;
  } finally {
    db.close();
  }
}
