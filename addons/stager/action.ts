// There is deliberately no --password and no --mfa
import {
  existsSync,
  mkdirSync,
  chmodSync,
  chownSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
  readdirSync,
  statSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  createActionContext,
  readPanelIdentity,
  validateDomain,
  validatePort,
  validateFlag,
  validateJobId,
  validateEmail,
  validateMfa,
  acquireDomainLock,
  DEFAULT_LOCK_DIR,
  type ActionContext,
} from "../../lib/action-common";

export const DATA_BASE_DIR = process.env.DATA_BASE_DIR || "/var/lib/clp-addons/stager";
export function getJobsDir(): string { return process.env.JOBS_DIR || join(process.env.DATA_BASE_DIR || "/var/lib/clp-addons/stager", "jobs"); }
export const DEFAULT_LOCK_DIR_PATH = process.env.LOCK_DIR || DEFAULT_LOCK_DIR;
export const PANEL_DB = process.env.PANEL_DB || "/home/clp/htdocs/app/data/db.sq3";
export const CLPCTL = process.env.CLPCTL || "/usr/bin/clpctl";
export function getNginxVhostDir(): string { return process.env.NGINX_VHOST_DIR || "/etc/nginx/sites-enabled"; }
export const INSTATIC_WRAPPER = process.env.INSTATIC_WRAPPER || "/usr/local/libexec/clp-addons/clp-action-instatic";
export const INSTATIC_DATA_DIR = process.env.INSTATIC_DATA_DIR || "/var/lib/clp-addons/instatic";
export const CLONABLE_TYPES = ["php", "static", "reverse-proxy"] as const;

export function applicationOk(a: string): boolean {
  return /^[A-Za-z0-9]([A-Za-z0-9 ._-]{0,62}[A-Za-z0-9])?$/.test(a);
}

export function typeIsClonable(t: string): boolean {
  return (CLONABLE_TYPES as readonly string[]).includes(t);
}

export function siteUserFor(domain: string): string {
  const d = domain.toLowerCase();
  const readable = d.replace(/[^a-z0-9]/g, "").slice(0, 8);
  const hash = Bun.CryptoHasher.hash("sha256", d, "hex").slice(0, 6);
  return `addon-${readable}-${hash}`;
}

export function dbNameFor(domain: string): string {
  const d = domain.toLowerCase();
  const readable = d.replace(/[^a-z0-9]/g, "").slice(0, 8);
  const hash = Bun.CryptoHasher.hash("sha256", d, "hex").slice(0, 6);
  return `stg${readable}${hash}`;
}

export function dbUserFor(domain: string): string {
  const d = domain.toLowerCase();
  const readable = d.replace(/[^a-z0-9]/g, "").slice(0, 8);
  const hash = Bun.CryptoHasher.hash("sha256", d, "hex").slice(0, 6);
  return `u${readable}${hash}`;
}

export function userTaken(user: string): boolean {
  try {
    execFileSync("getent", ["passwd", user], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function genPassword(): string {
  const raw = randomBytes(24).toString("base64").replace(/[^a-zA-Z0-9]/g, "");
  return `Aa1${raw.slice(0, 16)}!`;
}

export function genDbPassword(): string {
  let res = "";
  while (res.length < 24) {
    res += randomBytes(24).toString("base64").replace(/[^a-zA-Z0-9]/g, "");
  }
  return res.slice(0, 24);
}

export function newJobId(): string {
  const now = new Date();
  const y = now.getUTCFullYear().toString().padStart(4, "0");
  const m = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = now.getUTCDate().toString().padStart(2, "0");
  const hh = now.getUTCHours().toString().padStart(2, "0");
  const mm = now.getUTCMinutes().toString().padStart(2, "0");
  const ss = now.getUTCSeconds().toString().padStart(2, "0");
  const hex = randomBytes(3).toString("hex");
  return `${y}${m}${d}T${hh}${mm}${ss}Z-${hex}`;
}

function getPanelDb(): Database | null {
  if (!existsSync(PANEL_DB)) return null;
  try {
    return new Database(PANEL_DB, { readonly: true });
  } catch {
    return null;
  }
}

export function siteExists(domain: string): boolean {
  const db = getPanelDb();
  if (!db) return false;
  try {
    const row = db.query("SELECT COUNT(*) as cnt FROM site WHERE domain_name = ?").get(domain) as { cnt: number } | null;
    return (row?.cnt ?? 0) > 0;
  } finally {
    db.close();
  }
}

export function siteRow(domain: string): { type: string; user: string; rootDirectory: string; application: string } | null {
  const db = getPanelDb();
  if (!db) return null;
  try {
    const row = db.query("SELECT type, user, root_directory, COALESCE(application, '') as application FROM site WHERE domain_name = ?").get(domain) as {
      type: string;
      user: string;
      root_directory: string;
      application: string;
    } | null;
    if (!row) return null;
    return {
      type: row.type,
      user: row.user,
      rootDirectory: row.root_directory,
      application: row.application,
    };
  } finally {
    db.close();
  }
}

export function phpVersionOf(domain: string): string | null {
  const db = getPanelDb();
  if (!db) return null;
  try {
    const row = db.query("SELECT p.php_version FROM php_settings p JOIN site s ON s.id = p.site_id WHERE s.domain_name = ?").get(domain) as { php_version: string } | null;
    return row?.php_version ?? null;
  } finally {
    db.close();
  }
}

export function databaseOf(domain: string): string | null {
  const db = getPanelDb();
  if (!db) return null;
  try {
    const row = db.query("SELECT d.name FROM database d JOIN site s ON s.id = d.site_id WHERE s.domain_name = ? ORDER BY d.id LIMIT 1").get(domain) as { name: string } | null;
    return row?.name ?? null;
  } finally {
    db.close();
  }
}

export function vhostOf(domain: string): string | null {
  const vhostDir = getNginxVhostDir();
  if (existsSync(join(vhostDir, `${domain}.conf`))) {
    return readFileSync(join(vhostDir, `${domain}.conf`), "utf8");
  }
  if (existsSync(join(vhostDir, domain))) {
    return readFileSync(join(vhostDir, domain), "utf8");
  }
  const db = getPanelDb();
  if (!db) return null;
  try {
    const row = db.query("SELECT vhost_template FROM site WHERE domain_name = ?").get(domain) as { vhost_template: string } | null;
    return row?.vhost_template ?? null;
  } finally {
    db.close();
  }
}

export function applicationOf(domain: string): string {
  const db = getPanelDb();
  if (!db) return "";
  try {
    const row = db.query("SELECT COALESCE(application, '') as application FROM site WHERE domain_name = ?").get(domain) as { application: string } | null;
    return row?.application ?? "";
  } finally {
    db.close();
  }
}

export function reverseProxyUrlOf(domain: string): string {
  const db = getPanelDb();
  if (!db) return "";
  try {
    const row = db.query("SELECT COALESCE(reverse_proxy_url, '') as url FROM site WHERE domain_name = ?").get(domain) as { url: string } | null;
    return row?.url ?? "";
  } finally {
    db.close();
  }
}

export function instaticMeta(domain: string, field: string): string | null {
  const file = join(INSTATIC_DATA_DIR, domain, "meta.json");
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const val = data[field];
    return val !== undefined && val !== null ? String(val) : null;
  } catch {
    return null;
  }
}

function getInstaticCmd(): string[] {
  if (process.env.INSTATIC_WRAPPER) return [process.env.INSTATIC_WRAPPER];
  if (existsSync("/usr/local/libexec/clp-addons/clp-action-instatic")) {
    return ["/usr/local/libexec/clp-addons/clp-action-instatic"];
  }
  return [process.env.CLP_ADDONS_BIN || "/usr/local/bin/clp-addons", "action", "instatic"];
}

export function instaticBackendOf(domain: string): { ok: true; port: number; tag: string } | { ok: false; reject: string } {
  const instaticInstalled = process.env.INSTATIC_WRAPPER
    ? existsSync(process.env.INSTATIC_WRAPPER)
    : (existsSync("/usr/local/libexec/clp-addons/clp-action-instatic") || existsSync("/etc/clp-addons/instatic.conf"));
  if (!instaticInstalled) {
    return { ok: false, reject: "the Instatic addon is not installed on this server, so there is no supported way to duplicate the backend" };
  }
  const metaFile = join(INSTATIC_DATA_DIR, domain, "meta.json");
  if (!existsSync(metaFile)) {
    return { ok: false, reject: "its backend is not an Instatic instance this box manages; cloning would point the staging hostname at the live application" };
  }
  const portStr = instaticMeta(domain, "port") ?? "";
  const tag = instaticMeta(domain, "tag") ?? "";
  if (!/^[0-9]{1,5}$/.test(portStr) || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(tag)) {
    return { ok: false, reject: `the Instatic record for ${domain} is incomplete` };
  }
  const port = parseInt(portStr, 10);
  const url = reverseProxyUrlOf(domain);
  if (url !== `http://127.0.0.1:${port}`) {
    return { ok: false, reject: `it proxies '${url}' rather than the Instatic instance recorded for it; cloning would point the staging hostname at whatever that is` };
  }
  return { ok: true, port, tag };
}

export function jobDir(id: string): string {
  return join(getJobsDir(), id);
}

export function jobGet(dir: string, field: string): string {
  const file = join(dir, field);
  if (!existsSync(file)) return "";
  try {
    const buf = readFileSync(file);
    return buf.subarray(0, 4096).toString("utf8").replace(/\n/g, "");
  } catch {
    return "";
  }
}

export function jobSet(dir: string, field: string, value: string): void {
  const file = join(dir, field);
  writeFileSync(file, `${value}\n`, { mode: 0o600 });
}

export function jobStateFor(target: string): string | null {
  if (!existsSync(getJobsDir())) return null;
  try {
    const entries = readdirSync(getJobsDir()).sort().reverse();
    for (const name of entries) {
      const dir = join(getJobsDir(), name);
      try {
        if (!statSync(dir).isDirectory()) continue;
        if (jobGet(dir, "target") === target) {
          return jobGet(dir, "state") || null;
        }
      } catch {}
    }
  } catch {}
  return null;
}

export function jobJson(dir: string, id: string, panelSites: Set<string> | null): Record<string, unknown> {
  const source = jobGet(dir, "source");
  const target = jobGet(dir, "target");
  const portRaw = jobGet(dir, "port");
  const port = /^[0-9]+$/.test(portRaw) ? parseInt(portRaw, 10) : 0;
  const state = jobGet(dir, "state");
  const step = jobGet(dir, "step");
  const error = jobGet(dir, "error") || null;
  const createdAt = jobGet(dir, "createdAt");
  const startedAt = jobGet(dir, "startedAt") || null;
  const finishedAt = jobGet(dir, "finishedAt") || null;

  let result: unknown = null;
  const resFile = join(dir, "result.json");
  if (existsSync(resFile)) {
    try {
      result = JSON.parse(readFileSync(resFile, "utf8"));
    } catch {}
  }

  let panelSite: boolean | null = null;
  if (panelSites !== null && state === "done") {
    panelSite = panelSites.has(target);
  }

  return {
    id,
    source,
    target,
    port,
    state,
    step,
    error,
    createdAt,
    startedAt,
    finishedAt,
    result,
    panelSite,
  };
}

export function stripRedirectBlock(content: string): string {
  const lines = content.split("\n");
  if (lines.length === 0 || !lines[0]?.startsWith("server {")) {
    return content;
  }
  let depth = 0;
  let inBlock = false;
  let redirect = false;
  const blockLines: string[] = [];
  const resultLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (i === 0 && line.startsWith("server {")) {
      inBlock = true;
      depth = 1;
      blockLines.push(line);
      continue;
    }
    if (inBlock) {
      blockLines.push(line);
      const openMatches = (line.match(/\{/g) || []).length;
      const closeMatches = (line.match(/\}/g) || []).length;
      depth += openMatches - closeMatches;
      if (/return 301/.test(line)) {
        redirect = true;
      }
      if (depth === 0) {
        inBlock = false;
        if (!redirect) {
          resultLines.push(...blockLines);
        }
      }
      continue;
    }
    resultLines.push(line);
  }
  return resultLines.join("\n");
}

export function takeRedirectBlock(content: string): string {
  const lines = content.split("\n");
  if (lines.length === 0 || !lines[0]?.startsWith("server {")) {
    return "";
  }
  let depth = 1;
  let redirect = false;
  const blockLines = [lines[0]];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    blockLines.push(line);
    const openMatches = (line.match(/\{/g) || []).length;
    const closeMatches = (line.match(/\}/g) || []).length;
    depth += openMatches - closeMatches;
    if (/return 301/.test(line)) {
      redirect = true;
    }
    if (depth === 0) {
      return redirect ? blockLines.join("\n") : "";
    }
  }
  return "";
}

export function foldServerName(content: string, domain: string, repl: string): string {
  const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re1 = new RegExp(`^([ \t]*)server_name ${escaped} www1\\.${escaped};[ \t]*$`, "gm");
  const re2 = new RegExp(`^([ \t]*)server_name ${escaped};[ \t]*$`, "gm");
  return content.replace(re1, `$1${repl}`).replace(re2, `$1${repl}`);
}

export function generatedServerName(content: string, domain: string): string {
  const lines = content.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (line === `server_name ${domain};` || line === `server_name ${domain} www1.${domain};`) {
      return line;
    }
  }
  return "";
}

export function replaceHostname(content: string, source: string, target: string): string {
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<=^|[^A-Za-z0-9.-])${escaped}(?=[^A-Za-z0-9-]|$)`, "g");
  return content.replace(re, target);
}

export function vhostShape(body: string, domain: string): string {
  const stripped = stripRedirectBlock(body);
  const folded = foldServerName(stripped, domain, "server_name {GENERATED};");
  return folded
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

export function vhostDiffers(source: string, target: string, srcUser: string, stgUser: string): boolean {
  const aRaw = vhostOf(source);
  const bRaw = vhostOf(target);
  if (!aRaw || !bRaw) return false;
  let a = vhostShape(aRaw, source);
  const b = vhostShape(bRaw, target);
  a = a.split(source).join(target);
  a = a.split(srcUser).join(stgUser);
  return a !== b;
}

export function serverNameHosts(body: string): string[] {
  const hosts: string[] = [];
  let inq = "";
  let tok = "";
  let naming = false;

  const flush = (t: string) => {
    if (t === "") return;
    if (naming) {
      hosts.push(t.toLowerCase());
      return;
    }
    if (t === "server_name") {
      naming = true;
    }
  };

  const n = body.length;
  for (let i = 0; i < n; i++) {
    const c = body[i];
    if (inq !== "") {
      if (c === "\\") {
        i++;
        if (i < n) tok += body[i];
        continue;
      }
      if (c === inq) {
        inq = "";
        continue;
      }
      tok += c;
      continue;
    }
    if (c === '"' || c === "'") {
      if (tok !== "") {
        return ["\x01quote-inside-token"];
      }
      inq = c;
      continue;
    }
    if (c === "#") {
      if (tok === "") {
        while (i < n && body[i] !== "\n") i++;
        continue;
      }
      tok += c;
      continue;
    }
    if (c === ";" || c === "{" || c === "}") {
      flush(tok);
      tok = "";
      naming = false;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      flush(tok);
      tok = "";
      continue;
    }
    tok += c;
  }
  flush(tok);
  if (inq !== "") {
    return ["\x01unterminated-quote"];
  }
  return hosts;
}

export function vhostBodyOk(bodyOrFile: string, source: string, target: string): { ok: true } | { ok: false; reject: string } {
  const body = (existsSync(bodyOrFile) && !bodyOrFile.includes("\n") && statSync(bodyOrFile).isFile())
    ? readFileSync(bodyOrFile, "utf8")
    : bodyOrFile;
  const hosts = serverNameHosts(body);
  const t = target.toLowerCase();
  for (const tok of hosts) {
    if (!tok || tok === "{{server_name}}") continue;
    const host = tok.startsWith("*.") ? tok.slice(2) : tok;
    if (host !== t && !host.endsWith(`.${t}`)) {
      return { ok: false, reject: `a server_name names '${tok}', which is not ${target} or below it` };
    }
  }
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundaryRe = new RegExp(`(^|[^A-Za-z0-9.-])${escaped}([^A-Za-z0-9-]|$)`, "i");
  const lines = body.split("\n");
  let leaks = 0;
  for (const line of lines) {
    if (boundaryRe.test(line)) leaks++;
  }
  if (leaks > 0) {
    return { ok: false, reject: `the source hostname still appears on ${leaks} line(s) after substitution` };
  }
  return { ok: true };
}

export function vhostTemplateBody(source: string, target: string): string {
  const body = vhostOf(source) || "";
  let cand = stripRedirectBlock(body);
  cand = foldServerName(cand, source, "{{server_name}}");
  cand = replaceHostname(cand, source, target);
  return cand;
}

export function vhostTemplateOk(tplOrFile: string, source: string, target: string): { ok: true } | { ok: false; reject: string } {
  const tpl = (existsSync(tplOrFile) && !tplOrFile.includes("\n") && statSync(tplOrFile).isFile())
    ? readFileSync(tplOrFile, "utf8")
    : tplOrFile;
  if (!tpl.includes("{{server_name}}")) {
    return { ok: false, reject: "the template does not contain the {{server_name}} placeholder" };
  }
  return vhostBodyOk(tpl, source, target);
}

export function learnVhostMap(
  stored: string,
  rendered: string,
): { ok: true; map: Record<string, string> } | { ok: false; reject: string } {
  const out = rendered.replace(/\n$/, "");
  const tpl = stored;

  const lits: string[] = [];
  const keys: string[] = [];
  let rest = tpl;

  while (rest.includes("{{")) {
    const openIdx = rest.indexOf("{{");
    lits.push(rest.slice(0, openIdx));
    rest = rest.slice(openIdx + 2);
    const closeIdx = rest.indexOf("}}");
    if (closeIdx === -1) {
      return { ok: false, reject: "the clone's stored vhost has an unterminated placeholder" };
    }
    const raw = rest.slice(0, closeIdx);
    rest = rest.slice(closeIdx + 2);
    if (!/^[a-zA-Z0-9_]+$/.test(raw)) {
      return { ok: false, reject: `the clone's stored vhost has a placeholder named '${raw}'` };
    }
    keys.push(raw);
  }
  lits.push(rest);

  const n = keys.length;
  if (n === 0) return { ok: true, map: {} };

  for (let i = 1; i < n; i++) {
    if (lits[i] === "") {
      return {
        ok: false,
        reject: `the clone's stored vhost puts {{${keys[i - 1]}}} and {{${keys[i]}}} next to each other, which cannot be read apart`,
      };
    }
  }

  // Forwards
  const fwd: Record<string, string> = {};
  let o = out;
  for (let i = 0; i < n; i++) {
    const lit = lits[i]!;
    const key = keys[i]!;
    if (!o.startsWith(lit)) {
      return { ok: false, reject: `the rendered vhost diverges from the stored one before {{${key}}}` };
    }
    o = o.slice(lit.length);
    let value: string;
    if (i + 1 < n) {
      const tail = lits[i + 1]!;
      const idx = o.indexOf(tail);
      if (idx === -1) {
        return { ok: false, reject: `the rendered vhost has nothing matching the text after {{${key}}}` };
      }
      value = o.slice(0, idx);
    } else {
      const tail = lits[n]!;
      if (tail !== "" && !o.endsWith(tail)) {
        return { ok: false, reject: `the rendered vhost does not end with the text after {{${key}}}` };
      }
      value = tail ? o.slice(0, o.length - tail.length) : o;
    }
    o = o.slice(value.length);
    if (key in fwd && fwd[key] !== value) {
      return { ok: false, reject: `{{${key}}} was rendered two different ways in one vhost` };
    }
    fwd[key] = value;
  }
  if (o !== lits[n]) {
    return { ok: false, reject: "the rendered vhost does not end where the stored one does" };
  }

  // Backwards
  const bwd: Record<string, string> = {};
  let p = out;
  const tailEnd = lits[n]!;
  if (tailEnd !== "") {
    if (!p.endsWith(tailEnd)) {
      return { ok: false, reject: "the rendered vhost does not end where the stored one does" };
    }
    p = p.slice(0, p.length - tailEnd.length);
  }
  for (let i = n - 1; i >= 0; i--) {
    const lit = lits[i]!;
    const key = keys[i]!;
    let value: string;
    if (lit === "") {
      value = p;
      p = "";
    } else {
      const idx = p.lastIndexOf(lit);
      if (idx === -1) {
        return { ok: false, reject: `the rendered vhost has nothing matching the text before {{${key}}}` };
      }
      value = p.slice(idx + lit.length);
      p = p.slice(0, idx);
    }
    if (key in bwd && bwd[key] !== value) {
      return { ok: false, reject: `{{${key}}} was rendered two different ways in one vhost` };
    }
    bwd[key] = value;
  }
  if (p !== "") {
    return { ok: false, reject: "the rendered vhost does not begin where the stored one does" };
  }

  for (const key of Object.keys(fwd)) {
    if (bwd[key] !== fwd[key]) {
      return {
        ok: false,
        reject: `{{${key}}} could be read out of the clone's vhost in more than one way, so where it ends is a guess`,
      };
    }
  }

  return { ok: true, map: fwd };
}

export function renderVhostBody(
  body: string,
  map: Record<string, string>,
): { ok: true; out: string; body: string } | { ok: false; reject: string } {
  let rest = body;
  let out = "";
  while (rest.includes("{{")) {
    const openIdx = rest.indexOf("{{");
    out += rest.slice(0, openIdx);
    rest = rest.slice(openIdx + 2);
    const closeIdx = rest.indexOf("}}");
    if (closeIdx === -1) {
      return { ok: false, reject: "the composed vhost has an unterminated placeholder" };
    }
    const raw = rest.slice(0, closeIdx);
    rest = rest.slice(closeIdx + 2);
    if (!/^[a-zA-Z0-9_]+$/.test(raw)) {
      return {
        ok: false,
        reject: `the source's vhost has a placeholder named '${raw}', which CloudPanel matches but never fills; it would render here and be blanked the next time the panel regenerates the site`,
      };
    }
    if (!(raw in map)) {
      return { ok: false, reject: `the source's vhost uses {{${raw}}}, which CloudPanel did not put in the clone's own` };
    }
    out += map[raw];
  }
  out += rest;
  return { ok: true, out, body: out };
}

export function composeVhostBody(
  source: string,
  target: string,
): { ok: true; body: string } | { ok: false; reject: string } {
  const srcBody = vhostOf(source);
  const tgtBody = vhostOf(target);
  if (!srcBody || !tgtBody) {
    return { ok: false, reject: "the panel has no stored vhost for one of the two sites" };
  }
  const nameLine = generatedServerName(tgtBody, target);
  if (!nameLine) {
    return { ok: false, reject: "the clone's own vhost has no generated server_name line to copy" };
  }
  let cand = stripRedirectBlock(srcBody);
  cand = foldServerName(cand, source, nameLine);
  cand = replaceHostname(cand, source, target);
  cand = cand.replace(/^\s*\n+/, "");
  if (!cand) {
    return { ok: false, reject: "the source's vhost was empty once its generated parts were removed" };
  }
  const redirect = takeRedirectBlock(tgtBody);
  if (redirect) {
    return { ok: true, body: `${redirect}\n\n${cand}\n` };
  }
  return { ok: true, body: cand };
}

function makeClpStage(): string | null {
  try {
    const stage = execFileSync("mktemp", ["-d", "/tmp/clp-stager-stage.XXXXXX"], { encoding: "utf8" }).trim();
    try {
      execFileSync("chown", ["root:clp", stage], { stdio: "ignore" });
      chmodSync(stage, 0o750);
    } catch {}
    return stage;
  } catch {
    return null;
  }
}

export function panelUpdateSite(
  target: string,
  type: string,
  application: string,
  bodyFile?: string,
  siteCreated = true,
): { ok: true } | { ok: false; reject: string } {
  if (!siteCreated) {
    return { ok: false, reject: "refusing to write the panel record of a site this job did not create" };
  }
  if (!existsSync(PANEL_DB)) {
    return { ok: false, reject: "the panel database is not readable" };
  }
  if (!applicationOk(application)) {
    return { ok: false, reject: `refusing to record \"${application}\" as the clone's application: not a name CloudPanel could have written` };
  }
  if (bodyFile && !existsSync(bodyFile)) {
    return { ok: false, reject: "the composed vhost was not staged" };
  }

  const stage = makeClpStage();
  if (!stage) {
    return { ok: false, reject: "a staging directory for the panel write could not be created" };
  }

  try {
    const appFile = join(stage, "application");
    writeFileSync(appFile, application, { mode: 0o640 });
    try {
      execFileSync("chown", ["root:clp", appFile], { stdio: "ignore" });
    } catch {}

    const setVhost = bodyFile ? `vhost_template = CAST(readfile('${bodyFile}') AS TEXT), ` : "";
    const sql = `PRAGMA busy_timeout=5000;
UPDATE site
   SET ${setVhost}application = CAST(readfile('${appFile}') AS TEXT),
       updated_at = datetime('now')
 WHERE domain_name = '${target}' AND type = '${type}';`;

    try {
      execFileSync("runuser", ["-u", "clp", "--", "sqlite3", PANEL_DB, sql], { stdio: ["ignore", "ignore", "pipe"] });
    } catch {
      return { ok: false, reject: "the panel database refused the update" };
    }

    let check = "0";
    try {
      const checkSql = bodyFile
        ? `SELECT CASE WHEN vhost_template = CAST(readfile('${bodyFile}') AS TEXT)
                        AND application = CAST(readfile('${appFile}') AS TEXT) THEN 1 ELSE 0 END
             FROM site WHERE domain_name = '${target}';`
        : `SELECT CASE WHEN application = CAST(readfile('${appFile}') AS TEXT) THEN 1 ELSE 0 END
             FROM site WHERE domain_name = '${target}';`;
      const out = execFileSync("sqlite3", ["-readonly", PANEL_DB, checkSql], { encoding: "utf8" }).trim();
      check = out;
    } catch {}

    if (check !== "1") {
      return { ok: false, reject: "the panel record does not read back as it was written" };
    }
    return { ok: true };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export function recoverCarriedVhosts(ctx: ActionContext): number {
  let recovered = 0;
  if (!existsSync(getNginxVhostDir())) return 0;

  try {
    for (const file of readdirSync(getNginxVhostDir())) {
      if (!file.endsWith(".conf.clp-stager-bak")) continue;
      const bak = join(getNginxVhostDir(), file);
      const domain = file.slice(0, -".conf.clp-stager-bak".length);
      const state = jobStateFor(domain);
      if (state === "queued" || state === "running") continue;
      if (state === "done") {
        try { unlinkSync(bak); } catch {}
        continue;
      }
      ctx.warn(`restoring the stock vhost for ${domain}: a clone was interrupted while carrying one across`);
      const targetConf = join(getNginxVhostDir(), `${domain}.conf`);
      try {
        copyFileSync(bak, targetConf);
        try { chownSync(targetConf, 0, 0); } catch {}
        try { chmodSync(targetConf, 0o644); } catch {}
        recovered++;
      } catch {
        ctx.warn(`could not restore the stock vhost for ${domain}`);
      }
      try { unlinkSync(bak); } catch {}
    }
  } catch {}

  if (recovered > 0) {
    let nginxOk = false;
    try {
      execFileSync("nginx", ["-t"], { stdio: "ignore" });
      nginxOk = true;
    } catch {}

    if (nginxOk) {
      try {
        execFileSync("systemctl", ["reload", "nginx"], { stdio: "ignore" });
      } catch {
        ctx.warn(`nginx did not reload after recovering ${recovered} vhost(s)`);
      }
    } else {
      ctx.warn(`nginx still rejects its configuration after recovering ${recovered} vhost(s); not reloading`);
    }
  }

  return recovered;
}

export async function cmdSites(ctx: ActionContext): Promise<void> {
  const db = getPanelDb();
  if (!db) {
    ctx.emitOk({ sites: [] });
    return;
  }
  try {
    const rows = db.query(`
      SELECT s.domain_name, s.type, s.user, COALESCE(p.php_version, '') as php_version,
             COALESCE(s.application, '') as application,
             (SELECT COUNT(*) FROM database d WHERE d.site_id = s.id) as dbs
        FROM site s LEFT JOIN php_settings p ON p.site_id = s.id
       WHERE s.type IN ('php','static','reverse-proxy')
       ORDER BY s.domain_name;
    `).all() as Array<{
      domain_name: string;
      type: string;
      user: string;
      php_version: string;
      application: string;
      dbs: number;
    }>;

    const sites: unknown[] = [];
    for (const r of rows) {
      if (r.type === "reverse-proxy") {
        const backend = instaticBackendOf(r.domain_name);
        if (!backend.ok) continue;
      }
      sites.push({
        domain: r.domain_name,
        siteType: r.type,
        siteUser: r.user,
        phpVersion: r.php_version,
        application: r.application,
        databases: r.dbs,
      });
    }
    ctx.emitOk({ sites });
  } finally {
    db.close();
  }
}

export async function cmdDescribe(domain: string, ctx: ActionContext): Promise<void> {
  const row = siteRow(domain);
  if (!row) {
    ctx.emitErr(`no CloudPanel site for ${domain}`);
  }
  if (!typeIsClonable(row.type)) {
    ctx.emitErr(`${domain} is a '${row.type}' site; only ${CLONABLE_TYPES.join(" ")} sites can be cloned`);
  }
  let instatic = false;
  if (row.type === "reverse-proxy") {
    const backend = instaticBackendOf(domain);
    if (!backend.ok) {
      ctx.emitErr(`${domain} cannot be cloned: ${backend.reject}`);
    }
    instatic = true;
  }
  const php = row.type === "php" ? phpVersionOf(domain) ?? "" : "";
  const db = databaseOf(domain) ?? "";
  const siteDir = `/home/${row.user}/htdocs/${domain}`;
  let sizeMb = 0;
  if (existsSync(siteDir)) {
    try {
      const duOut = execFileSync("du", ["-sm", siteDir], { encoding: "utf8" });
      const firstNum = duOut.trim().split(/\s+/)[0];
      sizeMb = parseInt(firstNum ?? "0", 10) || 0;
    } catch {}
  }

  ctx.emitOk({
    domain,
    siteType: row.type,
    instatic,
    siteUser: row.user,
    phpVersion: php,
    application: row.application || "Generic",
    rootDirectory: row.rootDirectory,
    database: db,
    sizeMb,
  });
}

export async function cmdClone(
  source: string,
  target: string,
  tls: string,
  port: string | undefined,
  email: string | undefined,
  ctx: ActionContext,
): Promise<void> {
  if (source === target) {
    ctx.emitErr("the source and the target are the same site");
  }
  if (!siteExists(source)) {
    ctx.emitErr(`no CloudPanel site for ${source}`);
  }
  if (siteExists(target)) {
    ctx.emitErr(`a CloudPanel site for ${target} already exists`);
  }

  const row = siteRow(source);
  if (!row || !typeIsClonable(row.type)) {
    ctx.emitErr(`${source} is a '${row?.type}' site; only ${CLONABLE_TYPES.join(" ")} sites can be cloned`);
  }

  let password = "";
  let mfa = "";
  if (row.type === "reverse-proxy") {
    const backend = instaticBackendOf(source);
    if (!backend.ok) {
      ctx.emitErr(`${source} cannot be cloned: ${backend.reject}`);
    }
    if (!port) {
      ctx.emitErr("cloning an Instatic site needs --port for the clone's own instance");
    }
    validatePort(port, ctx);
    if (!email) {
      ctx.emitErr("cloning an Instatic site needs --email for the source instance's admin account");
    }
    validateEmail(email, ctx);

    // Secrets on stdin: exactly 2 lines
    try {
      const stdinBuf = readFileSync(0);
      const supplied = stdinBuf.toString("utf8");
      const parts = supplied.split("\n");
      if (parts.length < 2 || (parts.length > 3 && (parts.length !== 3 || parts[2] !== ""))) {
        ctx.emitErr("the credential channel takes exactly two lines");
      }
      password = parts[0] ?? "";
      mfa = parts[1] ?? "";
    } catch (e: any) {
      if (e?.message && e.message.includes("credential channel")) throw e;
      ctx.emitErr("the credential channel takes exactly two lines");
    }

    if (!password) {
      ctx.emitErr("cloning an Instatic site needs the source instance's admin password on stdin");
    }
    if (password.length > 256) {
      ctx.emitErr("the password is too long");
    }
    if (mfa) {
      validateMfa(mfa, ctx);
    }
  } else {
    if (port || email) {
      ctx.emitErr("--port and --email apply only to cloning an Instatic site");
    }
  }

  const stgUser = siteUserFor(target);
  if (userTaken(stgUser)) {
    ctx.emitErr(`the site user ${stgUser} already exists; ${target} may be half-created`);
  }

  const lock = await acquireDomainLock(target, ctx, {
    lockDir: DEFAULT_LOCK_DIR_PATH,
    timeoutMs: 30_000,
    prefix: "stager-",
  });

  try {
    if (existsSync(getJobsDir())) {
      for (const name of readdirSync(getJobsDir())) {
        const d = join(getJobsDir(), name);
        try {
          if (!statSync(d).isDirectory()) continue;
          if (jobGet(d, "target") === target) {
            const st = jobGet(d, "state");
            if (st === "queued" || st === "running") {
              ctx.emitErr(`a clone into ${target} is already ${st}`);
            }
          }
        } catch (e: any) {
          if (e?.message && e.message.includes("already")) throw e;
        }
      }
    }

    const id = newJobId();
    const dir = jobDir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);

    jobSet(dir, "source", source);
    jobSet(dir, "target", target);
    jobSet(dir, "tls", tls);
    if (port) jobSet(dir, "port", port);
    if (email) jobSet(dir, "email", email);
    if (mfa) jobSet(dir, "mfa", mfa);
    if (password) jobSet(dir, "srcPassword", password);
    jobSet(dir, "createdAt", new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
    jobSet(dir, "step", "queued");
    jobSet(dir, "state", "queued");
    writeFileSync(join(dir, "log"), "", { mode: 0o600 });

    lock.release();

    const selfCmd = process.env.STAGER_RUNNER
      ? process.env.STAGER_RUNNER.split(" ")
      : process.env.STAGER_WRAPPER
      ? [process.env.STAGER_WRAPPER]
      : process.env.CLP_ADDONS_BIN
      ? [process.env.CLP_ADDONS_BIN, "action", "stager"]
      : existsSync("/usr/local/libexec/clp-addons/clp-action-stager")
      ? ["/usr/local/libexec/clp-addons/clp-action-stager"]
      : ["/usr/local/bin/clp-addons", "action", "stager"];

    const unit = `clp-addon-stager-job-${id}`;
    const desc = `clp-addons: cloning ${source} into ${target}`;
    const runArgs = [
      `--unit=${unit}`,
      `--description=${desc}`,
      "--collect",
      "--property=Type=exec",
      "--",
      ...selfCmd,
      "run",
      "--job",
      id,
    ];

    try {
      execFileSync("systemd-run", runArgs, { stdio: "ignore" });
    } catch {
      jobSet(dir, "error", "could not start the clone job");
      jobSet(dir, "state", "failed");
      try { unlinkSync(join(dir, "srcPassword")); } catch {}
      try { unlinkSync(join(dir, "mfa")); } catch {}
      ctx.emitErr("systemd-run refused to start the clone job");
    }

    ctx.emitOk({ job: id, source, target });
  } finally {
    lock.release();
  }
}

export async function cmdJobs(ctx: ActionContext): Promise<void> {
  const panelSites = new Set<string>();
  const db = getPanelDb();
  if (db) {
    try {
      const rows = db.query("SELECT domain_name FROM site").all() as Array<{ domain_name: string }>;
      for (const r of rows) panelSites.add(r.domain_name);
    } finally {
      db.close();
    }
  }

  const jobs: unknown[] = [];
  if (existsSync(getJobsDir())) {
    const entries = readdirSync(getJobsDir()).sort().reverse();
    for (const name of entries) {
      if (!/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$/.test(name)) continue;
      const d = join(getJobsDir(), name);
      try {
        if (!statSync(d).isDirectory()) continue;
        jobs.push(jobJson(d, name, db ? panelSites : null));
      } catch {}
    }
  }
  ctx.emitOk({ jobs });
}

export async function cmdJob(id: string, ctx: ActionContext): Promise<void> {
  const dir = jobDir(id);
  if (!existsSync(dir)) {
    ctx.emitErr(`no such job: ${id}`);
  }

  const panelSites = new Set<string>();
  const db = getPanelDb();
  if (db) {
    try {
      const rows = db.query("SELECT domain_name FROM site").all() as Array<{ domain_name: string }>;
      for (const r of rows) panelSites.add(r.domain_name);
    } finally {
      db.close();
    }
  }

  const jobData = jobJson(dir, id, db ? panelSites : null);
  let log = "";
  const logFile = join(dir, "log");
  if (existsSync(logFile)) {
    try {
      const lines = readFileSync(logFile, "utf8").split("\n");
      log = lines.slice(-400).join("\n");
    } catch {}
  }

  ctx.emitOk({ job: jobData, log });
}

export async function cmdPrune(ctx: ActionContext): Promise<void> {
  const identity = readPanelIdentity();
  if (!identity) {
    ctx.emitErr("the CloudPanel panel identity is missing or malformed");
  }

  let removed = 0;
  let stuck = 0;
  const now = Date.now();

  if (existsSync(getJobsDir())) {
    for (const name of readdirSync(getJobsDir())) {
      const dir = join(getJobsDir(), name);
      let stat;
      try {
        stat = statSync(dir);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }

      let state = jobGet(dir, "state");
      if (state === "queued" || state === "running") {
        let active = false;
        try {
          execFileSync("systemctl", ["is-active", "--quiet", `clp-addon-stager-job-${name}`], { stdio: "ignore" });
          active = true;
        } catch {
          active = false;
        }

        const ageSeconds = (now - stat.mtimeMs) / 1000;
        if (!active && ageSeconds > 300) {
          ctx.warn(`job ${name} is recorded as ${state} but nothing is running it; marking it failed`);
          jobSet(dir, "error", "the clone job stopped without recording a result");
          jobSet(dir, "state", "failed");
          state = "failed";
          stuck++;
        }
      }

      const ageDays = (now - stat.mtimeMs) / (1000 * 86400);
      if (ageDays > 14) {
        rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    }
  }

  const vhostsRecovered = recoverCarriedVhosts(ctx);

  try {
    const tmp = tmpdir();
    for (const file of readdirSync(tmp)) {
      if (file.startsWith("clp-stager-stage.")) {
        const full = join(tmp, file);
        try {
          const s = statSync(full);
          if ((now - s.mtimeMs) > 24 * 3600 * 1000) {
            rmSync(full, { recursive: true, force: true });
          }
        } catch {}
      }
    }
  } catch {}

  ctx.emitOk({ removed, stuck, vhostsRecovered });
}

export async function cmdRun(jobId: string, ctx: ActionContext): Promise<void> {
  const dir = jobDir(jobId);
  if (!existsSync(dir)) {
    ctx.emitErr(`no such job: ${jobId}`);
  }

  const logFile = join(dir, "log");
  const stepLog = (msg: string) => {
    try {
      appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {}
    ctx.log(msg);
  };

  const failJob = (reason: string): never => {
    stepLog(`FAIL: ${reason}`);
    jobSet(dir, "error", reason);
    jobSet(dir, "state", "failed");
    jobSet(dir, "finishedAt", new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
    try { unlinkSync(join(dir, "srcPassword")); } catch {}
    try { unlinkSync(join(dir, "mfa")); } catch {}
    return ctx.emitErr(reason);
  };

  let source = jobGet(dir, "source");
  let target = jobGet(dir, "target");
  const tls = jobGet(dir, "tls") || "no";
  const portStr = jobGet(dir, "port");
  const email = jobGet(dir, "email");
  const mfa = jobGet(dir, "mfa");

  if (!source || !target) {
    return failJob("job record is incomplete");
  }

  source = validateDomain(source, ctx, { paramName: "source" });
  target = validateDomain(target, ctx, { paramName: "target" });
  jobId = validateJobId(jobId, ctx);
  if (portStr) validatePort(portStr, ctx);
  if (email) validateEmail(email, ctx);
  if (mfa) validateMfa(mfa, ctx);

  const state = jobGet(dir, "state");
  if (state !== "queued") {
    return failJob(`job ${jobId} is ${state}, not queued`);
  }

  const lock = await acquireDomainLock(target, ctx, {
    lockDir: DEFAULT_LOCK_DIR_PATH,
    timeoutMs: 30_000,
    prefix: "stager-",
  });

  let siteCreated = false;
  let siteViaInstatic = false;
  let dbCreated = false;
  let dumpFile = "";
  let stgDbName = "";

  try {
    if (siteExists(target)) {
      return failJob(`a CloudPanel site for ${target} appeared after this clone was queued; nothing was changed`);
    }

    jobSet(dir, "state", "running");
    jobSet(dir, "startedAt", new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));

    const setStep = (s: string) => {
      jobSet(dir, "step", s);
      stepLog(`step: ${s}`);
    };

    setStep("inspecting source site");
    const srcRow = siteRow(source);
    if (!srcRow) return failJob(`no CloudPanel site for ${source}`);
    if (!typeIsClonable(srcRow.type)) return failJob(`${source} is a '${srcRow.type}' site; cannot be cloned`);

    const srcType = srcRow.type;
    const srcUser = srcRow.user;
    let srcApp = srcRow.application;
    const notes: string[] = [];

    if (srcApp && !applicationOk(srcApp)) {
      notes.push(`${source} records an application name this addon will not put in a query or a command line, so the clone was built from Generic instead; check Site -> Vhost on ${source}`);
      ctx.warn(`${source} has an unusable site.application; falling back to Generic`);
      srcApp = "";
    }
    srcApp = srcApp || "Generic";

    let phpVersion = "";
    if (srcType === "php") {
      phpVersion = phpVersionOf(source) || "";
    }
    const srcDb = databaseOf(source);
    const srcDir = `/home/${srcUser}/htdocs/${source}`;

    let srcTag = "";
    if (srcType === "reverse-proxy") {
      const backend = instaticBackendOf(source);
      if (!backend.ok) return failJob(`${source} cannot be cloned: ${backend.reject}`);
      srcTag = backend.tag;
    } else {
      if (!existsSync(srcDir)) {
        return failJob(`source directory ${srcDir} does not exist`);
      }
    }

    // Creating target site
    setStep("creating site");
    const stgUser = siteUserFor(target);
    if (userTaken(stgUser)) return failJob(`site user ${stgUser} already exists`);
    const stgPass = genPassword();

    if (srcType === "php") {
      execFileSync(CLPCTL, [
        "site:add:php",
        `--domainName=${target}`,
        `--phpVersion=${phpVersion}`,
        `--vhostTemplate=${srcApp}`,
        `--siteUser=${stgUser}`,
        `--siteUserPassword=${stgPass}`,
      ]);
      siteCreated = true;
    } else if (srcType === "static") {
      execFileSync(CLPCTL, [
        "site:add:static",
        `--domainName=${target}`,
        `--siteUser=${stgUser}`,
        `--siteUserPassword=${stgPass}`,
      ]);
      siteCreated = true;
    } else if (srcType === "reverse-proxy") {
      const instaticCmd = getInstaticCmd();
      const createOut = execFileSync(instaticCmd[0]!, [
        ...instaticCmd.slice(1),
        "create",
        `--domain=${target}`,
        `--port=${portStr}`,
        `--tag=${srcTag}`,
        `--tls=${tls}`,
      ], { encoding: "utf8" });
      siteViaInstatic = true;
      try {
        const reply = JSON.parse(createOut.trim());
        if (reply?.data?.siteCreatedByAddon === true) {
          siteCreated = true;
        } else {
          notes.push(`the CloudPanel site for ${target} already existed and was adopted rather than created, so its vhost and panel record were left as they were`);
        }
      } catch {}
    }

    // Database copy if applicable
    if (srcDb) {
      setStep("copying database");
      stgDbName = dbNameFor(target);
      const stgDbUser = dbUserFor(target);
      const stgDbPass = genDbPassword();
      dumpFile = join(dir, "dump.sql.gz");

      execFileSync(CLPCTL, ["db:export", `--databaseName=${srcDb}`, `--file=${dumpFile}`]);
      chmodSync(dumpFile, 0o600);

      execFileSync(CLPCTL, [
        "db:add",
        `--domainName=${target}`,
        `--databaseName=${stgDbName}`,
        `--databaseUserName=${stgDbUser}`,
        `--databaseUserPassword=${stgDbPass}`,
      ]);
      dbCreated = true;

      execFileSync(CLPCTL, ["db:import", `--databaseName=${stgDbName}`, `--file=${dumpFile}`]);
      try { unlinkSync(dumpFile); dumpFile = ""; } catch {}
    }

    // File copy
    const destDir = `/home/${stgUser}/htdocs/${target}`;
    if (srcType !== "reverse-proxy") {
      setStep("copying files");
      if (existsSync(srcDir) && existsSync(destDir)) {
        execFileSync("sh", ["-c", `tar -C "${srcDir}" -cf - . | tar -xf - -C "${destDir}"`]);
        execFileSync("chown", ["-R", `${stgUser}:${stgUser}`, destDir]);
      }
    }

    // Rewrite application config if DB copied
    if (srcDb && existsSync(destDir)) {
      const wpConfig = join(destDir, "wp-config.php");
      const dotEnv = join(destDir, ".env");
      if (existsSync(wpConfig)) {
        let content = readFileSync(wpConfig, "utf8");
        content = content.replace(/define\(\s*'DB_NAME',\s*'[^']*'\s*\);/g, `define('DB_NAME', '${stgDbName}');`);
        content = content.replace(/define\(\s*'DB_USER',\s*'[^']*'\s*\);/g, `define('DB_USER', '${dbUserFor(target)}');`);
        content = content.replace(/define\(\s*'DB_PASSWORD',\s*'[^']*'\s*\);/g, `define('DB_PASSWORD', '${genDbPassword()}');`);
        if (content.includes("WP_HOME")) {
          content = content.replace(/define\(\s*'WP_HOME',\s*'[^']*'\s*\);/g, `define('WP_HOME', 'https://${target}');`);
          content = content.replace(/define\(\s*'WP_SITEURL',\s*'[^']*'\s*\);/g, `define('WP_SITEURL', 'https://${target}');`);
        } else {
          content = content.replace(
            /(define\(\s*'DB_PASSWORD'[^\n]*\n)/,
            `$1define('WP_HOME', 'https://${target}');\ndefine('WP_SITEURL', 'https://${target}');\n`,
          );
        }
        writeFileSync(wpConfig, content);
      } else if (existsSync(dotEnv)) {
        let content = readFileSync(dotEnv, "utf8");
        content = content.replace(/^DB_DATABASE=.*/m, `DB_DATABASE=${stgDbName}`);
        content = content.replace(/^DB_USERNAME=.*/m, `DB_USERNAME=${dbUserFor(target)}`);
        writeFileSync(dotEnv, content);
      }
    }

    // TLS Certificate if requested
    if (tls === "yes") {
      setStep("requesting certificate");
      try {
        execFileSync(CLPCTL, ["lets-encrypt:install:certificate", `--domainName=${target}`]);
      } catch {
        notes.push(`the certificate request failed; point ${target} at this server and retry from Site -> SSL/TLS`);
      }
    } else {
      notes.push(`no certificate was requested; ${target} is served with CloudPanel's self-signed one until you issue one`);
    }

    // Record result
    const resultObj = {
      siteType: srcType,
      siteUser: stgUser,
      phpVersion: phpVersion || null,
      vhostTemplate: srcApp,
      vhostCarried: false,
      vhostCarriedBy: "",
      database: srcDb ? { source: srcDb, name: stgDbName, user: dbUserFor(target) } : null,
      instatic: srcType === "reverse-proxy" ? { port: parseInt(portStr || "0", 10), tag: srcTag } : null,
      notes,
    };
    writeFileSync(join(dir, "result.json"), JSON.stringify(resultObj, null, 2), { mode: 0o600 });
    jobSet(dir, "finishedAt", new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
    jobSet(dir, "state", "done");
    stepLog("job completed successfully");
    ctx.emitOk({ job: jobId, status: "done" });
  } catch (err: any) {
    if (dumpFile) {
      try { unlinkSync(dumpFile); } catch {}
    }
    if (dbCreated && stgDbName) {
      try {
        execFileSync(CLPCTL, ["db:delete", `--databaseName=${stgDbName}`, "--force"], { stdio: "ignore" });
      } catch {}
    }
    if (siteViaInstatic) {
      const instaticCmd = getInstaticCmd();
      try {
        execFileSync(instaticCmd[0]!, [...instaticCmd.slice(1), "delete", `--domain=${target}`, `--confirm=${target}`], { stdio: "ignore" });
      } catch {}
    } else if (siteCreated) {
      try {
        execFileSync(CLPCTL, ["site:delete", `--domainName=${target}`, "--force"], { stdio: "ignore" });
      } catch {}
    }
    return failJob(err?.message || "clone job failed");
  } finally {
    lock.release();
  }
}

export async function handleStagerAction(args: string[]): Promise<void> {
  const ctx = createActionContext("stager");

  if (args.length === 0) {
    ctx.emitErr("usage: clp-action-stager {sites|describe|clone|run|job|jobs|prune} [options]");
  }

  const verb = args[0];
  const rest = args.slice(1);

  let source: string | undefined;
  let target: string | undefined;
  let domain: string | undefined;
  let job: string | undefined;
  let tls = "no";
  let tlsExplicit = false;
  let port: string | undefined;
  let email: string | undefined;

  let i = 0;
  while (i < rest.length) {
    const arg = rest[i];
    if (arg === "--source") {
      if (i + 1 >= rest.length) ctx.emitErr("--source needs a value");
      source = rest[++i];
    } else if (arg === "--target") {
      if (i + 1 >= rest.length) ctx.emitErr("--target needs a value");
      target = rest[++i];
    } else if (arg === "--domain") {
      if (i + 1 >= rest.length) ctx.emitErr("--domain needs a value");
      domain = rest[++i];
    } else if (arg === "--job") {
      if (i + 1 >= rest.length) ctx.emitErr("--job needs a value");
      job = rest[++i];
    } else if (arg === "--tls") {
      if (i + 1 >= rest.length) ctx.emitErr("--tls needs a value");
      tls = rest[++i]!;
      tlsExplicit = true;
    } else if (arg === "--port") {
      if (i + 1 >= rest.length) ctx.emitErr("--port needs a value");
      port = rest[++i];
    } else if (arg === "--email") {
      if (i + 1 >= rest.length) ctx.emitErr("--email needs a value");
      email = rest[++i];
    } else {
      ctx.emitErr(`unknown argument: '${arg}'`);
    }
    i++;
  }

  // 1. Verb-level validations
  switch (verb) {
    case "sites":
    case "jobs":
      break;
    case "prune": {
      const identity = readPanelIdentity();
      if (!identity) {
        ctx.emitErr("the CloudPanel panel identity is missing or malformed");
      }
      break;
    }
    case "describe":
      domain = validateDomain(domain, ctx, { paramName: "domain" });
      break;
    case "clone":
      source = validateDomain(source, ctx, { paramName: "source" });
      target = validateDomain(target, ctx, { paramName: "target" });
      validateFlag(tls, "tls", ctx);
      if (port !== undefined) validatePort(port, ctx);
      if (email !== undefined) validateEmail(email, ctx);
      break;
    case "run":
    case "job":
      job = validateJobId(job, ctx);
      break;
    default:
      ctx.emitErr(`unknown verb: '${verb}'`);
  }

  // 2. Reject arguments the verb does not take
  switch (verb) {
    case "clone":
      if (domain !== undefined || job !== undefined) {
        ctx.emitErr("clone takes --source, --target, --tls and, for an Instatic site, --port and --email");
      }
      break;
    case "describe":
      if (source !== undefined || target !== undefined || job !== undefined || tlsExplicit || port !== undefined || email !== undefined) {
        ctx.emitErr("describe takes only --domain");
      }
      break;
    case "run":
    case "job":
      if (source !== undefined || target !== undefined || domain !== undefined || tlsExplicit || port !== undefined || email !== undefined) {
        ctx.emitErr(`${verb} takes only --job`);
      }
      break;
    case "sites":
    case "jobs":
    case "prune":
      if (source !== undefined || target !== undefined || domain !== undefined || job !== undefined || tlsExplicit || port !== undefined || email !== undefined) {
        ctx.emitErr(`${verb} takes no arguments`);
      }
      break;
  }

  // 3. Dispatch to verb implementations
  switch (verb) {
    case "sites":
      await cmdSites(ctx);
      break;
    case "describe":
      await cmdDescribe(domain!, ctx);
      break;
    case "clone":
      await cmdClone(source!, target!, tls, port, email, ctx);
      break;
    case "jobs":
      await cmdJobs(ctx);
      break;
    case "job":
      await cmdJob(job!, ctx);
      break;
    case "prune":
      await cmdPrune(ctx);
      break;
    case "run":
      await cmdRun(job!, ctx);
      break;
  }
}
