import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reconcileNewSites, runCloudflareAction, transformVhost, type CloudflareActionPaths,
} from "../addons/cloudflare-ips/action";
import { CLIENT_JS, dashboardView } from "../addons/cloudflare-ips/app/views";
import type { CommandResult } from "../cli/action-common";

const realUid = process.getuid?.() ?? 0;
const originalGetuid = process.getuid;

beforeEach(() => {
  Object.defineProperty(process, "getuid", { value: () => 0, configurable: true });
});

afterEach(() => {
  Object.defineProperty(process, "getuid", { value: originalGetuid, configurable: true });
});

function vhost(user: string): string {
  return `server {
  listen 443 ssl;
  server_name example.test;
  access_log /home/${user}/logs/nginx/access.log main;
  error_log /home/${user}/logs/nginx/error.log;
  location / { try_files $uri =404; }
}
`;
}

function fixture(): { root: string; paths: CloudflareActionPaths; db: Database } {
  const root = mkdtempSync(join(tmpdir(), "cloudflare-ips-test-"));
  const nginxVhostDir = join(root, "vhosts");
  mkdirSync(nginxVhostDir);
  const panelDb = join(root, "panel.sqlite");
  const db = new Database(panelDb);
  db.exec(`CREATE TABLE site (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_name TEXT UNIQUE NOT NULL,
    user TEXT NOT NULL,
    type TEXT NOT NULL,
    allow_traffic_from_cloudflare_only INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
  return {
    root,
    db,
    paths: {
      panelDb,
      nginxVhostDir,
      policyFile: join(root, "state", "policy.json"),
      lockFile: join(root, "locks", "cloudflare.lock"),
      nginx: "nginx-test",
      systemctl: "systemctl-test",
      vhostUid: realUid,
      stateUid: realUid,
    },
  };
}

function addSite(db: Database, paths: CloudflareActionPaths, domain: string, user: string, enabled = false): number {
  db.query("INSERT INTO site (domain_name, user, type, allow_traffic_from_cloudflare_only) VALUES (?, ?, 'php', ?);")
    .run(domain, user, enabled ? 1 : 0);
  const id = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id;").get()!.id);
  const file = join(paths.nginxVhostDir, `${domain}.conf`);
  writeFileSync(file, transformVhost(vhost(user), user, enabled), { mode: 0o644 });
  chmodSync(file, 0o644);
  return id;
}

const successCommand = (): CommandResult => ({ ok: true, stdout: "", stderr: "", exitCode: 0 });

test("dashboard renders bulk, per-site, and automatic controls with escaped site data", () => {
  const html = dashboardView({
    autoEnableNewSites: true,
    sites: [{ domain: '"><script>alert(1)</script>.example.test', type: "php", enabled: false, excludedFromAutomatic: true }],
  });
  expect(html).toContain("Enable selected");
  expect(html).toContain('id="select-all"');
  expect(html).toContain('id="automatic-policy"');
  expect(html).toContain("Excluded from automatic enabling");
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(() => new Function(CLIENT_JS)).not.toThrow();
});

test("vhost transformation mirrors CloudPanel and is reversible", () => {
  const original = vhost("site-user");
  const enabled = transformVhost(original, "site-user", true);
  expect(enabled).toContain("access.log cloudflare;");
  expect(enabled).toContain("include /etc/nginx/cloudflare/ips;");
  expect(transformVhost(enabled, "site-user", false)).toBe(original);
});

test("bulk updates change every selected row and reload Nginx once", async () => {
  const f = fixture();
  const commands: string[] = [];
  try {
    addSite(f.db, f.paths, "one.example.test", "one");
    addSite(f.db, f.paths, "two.example.test", "two");
    f.db.close();
    const code = await runCloudflareAction(["set", "--enabled", "yes"], {
      paths: f.paths,
      input: JSON.stringify({ domains: ["one.example.test", "two.example.test"] }),
      emitReply: false,
      run(command, args) {
        commands.push([command, ...args].join(" "));
        return successCommand();
      },
    });
    expect(code).toBe(0);
    const verify = new Database(f.paths.panelDb, { readonly: true });
    expect(verify.query<{ total: number }, []>("SELECT SUM(allow_traffic_from_cloudflare_only) AS total FROM site;").get()!.total).toBe(2);
    verify.close();
    expect(readFileSync(join(f.paths.nginxVhostDir, "one.example.test.conf"), "utf8")).toContain(CLOUDFLARE_MARKER);
    expect(readFileSync(join(f.paths.nginxVhostDir, "two.example.test.conf"), "utf8")).toContain(CLOUDFLARE_MARKER);
    expect(commands).toEqual(["nginx-test -t", "systemctl-test reload nginx"]);
  } finally {
    try { f.db.close(); } catch {}
    rmSync(f.root, { recursive: true, force: true });
  }
});

const CLOUDFLARE_MARKER = "include /etc/nginx/cloudflare/ips;";

test("failed Nginx validation rolls the database and vhost back", async () => {
  const f = fixture();
  let checks = 0;
  try {
    addSite(f.db, f.paths, "rollback.example.test", "rollback");
    f.db.close();
    const original = readFileSync(join(f.paths.nginxVhostDir, "rollback.example.test.conf"), "utf8");
    const code = await runCloudflareAction(["set", "--enabled", "yes"], {
      paths: f.paths,
      input: JSON.stringify({ domains: ["rollback.example.test"] }),
      emitReply: false,
      run(command) {
        if (command === "nginx-test" && checks++ === 0) return { ok: false, stdout: "", stderr: "bad config", exitCode: 1 };
        return successCommand();
      },
    });
    expect(code).toBe(1);
    const verify = new Database(f.paths.panelDb, { readonly: true });
    expect(verify.query<{ enabled: number }, []>("SELECT allow_traffic_from_cloudflare_only AS enabled FROM site;").get()!.enabled).toBe(0);
    verify.close();
    expect(readFileSync(join(f.paths.nginxVhostDir, "rollback.example.test.conf"), "utf8")).toBe(original);
  } finally {
    try { f.db.close(); } catch {}
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("automatic policy enables new site IDs and keeps hostname exceptions off", async () => {
  const f = fixture();
  try {
    addSite(f.db, f.paths, "exception.example.test", "exception");
    f.db.close();
    expect(await runCloudflareAction(["policy", "--enabled", "yes"], {
      paths: f.paths, emitReply: false,
    })).toBe(0);
    expect(await runCloudflareAction(["set", "--enabled", "no"], {
      paths: f.paths,
      input: JSON.stringify({ domains: ["exception.example.test"] }),
      emitReply: false,
      run: successCommand,
    })).toBe(0);

    const changed = new Database(f.paths.panelDb);
    changed.query("DELETE FROM site WHERE domain_name = ?;").run("exception.example.test");
    addSite(changed, f.paths, "exception.example.test", "exception-new");
    addSite(changed, f.paths, "new.example.test", "new-site");
    changed.close();

    const result = await reconcileNewSites(f.paths, successCommand);
    expect(result).toEqual({ discovered: 2, enabled: 1 });
    const verify = new Database(f.paths.panelDb, { readonly: true });
    const rows = verify.query<{ domain: string; enabled: number }, []>(
      "SELECT domain_name AS domain, allow_traffic_from_cloudflare_only AS enabled FROM site ORDER BY domain_name;",
    ).all();
    verify.close();
    expect(rows).toEqual([
      { domain: "exception.example.test", enabled: 0 },
      { domain: "new.example.test", enabled: 1 },
    ]);
    expect(readFileSync(join(f.paths.nginxVhostDir, "exception.example.test.conf"), "utf8")).not.toContain(CLOUDFLARE_MARKER);
    expect(readFileSync(join(f.paths.nginxVhostDir, "new.example.test.conf"), "utf8")).toContain(CLOUDFLARE_MARKER);
  } finally {
    try { f.db.close(); } catch {}
    rmSync(f.root, { recursive: true, force: true });
  }
});
