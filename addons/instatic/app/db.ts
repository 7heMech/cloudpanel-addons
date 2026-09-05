import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";

const DB_DIR = process.env.INSTATIC_APP_DATA || "/var/lib/clp-addons/instatic";
if (!existsSync(DB_DIR)) {
  mkdirSync(DB_DIR, { recursive: true });
}

export const db = new Database(`${DB_DIR}/app.db`);

// Initialize schema
db.run(`
  CREATE TABLE IF NOT EXISTS instances (
    domain TEXT PRIMARY KEY,
    port INTEGER NOT NULL,
    tag TEXT NOT NULL,
    container_name TEXT NOT NULL,
    site_user TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

export interface InstanceRecord {
  domain: string;
  port: number;
  tag: string;
  container_name: string;
  site_user: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export const instanceRepo = {
  getAll(): InstanceRecord[] {
    return db.query("SELECT * FROM instances ORDER BY created_at DESC").all() as InstanceRecord[];
  },

  getByDomain(domain: string): InstanceRecord | null {
    return (db.query("SELECT * FROM instances WHERE domain = ?").get(domain) as InstanceRecord) || null;
  },

  insert(inst: InstanceRecord): void {
    db.query(`
      INSERT INTO instances (domain, port, tag, container_name, site_user, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      inst.domain,
      inst.port,
      inst.tag,
      inst.container_name,
      inst.site_user,
      inst.status,
      inst.created_at,
      inst.updated_at
    );
  },

  updateTag(domain: string, tag: string): void {
    const now = new Date().toISOString();
    db.query(`UPDATE instances SET tag = ?, updated_at = ? WHERE domain = ?`).run(tag, now, domain);
  },

  updateStatus(domain: string, status: string): void {
    const now = new Date().toISOString();
    db.query(`UPDATE instances SET status = ?, updated_at = ? WHERE domain = ?`).run(status, now, domain);
  },

  delete(domain: string): void {
    db.query(`DELETE FROM instances WHERE domain = ?`).run(domain);
  }
};
