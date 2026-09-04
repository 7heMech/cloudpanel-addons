import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from "node:fs";

export const SNAPSHOT_FILE = "/var/lib/clp-addons/snapshot.json";
const CLP_DB = "/home/clp/htdocs/app/data/db.sq3";

export interface SanitizedSite {
  domain: string;
  user: string;
  type: string;
}

export interface PanelSnapshot {
  updatedAt: string;
  allocatedPorts: number[];
  sites: SanitizedSite[];
}

export function generateSnapshot(): PanelSnapshot {
  const portsSet = new Set<number>();
  const sites: SanitizedSite[] = [];

  if (existsSync(CLP_DB)) {
    try {
      // 1. Fetch sites
      const rawSites = execSync(
        `sqlite3 -readonly "${CLP_DB}" "SELECT domain_name, user, type FROM site;"`,
        { encoding: "utf-8" }
      );
      for (const line of rawSites.trim().split("\n")) {
        if (!line.trim()) continue;
        const [domain, user, type] = line.split("|");
        sites.push({ domain, user, type });
      }

      // 2. Fetch PHP pool ports
      const rawPhpPorts = execSync(
        `sqlite3 -readonly "${CLP_DB}" "SELECT pool_port FROM php_settings WHERE pool_port IS NOT NULL;"`,
        { encoding: "utf-8" }
      );
      for (const p of rawPhpPorts.trim().split("\n")) {
        const portNum = parseInt(p.trim(), 10);
        if (!isNaN(portNum)) portsSet.add(portNum);
      }

      // 3. Fetch Node.js ports
      const rawNodePorts = execSync(
        `sqlite3 -readonly "${CLP_DB}" "SELECT port FROM nodejs_settings WHERE port IS NOT NULL;"`,
        { encoding: "utf-8" }
      );
      for (const p of rawNodePorts.trim().split("\n")) {
        const portNum = parseInt(p.trim(), 10);
        if (!isNaN(portNum)) portsSet.add(portNum);
      }

      // 4. Fetch Python ports
      const rawPyPorts = execSync(
        `sqlite3 -readonly "${CLP_DB}" "SELECT port FROM python_settings WHERE port IS NOT NULL;"`,
        { encoding: "utf-8" }
      );
      for (const p of rawPyPorts.trim().split("\n")) {
        const portNum = parseInt(p.trim(), 10);
        if (!isNaN(portNum)) portsSet.add(portNum);
      }

      // 5. Fetch Reverse Proxy ports
      const rawRpUrls = execSync(
        `sqlite3 -readonly "${CLP_DB}" "SELECT reverse_proxy_url FROM site WHERE reverse_proxy_url IS NOT NULL AND reverse_proxy_url != '';"`,
        { encoding: "utf-8" }
      );
      for (const url of rawRpUrls.trim().split("\n")) {
        const match = url.match(/:([0-9]{2,5})/);
        if (match) {
          const portNum = parseInt(match[1], 10);
          if (!isNaN(portNum)) portsSet.add(portNum);
        }
      }
    } catch (err) {
      console.error("[ERROR] Reading panel database for snapshot:", err);
    }
  }

  // 6. Add ports from Instatic metadata on disk
  const instaticBase = "/var/lib/clp-addons/instatic";
  if (existsSync(instaticBase)) {
    try {
      const dirs = readdirSync(instaticBase);
      for (const d of dirs) {
        const metaPath = `${instaticBase}/${d}/meta.json`;
        if (existsSync(metaPath)) {
          const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
          if (meta.port) portsSet.add(Number(meta.port));
        }
      }
    } catch {
      // Ignore reading errors
    }
  }

  // 7. Add listening ports from ss -tln
  try {
    const rawListening = execSync("ss -tln", { encoding: "utf-8" });
    const matches = rawListening.matchAll(/:([0-9]{2,5})\s/g);
    for (const m of matches) {
      const portNum = parseInt(m[1], 10);
      if (!isNaN(portNum)) portsSet.add(portNum);
    }
  } catch {
    // Ignore ss failure
  }

  const snapshot: PanelSnapshot = {
    updatedAt: new Date().toISOString(),
    allocatedPorts: Array.from(portsSet).sort((a, b) => a - b),
    sites,
  };

  mkdirSync("/var/lib/clp-addons", { recursive: true });
  writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2), {
    mode: 0o644,
  });

  return snapshot;
}

export function getNextAvailablePort(start = 39000, end = 39999): number {
  const snapshot = existsSync(SNAPSHOT_FILE)
    ? (JSON.parse(readFileSync(SNAPSHOT_FILE, "utf-8")) as PanelSnapshot)
    : generateSnapshot();

  const allocated = new Set(snapshot.allocatedPorts);
  for (let port = start; port <= end; port++) {
    if (!allocated.has(port)) {
      return port;
    }
  }
  throw new Error(`No available ports in range ${start}..${end}`);
}
