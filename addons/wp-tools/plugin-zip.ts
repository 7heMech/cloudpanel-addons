// What a plugin zip has to be before it goes anywhere near a site.
//
// A zip is read here, as root, without extracting anything: the central
// directory says what is in it, and only the plugin's own header is inflated,
// into memory. WordPress extracts it later as the site's user. So nothing here
// writes a file named by the zip, and a name that climbs out of its folder is
// refused rather than cleaned, because WordPress and WP-CLI would read the same
// zip and might clean it differently.

import { inflateRawSync } from "node:zlib";

/** An upload, as the browser sent it. */
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
/** A WordPress.org download: some directory plugins are larger than anyone uploads. */
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
/** Everything in it once extracted, which is what the site's disk pays. */
export const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
export const MAX_ENTRIES = 30_000;

/** WordPress.org's own slugs: lowercase words joined by hyphens. */
export const DIRECTORY_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
/**
 * The folder an uploaded plugin unpacks into, which becomes its slug. Wider than
 * the directory's, since commercial plugins use underscores and capitals
 * (`js_composer`), and still a single plain name.
 */
export const UPLOADED_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export interface PluginZip {
  /** The folder the plugin unpacks into. */
  slug: string;
  /** From the plugin's `Plugin Name:` header. */
  name: string;
  version: string;
  /** Size of the zip itself. */
  size: number;
}

export class PluginZipError extends Error {}

function refuse(message: string): never {
  throw new PluginZipError(message);
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

interface Entry {
  name: string;
  method: number;
  compressed: number;
  size: number;
  dataStart: number;
}

function findEndOfCentralDirectory(view: DataView): number {
  const last = view.byteLength - 22;
  for (let offset = last; offset >= Math.max(0, last - 0xffff); offset--) {
    if (view.getUint32(offset, true) === EOCD && offset + 22 + view.getUint16(offset + 20, true) === view.byteLength) return offset;
  }
  refuse("that is not a zip file");
}

/** Names come from whoever made the zip; this is the whole of what is accepted. */
function checkName(name: string): void {
  if (!name || name.length > 1024) refuse("the zip holds a file with an unusable name");
  // Control characters, and the Windows separator that Linux would keep as part of a name.
  if (/[\x00-\x1f\x7f\\]/.test(name)) refuse("the zip holds a file with an unusable name");
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) refuse("the zip holds a file with an absolute path");
  const segments = name.split("/");
  if (segments.at(-1) === "") segments.pop();
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    refuse("the zip holds a file whose path leaves its folder");
  }
}

function readEntries(bytes: Uint8Array): Entry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 22 || view.getUint32(0, true) !== LOCAL) refuse("that is not a zip file");
  const end = findEndOfCentralDirectory(view);
  const disks = [view.getUint16(end + 4, true), view.getUint16(end + 6, true)];
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryStart = view.getUint32(end + 16, true);
  if (disks.some(Boolean) || view.getUint16(end + 8, true) !== count) refuse("a zip split across several files is not supported");
  if (count === 0xffff || directorySize === 0xffffffff || directoryStart === 0xffffffff) refuse("ZIP64 archives are not supported");
  if (count === 0) refuse("the zip is empty");
  if (count > MAX_ENTRIES) refuse(`the zip holds more than ${MAX_ENTRIES} files`);
  // Nothing before the first entry and nothing between the directory and its end.
  if (directoryStart + directorySize !== end) refuse("that is not a zip file");

  const names = new Set<string>();
  const entries: Entry[] = [];
  let extracted = 0;
  let offset = directoryStart;
  const latin1 = new TextDecoder("latin1");
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== CENTRAL) refuse("the zip's directory is damaged");
    const madeBy = view.getUint16(offset + 4, true);
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const external = view.getUint32(offset + 38, true);
    const local = view.getUint32(offset + 42, true);
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (offset > end) refuse("the zip's directory is damaged");

    let name: string;
    try { name = flags & 0x800 ? utf8.decode(rawName) : latin1.decode(rawName); }
    catch { refuse("the zip holds a file with an unusable name"); }
    checkName(name);
    if (names.has(name)) refuse("the zip names the same file twice");
    names.add(name);
    if (flags & 0x1) refuse("encrypted zips are not supported");
    if (method !== 0 && method !== 8) refuse("the zip uses a compression method WordPress may not read");
    if (compressed === 0xffffffff || size === 0xffffffff) refuse("ZIP64 archives are not supported");
    // Unix permissions are in the top half when the zip was made on Unix:
    // anything but a plain file or folder, a symlink above all, is refused.
    if (madeBy >> 8 === 3) {
      const type = (external >>> 16) & 0o170000;
      if (type !== 0 && type !== 0o100000 && type !== 0o040000) refuse("the zip holds a link or a special file");
    }
    extracted += size;
    if (extracted > MAX_EXTRACTED_BYTES) refuse(`the zip unpacks to more than ${MAX_EXTRACTED_BYTES / 1024 / 1024} MB`);

    // The local header must name the same file, or two readers of this zip
    // could disagree about what is in it.
    if (local + 30 > directoryStart || view.getUint32(local, true) !== LOCAL) refuse("the zip's directory is damaged");
    const localNameLength = view.getUint16(local + 26, true);
    const localExtraLength = view.getUint16(local + 28, true);
    const localName = bytes.subarray(local + 30, local + 30 + localNameLength);
    if (localNameLength !== nameLength || !localName.every((byte, at) => byte === rawName[at])) refuse("the zip's directory is damaged");
    const dataStart = local + 30 + localNameLength + localExtraLength;
    if (dataStart + compressed > directoryStart) refuse("the zip's directory is damaged");
    entries.push({ name, method, compressed, size, dataStart });
  }
  return entries;
}

/** WordPress's own `_cleanup_header_comment`, on the first 8 KiB as `get_file_data` reads them. */
function header(text: string, field: string): string {
  const match = new RegExp(`^(?:[ \\t]*<\\?php)?[ \\t/*#@]*${field}:(.*)$`, "mi").exec(text.slice(0, 8192).replaceAll("\r", "\n"));
  return (match?.[1] ?? "").replace(/\s*(?:\*\/|\?>).*/, "").trim();
}

/** Plain text of at most 200 characters, since the page and the job record show it. */
export function cleanLabel(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

function entryText(bytes: Uint8Array, entry: Entry): string {
  const data = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressed);
  const plain = entry.method === 0 ? data : inflateRawSync(data, { maxOutputLength: entry.size });
  return new TextDecoder().decode(plain.subarray(0, 8192));
}

/**
 * Whether these bytes are a plugin WordPress can install: one folder, every
 * name inside it, and a PHP file directly in it carrying a `Plugin Name:`
 * header. Throws a `PluginZipError` saying what is wrong.
 */
export function inspectPluginZip(bytes: Uint8Array, maxBytes = MAX_UPLOAD_BYTES): PluginZip {
  if (bytes.byteLength > maxBytes) refuse(`the zip is larger than ${maxBytes / 1024 / 1024} MB`);
  const entries = readEntries(bytes);
  // macOS's resource forks travel beside the folder; WordPress skips them too.
  const own = entries.filter((entry) => entry.name.split("/")[0] !== "__MACOSX");
  const folders = new Set(own.map((entry) => entry.name.split("/")[0]!));
  const folder = folders.size === 1 ? [...folders][0]! : "";
  if (!folder || own.some((entry) => !entry.name.includes("/"))) {
    refuse("a plugin zip holds a single folder with the plugin inside it");
  }
  if (!UPLOADED_SLUG_RE.test(folder)) refuse(`the plugin's folder name '${cleanLabel(folder).slice(0, 60)}' is not a plain name`);

  // The main file is usually named after the folder; WordPress looks at every
  // PHP file directly inside it, and so does this, up to a point.
  const candidates = own
    .filter((entry) => /^[^/]+\/[^/]+\.php$/i.test(entry.name) && entry.size <= 4 * 1024 * 1024)
    .sort((a, b) => Number(b.name === `${folder}/${folder}.php`) - Number(a.name === `${folder}/${folder}.php`))
    .slice(0, 50);
  for (const entry of candidates) {
    let text: string;
    try { text = entryText(bytes, entry); } catch { refuse("the zip is damaged"); }
    const name = cleanLabel(header(text, "Plugin Name"));
    if (name) return { slug: folder, name, version: cleanLabel(header(text, "Version")).slice(0, 40), size: bytes.byteLength };
  }
  refuse("the zip holds no WordPress plugin: no PHP file in its folder has a Plugin Name header");
}
