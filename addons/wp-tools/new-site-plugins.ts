// Plugins chosen while creating a WordPress site, installed once it exists.
//
// The choice is made on CloudPanel's own new-site form, before CloudPanel has
// created anything, so it is recorded as a background job that waits: first for
// the site to appear in the panel, then for WordPress to be installed in it. Only
// then is each plugin installed, as the site's own user through the shared
// WP-CLI runner. Root fetches and checks every zip, and hands it to the site's
// user on stdin; it never writes into the site.
//
// Uploaded zips are staged here first, in root-only storage under an id root
// chose, and the job deletes what it was given when it ends. Nothing a browser
// sends becomes a path.

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../lib/atomic-write";
import { readBoundedBytes, readBoundedText } from "../../lib/app-http";
import { commandOutput, runWp, wpReply, type WpOptions, type WpSite } from "./wp-cli";
import {
  DIRECTORY_SLUG_RE, MAX_DOWNLOAD_BYTES, MAX_UPLOAD_BYTES, PluginZipError, cleanLabel, inspectPluginZip, type PluginZip,
} from "./plugin-zip";

/** More than a new site should start with, and a bound on what one job does. */
export const MAX_NEW_SITE_PLUGINS = 20;
/** Uploads waiting for a form to be submitted, across every administrator. */
export const MAX_STAGED_UPLOADS = 20;
/** How long an upload waits for its form; the form itself expires sooner. */
const STAGED_UPLOAD_HOURS = 6;
/** One part of an upload through the gateway, whose requests are at most 1 MiB. */
export const UPLOAD_PART_BYTES = 704 * 1024;
export const UPLOAD_ID_RE = /^[a-f0-9]{32}$/;

/** CloudPanel creates a WordPress site in well under this, from submit to the page it lands on. */
const SITE_WAIT_MS = 10 * 60_000;
/** And installs WordPress in it within this once the site exists. */
const WORDPRESS_WAIT_MS = 10 * 60_000;
const POLL_MS = 3_000;
/** A site created this long before its plugins were chosen is not the one they were chosen for. */
const CREATED_SKEW_MS = 2 * 60_000;

const DIRECTORY_API = "https://api.wordpress.org/plugins/info/1.2/";
/** The one host and path shape a directory download may come from. */
const DOWNLOAD_RE = /^https:\/\/downloads\.wordpress\.org\/plugin\/[A-Za-z0-9._-]+\.zip$/;

export type NewSitePluginSource = "wordpress.org" | "upload";

export interface NewSitePlugin {
  source: NewSitePluginSource;
  slug: string;
  name: string;
  activate: boolean;
  /** The staged upload this plugin is, for an uploaded one. */
  upload?: string;
}

export type NewSitePluginStatus = "installed" | "activated" | "present" | "failed";

export interface NewSitePluginOutcome extends Omit<NewSitePlugin, "upload"> {
  status: NewSitePluginStatus;
  error: string;
}

/**
 * `done` with each plugin's outcome; `not-created` when no site of that name
 * appeared, which is what a form CloudPanel rejected looks like; `superseded`
 * when the form was submitted again and a later job took over.
 */
export interface NewSiteResult {
  outcome: "done" | "not-created" | "superseded";
  plugins: NewSitePluginOutcome[];
}

export interface StagedUpload extends PluginZip {
  id: string;
}

interface UploadMeta {
  createdAt: string;
  parts: number;
  received: number;
  /** Set once the last part arrived and the zip passed inspection. */
  plugin?: PluginZip;
  /** Set when a job took it; only that job deletes it then. */
  claimed?: boolean;
}

function uploadDir(uploadsDir: string, id: string): string {
  if (!UPLOAD_ID_RE.test(id)) throw new Error("that is not an upload id");
  return join(uploadsDir, id);
}

function readMeta(dir: string): UploadMeta | null {
  try {
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as UploadMeta;
    return typeof meta.createdAt === "string" && Number.isSafeInteger(meta.parts) && Number.isSafeInteger(meta.received) ? meta : null;
  } catch {
    return null;
  }
}

function saveMeta(dir: string, meta: UploadMeta): void {
  writeFileAtomic(join(dir, "meta.json"), `${JSON.stringify(meta)}\n`, { mode: 0o600 });
}

function stagedIds(uploadsDir: string): string[] {
  try { return readdirSync(uploadsDir).filter((entry) => UPLOAD_ID_RE.test(entry)); } catch { return []; }
}

/**
 * Drop uploads no form claimed in time, and claimed ones a job should long
 * since have deleted. Anything else in the directory is not ours to touch.
 */
export function pruneUploads(uploadsDir: string, now = new Date()): number {
  let removed = 0;
  for (const id of stagedIds(uploadsDir)) {
    const dir = join(uploadsDir, id);
    const meta = readMeta(dir);
    let since: number;
    try { since = meta ? Date.parse(meta.createdAt) : statSync(dir).mtimeMs; } catch { continue; }
    const hours = meta?.claimed ? 48 : STAGED_UPLOAD_HOURS;
    if (!(now.getTime() - since < hours * 3_600_000)) {
      rmSync(dir, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

function decodePart(base64: string): Uint8Array {
  const text = base64.trim();
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error("the upload part is not base64");
  const bytes = Buffer.from(text, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > UPLOAD_PART_BYTES) throw new Error("the upload part has the wrong size");
  return bytes;
}

/**
 * One part of an upload. The first carries no id and gets one; each after it
 * must be the next in order; the last is inspected, and a zip that is not a
 * plugin is deleted rather than kept.
 */
export function stageUploadPart(
  uploadsDir: string,
  request: { id?: string; part: number; last: boolean },
  base64: string,
  now = new Date(),
): { id: string; upload?: StagedUpload } {
  const bytes = decodePart(base64);
  let id = request.id;
  let dir: string;
  let meta: UploadMeta | null;
  if (!id) {
    if (request.part !== 0) throw new Error("an upload starts with part 0");
    pruneUploads(uploadsDir, now);
    if (stagedIds(uploadsDir).length >= MAX_STAGED_UPLOADS) {
      throw new Error("too many plugin uploads are waiting for a site; create the site, or try again later");
    }
    mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
    id = randomBytes(16).toString("hex");
    dir = uploadDir(uploadsDir, id);
    mkdirSync(dir, { mode: 0o700 });
    meta = { createdAt: now.toISOString(), parts: 0, received: 0 };
  } else {
    dir = uploadDir(uploadsDir, id);
    meta = readMeta(dir);
    if (!meta || meta.plugin || meta.claimed) throw new Error("that upload is not in progress; upload the zip again");
    if (request.part !== meta.parts) throw new Error("the upload parts arrived out of order; upload the zip again");
  }
  const fail = (message: string): never => {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(message);
  };
  if (meta.received + bytes.byteLength > MAX_UPLOAD_BYTES) fail(`a plugin zip may be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  appendFileSync(join(dir, "plugin.zip"), bytes, { mode: 0o600 });
  meta.parts++;
  meta.received += bytes.byteLength;
  if (request.last) {
    let plugin: PluginZip;
    try {
      plugin = inspectPluginZip(readFileSync(join(dir, "plugin.zip")));
    } catch (error) {
      fail(error instanceof PluginZipError ? error.message : "the zip could not be read");
    }
    meta.plugin = plugin!;
    saveMeta(dir, meta);
    return { id, upload: { id, ...plugin! } };
  }
  saveMeta(dir, meta);
  return { id };
}

/** Forget an upload the administrator took back off the form. A claimed one belongs to its job. */
export function discardUpload(uploadsDir: string, id: string): boolean {
  const dir = uploadDir(uploadsDir, id);
  const meta = readMeta(dir);
  if (!existsSync(dir) || meta?.claimed) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** The finished, unclaimed uploads a plan names, marked as its own. Throws naming the first one that is not. */
export function claimUploads(uploadsDir: string, ids: string[]): StagedUpload[] {
  const found = ids.map((id) => {
    const meta = readMeta(uploadDir(uploadsDir, id));
    if (!meta?.plugin || meta.claimed) throw new Error("an uploaded plugin is no longer waiting; upload it again");
    return { id, meta };
  });
  for (const { id, meta } of found) saveMeta(uploadDir(uploadsDir, id), { ...meta, claimed: true });
  return found.map(({ id, meta }) => ({ id, ...meta.plugin! }));
}

/** Give claimed uploads back, when the job that claimed them could not be started. */
export function releaseUploads(uploadsDir: string, ids: string[]): void {
  for (const id of ids) {
    const dir = uploadDir(uploadsDir, id);
    const meta = readMeta(dir);
    if (meta?.claimed) saveMeta(dir, { ...meta, claimed: false });
  }
}

export function removeUploads(uploadsDir: string, ids: string[]): void {
  for (const id of ids) rmSync(uploadDir(uploadsDir, id), { recursive: true, force: true });
}

// --- WordPress.org ---------------------------------------------------------

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The few entities WordPress.org leaves in plugin names. */
export function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d{1,6});/g, (_, code) => String.fromCodePoint(Math.min(Number(code), 0x10ffff)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, code) => String.fromCodePoint(Math.min(Number.parseInt(code, 16), 0x10ffff)))
    .replaceAll("&quot;", '"').replaceAll("&#039;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

/**
 * A directory plugin's current release, from WordPress.org's own API and its own
 * download host and nowhere else: no redirect is followed, and the zip is
 * inspected like an upload and must unpack into the folder the slug names.
 */
export async function downloadDirectoryPlugin(slug: string, fetchImpl: Fetch = fetch): Promise<{ name: string; zip: Uint8Array }> {
  if (!DIRECTORY_SLUG_RE.test(slug)) throw new Error("that is not a WordPress.org plugin slug");
  const query = new URLSearchParams({
    action: "plugin_information", "request[slug]": slug,
    "request[fields][sections]": "0", "request[fields][description]": "0", "request[fields][reviews]": "0",
    "request[fields][banners]": "0", "request[fields][icons]": "0", "request[fields][screenshots]": "0",
  });
  let info: { slug?: unknown; name?: unknown; download_link?: unknown; error?: unknown };
  try {
    const response = await fetchImpl(`${DIRECTORY_API}?${query}`, { redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (response.status === 404) throw new Error("not found");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    info = JSON.parse(await readBoundedText(response, 1024 * 1024));
  } catch (error) {
    if (error instanceof Error && error.message === "not found") throw new Error("WordPress.org has no plugin with that slug");
    throw new Error(`WordPress.org did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!info || typeof info !== "object" || info.error || info.slug !== slug) throw new Error("WordPress.org has no plugin with that slug");
  if (typeof info.download_link !== "string" || !DOWNLOAD_RE.test(info.download_link)) {
    throw new Error("WordPress.org named a download outside downloads.wordpress.org");
  }
  let zip: Uint8Array;
  try {
    const response = await fetchImpl(info.download_link, { redirect: "error", signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    zip = await readBoundedBytes(response, MAX_DOWNLOAD_BYTES);
  } catch (error) {
    throw new Error(`the download from WordPress.org failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const inspected = inspectPluginZip(zip, MAX_DOWNLOAD_BYTES);
  if (inspected.slug !== slug) throw new Error("the WordPress.org download is not the plugin that was chosen");
  return { name: cleanLabel(decodeEntities(typeof info.name === "string" ? info.name : "")) || inspected.name, zip };
}

// --- the job ---------------------------------------------------------------

/** What the job knows of the site, from CloudPanel and the account it runs as. */
export interface NewSiteLookup {
  /** CloudPanel's `created_at`, UTC. */
  createdAt: string;
  /** Null while the account or its root cannot be resolved yet. */
  site: WpSite | null;
}

export interface NewSiteRun {
  runuser: string;
  uploadsDir: string;
  domain: string;
  plugins: NewSitePlugin[];
  /** When the plugins were chosen: the job's own `createdAt`. */
  chosenAt: string;
  lookup: () => NewSiteLookup | null;
  /** Whether a later submission of the same form took over; asked only while waiting for the site. */
  superseded: () => boolean;
  /** Once the site exists: false if the job was superseded after all, else nothing supersedes it from now on. */
  begin: () => boolean;
  /** Whether WordPress Tools is still enabled. */
  enabled: () => boolean;
  deadline: number;
}

export interface NewSiteOptions extends WpOptions {
  fetch?: Fetch;
  /** Test-only: shorter waits. */
  waits?: { siteMs: number; wordpressMs: number; pollMs: number };
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const STATUS_MARKER = "CLP-ADDONS-PLUGINS:";
// Every installed plugin by folder, and whether it is active where it counts:
// on a multisite network only network activation does.
const STATUS_PHP = `
if (!function_exists('get_plugins')) { require_once ABSPATH . 'wp-admin/includes/plugin.php'; }
$found = array();
foreach (get_plugins() as $file => $data) {
  $folder = strpos($file, '/') === false ? preg_replace('/\\.php$/', '', $file) : dirname($file);
  $active = is_multisite() ? is_plugin_active_for_network($file) : is_plugin_active($file);
  $found[$folder] = !empty($found[$folder]) || $active;
}
echo "\\n" . '${STATUS_MARKER}' . wp_json_encode(array('multisite' => is_multisite(), 'plugins' => (object) $found));`;

interface SitePlugins {
  multisite: boolean;
  plugins: Record<string, boolean>;
}

async function sitePlugins(run: NewSiteRun, site: WpSite, options: NewSiteOptions): Promise<SitePlugins> {
  const reply = wpReply<{ multisite?: unknown; plugins?: unknown }>(await runWp(run, site, ["eval", STATUS_PHP], options, run.deadline), STATUS_MARKER);
  if (typeof reply.multisite !== "boolean" || !reply.plugins || typeof reply.plugins !== "object") {
    throw new Error("WP-CLI returned no plugin list; check that the site loads in WordPress");
  }
  return { multisite: reply.multisite, plugins: reply.plugins as Record<string, boolean> };
}

/** Writes the zip from stdin into a fresh private directory of the site user's, and names it. */
const STAGE_SCRIPT = `set -eu
umask 077
d=$(mktemp -d)
cat >"$d/$1.zip"
printf '%s' "$d"`;
const STAGED_DIR_RE = /^\/tmp\/tmp\.[A-Za-z0-9]{6,32}$/;

function asSite(run: NewSiteRun, site: WpSite, command: string[], stdin?: Uint8Array) {
  return {
    argv: [run.runuser, "-u", site.user, "--", ...command],
    cwd: "/",
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: site.home },
    timeoutMs: 60_000,
    ...(stdin ? { stdinBytes: stdin } : {}),
  };
}

async function installZip(run: NewSiteRun, site: WpSite, plugin: NewSitePlugin, zip: Uint8Array, multisite: boolean, options: NewSiteOptions): Promise<void> {
  const execute = options.runWpCommand ?? commandOutput;
  const dir = (await execute(asSite(run, site, ["/bin/sh", "-c", STAGE_SCRIPT, "sh", plugin.slug], zip))).trim();
  if (!STAGED_DIR_RE.test(dir)) throw new Error("the plugin zip could not be handed to the site's user");
  try {
    const activate = plugin.activate ? [multisite ? "--activate-network" : "--activate"] : [];
    await runWp(run, site, ["plugin", "install", `${dir}/${plugin.slug}.zip`, ...activate], options, run.deadline);
  } finally {
    await execute(asSite(run, site, ["rm", "-rf", "--", dir])).catch(() => {});
  }
}

async function installOne(run: NewSiteRun, site: WpSite, plugin: NewSitePlugin, options: NewSiteOptions): Promise<NewSitePluginOutcome> {
  const { upload: _upload, ...shown } = plugin;
  const outcome: NewSitePluginOutcome = { ...shown, status: "failed", error: "" };
  try {
    const before = await sitePlugins(run, site, options);
    if (plugin.slug in before.plugins) {
      // A plugin WordPress ships, such as Akismet: left as it is, and activated if asked.
      if (plugin.activate && !before.plugins[plugin.slug]) {
        await runWp(run, site, ["plugin", "activate", plugin.slug, ...(before.multisite ? ["--network"] : [])], options, run.deadline);
      }
      outcome.status = "present";
    } else {
      let zip: Uint8Array;
      if (plugin.source === "upload") {
        zip = readFileSync(join(uploadDir(run.uploadsDir, plugin.upload ?? ""), "plugin.zip"));
        // Inspected again: the job trusts nothing it did not just read.
        if (inspectPluginZip(zip).slug !== plugin.slug) throw new Error("the uploaded zip changed since it was checked");
      } else {
        const downloaded = await downloadDirectoryPlugin(plugin.slug, options.fetch);
        zip = downloaded.zip;
        outcome.name = downloaded.name;
      }
      await installZip(run, site, plugin, zip, before.multisite, options);
      outcome.status = plugin.activate ? "activated" : "installed";
    }
    const after = await sitePlugins(run, site, options);
    if (!(plugin.slug in after.plugins)) throw new Error("WordPress does not list the plugin after installing it");
    if (plugin.activate && !after.plugins[plugin.slug]) throw new Error("the plugin was installed but WordPress did not activate it");
  } catch (error) {
    outcome.status = "failed";
    outcome.error = cleanLabel(error instanceof Error ? error.message : String(error)).slice(0, 500);
  }
  return outcome;
}

function isWordPress(root: string): boolean {
  return existsSync(join(root, "wp-includes")) && existsSync(join(root, "wp-content"));
}

/**
 * Wait for the site, then for WordPress, then install each plugin in the order
 * chosen. One plugin failing does not stop the rest; a site that never appears
 * ends the job quietly, since that is what a rejected form leaves.
 */
export async function runNewSitePlugins(
  run: NewSiteRun,
  options: NewSiteOptions,
  onProgress: (progress: { completed: number; total: number; site: string }) => void,
  step: (text: string) => void,
): Promise<NewSiteResult> {
  const waits = options.waits ?? { siteMs: SITE_WAIT_MS, wordpressMs: WORDPRESS_WAIT_MS, pollMs: POLL_MS };
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = () => (options.now?.() ?? new Date()).getTime();
  const chosen = Date.parse(run.chosenAt);
  let superseded = false;
  try {
    step(`Waiting for CloudPanel to create ${run.domain}`);
    let found = run.lookup();
    while (!found) {
      if (run.superseded()) { superseded = true; return { outcome: "superseded", plugins: [] }; }
      if (now() > chosen + waits.siteMs) return { outcome: "not-created", plugins: [] };
      await sleep(waits.pollMs);
      found = run.lookup();
    }
    if (!run.begin()) { superseded = true; return { outcome: "superseded", plugins: [] }; }
    // Refused when the plan was made; asked again in case the name was free
    // then and an older site was restored under it since.
    if (!found.createdAt) throw new Error(`CloudPanel recorded no creation time for ${run.domain}, so nothing was installed`);
    if (!(Date.parse(`${found.createdAt.replace(" ", "T")}Z`) >= chosen - CREATED_SKEW_MS)) {
      throw new Error(`${run.domain} existed before its plugins were chosen, so nothing was installed`);
    }

    step(`Waiting for WordPress on ${run.domain}`);
    const appeared = now();
    let site: WpSite | null = null;
    let last = "";
    for (;;) {
      if (!run.enabled()) throw new Error("WordPress Tools was disabled before WordPress was installed");
      site = run.lookup()?.site ?? null;
      if (site && isWordPress(site.root)) {
        try {
          await runWp(run, site, ["core", "is-installed"], options, run.deadline);
          break;
        } catch (error) {
          last = error instanceof Error ? error.message : String(error);
        }
      }
      if (now() > appeared + waits.wordpressMs) {
        throw new Error(`WordPress was not installed on ${run.domain} in time${last ? ` (${last})` : ""}; install the plugins in WordPress`);
      }
      await sleep(waits.pollMs);
    }

    const plugins: NewSitePluginOutcome[] = [];
    for (const [index, plugin] of run.plugins.entries()) {
      onProgress({ completed: index, total: run.plugins.length, site: plugin.name });
      plugins.push(await installOne(run, site, plugin, options));
    }
    return { outcome: "done", plugins };
  } finally {
    // A superseded job's uploads were handed to the job that replaced it.
    if (!superseded) removeUploads(run.uploadsDir, run.plugins.flatMap((plugin) => plugin.upload ? [plugin.upload] : []));
  }
}

/** `slug:1,other:0` into the plugins and whether each is activated. */
export function parsePluginList(value: string | undefined, pattern: RegExp, what: string): { key: string; activate: boolean }[] {
  if (value === undefined || value === "") return [];
  return value.split(",").map((item) => {
    const match = /^(.+):([01])$/.exec(item);
    if (!match || !pattern.test(match[1]!)) throw new Error(`that is not a valid ${what}`);
    return { key: match[1]!, activate: match[2] === "1" };
  });
}
