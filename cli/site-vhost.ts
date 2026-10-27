/**
 * A CloudPanel site's vhost, replaced the way the panel keeps it: the body,
 * with CloudPanel's `{{placeholders}}`, in the panel database, and that body
 * rendered into `/etc/nginx/sites-enabled/<domain>.conf`. Only the stored body
 * survives the panel writing the file again, as it does for a certificate.
 *
 * The placeholders' values are learned from the site's own stored and
 * rendered vhosts, so a replacement can only use placeholders the panel
 * already fills for that site.
 */
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../lib/atomic-write";
import { runCommand } from "./action-common";

export interface VhostMapResult {
  map: Map<string, string> | null;
  reason: string;
}

export function learnVhostMapContent(template: string, renderedInput: string): VhostMapResult {
  let rendered = renderedInput.replace(/\n$/, "");
  const reject = (reason: string): VhostMapResult => ({ map: null, reason });
  const literals: string[] = [];
  const keys: string[] = [];
  let rest = template;
  while (rest.includes("{{")) {
    const start = rest.indexOf("{{");
    literals.push(rest.slice(0, start));
    rest = rest.slice(start + 2);
    const end = rest.indexOf("}}");
    if (end === -1) return reject("the template has an invalid placeholder");
    const key = rest.slice(0, end);
    rest = rest.slice(end + 2);
    if (!/^[a-zA-Z0-9_]+$/.test(key)) return reject(`the template has an invalid placeholder {{${key}}}`);
    keys.push(key);
  }
  literals.push(rest);
  const count = keys.length;
  if (count === 0) return { map: new Map(), reason: "" };
  for (let index = 1; index < count; index++) {
    if (!literals[index]) return reject(`{{${keys[index - 1]}}} and {{${keys[index]}}} are next to each other`);
  }

  const forward = new Map<string, string>();
  let remaining = rendered;
  for (let index = 0; index < count; index++) {
    const key = keys[index]!;
    const literal = literals[index]!;
    if (!remaining.startsWith(literal)) return reject(`the rendered vhost does not start with the text before {{${key}}}`);
    remaining = remaining.slice(literal.length);
    let value: string;
    if (index + 1 < count) {
      const next = literals[index + 1]!;
      const position = remaining.indexOf(next);
      if (position === -1) return reject(`the rendered vhost does not contain the text after {{${key}}}`);
      value = remaining.slice(0, position);
    } else {
      const tail = literals[count]!;
      if (tail && !remaining.endsWith(tail)) return reject(`the rendered vhost does not end with the text after {{${key}}}`);
      value = tail ? remaining.slice(0, -tail.length) : remaining;
    }
    remaining = remaining.slice(value.length);
    const old = forward.get(key);
    if (old !== undefined && old !== value) return reject(`{{${key}}} resolves more than one way`);
    forward.set(key, value);
  }
  if (remaining !== literals[count]) return reject("the rendered vhost was not consumed completely");

  const backward = new Map<string, string>();
  let before = rendered;
  const finalLiteral = literals[count]!;
  if (finalLiteral) {
    if (!before.endsWith(finalLiteral)) return reject(`the rendered vhost does not end with the text after {{${keys[count - 1]}}}`);
    before = before.slice(0, -finalLiteral.length);
  }
  for (let index = count - 1; index >= 0; index--) {
    const key = keys[index]!;
    const literal = literals[index]!;
    let value: string;
    if (!literal) {
      value = before;
      before = "";
    } else {
      const position = before.lastIndexOf(literal);
      if (position === -1) return reject(`the rendered vhost does not contain the text before {{${key}}}`);
      value = before.slice(position + literal.length);
      before = before.slice(0, position);
    }
    const old = backward.get(key);
    if (old !== undefined && old !== value) return reject(`{{${key}}} resolves more than one way`);
    backward.set(key, value);
  }
  if (before) return reject("the rendered vhost was not consumed completely");

  const result = new Map<string, string>();
  for (const [key, value] of forward) {
    if (backward.get(key) !== value) return reject(`{{${key}}} resolves more than one way`);
    result.set(key, value);
  }
  return { map: result, reason: "" };
}

export function renderVhostBodyResult(body: string, mapping: Map<string, string>): { value: string | null; reason: string } {
  let output = "";
  let rest = body;
  while (rest.includes("{{")) {
    const start = rest.indexOf("{{");
    output += rest.slice(0, start);
    rest = rest.slice(start + 2);
    const end = rest.indexOf("}}");
    if (end === -1) return { value: null, reason: "the template has an invalid placeholder" };
    const key = rest.slice(0, end);
    rest = rest.slice(end + 2);
    if (!/^[a-zA-Z0-9_]+$/.test(key)) return { value: null, reason: `the placeholder {{${key}}} is invalid` };
    if (!mapping.has(key)) return { value: null, reason: `the panel never fills the placeholder {{${key}}}` };
    output += mapping.get(key)!;
  }
  return { value: output + rest, reason: "" };
}

export interface SiteVhostPaths {
  panelDb: string;
  sqlite3: string;
  nginxVhostDir: string;
  /** Where the body is staged for the panel's own user to read. */
  tempDir: string;
}

export const DEFAULT_SITE_VHOST_PATHS: SiteVhostPaths = {
  panelDb: "/home/clp/htdocs/app/data/db.sq3",
  sqlite3: "/usr/bin/sqlite3",
  nginxVhostDir: "/etc/nginx/sites-enabled",
  tempDir: "/tmp",
};

export function storedVhost(panelDb: string, domain: string): string {
  const db = new Database(panelDb, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const row = db.query<{ vhost_template: string | null }, [string]>("SELECT vhost_template FROM site WHERE domain_name = ?").get(domain);
    if (!row?.vhost_template) throw new Error(`CloudPanel has no vhost stored for ${domain}`);
    return row.vhost_template;
  } finally {
    db.close();
  }
}

const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** Writes `body` as the site's vhost, in the panel and on disk; nginx rejecting it, or failing to reload, puts the old one back. */
export function replaceSiteVhost(paths: SiteVhostPaths, domain: string, body: string): void {
  const conf = join(paths.nginxVhostDir, `${domain}.conf`);
  const stored = storedVhost(paths.panelDb, domain);
  const previous = readFileSync(conf, "utf8");
  const learned = learnVhostMapContent(stored, previous);
  if (!learned.map) throw new Error(`the vhost of ${domain} could not be read: ${learned.reason}`);
  const rendered = renderVhostBodyResult(body, learned.map);
  if (rendered.value === null) throw new Error(`the vhost for ${domain} could not be written: ${rendered.reason}`);

  const restore = () => writeFileAtomic(conf, previous, { mode: 0o644 });
  writeFileAtomic(conf, `${rendered.value}\n`, { mode: 0o644 });
  const checked = runCommand("nginx", ["-t"]);
  if (!checked.ok) {
    restore();
    throw new Error(`nginx refused the vhost for ${domain}: ${checked.stderr.trim().split("\n").pop() ?? ""}`);
  }
  try {
    writePanelVhost(paths, domain, body, stored);
  } catch (error) {
    restore();
    throw error;
  }
  if (!runCommand("systemctl", ["reload", "nginx"]).ok) {
    restore();
    writePanelVhost(paths, domain, stored, body);
    runCommand("systemctl", ["reload", "nginx"]);
    throw new Error(`nginx did not reload with the vhost for ${domain}`);
  }
}

/** Through the panel's own user, so a journal left by a crash stays the panel's to recover; read back before it counts. */
function writePanelVhost(paths: SiteVhostPaths, domain: string, body: string, expected: string): void {
  const stage = mkdtempSync(join(paths.tempDir, "clp-addons-vhost."));
  try {
    if (!runCommand("chown", ["root:clp", stage]).ok) throw new Error("the vhost could not be staged for the panel");
    chmodSync(stage, 0o710);
    const file = join(stage, "body");
    writeFileSync(file, body, { mode: 0o640 });
    if (!runCommand("chown", ["root:clp", file]).ok) throw new Error("the vhost could not be staged for the panel");
    const statement = `PRAGMA busy_timeout=5000; UPDATE site SET vhost_template = CAST(readfile(${sqlLiteral(file)}) AS TEXT), updated_at = datetime('now')`
      + ` WHERE domain_name = ${sqlLiteral(domain)} AND vhost_template = CAST(X'${Buffer.from(expected).toString("hex")}' AS TEXT);`;
    const updated = runCommand("runuser", ["-u", "clp", "--", paths.sqlite3, paths.panelDb, statement]);
    if (!updated.ok || storedVhost(paths.panelDb, domain) !== body) throw new Error(`CloudPanel did not keep the vhost for ${domain}`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
