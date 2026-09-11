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

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, realpathSync } from "node:fs";
import {
  NGINX_PROXY_STATE_DIR, nginxLayout, TEMPLATE_STATE_DIR, TEMPLATES_DIR, TWIG_CACHE_DIR,
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
  return Bun.CryptoHasher.hash("sha256", s, "hex");
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

  const anchor = target.anchorBefore ?? target.anchorAfter;
  if (!anchor || !upstream.includes(anchor)) return { ...id, state: "anchor-not-found-in-markup" };

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
  // every reconciliation and produce a file that never settles. Injections with
  // anchorBefore are applied before the anchor in ascending order, while
  // injections with anchorAfter are applied after the anchor in reverse order.
  const befores = list.filter((inj) => Boolean(inj.target.anchorBefore));
  const afters = list.filter((inj) => !inj.target.anchorBefore);

  for (const inj of [...befores].sort((a, b) =>
    a.addon.localeCompare(b.addon) || a.target.slug.localeCompare(b.target.slug)
  )) {
    const anchor = inj.target.anchorBefore!;
    const at = rendered.indexOf(anchor);
    if (at === -1) {
      statuses.push({ addon: inj.addon, slug: inj.target.slug, state: "anchor-not-found-in-markup" });
      continue;
    }
    rendered = rendered.slice(0, at) + wrap(inj) + rendered.slice(at);
    statuses.push({ addon: inj.addon, slug: inj.target.slug, state: "ok" });
  }

  for (const inj of [...afters].sort((a, b) =>
    b.addon.localeCompare(a.addon) || b.target.slug.localeCompare(a.target.slug)
  )) {
    const anchor = inj.target.anchorAfter;
    if (!anchor) {
      statuses.push({ addon: inj.addon, slug: inj.target.slug, state: "anchor-not-found-in-markup" });
      continue;
    }
    const at = rendered.indexOf(anchor);
    if (at === -1) {
      statuses.push({ addon: inj.addon, slug: inj.target.slug, state: "anchor-not-found-in-markup" });
      continue;
    }
    const cut = at + anchor.length;
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
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
    # clp-addons:proxy:end`;

const NGINX_PROXY_BLOCK_RE = /\r?\n?[ \t]*# clp-addons:proxy:start[\s\S]*?[ \t]*# clp-addons:proxy:end\r?\n?/g;

export interface NginxPaths {
  vhostPath?: string;
  sitesDir?: string;
  stateDir?: string;
}

/** The installed CloudPanel panel vhost, unless an operator supplies another absolute path. */
export function cloudpanelMasterVhost(): string {
  return `${nginxLayout().sitesDir}/cloudpanel.conf`;
}

export type NginxProxyState =
  | "ok"
  | "missing"
  | "ambiguous"
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
    sitesDir: options.sitesDir ?? nginxLayout().sitesDir,
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

type MasterVhostResolution =
  | { path: string; content: string }
  | { state: "missing" | "ambiguous"; path?: string; detail: string };

function masterVhostPath(options: NginxPaths): { path: string } | { detail: string; path?: string } {
  const explicit = options.vhostPath || process.env.CLP_ADDONS_NGINX_VHOST;
  if (explicit) {
    if (!explicit.startsWith("/")) {
      return { path: explicit, detail: "CloudPanel master vhost path must be absolute" };
    }
    return { path: explicit };
  }

  if (options.sitesDir === undefined) return { path: cloudpanelMasterVhost() };
  const sitesDir = options.sitesDir;
  if (!sitesDir.startsWith("/")) {
    return { path: `${sitesDir}/cloudpanel.conf`, detail: "CloudPanel Nginx sites directory must be absolute" };
  }
  const normalizedDir = sitesDir.replace(/\/+$/, "");
  return { path: normalizedDir ? `${normalizedDir}/cloudpanel.conf` : "/cloudpanel.conf" };
}

function listen8443Blocks(content: string): ServerBlock[] {
  return serverBlocks(stripNginxProxy(content))
    .filter((block) => /\blisten\s+[^;]*\b8443\b/.test(block.maskedBody));
}

function resolveMasterVhost(options: NginxPaths = {}): MasterVhostResolution {
  const candidate = masterVhostPath(options);
  if ("detail" in candidate) {
    return { state: "missing", ...candidate };
  }
  if (!existsSync(candidate.path)) {
    return {
      state: "missing",
      path: candidate.path,
      detail: `CloudPanel master vhost does not exist: ${candidate.path}`,
    };
  }

  const content = readNginxFile(candidate.path);
  if (content === null) {
    return {
      state: "missing",
      path: candidate.path,
      detail: `CloudPanel master vhost could not be read: ${candidate.path}`,
    };
  }

  const blocks = listen8443Blocks(content);
  if (blocks.length !== 1) {
    const reason = blocks.length === 0
      ? "no server block listening on port 8443"
      : `${blocks.length} server blocks listening on port 8443`;
    return {
      state: "ambiguous",
      path: candidate.path,
      detail: `CloudPanel master vhost is ambiguous: ${candidate.path} contains ${reason}`,
    };
  }
  return { path: candidate.path, content };
}

/**
 * The vhost path the watcher follows. Unlike findMasterVhost this does not
 * require the file to be readable or unambiguous: a `.path` unit has to name
 * the file even while it is missing, so it can fire when it appears.
 */
export function panelVhostWatchPath(options: NginxPaths = {}): string | null {
  return masterVhostPath(nginxPaths(options)).path ?? null;
}

export function findMasterVhost(options: NginxPaths = {}): string | null {
  const resolved = resolveMasterVhost(options);
  return "content" in resolved ? resolved.path : null;
}

export function masterVhostHost(options: NginxPaths = {}): string | null {
  const resolved = resolveMasterVhost(options);
  if (!("content" in resolved)) return null;
  const block = listen8443Blocks(resolved.content)[0];
  const match = block?.maskedBody.match(/\bserver_name\s+([^;]+);/);
  if (!match) return null;
  return match[1]!.split(/\s+/).find((name) => name !== "_" && name !== "localhost") ?? null;
}

function stripNginxProxy(content: string): string {
  return content.replace(NGINX_PROXY_BLOCK_RE, "");
}

/**
 * The one quote- and comment-aware pass every scanner below is built from.
 *
 * `#` comments and `'`/`"` strings can hide braces, and even hide the literal
 * word "server". This used to be split between a brace-matcher that tracked
 * quote/comment state itself and a separate, unaware regex that decided where
 * to start matching -- two ideas of what counts as real config, which is the
 * gap a commented-out `# server { listen 8443; }` fell through: both halves
 * agreed with each other, just not with the truth.
 *
 * So masking is now the only place that decision lives. Every character
 * inside a comment or a string becomes a space, once, before anything else
 * reads the text. Newlines are never consumed, so the masked copy lines up
 * character-for-character with the original and offsets found in one can
 * slice the other. Neither construct survives end of line, matching Nginx.
 */
const NGINX_NOISE_RE = /#[^\n]*|"(?:\\.|[^"\\\n])*(?:"|\\)?|'(?:\\.|[^'\\\n])*(?:'|\\)?/g;

function maskNginxNoise(content: string): string {
  return content.replace(NGINX_NOISE_RE, (noise) => " ".repeat(noise.length));
}

/** The `}` that closes the `{` at `open`. `masked` must already be noise-masked. */
function matchingBrace(masked: string, open: number): number | null {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}" && --depth === 0) return i;
  }
  return null;
}

interface ServerBlock {
  /** Offset of the block's closing `}`, which is where the proxy block is spliced in. */
  end: number;
  /** The block with comments/strings blanked, for matching directives inside it. */
  maskedBody: string;
}

function serverBlocks(content: string): ServerBlock[] {
  const masked = maskNginxNoise(content);
  const blocks: ServerBlock[] = [];
  const re = /\bserver\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(masked))) {
    const end = matchingBrace(masked, re.lastIndex - 1);
    if (end === null) continue;
    blocks.push({ end, maskedBody: masked.slice(match.index, end + 1) });
    re.lastIndex = end + 1;
  }
  return blocks;
}

function renderNginxProxy(content: string, enabled: boolean): { content?: string; state?: "ambiguous" | "conflict"; detail?: string } {
  if (!enabled) return { content: stripNginxProxy(content) };
  const upstream = stripNginxProxy(content);
  if (/\blocation\s+(?:=\s*)?\/addons\//.test(upstream)) return { state: "conflict" };

  const blocks = listen8443Blocks(upstream);
  if (blocks.length !== 1) {
    return {
      state: "ambiguous",
      detail: "CloudPanel master vhost must contain exactly one server block listening on port 8443",
    };
  }
  const target = blocks[0]!;
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
    const result = Bun.spawnSync([command, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    if (result.success) return null;
    const stderr = result.stderr.toString("utf-8");
    const stdout = result.stdout.toString("utf-8");
    return (stderr || stdout || `Command failed: ${command}${args.length ? ` ${args.join(" ")}` : ""}`).trim();
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown; message?: unknown };
    const output = (value: unknown): string => {
      if (typeof value === "string") return value;
      if (value instanceof Uint8Array) return Buffer.from(value).toString("utf-8");
      return value == null ? "" : String(value);
    };
    const stderr = output(e.stderr);
    const stdout = output(e.stdout);
    return (stderr || stdout || output(e.message) || `Command failed: ${command}${args.length ? ` ${args.join(" ")}` : ""}`).trim();
  }
}

function restoreNginxContent(path: string, content: string): void {
  const mode = statSync(path).mode & 0o777;
  writeAtomic(path, content, mode);
}

function removeNginxState(files: { pristine: string; hash: string; path: string }): void {
  rmSync(files.pristine, { force: true });
  rmSync(files.hash, { force: true });
  rmSync(files.path, { force: true });
}

function hasNginxState(files: { pristine: string; hash: string; path: string }): boolean {
  return existsSync(files.pristine) || existsSync(files.hash) || existsSync(files.path);
}

function readNginxBaseline(files: { pristine: string; hash: string; path: string }): { pristine: string; hash: string } | null {
  try {
    const pristine = readFileSync(files.pristine, "utf-8");
    const hash = readFileSync(files.hash, "utf-8").trim();
    if (!hash || hash !== sha256(pristine)) return null;
    return { pristine, hash };
  } catch {
    return null;
  }
}

function upstreamChangedResult(
  vhostPath: string,
  expected: string,
  found: string,
  detail = "CloudPanel rewrote the master vhost; no changes were made",
): NginxReconcileResult {
  return {
    state: "upstream-changed",
    changed: false,
    vhostPath,
    detail: `${detail} (recorded ${expected.slice(0, 12)}, current ${found.slice(0, 12)})`,
  };
}

export function inspectNginxProxy(options: NginxPaths = {}): NginxProxyStatus {
  const resolved = resolveMasterVhost(options);
  if (!("content" in resolved)) {
    return { state: resolved.state, vhostPath: resolved.path, detail: resolved.detail };
  }
  const path = resolved.path;
  const content = resolved.content;
  const files = nginxStateFiles(options.stateDir ?? NGINX_PROXY_STATE_DIR);
  const baseline = readNginxBaseline(files);
  if (hasNginxState(files) && baseline === null) {
    return {
      state: "upstream-changed",
      vhostPath: path,
      detail: "managed Nginx baseline is missing or invalid; no changes were made",
    };
  }
  if (baseline) {
    const expected = baseline.hash;
    const found = sha256(stripNginxProxy(content));
    if (expected !== found) {
      return upstreamChangedResult(path, expected, found);
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
  const resolved = resolveMasterVhost(p);
  if (!("content" in resolved)) {
    return { state: resolved.state, changed: false, vhostPath: resolved.path, detail: resolved.detail };
  }
  const selectedPath = resolved.path;
  const vhostPath = (() => {
    try {
      return realpathSync(selectedPath);
    } catch {
      return selectedPath;
    }
  })();

  const onDisk = resolved.content;

  const files = nginxStateFiles(p.stateDir);
  const upstream = stripNginxProxy(onDisk);
  const found = sha256(upstream);
  const baseline = readNginxBaseline(files);
  if (hasNginxState(files) && baseline === null) {
    return {
      state: "upstream-changed",
      changed: false,
      vhostPath: selectedPath,
      detail: "managed Nginx baseline is missing or invalid; no changes were made",
    };
  }
  if (baseline && baseline.hash !== found) {
    return upstreamChangedResult(selectedPath, baseline.hash, found);
  }
  if (!baseline) {
    mkdirSync(p.stateDir, { recursive: true });
    const pristine = upstream;
    writeAtomic(files.pristine, pristine, 0o600);
    writeAtomic(files.hash, `${found}\n`, 0o600);
    writeAtomic(files.path, `${vhostPath}\n`, 0o600);
  }

  const rendered = renderNginxProxy(onDisk, enabled);
  if (!rendered.content) {
    return {
      state: rendered.state ?? "conflict",
      changed: false,
      vhostPath: selectedPath,
      detail: rendered.detail ?? "an unmanaged /addons/ location already exists",
    };
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

  // Validate and reload the instance that actually owns the resolved tree: on
  // CloudPanel 6 the panel runs a second Nginx whose config the distro `nginx -t`
  // never reads, so testing the wrong one would pass on a broken vhost.
  const layout = nginxLayout();
  const tested = commandFailure("nginx", layout.configFile ? ["-t", "-c", layout.configFile] : ["-t"]);
  if (tested) {
    restoreNginxContent(vhostPath, onDisk);
    return { state: "validation-failed", changed: false, vhostPath: selectedPath, detail: `nginx -t failed: ${tested}` };
  }

  const reloaded = commandFailure("systemctl", ["reload", layout.service]);
  if (reloaded) {
    restoreNginxContent(vhostPath, onDisk);
    return { state: "validation-failed", changed: false, vhostPath: selectedPath, detail: `nginx reload failed: ${reloaded}` };
  }

  if (!enabled) {
    removeNginxState(files);
  }
  return { state: enabled ? "ok" : "missing", changed: true, vhostPath: selectedPath };
}
