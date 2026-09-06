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
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { TEMPLATE_STATE_DIR, TEMPLATES_DIR, TWIG_CACHE_DIR, type AddonTarget } from "./paths";

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
  /** Overridden only by tests, which must never touch the panel's own files. */
  templatesDir?: string;
}

/** Absolute path of the template an injection patches. */
function fileOf(inj: Injection): string {
  return `${inj.templatesDir ?? TEMPLATES_DIR}/${inj.target.template}`;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
function fileKey(file: string): string {
  return file.replace(`${TEMPLATES_DIR}/`, "").replace(/[^A-Za-z0-9.]+/g, "_");
}
const pristinePath = (file: string) => `${TEMPLATE_STATE_DIR}/${fileKey(file)}.pristine`;
const hashPath = (file: string) => `${TEMPLATE_STATE_DIR}/${fileKey(file)}.sha256`;
// The key folds path separators, so it cannot be turned back into a path
// unambiguously. Record the original rather than guessing it back.
const originPath = (file: string) => `${TEMPLATE_STATE_DIR}/${fileKey(file)}.path`;

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
export function inspect(inj: Injection): TargetStatus {
  const { addon, target } = inj;
  const id = { addon, slug: target.slug };
  const file = fileOf(inj);
  if (!existsSync(file)) return { ...id, state: "template-absent" };

  const onDisk = readFileSync(file, "utf-8");
  const upstream = stripAllMarkers(onDisk);

  if (existsSync(hashPath(file))) {
    const expected = readFileSync(hashPath(file), "utf-8").trim();
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
export function reconcile(injections: Injection[]): { statuses: TargetStatus[]; changed: boolean } {
  dropLegacySnapshots();

  const byFile = new Map<string, Injection[]>();
  for (const inj of injections) {
    const file = fileOf(inj);
    const list = byFile.get(file) ?? [];
    list.push(inj);
    byFile.set(file, list);
  }

  // Files that carry a block from an addon no longer in the set still have to
  // be visited, or an uninstalled addon's markup stays on the page.
  for (const file of patchedFiles()) if (!byFile.has(file)) byFile.set(file, []);

  const statuses: TargetStatus[] = [];
  let changed = false;
  for (const [file, list] of byFile) {
    const r = renderFile(file, list);
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
function dropLegacySnapshots(): void {
  if (!existsSync(TEMPLATE_STATE_DIR)) return;
  const names = readdirSync(TEMPLATE_STATE_DIR);
  for (const f of names) {
    if (!f.endsWith(".pristine") && !f.endsWith(".sha256")) continue;
    const base = f.slice(0, f.lastIndexOf("."));
    if (names.includes(`${base}.path`)) continue;
    rmSync(`${TEMPLATE_STATE_DIR}/${f}`, { force: true });
  }
}

/** Templates we have a pristine snapshot for, i.e. ones some addon has patched. */
function patchedFiles(): string[] {
  if (!existsSync(TEMPLATE_STATE_DIR)) return [];
  return readdirSync(TEMPLATE_STATE_DIR)
    .filter((f) => f.endsWith(".path"))
    .map((f) => readFileSync(`${TEMPLATE_STATE_DIR}/${f}`, "utf-8").trim())
    .filter((f) => f && existsSync(f));
}

function renderFile(file: string, list: Injection[]): { statuses: TargetStatus[]; changed: boolean } {
  if (!existsSync(file)) {
    return {
      statuses: list.map(({ addon, target }) => ({ addon, slug: target.slug, state: "template-absent" as const })),
      changed: false,
    };
  }

  const onDisk = readFileSync(file, "utf-8");
  const upstream = stripAllMarkers(onDisk);

  mkdirSync(TEMPLATE_STATE_DIR, { recursive: true });
  if (!existsSync(pristinePath(file))) {
    writeFileSync(pristinePath(file), upstream, { mode: 0o600 });
    writeFileSync(hashPath(file), `${sha256(upstream)}\n`, { mode: 0o644 });
    writeFileSync(originPath(file), `${file}\n`, { mode: 0o644 });
  }

  const expected = readFileSync(hashPath(file), "utf-8").trim();
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

  const pristine = readFileSync(pristinePath(file), "utf-8");
  const statuses: TargetStatus[] = [];
  let rendered = pristine;

  // Stable order, so two addons patching one anchor do not swap places on
  // every reconciliation and produce a file that never settles.
  for (const inj of [...list].sort((a, b) =>
    a.addon.localeCompare(b.addon) || a.target.slug.localeCompare(b.target.slug)
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
    rmSync(pristinePath(file), { force: true });
    rmSync(hashPath(file), { force: true });
    rmSync(originPath(file), { force: true });
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
