// Privileged side of decision 2.7.
//
// The port-collision check needs the panel's site list, but the panel database
// also holds password hashes and site credentials, and the app's site user
// cannot read /home/clp at all. So this runs as root, reads non-secret columns
// only, and writes a sanitized JSON snapshot that the app consumes. The app
// must never import this file.

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync, renameSync, chmodSync } from "node:fs";
import { PORT_RANGE, SNAPSHOT_FILE, type PanelSnapshot, type SanitizedSite } from "./snapshot-reader";

const PANEL_DB = "/home/clp/htdocs/app/data/db.sq3";
const INSTATIC_DATA = "/var/lib/clp-addons/instatic";

function query(sql: string): string[] {
  try {
    return execFileSync("sqlite3", ["-readonly", PANEL_DB, sql], { encoding: "utf-8" })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    // A table that does not exist on this CloudPanel version is not an error;
    // it just contributes no ports.
    return [];
  }
}

export function generateSnapshot(): PanelSnapshot {
  if (process.getuid && process.getuid() !== 0) {
    throw new Error("generateSnapshot must run as root; the app reads the snapshot file instead");
  }

  const ports = new Set<number>();
  const sites: SanitizedSite[] = [];

  const addPort = (raw: string | undefined) => {
    const n = Number.parseInt((raw ?? "").trim(), 10);
    if (Number.isInteger(n) && n > 0 && n < 65536) ports.add(n);
  };

  if (existsSync(PANEL_DB)) {
    // Non-secret columns only. Never SELECT from the user table.
    for (const row of query("SELECT domain_name, user, type FROM site;")) {
      const [domain, user, type] = row.split("|");
      if (domain) sites.push({ domain, user: user ?? "", type: type ?? "" });
    }

    for (const p of query("SELECT pool_port FROM php_settings WHERE pool_port IS NOT NULL;")) addPort(p);
    for (const p of query("SELECT port FROM nodejs_settings WHERE port IS NOT NULL;")) addPort(p);
    for (const p of query("SELECT port FROM python_settings WHERE port IS NOT NULL;")) addPort(p);

    for (const url of query(
      "SELECT reverse_proxy_url FROM site WHERE reverse_proxy_url IS NOT NULL AND reverse_proxy_url != '';"
    )) {
      // Match the port only at the end of the authority, so a scheme or a path
      // segment containing digits cannot be mistaken for one.
      const m = url.match(/:(\d{2,5})(?:\/|$)/);
      if (m) addPort(m[1]);
    }
  }

  // Ports this addon has already handed out, which the panel does not know about.
  if (existsSync(INSTATIC_DATA)) {
    for (const entry of readdirSync(INSTATIC_DATA)) {
      const meta = `${INSTATIC_DATA}/${entry}/meta.json`;
      if (!existsSync(meta)) continue;
      try {
        addPort(String(JSON.parse(readFileSync(meta, "utf-8")).port));
      } catch {
        // A half-written meta file should not abort the whole snapshot.
      }
    }
  }

  // Anything currently listening, whoever owns it.
  try {
    const ss = execFileSync("ss", ["-tlnH"], { encoding: "utf-8" });
    for (const m of ss.matchAll(/:(\d{2,5})\s/g)) addPort(m[1]);
  } catch {
    // ss absent is survivable; the database and disk scans still apply.
  }

  const snapshot: PanelSnapshot = {
    updatedAt: new Date().toISOString(),
    portRange: PORT_RANGE,
    allocatedPorts: [...ports].sort((a, b) => a - b),
    sites,
  };

  mkdirSync("/var/lib/clp-addons", { recursive: true });

  // Write then rename, so a reader never sees a truncated file. 0640 because
  // the site list is customer data: the app's group may read it, nobody else.
  const tmp = `${SNAPSHOT_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o640 });
  chmodSync(tmp, 0o640);
  renameSync(tmp, SNAPSHOT_FILE);

  return snapshot;
}
