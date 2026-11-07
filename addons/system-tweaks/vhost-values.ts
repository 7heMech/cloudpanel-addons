/**
 * Stored site settings that `vhost-guard.php` would refuse today. The guard
 * only sees new saves, so a value written before it was in place stays in the
 * vhost CloudPanel renders; a Varnish server a site's own user wrote is left out
 * of it by varnish-backend.ts. These are the guard's rules again;
 * `tests/fixtures/vhost-guard-values.json` holds both to the same answers.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { withPanelDb } from "../../lib/panel-db";
import { PANEL_DB } from "../../lib/paths";

export type VhostValueRule =
  | "rootDirectory" | "botName" | "blockedIp" | "allowedIps" | "additionalConfiguration"
  | "varnishServer" | "reverseProxyUrl" | "port";

function ip(value: string): boolean {
  const parts = value.split("/");
  if (parts.length > 2) return false;
  const v6 = parts[0]!.includes(":");
  if (isIP(parts[0]!) !== (v6 ? 6 : 4)) return false;
  return parts.length === 1 || (/^[0-9]{1,3}$/.test(parts[1]!) && Number(parts[1]) <= (v6 ? 128 : 32));
}

// Byte-for-byte the patterns in vhost-guard.php; JavaScript strings stand in
// for PHP's bytes, so non-ASCII is any code point above 0x7F.
export const VHOST_VALUE_RULES: Record<VhostValueRule, (value: string) => boolean> = {
  rootDirectory: (value) => value === "" || (Buffer.byteLength(value) <= 255
    && value.replace(/\/+$/, "").split("/").every((folder) => folder !== "." && folder !== ".." && /^[A-Za-z0-9._~@+\u0080-\u{10FFFF}-]+$/u.test(folder))),
  botName: (value) => /^[A-Za-z0-9 ._/:-]{1,125}$/.test(value),
  blockedIp: ip,
  allowedIps: (value) => value === "" || value.split(",").every((part) => ip(part.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, ""))),
  additionalConfiguration: (value) => /^[^"\\{}$\x00-\x08\x0B\x0C\x0E-\x1F\x7F]*$/.test(value),
  varnishServer: (value) => /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$/.test(value.replace(/^\/+|\/+$/g, "")),
  reverseProxyUrl: (value) => /^https?:\/\/[A-Za-z0-9._~:/?[\]@!&()*+,=%-]+$/i.test(value),
  port: (value) => /^[0-9]{1,5}$/.test(value),
};

export interface StoredVhostValue {
  domain: string;
  /** What the panel calls it. */
  field: string;
}

export interface VhostValuesOptions {
  panelDb?: string;
  homeRoot?: string;
}

const FIELDS: { field: string; rule: VhostValueRule; sql: string }[] = [
  { field: "Root Directory", rule: "rootDirectory", sql: "SELECT domain_name, root_directory AS value FROM site" },
  { field: "Reverse proxy URL", rule: "reverseProxyUrl", sql: "SELECT domain_name, reverse_proxy_url AS value FROM site WHERE reverse_proxy_url IS NOT NULL" },
  { field: "Blocked bot", rule: "botName", sql: "SELECT s.domain_name, b.name AS value FROM blocked_bot b JOIN site s ON s.id = b.site_id" },
  { field: "Blocked IP", rule: "blockedIp", sql: "SELECT s.domain_name, b.ip AS value FROM blocked_ip b JOIN site s ON s.id = b.site_id" },
  { field: "Basic auth whitelisted IPs", rule: "allowedIps", sql: "SELECT s.domain_name, a.whitelisted_ips AS value FROM site s JOIN basic_auth a ON a.id = s.basic_auth_id WHERE a.whitelisted_ips IS NOT NULL" },
  { field: "Additional configuration directives", rule: "additionalConfiguration", sql: "SELECT s.domain_name, p.additional_configuration AS value FROM php_settings p JOIN site s ON s.id = p.site_id WHERE p.additional_configuration IS NOT NULL" },
  { field: "Node.js port", rule: "port", sql: "SELECT s.domain_name, n.port AS value FROM nodejs_settings n JOIN site s ON s.id = n.site_id" },
  { field: "Python port", rule: "port", sql: "SELECT s.domain_name, p.port AS value FROM python_settings p JOIN site s ON s.id = p.site_id" },
];

/** A site's Varnish settings file, as its own user left it; null when there is none to read. */
export function readVarnishSettings(homeRoot: string, user: string): Record<string, unknown> | null {
  if (!/^[a-z][-a-z0-9_]+$/i.test(user)) return null;
  let fd: number;
  try {
    // The site's user owns this directory and can swap the file at any moment,
    // so the open follows no link and waits on no FIFO, and the checks are of what was opened.
    fd = openSync(join(homeRoot, user, ".varnish-cache", "settings.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 64 * 1024) return null;
    const settings = JSON.parse(readFileSync(fd, "utf8"));
    return settings !== null && typeof settings === "object" && !Array.isArray(settings) ? settings : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export function storedVhostValues(options: VhostValuesOptions = {}): StoredVhostValue[] {
  const found: StoredVhostValue[] = [];
  withPanelDb(options.panelDb ?? PANEL_DB, (db) => {
    for (const { field, rule, sql } of FIELDS) {
      for (const row of db.query(sql).all() as { domain_name: string; value: unknown }[]) {
        if (!VHOST_VALUE_RULES[rule](String(row.value ?? ""))) found.push({ domain: row.domain_name, field });
      }
    }
    // Every site's, not only those with Varnish on: switching it on later renders the file.
    for (const row of db.query("SELECT domain_name, user FROM site").all() as { domain_name: string; user: string }[]) {
      const server = readVarnishSettings(options.homeRoot ?? "/home", row.user)?.server;
      if (typeof server === "string" && !VHOST_VALUE_RULES.varnishServer(server)) found.push({ domain: row.domain_name, field: "Varnish server" });
    }
  });
  return found;
}
