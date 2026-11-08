/**
 * Theme & Branding: the settings behind the `branding` switch, and the images
 * it serves. Root work, because the settings end up in CloudPanel's own
 * templates and the images are answered before there is a session.
 *
 * Modelled on CloudPanel v3's Admin tab of the same name, which is why it is
 * kept apart from the other switches: when v3 ships, this file goes.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ActionFailure, failAction } from "../../lib/action";
import { writeFileAtomic } from "../../lib/atomic-write";
import { isTrustedFile } from "../../lib/trusted-file";

const BRANDING_VERSION = 1;

/** Each upload, decoded. A logo larger than this is a photograph. */
const MAX_ASSET_BYTES = 512 * 1024;
const MAX_CSS_BYTES = 64 * 1024;
const MAX_FOOTER_BYTES = 16 * 1024;
/** One upload in base64, the text settings and their JSON. */
export const MAX_BRANDING_INPUT_BYTES = 900 * 1024;

const LOGO_SLOTS = ["headerLight", "headerDark", "markLight", "markDark", "favicon"] as const;
export type LogoSlot = (typeof LOGO_SLOTS)[number];

export interface Branding {
  customLogo: boolean;
  /** The stored file for each slot, named by its content; "" keeps CloudPanel's own. */
  logos: Record<LogoSlot, string>;
  customCss: boolean;
  css: string;
  showFooter: boolean;
  /** List items that replace the footer's links; "" keeps CloudPanel's own. */
  footerHtml: string;
}

export const DEFAULT_BRANDING: Branding = {
  customLogo: false,
  logos: { headerLight: "", headerDark: "", markLight: "", markDark: "", favicon: "" },
  customCss: false,
  css: "",
  showFooter: true,
  footerHtml: "",
};

export const ASSET_NAME_RE = /^[0-9a-f]{64}\.(svg|png|jpg|ico)$/;

const CONTENT_TYPES: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  ico: "image/x-icon",
};

function assetContentType(name: string): string {
  return CONTENT_TYPES[name.slice(name.lastIndexOf(".") + 1)] ?? "application/octet-stream";
}

/**
 * Whether text can be put inside `{% verbatim %}` in a CloudPanel template.
 * Only the closing tag ends it, and what follows would be Twig run by the
 * panel's PHP, so it is refused on the way in and dropped on the way out.
 */
export function twigSafe(text: string): boolean {
  return !/endverbatim/i.test(text) && !text.includes("\0");
}

interface BrandingPaths {
  brandingFile: string;
  brandingDir: string;
  rootUid: number;
}

export function readBranding(paths: BrandingPaths): Branding {
  const branding: Branding = { ...DEFAULT_BRANDING, logos: { ...DEFAULT_BRANDING.logos } };
  if (!existsSync(paths.brandingFile)) return branding;
  let stored: Record<string, unknown>;
  try {
    if (!isTrustedFile(lstatSync(paths.brandingFile), paths.rootUid)) failAction("the branding file is not a trusted regular file");
    stored = JSON.parse(readFileSync(paths.brandingFile, "utf8"));
  } catch (error) {
    if (error instanceof ActionFailure) throw error;
    return branding;
  }
  if (typeof stored !== "object" || stored === null || stored.version !== BRANDING_VERSION) return branding;
  for (const key of ["customLogo", "customCss", "showFooter"] as const) {
    if (typeof stored[key] === "boolean") branding[key] = stored[key];
  }
  if (typeof stored.css === "string" && twigSafe(stored.css)) branding.css = stored.css;
  if (typeof stored.footerHtml === "string" && twigSafe(stored.footerHtml)) branding.footerHtml = stored.footerHtml;
  const logos = stored.logos as Record<string, unknown> | undefined;
  for (const slot of LOGO_SLOTS) {
    const name = logos?.[slot];
    if (typeof name === "string" && ASSET_NAME_RE.test(name)) branding.logos[slot] = name;
  }
  return branding;
}

function writeBranding(paths: BrandingPaths, branding: Branding): void {
  writeFileAtomic(paths.brandingFile, `${JSON.stringify({ version: BRANDING_VERSION, ...branding }, null, 2)}\n`,
    { mode: 0o600, createParent: true });
}

/**
 * Markup a browser would run if the image were opened on its own. The image is
 * served with a sandboxing policy as well; this keeps such a file off the box.
 */
const SVG_ACTIVE_CONTENT = /<script|<foreignobject|<iframe|<embed|<object|<!entity|\bon[a-z]+\s*=|javascript:|data:text\/html/i;

/** The file's own type, from its first bytes rather than from what it claims. */
function imageType(bytes: Buffer): "svg" | "png" | "jpg" | "ico" | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return "ico";
  const text = bytes.toString("utf8").replace(/^﻿/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(text)) return "svg";
  return null;
}

const ACCEPTED: Record<LogoSlot, string[]> = {
  headerLight: ["svg", "png", "jpg"],
  headerDark: ["svg", "png", "jpg"],
  markLight: ["svg", "png", "jpg"],
  markDark: ["svg", "png", "jpg"],
  favicon: ["svg", "png", "ico"],
};

function storeAsset(paths: BrandingPaths, slot: LogoSlot, base64: string): string {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) failAction("the image is not base64");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) failAction("the image is empty");
  if (bytes.length > MAX_ASSET_BYTES) failAction(`images are limited to ${MAX_ASSET_BYTES / 1024} KB`);
  const type = imageType(bytes);
  if (!type || !ACCEPTED[slot].includes(type)) {
    failAction(`${slot === "favicon" ? "a favicon" : "a logo"} must be ${ACCEPTED[slot].map((t) => t.toUpperCase()).join(", ")}`);
  }
  if (type === "svg" && SVG_ACTIVE_CONTENT.test(bytes.toString("utf8"))) {
    failAction("the SVG carries scripts, event handlers or embedded documents");
  }
  const name = `${createHash("sha256").update(bytes).digest("hex")}.${type}`;
  writeFileAtomic(join(paths.brandingDir, name), bytes, { mode: 0o600, createParent: true });
  return name;
}

/** Files no slot names any more. */
function pruneAssets(paths: BrandingPaths, branding: Branding): void {
  if (!existsSync(paths.brandingDir)) return;
  const kept = new Set(Object.values(branding.logos));
  for (const name of readdirSync(paths.brandingDir)) {
    if (!kept.has(name)) rmSync(join(paths.brandingDir, name), { force: true });
  }
}

function text(body: Record<string, unknown>, key: "css" | "footerHtml", max: number): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") failAction(`${key} must be text`);
  if (Buffer.byteLength(value) > max) failAction(`${key} is limited to ${max / 1024} KB`);
  if (!twigSafe(value)) failAction(`${key} may not contain 'endverbatim' or a NUL byte`);
  return value;
}

/**
 * `{ customLogo?, customCss?, showFooter?, css?, footerHtml?, logo?: { slot, data } }`,
 * where an empty `data` puts CloudPanel's own image back in that slot.
 */
export function applyBranding(paths: BrandingPaths, body: Record<string, unknown>): Branding {
  const branding = readBranding(paths);
  let named = 0;
  for (const key of ["customLogo", "customCss", "showFooter"] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") failAction(`${key} must be true or false`);
    branding[key] = body[key];
    named++;
  }
  const css = text(body, "css", MAX_CSS_BYTES);
  if (css !== undefined) { branding.css = css; named++; }
  const footer = text(body, "footerHtml", MAX_FOOTER_BYTES);
  if (footer !== undefined) { branding.footerHtml = footer; named++; }
  if (body.logo !== undefined) {
    const logo = body.logo as Record<string, unknown> | null;
    const slot = LOGO_SLOTS.find((known) => known === logo?.slot);
    if (!slot) failAction(`logo.slot must be one of ${LOGO_SLOTS.join(", ")}`);
    if (typeof logo!.data !== "string") failAction("logo.data must be base64 text");
    branding.logos[slot] = logo!.data === "" ? "" : storeAsset(paths, slot, logo!.data);
    named++;
  }
  if (named === 0) failAction("no branding setting was named");
  writeBranding(paths, branding);
  pruneAssets(paths, branding);
  return branding;
}

/** One stored image, only while a slot names it. */
export function brandingAsset(paths: BrandingPaths, name: string): { type: string; data: string } {
  if (!ASSET_NAME_RE.test(name)) failAction("that is not a branding image");
  if (!Object.values(readBranding(paths).logos).includes(name)) failAction("no such branding image");
  const path = join(paths.brandingDir, name);
  if (!existsSync(path) || !isTrustedFile(lstatSync(path), paths.rootUid)) failAction("no such branding image");
  return { type: assetContentType(name), data: readFileSync(path).toString("base64") };
}
