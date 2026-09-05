// Panel-side anchor management.
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

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync,
} from "node:fs";

const PANEL_APP = "/home/clp/htdocs/app/files";
export const TEMPLATES_DIR = `${PANEL_APP}/templates`;
export const TWIG_CACHE_DIR = `${PANEL_APP}/var/cache`;

const STATE_DIR = "/var/lib/clp-addons/templates";

const START = "{# clp-addons:instatic:start #}";
const END = "{# clp-addons:instatic:end #}";

// CloudPanel versions this patch's markup assumptions were verified against.
// A version outside this list is not fatal, but the hash gate below is what
// actually stops us on a markup change.
export const KNOWN_GOOD_PANEL_VERSIONS = ["2.5.4-3+clp-bookworm"];

export interface Target {
  slug: string;
  /** Path of the template on the running box. */
  file: string;
  /** Literal markup the snippet is inserted immediately after. */
  anchorAfter: string;
  snippet: (addonUrl: string) => string;
  /** A missing nav entry means the feature is unreachable; the card is a nicety. */
  required: boolean;
}

export const TARGETS: Target[] = [
  {
    slug: "header-nav",
    file: `${TEMPLATES_DIR}/Frontend/Partial/header.html.twig`,
    anchorAfter: '<div class="nav-link-container w-100">',
    required: true,
    snippet: (url) => `
        ${START}
        <a href="${url}" class="nav-link" target="_blank" rel="noopener">Instatic</a>
        ${END}`,
  },
  {
    slug: "new-site-card",
    file: `${TEMPLATES_DIR}/Frontend/Site/New/index.html.twig`,
    anchorAfter: '<div class="site-type-container">',
    required: false,
    snippet: (url) => `
          ${START}
          <div class="application">
            <div class="application-image">
              <svg width="160" height="160" viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
                <rect width="160" height="160" rx="24" fill="#0f172a"/>
                <path d="M40 45h80v14H40zm0 28h80v14H40zm0 28h55v14H40z" fill="#38bdf8"/>
                <circle cx="115" cy="108" r="7" fill="#f43f5e"/>
              </svg>
            </div>
            <div class="deploy-application-container">
              <a href="${url}/new" class="btn btn-white" target="_blank" rel="noopener">Instatic Site</a>
            </div>
          </div>
          ${END}`,
  },
];

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Remove our marker block, yielding what the file looked like before patching. */
function stripMarkers(content: string): string {
  const re = new RegExp(`\\n?[ \\t]*${escapeRe(START)}[\\s\\S]*?${escapeRe(END)}`, "g");
  return content.replace(re, "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pristinePath(slug: string): string {
  return `${STATE_DIR}/${slug}.pristine`;
}
function hashPath(slug: string): string {
  return `${STATE_DIR}/${slug}.sha256`;
}

export type TargetStatus =
  | { slug: string; state: "ok" }
  | { slug: string; state: "missing-anchor" }
  | { slug: string; state: "stale-content" }
  | { slug: string; state: "template-absent" }
  | { slug: string; state: "upstream-changed"; expected: string; found: string }
  | { slug: string; state: "anchor-not-found-in-markup" };

/** Extract the text between our markers, markers included. */
function markerBlock(content: string): string | null {
  const from = content.indexOf(START);
  if (from === -1) return null;
  const to = content.indexOf(END, from);
  return to === -1 ? null : content.slice(from, to + END.length);
}

/**
 * Non-mutating: what is the state of this target right now?
 *
 * The check is functional rather than a file diff (section 8): when the
 * expected snippet is supplied, a marker block whose content no longer matches
 * it counts as stale, not as present. Without that, changing the addon's
 * hostname leaves the nav pointing at the old one forever.
 */
export function inspectTarget(t: Target, addonUrl?: string): TargetStatus {
  if (!existsSync(t.file)) return { slug: t.slug, state: "template-absent" };

  const onDisk = readFileSync(t.file, "utf-8");
  const patched = onDisk.includes(START);
  const upstream = patched ? stripMarkers(onDisk) : onDisk;

  if (existsSync(hashPath(t.slug))) {
    const expected = readFileSync(hashPath(t.slug), "utf-8").trim();
    const found = sha256(upstream);
    if (expected !== found) {
      return { slug: t.slug, state: "upstream-changed", expected, found };
    }
  }

  if (!upstream.includes(t.anchorAfter)) {
    return { slug: t.slug, state: "anchor-not-found-in-markup" };
  }

  if (!patched) return { slug: t.slug, state: "missing-anchor" };

  if (addonUrl !== undefined) {
    const present = markerBlock(onDisk);
    const expected = markerBlock(t.snippet(addonUrl));
    if (present !== expected) return { slug: t.slug, state: "stale-content" };
  }

  return { slug: t.slug, state: "ok" };
}

/**
 * Bring one target to the patched state, regenerating from the pristine copy.
 * Refuses to touch the file when upstream's markup has changed under us.
 */
export function applyTarget(t: Target, addonUrl: string): TargetStatus {
  const status = inspectTarget(t, addonUrl);
  if (status.state === "template-absent" || status.state === "upstream-changed" ||
      status.state === "anchor-not-found-in-markup") {
    return status;
  }
  if (status.state === "ok") return status;

  const onDisk = readFileSync(t.file, "utf-8");
  const upstream = onDisk.includes(START) ? stripMarkers(onDisk) : onDisk;

  // First run for this target: the unpatched file on disk is the pristine copy.
  mkdirSync(STATE_DIR, { recursive: true });
  if (!existsSync(pristinePath(t.slug))) {
    writeFileSync(pristinePath(t.slug), upstream, { mode: 0o600 });
    writeFileSync(hashPath(t.slug), `${sha256(upstream)}\n`, { mode: 0o644 });
  }

  // Regenerate from pristine rather than editing what is on disk.
  const pristine = readFileSync(pristinePath(t.slug), "utf-8");
  const at = pristine.indexOf(t.anchorAfter);
  if (at === -1) return { slug: t.slug, state: "anchor-not-found-in-markup" };

  const cut = at + t.anchorAfter.length;
  const patched = pristine.slice(0, cut) + t.snippet(addonUrl) + pristine.slice(cut);

  // Preserve the panel's own ownership and mode; the templates are read by the
  // clp user, not by us.
  const before = statSync(t.file);
  writeFileSync(t.file, patched, "utf-8");
  try {
    execFileSync("chown", [`${before.uid}:${before.gid}`, t.file]);
    execFileSync("chmod", [(before.mode & 0o7777).toString(8), t.file]);
  } catch {
    // Non-fatal: the panel reads the file, and root wrote it with a sane mode.
  }

  return { slug: t.slug, state: "ok" };
}

export function removeTarget(t: Target): void {
  if (!existsSync(t.file)) return;
  const onDisk = readFileSync(t.file, "utf-8");
  if (!onDisk.includes(START)) return;
  const before = statSync(t.file);
  writeFileSync(t.file, stripMarkers(onDisk), "utf-8");
  try {
    execFileSync("chown", [`${before.uid}:${before.gid}`, t.file]);
  } catch {
    // as above
  }
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
