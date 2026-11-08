// CloudPanel's Twig templates are proprietary, so none of them are ever stored
// in this repo. The pristine copy is snapshotted off the running box into
// /var/lib/clp-addons, patched from there, and hashed there.
//
// Two rules make re-injection safe to repeat:
//
//   1. Always regenerate from the pristine snapshot. Patching a file that may
//      already be patched eventually double-applies or corrupts it.
//   2. Hash the pristine template. The panel's PHP is obfuscated and cannot be
//      diffed, but Twig is plain text. If upstream's copy stops matching the
//      recorded hash, CloudPanel has touched the file our patch targets, so we
//      stop and flag rather than applying a patch built for the old markup --
//      unless the CloudPanel package was upgraded since the snapshot and every
//      anchor the patching addons need is in the new markup exactly once. Then
//      the new markup is snapshotted and patched (`rebaselineVerdict`).
//
// The snapshot lives outside /home/clp/htdocs/app on purpose: cloudpanel.postinst
// moves that whole directory aside and extracts a fresh copy on upgrade, so a
// pristine backup kept next to the template is destroyed by the very event it
// exists to survive.
//
// Several addons patch one template, so the pristine copy is keyed by the
// template file, not by the addon patching it, and rendering re-applies every
// addon's snippet in one pass.

import { writeFileAtomic } from "../lib/atomic-write";
import { tryRun } from "../lib/command";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, realpathSync,
} from "node:fs";
import { NGINX_PROXY_STATE_DIR, nginxLayout, TEMPLATE_STATE_DIR, TEMPLATES_DIR, TWIG_CACHE_DIR } from "../lib/paths";
import type { AddonTarget } from "../lib/addon-target";
import { withoutPhpMyAdminRules } from "../addons/system-tweaks/phpmyadmin";
import {
  type Refusal, baselineFiles, hasBaseline, occurrences, readBaseline, readBaselineVersion, rebaselineVerdict,
  recordBaseline, removeBaseline, sha256, writeBaselineVersion,
} from "../lib/baseline";
import { packageBusy, panelVersion } from "../lib/cloudpanel-version";

/** The addon supplies markup only; markers are added here so two addons cannot pick the same ones. */
export interface Injection {
  addon: string;
  target: AddonTarget;
  url: string;
}

export interface InjectOptions {
  templatesDir?: string;
  stateDir?: string;
  /** The installed CloudPanel version; read from dpkg when left out. Null while dpkg is changing it. */
  panelVersion?: PanelVersionSource;
  /** `repair --rebaseline`: take a changed template that still fits even though CloudPanel was not upgraded. */
  accept?: boolean;
  /** Whether dpkg is part-way through changing CloudPanel; asked of dpkg when left out. */
  panelBusy?: () => boolean;
}

/** A version, or a function asked each time, as dpkg is; dpkg itself when left out. */
type PanelVersionSource = string | null | (() => string | null);

function versionReader(source: PanelVersionSource | undefined): () => string | null {
  if (typeof source === "function") return source;
  return source === undefined ? () => panelVersion() : () => source;
}

/**
 * The version read before any file of a pass and the one read after a changed
 * file must agree. CloudPanel's postinst could finish between a read of a
 * half-written file and a read of the version, and the anchor watcher fires
 * exactly during upgrades.
 */
function settledVersion(before: string | null, now: () => string | null): string | null {
  const after = now();
  return before === after ? after : null;
}

interface InjectPaths {
  templatesDir: string;
  stateDir: string;
  /** The version as the pass began, before any file was read. */
  before: string | null;
  now: () => string | null;
  accept: boolean;
  busy: () => boolean;
}

function resolvePaths(p?: InjectOptions): InjectPaths {
  const now = versionReader(p?.panelVersion);
  return {
    templatesDir: p?.templatesDir ?? TEMPLATES_DIR,
    stateDir: p?.stateDir ?? TEMPLATE_STATE_DIR,
    before: now(),
    now,
    accept: p?.accept === true,
    busy: p?.panelBusy ?? (() => packageBusy("cloudpanel")),
  };
}

const startMarker = (addon: string, slug: string) => `{# clp-addons:${addon}:${slug}:start #}`;
const endMarker = (addon: string, slug: string) => `{# clp-addons:${addon}:${slug}:end #}`;

const ANY_BLOCK = /\n?[ \t]*\{# clp-addons:[a-z0-9_-]+:[a-z0-9_-]+:start #\}[\s\S]*?\{# clp-addons:[a-z0-9_-]+:[a-z0-9_-]+:end #\}/g;
/** Marker text a complete block's removal leaves behind: half a block, or one CloudPanel's markup carried over. */
const STRAY_MARKER = /clp-addons:[a-z0-9_-]+:[a-z0-9_-]+:(?:start|end)/;

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

/** The path under the templates directory, so an operator can tell which file a snapshot belongs to. */
function fileKey(file: string, p: InjectPaths): string {
  return file.replace(`${p.templatesDir}/`, "").replace(/[^A-Za-z0-9.]+/g, "_");
}
const recordOf = (file: string, p: InjectPaths) => baselineFiles(p.stateDir, fileKey(file, p));
const templateOf = (file: string, p: InjectPaths) => file.replace(`${p.templatesDir}/`, "");

const anchorOf = (inj: Injection) => inj.target.anchorBefore ?? inj.target.anchorAfter;

export type TargetStatus =
  | { addon: string; slug: string; state: "ok" }
  | { addon: string; slug: string; state: "missing-anchor" }
  | { addon: string; slug: string; state: "stale-content" }
  | { addon: string; slug: string; state: "template-absent" }
  | { addon: string; slug: string; state: "panel-updated"; installed: string }
  | {
    addon: string; slug: string; state: "upstream-changed"; template: string;
    reason: Refusal; recorded: string | null; installed: string | null;
  }
  | { addon: string; slug: string; state: "anchor-not-found-in-markup" };

/** A template recorded afresh because CloudPanel's upgrade changed it. */
export interface Rebaselined {
  file: string;
  from: string | null;
  to: string;
}

/**
 * Why the new markup cannot take its blocks, or null when it can. An optional
 * block whose anchor is gone is only left out, as it would be on any pass; a
 * repeated anchor refuses the file whoever needs it, since CloudPanel
 * restructured around it and the block could land in the wrong place.
 */
function misfit(upstream: string, list: Injection[]): Refusal | null {
  for (const inj of list) {
    const found = occurrences(upstream, anchorOf(inj) ?? "");
    if (found === 0 && inj.target.required) return "anchor-missing";
    if (found > 1) return "anchor-repeated";
  }
  return null;
}

type Assessment =
  | { kind: "absent" }
  | { kind: "unrecorded"; onDisk: string; upstream: string }
  | { kind: "match"; onDisk: string; upstream: string; recorded: string | null }
  | { kind: "rebaseline"; onDisk: string; upstream: string; recorded: string | null; installed: string }
  | { kind: "refuse"; onDisk: string; reason: Refusal; recorded: string | null; installed: string | null };

/** What may be done with one template given the blocks wanted in it. Writes nothing. */
function assess(file: string, list: Injection[], p: InjectPaths): Assessment {
  if (!existsSync(file)) return { kind: "absent" };
  const onDisk = readFileSync(file, "utf-8");
  const upstream = stripAllMarkers(onDisk);
  const record = recordOf(file, p);
  if (!hasBaseline(record)) {
    // Recorded mid-upgrade, a half-written file would be the record, with no
    // version to tell the finished one apart by.
    if (p.before === null && p.busy()) return { kind: "refuse", onDisk, reason: "busy", recorded: null, installed: null };
    return { kind: "unrecorded", onDisk, upstream };
  }
  const baseline = readBaseline(record);
  const recorded = readBaselineVersion(record);
  if (baseline && baseline.hash === sha256(upstream)) return { kind: "match", onDisk, upstream, recorded };
  const installed = settledVersion(p.before, p.now);
  const reason = rebaselineVerdict({
    recorded, installed, strayMarker: STRAY_MARKER.test(upstream), misfit: misfit(upstream, list), accept: p.accept,
  });
  return reason || installed === null
    ? { kind: "refuse", onDisk, reason: reason ?? "busy", recorded, installed }
    : { kind: "rebaseline", onDisk, upstream, recorded, installed };
}

function byTemplate(injections: Injection[], p: InjectPaths): Map<string, Injection[]> {
  const byFile = new Map<string, Injection[]>();
  for (const inj of injections) {
    const file = `${p.templatesDir}/${inj.target.template}`;
    const list = byFile.get(file) ?? [];
    list.push(inj);
    byFile.set(file, list);
  }
  return byFile;
}

/**
 * A marker block whose content no longer matches the snippet counts as stale,
 * not as present, so a snippet that changed (an addon's hostname, say) is
 * rewritten. Anchors are judged per template, against every injection given
 * for it, as reconcile judges them.
 */
export function inspectTemplates(injections: Injection[], paths?: InjectOptions): TargetStatus[] {
  const p = resolvePaths(paths);
  const statuses: TargetStatus[] = [];
  for (const [file, list] of byTemplate(injections, p)) {
    const found = assess(file, list, p);
    for (const inj of list) {
      const id = { addon: inj.addon, slug: inj.target.slug };
      if (found.kind === "absent") statuses.push({ ...id, state: "template-absent" });
      else if (found.kind === "refuse") {
        statuses.push({
          ...id, state: "upstream-changed", template: templateOf(file, p),
          reason: found.reason, recorded: found.recorded, installed: found.installed,
        });
      } else if (found.kind === "rebaseline") statuses.push({ ...id, state: "panel-updated", installed: found.installed });
      else {
        const anchor = anchorOf(inj);
        const present = blockOf(found.onDisk, inj.addon, inj.target.slug);
        if (!anchor || !found.upstream.includes(anchor)) statuses.push({ ...id, state: "anchor-not-found-in-markup" });
        else if (present === null) statuses.push({ ...id, state: "missing-anchor" });
        else if (present !== blockOf(wrap(inj), inj.addon, inj.target.slug)) statuses.push({ ...id, state: "stale-content" });
        else statuses.push({ ...id, state: "ok" });
      }
    }
  }
  return statuses;
}

/**
 * Make every template match exactly the set of injections given.
 *
 * Removal is not a separate operation: disabling an addon means calling this
 * with that addon's injections left out, and the file is re-rendered without
 * them. Passing none for a file restores it to pristine.
 */
export function reconcile(
  injections: Injection[],
  paths?: InjectOptions
): { statuses: TargetStatus[]; changed: boolean; rebaselined: Rebaselined[] } {
  const p = resolvePaths(paths);
  const byFile = byTemplate(injections, p);

  // Files that carry a block from an addon no longer in the set still have to
  // be visited, or a disabled addon's markup stays on the page.
  for (const file of patchedFiles(p)) if (!byFile.has(file)) byFile.set(file, []);

  const statuses: TargetStatus[] = [];
  const rebaselined: Rebaselined[] = [];
  let changed = false;
  for (const [file, list] of byFile) {
    const r = renderFile(file, list, p);
    statuses.push(...r.statuses);
    if (r.rebaselined) rebaselined.push(r.rebaselined);
    changed ||= r.changed;
  }
  return { statuses, changed, rebaselined };
}

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
): { statuses: TargetStatus[]; changed: boolean; rebaselined?: Rebaselined } {
  const found = assess(file, list, p);
  if (found.kind === "absent") {
    return {
      statuses: list.map(({ addon, target }) => ({ addon, slug: target.slug, state: "template-absent" as const })),
      changed: false,
    };
  }

  const record = recordOf(file, p);
  if (found.kind === "refuse") {
    // Nothing wanted here and nothing of ours left in the file: the record
    // has no further purpose, whoever changed the file.
    if (list.length === 0 && !found.onDisk.includes("clp-addons:")) removeBaseline(record);
    // CloudPanel changed the file our patches target, and the change does not
    // prove the patches still fit. Refuse to write markup built for markup
    // that no longer exists.
    return {
      statuses: list.map(({ addon, target }) => ({
        addon, slug: target.slug, state: "upstream-changed" as const, template: templateOf(file, p),
        reason: found.reason, recorded: found.recorded, installed: found.installed,
      })),
      changed: false,
    };
  }

  const { onDisk, upstream } = found;
  let rebaselined: Rebaselined | undefined;
  if (found.kind === "unrecorded" || found.kind === "rebaseline") {
    mkdirSync(p.stateDir, { recursive: true });
    const version = found.kind === "rebaseline" ? found.installed : p.before;
    recordBaseline(record, upstream, sha256(upstream), file, version);
    if (found.kind === "rebaseline") rebaselined = { file: templateOf(file, p), from: found.recorded, to: found.installed };
  } else {
    // Unchanged under a new CloudPanel: the record now vouches for this
    // version, so a later edit under it is told apart from an upgrade.
    if (p.before !== null && p.before !== found.recorded) writeBaselineVersion(record, p.before);
  }

  const statuses: TargetStatus[] = [];
  let rendered = upstream;

  // Stable order, so two addons patching one anchor do not swap places on
  // every reconciliation and produce a file that never settles.
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
  if (list.length === 0) removeBaseline(record);

  return { statuses, changed, rebaselined };
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

// `^~` rather than a plain prefix: CloudPanel's own vhost has a regex location
// for static file extensions, and nginx tests regex locations before a prefix
// match wins. Without it every addon URL ending in .js, .css, .svg or an image
// extension is taken by that rule and served from the filesystem as a 404.
export const NGINX_PROXY_BLOCK = `    # clp-addons:proxy:start
    location ^~ /addons/ {
        proxy_pass http://unix:/run/clp-addons/manager.sock:/;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
    # clp-addons:proxy:end`;

const NGINX_PROXY_BLOCK_RE = /\r?\n?[ \t]*# clp-addons:proxy:start[\s\S]*?[ \t]*# clp-addons:proxy:end\r?\n?/g;

interface NginxPaths {
  vhostPath?: string;
  sitesDir?: string;
  stateDir?: string;
}

/** As for the templates: the installed CloudPanel version, and the operator's `repair --rebaseline`. */
interface NginxBaselineOptions {
  panelVersion?: PanelVersionSource;
  accept?: boolean;
  panelBusy?: () => boolean;
}

function cloudpanelMasterVhost(): string {
  return `${nginxLayout().sitesDir}/cloudpanel.conf`;
}

type NginxProxyState =
  | "ok"
  | "missing"
  | "ambiguous"
  | "stale-content"
  | "upstream-changed"
  | "panel-updated"
  | "conflict"
  | "validation-failed";

export interface NginxProxyStatus {
  state: NginxProxyState;
  vhostPath?: string;
  detail?: string;
  /** Set with `upstream-changed`: why the changed vhost is left alone, and the versions that decided it. */
  refusal?: { reason: Refusal; recorded: string | null; installed: string | null };
}

interface NginxReconcileResult extends NginxProxyStatus {
  changed: boolean;
  /** The vhost was recorded afresh because CloudPanel's upgrade rewrote it. */
  rebaselined?: { from: string | null; to: string };
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

/** The vhost as CloudPanel wrote it, without the proxy or System Tweaks' phpMyAdmin rules. */
function panelUpstream(content: string): string {
  return withoutPhpMyAdminRules(stripNginxProxy(content));
}

/**
 * `#` comments and `'`/`"` strings can hide braces and even the word "server",
 * as in a commented-out `# server { listen 8443; }`. Every scanner reads the
 * text with each character inside one blanked to a space. Newlines are kept,
 * so offsets found in the masked copy slice the original. Neither construct
 * survives end of line, matching Nginx.
 */
const NGINX_NOISE_RE = /#[^\n]*|"(?:\\.|[^"\\\n])*(?:"|\\)?|'(?:\\.|[^'\\\n])*(?:'|\\)?/g;

function maskNginxNoise(content: string): string {
  return content.replace(NGINX_NOISE_RE, (noise) => " ".repeat(noise.length));
}

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

/** Keeps the file's owner: CloudPanel 6's panel account must still be able to rewrite its vhost. */
function writeNginxContent(path: string, content: string): void {
  const stat = statSync(path);
  writeFileAtomic(path, content, { mode: stat.mode & 0o777, owner: { uid: stat.uid, gid: stat.gid }, createParent: true });
}

/** Marker text left once both managed blocks are taken out. */
const VHOST_STRAY_MARKER = /# clp-addons:(?:proxy|phpmyadmin):(?:start|end)/;

/** Why the vhost as CloudPanel now writes it cannot take the proxy block, or null when it can. */
function proxyMisfit(upstream: string): Refusal | null {
  if (/\blocation\s+(?:=\s*)?\/addons\//.test(upstream)) return "conflict";
  const blocks = listen8443Blocks(upstream).length;
  return blocks === 0 ? "anchor-missing" : blocks > 1 ? "anchor-repeated" : null;
}

type VhostCheck =
  | { kind: "unrecorded" }
  | { kind: "match"; recorded: string | null }
  | { kind: "rebaseline"; recorded: string | null; installed: string }
  | { kind: "refuse"; reason: Refusal; recorded: string | null; installed: string | null };

/** The vhost against its record, by the rule the templates follow. Writes nothing. */
function checkVhost(
  upstream: string, files: ReturnType<typeof baselineFiles>, enabled: boolean,
  version: { before: string | null; now: () => string | null; busy: () => boolean }, accept?: boolean,
): VhostCheck {
  if (!hasBaseline(files)) {
    return version.before === null && version.busy()
      ? { kind: "refuse", reason: "busy", recorded: null, installed: null }
      : { kind: "unrecorded" };
  }
  const baseline = readBaseline(files);
  const recorded = readBaselineVersion(files);
  if (baseline?.hash === sha256(upstream)) return { kind: "match", recorded };
  const installed = settledVersion(version.before, version.now);
  const reason = rebaselineVerdict({
    recorded, installed, strayMarker: VHOST_STRAY_MARKER.test(upstream),
    misfit: enabled ? proxyMisfit(upstream) : null, accept,
  });
  return reason || installed === null
    ? { kind: "refuse", reason: reason ?? "busy", recorded, installed }
    : { kind: "rebaseline", recorded, installed };
}

function upstreamChangedResult(vhostPath: string, check: Extract<VhostCheck, { kind: "refuse" }>): NginxReconcileResult {
  return {
    state: "upstream-changed",
    changed: false,
    vhostPath,
    detail: "CloudPanel's master vhost changed; no changes were made",
    refusal: { reason: check.reason, recorded: check.recorded, installed: check.installed },
  };
}

export function inspectNginxProxy(options: NginxPaths & NginxBaselineOptions = {}): NginxProxyStatus {
  const now = versionReader(options.panelVersion);
  const before = now();
  const resolved = resolveMasterVhost(options);
  if (!("content" in resolved)) {
    return { state: resolved.state, vhostPath: resolved.path, detail: resolved.detail };
  }
  const path = resolved.path;
  const content = resolved.content;
  const files = baselineFiles(options.stateDir ?? NGINX_PROXY_STATE_DIR, "vhost");
  const check = checkVhost(panelUpstream(content), files, true, { before, now, busy: options.panelBusy ?? (() => packageBusy("cloudpanel")) }, options.accept);
  if (check.kind === "refuse") {
    const { changed: _, ...status } = upstreamChangedResult(path, check);
    return status;
  }
  if (check.kind === "rebaseline") {
    return { state: "panel-updated", vhostPath: path, detail: `CloudPanel ${check.installed} rewrote the master vhost; repair adds the proxy again` };
  }
  if (!content.includes("# clp-addons:proxy:start")) {
    return { state: "missing", vhostPath: path, detail: "proxy block is not installed" };
  }
  if (!content.includes(NGINX_PROXY_BLOCK)) {
    return { state: "stale-content", vhostPath: path, detail: "proxy block differs from the managed definition" };
  }
  return { state: "ok", vhostPath: path };
}

export function reconcileNginxProxy(
  options: NginxPaths & NginxBaselineOptions & { enabled?: boolean; reload?: boolean } = {},
): NginxReconcileResult {
  const { enabled = true, reload = true, panelVersion: version, accept, panelBusy, ...paths } = options;
  const p = nginxPaths(paths);
  const now = versionReader(version);
  const before = now();
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

  const files = baselineFiles(p.stateDir, "vhost");
  const upstream = panelUpstream(onDisk);
  const check = checkVhost(upstream, files, enabled, { before, now, busy: panelBusy ?? (() => packageBusy("cloudpanel")) }, accept);
  if (check.kind === "refuse") return upstreamChangedResult(selectedPath, check);
  let rebaselined: NginxReconcileResult["rebaselined"];
  // Kept only once the vhost it vouches for is in place and Nginx took it.
  const record = () => {
    if (check.kind === "match") {
      if (before !== null && before !== check.recorded) writeBaselineVersion(files, before);
      return;
    }
    mkdirSync(p.stateDir, { recursive: true });
    const installed = check.kind === "rebaseline" ? check.installed : before;
    recordBaseline(files, upstream, sha256(upstream), vhostPath, installed);
    if (check.kind === "rebaseline") rebaselined = { from: check.recorded, to: check.installed };
  };

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
    record();
    if (!enabled) removeBaseline(files);
    return { state: enabled ? "ok" : "missing", changed: false, vhostPath: selectedPath, rebaselined };
  }
  writeNginxContent(vhostPath, rendered.content);

  if (!reload) {
    record();
    if (!enabled) removeBaseline(files);
    return { state: enabled ? "ok" : "missing", changed: true, vhostPath: selectedPath, rebaselined };
  }

  // Validate and reload the instance that actually owns the resolved tree: on
  // CloudPanel 6 the panel runs a second Nginx whose config the distro `nginx -t`
  // never reads, so testing the wrong one would pass on a broken vhost.
  const layout = nginxLayout();
  const tested = tryRun("nginx", layout.configFile ? ["-t", "-c", layout.configFile] : ["-t"]);
  if (!tested.ok) {
    writeNginxContent(vhostPath, onDisk);
    return { state: "validation-failed", changed: false, vhostPath: selectedPath, detail: `nginx -t failed: ${tested.out}` };
  }

  const reloaded = tryRun("systemctl", ["reload", layout.service]);
  if (!reloaded.ok) {
    writeNginxContent(vhostPath, onDisk);
    return { state: "validation-failed", changed: false, vhostPath: selectedPath, detail: `nginx reload failed: ${reloaded.out}` };
  }

  record();
  if (!enabled) {
    removeBaseline(files);
  }
  return { state: enabled ? "ok" : "missing", changed: true, vhostPath: selectedPath, rebaselined };
}
