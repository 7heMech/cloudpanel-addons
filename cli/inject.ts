// Panel-side anchor management, for every installed addon.
//
// CloudPanel's Twig templates are proprietary, so none of them are ever stored
// in this repo (brief section 6). The pristine copy is snapshotted off the
// running box into /var/lib/clp-addons, patched from there, and hashed there.
//
// Two rules from section 8 make re-injection safe to repeat:
//
//   1. Always regenerate from the pristine snapshot. Patching a file that may
//      already be patched eventually double-applies or corrupts it.
//   2. Hash the pristine template. The panel's PHP is obfuscated and cannot be
//      diffed, but Twig is plain text. If upstream's copy stops matching the
//      recorded hash, CloudPanel has touched the file our patch targets, so we
//      stop and flag rather than applying a patch built for the old markup.
//
// The snapshot lives outside /home/clp/htdocs/app on purpose: cloudpanel.postinst
// moves that whole directory aside and extracts a fresh copy on upgrade, so a
// pristine backup kept next to the template is destroyed by the very event it
// exists to survive.
//
// What is new here is that a template is shared. The pristine copy is keyed by
// the template file, not by the addon patching it, and rendering re-applies
// every addon's snippet in one pass. Keying it per addon looked equivalent with
// one addon installed and was not: the second addon to install snapshotted a
// file that already contained the first addon's block, with that block stripped
// as if it were ours, so installing it silently deleted the first addon's nav
// entry -- and then the two reconciliation timers overwrote each other every
// fifteen minutes, forever.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, realpathSync } from "node:fs";
import {
  NGINX_PROXY_STATE_DIR, NGINX_SITES_DIR, TEMPLATE_STATE_DIR, TEMPLATES_DIR, TWIG_CACHE_DIR,
  type AddonTarget,
} from "./paths";
import { writeAtomic } from "./util";

// CloudPanel versions this patch's markup assumptions were verified against.
// A version outside this list is not fatal, but the hash gate below is what
// actually stops us on a markup change.
export const KNOWN_GOOD_PANEL_VERSIONS = ["2.5.4-3+clp-bookworm"];

/**
 * One addon's request to patch one template.
 *
 * The addon supplies markup and nothing else. Markers are added here rather
 * than by the addon, so two addons cannot pick the same ones -- which is how
 * uninstalling one used to strip the other's block as well.
 */
export interface Injection {
  addon: string;
  target: AddonTarget;
  url: string;
}

/**
 * Where the templates and their snapshots live.
 *
 * The only reason this is a parameter rather than two constants is that the
 * tests must never touch the panel's own files, nor need root to write under
 * /var/lib. Production callers pass nothing.
 */
export interface InjectPaths {
  templatesDir: string;
  stateDir: string;
}

function resolvePaths(p?: Partial<InjectPaths>): InjectPaths {
  return {
    templatesDir: p?.templatesDir ?? TEMPLATES_DIR,
    stateDir: p?.stateDir ?? TEMPLATE_STATE_DIR,
  };
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

const startMarker = (addon: string, slug: string) => `{# clp-addons:${addon}:${slug}:start #}`;
const endMarker = (addon: string, slug: string) => `{# clp-addons:${addon}:${slug}:end #}`;

/**
 * Every addon's markers, not just one addon's.
 *
 * The slug segment is optional because releases up to v0.2.0 wrote
 * `{# clp-addons:instatic:start #}` with no slug. Those blocks still have to be
 * recognised, or the first reconciliation after an upgrade would snapshot a
 * file with the old block still in it and bake that nav entry into the pristine
 * copy permanently.
 */
const ANY_BLOCK = /\n?[ \t]*\{# clp-addons:[a-z0-9_-]+(?::[a-z0-9_-]+)?:start #\}[\s\S]*?\{# clp-addons:[a-z0-9_-]+(?::[a-z0-9_-]+)?:end #\}/g;

/** What the file looked like before any addon touched it. */
function stripAllMarkers(content: string): string {
  return content.replace(ANY_BLOCK, "");
}

function blockOf(content: string, addon: string, slug: string): string | null {
  const s = startMarker(addon, slug);
  const e = endMarker(addon, slug);
  const from = content.indexOf(s);
  if (from === -1) return null;
  const to = content.indexOf(e, from);
  return to === -1 ? null : content.slice(from, to + e.length);
}

function wrap(inj: Injection): string {
  const s = startMarker(inj.addon, inj.target.slug);
  const e = endMarker(inj.addon, inj.target.slug);
  return `\n        ${s}${inj.target.snippet(inj.url)}\n        ${e}`;
}

/**
 * Pristine state is keyed by the template, because the template is shared.
 * The name is the path under the templates directory with separators folded,
 * so an operator can tell at a glance which file a snapshot belongs to.
 */
function fileKey(file: string, p: InjectPaths): string {
  return file.replace(`${p.templatesDir}/`, "").replace(/[^A-Za-z0-9.]+/g, "_");
}
const pristinePath = (f: string, p: InjectPaths) => `${p.stateDir}/${fileKey(f, p)}.pristine`;
const hashPath = (f: string, p: InjectPaths) => `${p.stateDir}/${fileKey(f, p)}.sha256`;
// The key folds path separators, so it cannot be turned back into a path
// unambiguously. Record the original rather than guessing it back.
const originPath = (f: string, p: InjectPaths) => `${p.stateDir}/${fileKey(f, p)}.path`;

export type TargetStatus =
  | { addon: string; slug: string; state: "ok" }
  | { addon: string; slug: string; state: "missing-anchor" }
  | { addon: string; slug: string; state: "stale-content" }
  | { addon: string; slug: string; state: "template-absent" }
  | { addon: string; slug: string; state: "upstream-changed"; expected: string; found: string }
  | { addon: string; slug: string; state: "anchor-not-found-in-markup" };

/**
 * Non-mutating: what is the state of this injection right now?
 *
 * The check is functional rather than a file diff (section 8): a marker block
 * whose content no longer matches the snippet counts as stale, not as present.
 * Without that, changing an addon's hostname leaves the nav pointing at the old
 * one forever.
 */
export function inspect(inj: Injection, paths?: Partial<InjectPaths>): TargetStatus {
  const p = resolvePaths(paths);
  const { addon, target } = inj;
  const id = { addon, slug: target.slug };
  const file = `${p.templatesDir}/${target.template}`;
  if (!existsSync(file)) return { ...id, state: "template-absent" };

  const onDisk = readFileSync(file, "utf-8");
  const upstream = stripAllMarkers(onDisk);

  if (existsSync(hashPath(file, p))) {
    const expected = readFileSync(hashPath(file, p), "utf-8").trim();
    const found = sha256(upstream);
    if (expected !== found) return { ...id, state: "upstream-changed", expected, found };
  }

  if (!upstream.includes(target.anchorAfter)) return { ...id, state: "anchor-not-found-in-markup" };

  const present = blockOf(onDisk, addon, target.slug);
  if (present === null) return { ...id, state: "missing-anchor" };
  if (present !== blockOf(wrap(inj), addon, target.slug)) return { ...id, state: "stale-content" };

  return { ...id, state: "ok" };
}

/**
 * Make every template match exactly the set of injections given.
 *
 * Removal is not a separate operation: uninstalling an addon means calling this
 * with that addon's injections left out, and the file is re-rendered without
 * them. Passing none for a file restores it to pristine.
 */
export function reconcile(
  injections: Injection[],
  paths?: Partial<InjectPaths>
): { statuses: TargetStatus[]; changed: boolean } {
  const p = resolvePaths(paths);
  dropLegacySnapshots(p);

  const byFile = new Map<string, Injection[]>();
  for (const inj of injections) {
    const file = `${p.templatesDir}/${inj.target.template}`;
    const list = byFile.get(file) ?? [];
    list.push(inj);
    byFile.set(file, list);
  }

  // Files that carry a block from an addon no longer in the set still have to
  // be visited, or an uninstalled addon's markup stays on the page.
  for (const file of patchedFiles(p)) if (!byFile.has(file)) byFile.set(file, []);

  const statuses: TargetStatus[] = [];
  let changed = false;
  for (const [file, list] of byFile) {
    const r = renderFile(file, list, p);
    statuses.push(...r.statuses);
    changed ||= r.changed;
  }
  return { statuses, changed };
}

/**
 * Snapshots from the per-addon scheme releases up to v0.2.0 used. They are
 * keyed by target slug and have no `.path` sidecar, and their recorded hash
 * belongs to a different keying, so leaving them would strand state that
 * nothing reads and that an operator would reasonably mistake for current.
 */
function dropLegacySnapshots(p: InjectPaths): void {
  if (!existsSync(p.stateDir)) return;
  const names = readdirSync(p.stateDir);
  for (const f of names) {
    if (!f.endsWith(".pristine") && !f.endsWith(".sha256")) continue;
    const base = f.slice(0, f.lastIndexOf("."));
    if (names.includes(`${base}.path`)) continue;
    rmSync(`${p.stateDir}/${f}`, { force: true });
  }
}

/** Templates we have a pristine snapshot for, i.e. ones some addon has patched. */
function patchedFiles(p: InjectPaths): string[] {
  if (!existsSync(p.stateDir)) return [];
  return readdirSync(p.stateDir)
    .filter((f) => f.endsWith(".path"))
    .map((f) => readFileSync(`${p.stateDir}/${f}`, "utf-8").trim())
    .filter((f) => f && existsSync(f));
}

function renderFile(
  file: string,
  list: Injection[],
  p: InjectPaths
): { statuses: TargetStatus[]; changed: boolean } {
  if (!existsSync(file)) {
    return {
      statuses: list.map(({ addon, target }) => ({ addon, slug: target.slug, state: "template-absent" as const })),
      changed: false,
    };
  }

  const onDisk = readFileSync(file, "utf-8");
  const upstream = stripAllMarkers(onDisk);

  mkdirSync(p.stateDir, { recursive: true });
  if (!existsSync(pristinePath(file, p))) {
    writeFileSync(pristinePath(file, p), upstream, { mode: 0o600 });
    writeFileSync(hashPath(file, p), `${sha256(upstream)}\n`, { mode: 0o644 });
    writeFileSync(originPath(file, p), `${file}\n`, { mode: 0o644 });
  }

  const expected = readFileSync(hashPath(file, p), "utf-8").trim();
  const found = sha256(upstream);
  if (expected !== found) {
    // CloudPanel changed the file our patches target. Refuse to write markup
    // built for markup that no longer exists.
    return {
      statuses: list.map(({ addon, target }) => ({
        addon, slug: target.slug, state: "upstream-changed" as const, expected, found,
      })),
      changed: false,
    };
  }

  const pristine = readFileSync(pristinePath(file, p), "utf-8");
  const statuses: TargetStatus[] = [];
  let rendered = pristine;

  // Stable order, so two addons patching one anchor do not swap places on
  // every reconciliation and produce a file that never settles. Insert in reverse
  // order because each block lands immediately after the same original anchor.
  for (const inj of [...list].sort((a, b) =>
    b.addon.localeCompare(a.addon) || b.target.slug.localeCompare(a.target.slug)
  )) {
    const at = rendered.indexOf(inj.target.anchorAfter);
    if (at === -1) {
      statuses.push({ addon: inj.addon, slug: inj.target.slug, state: "anchor-not-found-in-markup" });
      continue;
    }
    const cut = at + inj.target.anchorAfter.length;
    rendered = rendered.slice(0, cut) + wrap(inj) + rendered.slice(cut);
    statuses.push({ addon: inj.addon, slug: inj.target.slug, state: "ok" });
  }

  // In-place truncate: ownership and mode are the panel's and stay that way.
  const changed = rendered !== onDisk;
  if (changed) writeFileSync(file, rendered, "utf-8");

  // Nothing left patched here, so the snapshot has no further purpose. Keeping
  // it would pin a hash from a CloudPanel version that may since have moved on.
  if (list.length === 0) {
    rmSync(pristinePath(file, p), { force: true });
    rmSync(hashPath(file, p), { force: true });
    rmSync(originPath(file, p), { force: true });
  }

  return { statuses, changed };
}

/**
 * Purging is mandatory, not optional: Twig compiles templates to PHP and will
 * keep serving the pre-patch version until the compiled copy is gone.
 */
export function purgeTwigCache(): void {
  if (!existsSync(TWIG_CACHE_DIR)) return;
  for (const entry of readdirSync(TWIG_CACHE_DIR)) {
    rmSync(`${TWIG_CACHE_DIR}/${entry}`, { recursive: true, force: true });
  }
}

export function panelVersion(): string {
  try {
    return execFileSync("dpkg-query", ["-W", "-f=${Version}", "cloudpanel"], { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

export const NGINX_PROXY_BLOCK = `    # clp-addons:proxy:start
    location /addons/ {
        proxy_pass http://unix:/run/clp-addons/manager.sock:/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
    # clp-addons:proxy:end`;

const NGINX_PROXY_BLOCK_RE = /\n?[ \t]*# clp-addons:proxy:start[\s\S]*?[ \t]*# clp-addons:proxy:end\n?/g;

export interface NginxPaths {
  vhostPath?: string;
  sitesDir?: string;
  stateDir?: string;
}

export type NginxProxyState =
  | "ok"
  | "missing"
  | "stale-content"
  | "upstream-changed"
  | "conflict"
  | "validation-failed";

export interface NginxProxyStatus {
  state: NginxProxyState;
  vhostPath?: string;
  detail?: string;
}

export interface NginxReconcileResult extends NginxProxyStatus {
  changed: boolean;
}

function nginxPaths(options: NginxPaths): Required<NginxPaths> {
  return {
    vhostPath: options.vhostPath ?? "",
    sitesDir: options.sitesDir ?? NGINX_SITES_DIR,
    stateDir: options.stateDir ?? NGINX_PROXY_STATE_DIR,
  };
}

function readNginxFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function candidateScore(path: string, content: string): number {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  let score = 0;
  if (name === "cloudpanel.conf" || name.startsWith("cloudpanel")) score += 100;
  if (name === "default" || name === "default.conf") score += 40;
  if (/listen\s+[^;]*\b8443\b/.test(content)) score += 80;
  if (/\/home\/clp\/htdocs/.test(content)) score += 30;
  if (/server_name\s+[^;]+;/.test(content)) score += 10;
  return score;
}

export function findMasterVhost(options: NginxPaths = {}): string | null {
  const explicit = options.vhostPath || process.env.CLP_ADDONS_NGINX_VHOST;
  if (explicit) return existsSync(explicit) ? explicit : null;

  const dir = options.sitesDir ?? NGINX_SITES_DIR;
  if (!existsSync(dir)) return null;
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => !name.startsWith("."));
  } catch {
    return null;
  }

  let best: { path: string; score: number } | null = null;
  for (const name of names) {
    const path = `${dir}/${name}`;
    const content = readNginxFile(path);
    if (content === null || !/\bserver\s*\{/.test(content)) continue;
    const score = candidateScore(path, content);
    if (!best || score > best.score) best = { path, score };
  }
  return best?.path ?? null;
}

export function masterVhostHost(options: NginxPaths = {}): string | null {
  const path = findMasterVhost(options);
  if (!path) return null;
  const content = readNginxFile(path);
  const match = content?.match(/\bserver_name\s+([^;]+);/);
  if (!match) return null;
  return match[1]!.split(/\s+/).find((name) => name !== "_" && name !== "localhost") ?? null;
}

function stripNginxProxy(content: string): string {
  return content.replace(NGINX_PROXY_BLOCK_RE, "");
}

function matchingBrace(content: string, open: number): number | null {
  let depth = 0;
  let quote = "";
  let comment = false;
  for (let i = open; i < content.length; i++) {
    const ch = content[i];
    if (comment) {
      if (ch === "\n") comment = false;
      continue;
    }
    if (quote) {
      if (ch === quote && content[i - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === "#") {
      comment = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}" && --depth === 0) return i;
  }
  return null;
}

function serverBlocks(content: string): { start: number; end: number; body: string }[] {
  const blocks: { start: number; end: number; body: string }[] = [];
  const re = /\bserver\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content))) {
    const open = content.indexOf("{", match.index);
    const end = matchingBrace(content, open);
    if (end === null) continue;
    blocks.push({ start: match.index, end, body: content.slice(match.index, end + 1) });
    re.lastIndex = end + 1;
  }
  return blocks;
}

function renderNginxProxy(content: string, enabled: boolean): { content?: string; state?: "conflict" } {
  if (!enabled) return { content: stripNginxProxy(content) };
  const upstream = stripNginxProxy(content);
  if (/\blocation\s+(?:=\s*)?\/addons\//.test(upstream)) return { state: "conflict" };

  const blocks = serverBlocks(upstream);
  const target = blocks.find((block) => /\blisten\s+[^;]*\b8443\b/.test(block.body)) ?? blocks[0];
  if (!target) return { state: "conflict" };
  return {
    content: `${upstream.slice(0, target.end)}\n${NGINX_PROXY_BLOCK}\n${upstream.slice(target.end)}`,
  };
}

function nginxStateFiles(stateDir: string): { pristine: string; hash: string; path: string } {
  return {
    pristine: `${stateDir}/vhost.pristine`,
    hash: `${stateDir}/vhost.sha256`,
    path: `${stateDir}/vhost.path`,
  };
}

function commandFailure(command: string, args: string[]): string | null {
  try {
    execFileSync(command, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return (e.stderr || e.stdout || e.message || `${command} failed`).toString().trim();
  }
}

function restoreNginxPristine(path: string, pristine: string): void {
  const mode = statSync(path).mode & 0o777;
  writeAtomic(path, pristine, mode);
}

function removeNginxState(files: { pristine: string; hash: string; path: string }): void {
  rmSync(files.pristine, { force: true });
  rmSync(files.hash, { force: true });
  rmSync(files.path, { force: true });
}

export function inspectNginxProxy(options: NginxPaths = {}): NginxProxyStatus {
  const path = findMasterVhost(options);
  if (!path) return { state: "missing", detail: "CloudPanel master vhost was not found" };
  const content = readNginxFile(path);
  if (content === null) return { state: "missing", vhostPath: path, detail: "vhost could not be read" };
  const files = nginxStateFiles(options.stateDir ?? NGINX_PROXY_STATE_DIR);
  if (existsSync(files.hash)) {
    const expected = readFileSync(files.hash, "utf-8").trim();
    const found = sha256(stripNginxProxy(content));
    if (expected !== found) {
      return { state: "upstream-changed", vhostPath: path, detail: "CloudPanel rewrote the master vhost" };
    }
  }
  if (!content.includes("# clp-addons:proxy:start")) {
    return { state: "missing", vhostPath: path, detail: "proxy block is not installed" };
  }
  if (!content.includes(NGINX_PROXY_BLOCK)) {
    return { state: "stale-content", vhostPath: path, detail: "proxy block differs from the managed definition" };
  }
  return { state: "ok", vhostPath: path };
}

export function reconcileNginxProxy(options: NginxPaths & { enabled?: boolean; reload?: boolean } = {}): NginxReconcileResult {
  const { enabled = true, reload = true, ...paths } = options;
  const p = nginxPaths(paths);
  const selectedPath = findMasterVhost(p);
  if (!selectedPath) {
    return { state: "missing", changed: false, detail: "CloudPanel master vhost was not found" };
  }
  const vhostPath = (() => {
    try {
      return realpathSync(selectedPath);
    } catch {
      return selectedPath;
    }
  })();

  const onDisk = readNginxFile(selectedPath);
  if (onDisk === null) return { state: "missing", changed: false, vhostPath: selectedPath, detail: "vhost could not be read" };

  const files = nginxStateFiles(p.stateDir);
  mkdirSync(p.stateDir, { recursive: true });
  const upstream = stripNginxProxy(onDisk);
  const found = sha256(upstream);
  let pristine: string | null = null;
  try {
    const stored = readFileSync(files.pristine, "utf-8");
    const recorded = readFileSync(files.hash, "utf-8").trim();
    if (recorded === sha256(stored) && recorded === found) pristine = stored;
  } catch {
    pristine = null;
  }
  if (pristine === null) {
    pristine = upstream;
    writeAtomic(files.pristine, pristine, 0o600);
    writeAtomic(files.hash, `${found}\n`, 0o600);
    writeAtomic(files.path, `${vhostPath}\n`, 0o600);
  }

  const rendered = renderNginxProxy(onDisk, enabled);
  if (!rendered.content) {
    return { state: "conflict", changed: false, vhostPath: selectedPath, detail: "an unmanaged /addons/ location already exists" };
  }
  if (rendered.content === onDisk) {
    if (!enabled) removeNginxState(files);
    return { state: enabled ? "ok" : "missing", changed: false, vhostPath: selectedPath };
  }
  const mode = statSync(vhostPath).mode & 0o777;
  writeAtomic(vhostPath, rendered.content, mode);

  if (!reload) {
    if (!enabled) removeNginxState(files);
    return { state: enabled ? "ok" : "missing", changed: true, vhostPath: selectedPath };
  }

  const tested = commandFailure("nginx", ["-t"]);
  if (tested) {
    restoreNginxPristine(vhostPath, pristine);
    return { state: "validation-failed", changed: false, vhostPath: selectedPath, detail: `nginx -t failed: ${tested}` };
  }

  const reloaded = commandFailure("systemctl", ["reload", "nginx"]);
  if (reloaded) {
    restoreNginxPristine(vhostPath, pristine);
    return { state: "validation-failed", changed: false, vhostPath: selectedPath, detail: `nginx reload failed: ${reloaded}` };
  }

  if (!enabled) {
    removeNginxState(files);
  }
  return { state: enabled ? "ok" : "missing", changed: true, vhostPath: selectedPath };
}
