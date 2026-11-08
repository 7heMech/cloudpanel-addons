/**
 * CloudPanel installs `/usr/bin/clpctlWrapper` and a sudoers rule that lets
 * every local account run it as root. The wrapper runs clpctl as `clp`, who is
 * root-equivalent, and restricts a non-root, non-clp caller to four commands:
 * `db:export`, `db:import`, `system:permissions:reset` and
 * `varnish-cache:purge`. Those four still embed option values in shell strings
 * that clpctl builds, and a value with a `"`, `$`, backtick or `;` breaks out
 * and runs as root. A site's own Unix user is such a caller, so a hacked site
 * reaches root through it.
 *
 * `blockClpctlInjection`, on by default, replaces the wrapper with our own
 * (`clpctl-wrapper.sh`). It passes root and clp straight through to the saved
 * original, and for every other caller admits only `db:export`,
 * `system:permissions:reset` and `varnish-cache:purge`, with each option value
 * checked against an allowlist that holds no shell metacharacter. `db:import`
 * is refused, since clpctl runs its SQL as the database administrator.
 * Legitimate commands still reach CloudPanel's original wrapper unchanged, so
 * clpctl behaves exactly as before.
 *
 * The mitigation is pinned: it installs only over a wrapper whose bytes it was
 * built against and a CloudPanel version it knows. Anything else is left in
 * place and surfaced, so a wrapper CloudPanel has changed is never replaced
 * with one that might break clpctl. The saved original restores it byte for byte.
 */
import { addonStateDir, ROOT_UID } from "../../lib/paths";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { errorMessage } from "../../lib/errors";
import { runCommand, type CommandResult } from "../../lib/command";
import { writeFileAtomic } from "../../lib/atomic-write";
import { regularText, trustedText } from "../../lib/trusted-file";
import WRAPPER_SCRIPT from "./clpctl-wrapper.sh" with { type: "text" };
import { COMMAND_MS } from "./limits";

const DEFAULT_CLPCTL_GUARD_PATHS = {
  wrapper: "/usr/bin/clpctlWrapper",
  /** Where the original is kept; the script names this path too. */
  backup: `${addonStateDir("system-tweaks")}/clpctlWrapper.orig`,
  rootUid: ROOT_UID,
};

/**
 * SHA-256 of each CloudPanel wrapper this mitigation was built against, with
 * the CloudPanel package version it shipped with. The wrapper bytes are what
 * govern clpctl's contract, so they decide whether a replacement is safe; the
 * versions are recorded so a newer CloudPanel is caught even when its wrapper
 * is unchanged. Extend both after confirming a new release on a staging box.
 */
export const KNOWN_ORIGINAL_SHA256 = new Set([
  // cloudpanel 2.5.4-3 (CloudPanel CLI 6.0.8), /usr/bin/clpctlWrapper, 750 bytes.
  "ade4459016c372d2ec40d4fa78af62ce661a0b6e1847320663b92fdffcf90551",
]);

/** CloudPanel package versions (dpkg, without the distro suffix) this was built against. */
const KNOWN_VERSIONS = new Set(["2.5.4-3"]);

export interface ClpctlGuardOptions {
  paths?: Partial<typeof DEFAULT_CLPCTL_GUARD_PATHS>;
  run?: (command: string, args: string[]) => CommandResult;
  /** The CloudPanel package version, injected in tests; detected from dpkg otherwise. */
  version?: string | null;
  /** Extra hardened-wrapper hashes to treat as ours, for tests; unused in production. */
  shippedSha256?: Iterable<string>;
}

type WrapperKind =
  | "ours" // our hardened wrapper, over a saved known original
  | "known-original" // CloudPanel's own wrapper, a version we know
  | "unknown" // some other wrapper: do not touch it
  | "missing"; // no wrapper file at all

export interface ClpctlGuardStatus {
  enabled: boolean;
  /** Our hardened wrapper is installed and its saved original is intact. */
  active: boolean;
  /** It is safe to install over what is there now. */
  applicable: boolean;
  wrapper: WrapperKind;
  /** The detected CloudPanel package version, or null when dpkg does not know it. */
  version: string | null;
  /** Why it is not active or not applicable, for the page and repair. */
  reason?: string;
}

interface Context {
  paths: typeof DEFAULT_CLPCTL_GUARD_PATHS;
  run: (command: string, args: string[]) => CommandResult;
  version: string | null;
  /** Every hardened-wrapper hash this build counts as ours. */
  ours: Set<string>;
}

function contextOf(options: ClpctlGuardOptions): Context {
  return {
    paths: { ...DEFAULT_CLPCTL_GUARD_PATHS, ...options.paths },
    run: options.run ?? ((command, args) => runCommand(command, args, COMMAND_MS)),
    version: options.version !== undefined ? options.version : detectVersion(options),
    ours: new Set([...SHIPPED_WRAPPER_SHA256, ...(options.shippedSha256 ?? [])]),
  };
}

function detectVersion(options: ClpctlGuardOptions): string | null {
  const run = options.run ?? ((command: string, args: string[]) => runCommand(command, args, COMMAND_MS));
  const result = run("dpkg-query", ["-W", "-f=${Version}", "cloudpanel"]);
  if (!result.ok) return null;
  // Drop the distribution suffix, e.g. "2.5.4-3+clp-bookworm" -> "2.5.4-3".
  const version = result.stdout.trim().split("+")[0];
  return version || null;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const OUR_SHA256 = sha256(WRAPPER_SCRIPT);

/**
 * The SHA-256 of every hardened wrapper this addon has shipped. The one it ships
 * now is always in it; a release that changes `clpctl-wrapper.sh` adds the
 * previous `OUR_SHA256` value here. A wrapper whose hash is in this set is ours,
 * so an older one from an earlier release is recognised, upgraded to the current
 * script rather than classed as unknown, and never has its saved original
 * deleted out from under it.
 */
const PRIOR_SHIPPED_WRAPPER_SHA256: string[] = [
  // No hardened wrapper has shipped before the current one.
];
const SHIPPED_WRAPPER_SHA256 = new Set<string>([...PRIOR_SHIPPED_WRAPPER_SHA256, OUR_SHA256]);

/** A regular file's bytes when only root may write it, else null; a failed read is null too. */
function trustedBytes(path: string, rootUid: number): string | null {
  try {
    return trustedText(path, rootUid);
  } catch {
    return null;
  }
}

function savedOriginalGood(ctx: Context): boolean {
  const bytes = trustedBytes(ctx.paths.backup, ctx.paths.rootUid);
  return bytes !== null && KNOWN_ORIGINAL_SHA256.has(sha256(bytes));
}

function classify(ctx: Context): WrapperKind {
  const bytes = trustedBytes(ctx.paths.wrapper, ctx.paths.rootUid);
  if (bytes === null) return regularText(ctx.paths.wrapper) === null ? "missing" : "unknown";
  if (ctx.ours.has(sha256(bytes))) return "ours";
  if (KNOWN_ORIGINAL_SHA256.has(sha256(bytes))) return "known-original";
  return "unknown";
}

function versionKnown(ctx: Context): boolean {
  return ctx.version !== null && KNOWN_VERSIONS.has(ctx.version);
}

export function clpctlGuardStatus(enabled: boolean, options: ClpctlGuardOptions = {}): ClpctlGuardStatus {
  const ctx = contextOf(options);
  const wrapper = classify(ctx);
  const active = wrapper === "ours" && savedOriginalGood(ctx);
  const applicable = wrapper === "ours" || (wrapper === "known-original" && versionKnown(ctx));
  const status: ClpctlGuardStatus = { enabled, active, applicable, wrapper, version: ctx.version };
  if (!active) status.reason = pausedReason(ctx, wrapper);
  return status;
}

function pausedReason(ctx: Context, wrapper: WrapperKind): string {
  if (wrapper === "ours") return "the saved copy of CloudPanel's original wrapper is missing or unrecognised";
  if (wrapper === "missing") return `${ctx.paths.wrapper} is missing`;
  if (wrapper === "unknown") {
    return `${ctx.paths.wrapper} is not a CloudPanel wrapper this version was built against, so it is left in place`;
  }
  if (versionKnown(ctx)) return "CloudPanel's original wrapper is in place";
  return ctx.version === null
    ? "CloudPanel's version could not be read, so the wrapper is left in place"
    : `CloudPanel ${ctx.version} is newer than this mitigation was built against, so the wrapper is left in place`;
}

interface ClpctlGuardResult {
  /** The wrapper was written or removed. */
  changed: boolean;
  active: boolean;
  reason?: string;
}

/**
 * Anything but our own wrapper or a known original on a known CloudPanel
 * version is left untouched and reported, never thrown, so repair can call it
 * every cycle.
 */
export function applyClpctlGuard(options: ClpctlGuardOptions = {}): ClpctlGuardResult {
  const ctx = contextOf(options);
  const wrapper = classify(ctx);

  if (wrapper === "ours") {
    if (!savedOriginalGood(ctx)) {
      return { changed: false, active: false, reason: pausedReason(ctx, "ours") };
    }
    // An older shipped wrapper, still ours, is upgraded to the current script.
    if (readFileSync(ctx.paths.wrapper, "utf8") !== WRAPPER_SCRIPT) {
      writeFileAtomic(ctx.paths.wrapper, WRAPPER_SCRIPT, { mode: 0o700 });
      return { changed: true, active: true };
    }
    return { changed: false, active: true };
  }

  if (wrapper !== "known-original" || !versionKnown(ctx)) {
    return { changed: false, active: false, reason: pausedReason(ctx, wrapper) };
  }

  const original = readFileSync(ctx.paths.wrapper, "utf8");
  writeFileAtomic(ctx.paths.backup, original, { mode: 0o700, createParent: true });
  writeFileAtomic(ctx.paths.wrapper, WRAPPER_SCRIPT, { mode: 0o700 });
  return { changed: true, active: true };
}

/**
 * Put CloudPanel's original wrapper back, byte for byte, when ours is in place.
 * The saved copy is removed once the original is restored, or when the installed
 * wrapper is already a known original or missing, so nothing is left to apply.
 * A wrapper we do not recognise is left alone and its saved copy kept: it may be
 * an older hardened wrapper this build no longer lists, and deleting the copy
 * would strip the only path back to a working clpctl.
 */
export function restoreClpctlWrapper(options: ClpctlGuardOptions = {}): boolean {
  const ctx = contextOf(options);
  const wrapper = classify(ctx);
  if (wrapper !== "ours") {
    if (wrapper === "known-original" || wrapper === "missing") rmSync(ctx.paths.backup, { force: true });
    return false;
  }
  const original = trustedBytes(ctx.paths.backup, ctx.paths.rootUid);
  if (original === null || !KNOWN_ORIGINAL_SHA256.has(sha256(original))) {
    throw new Error("the saved copy of CloudPanel's original wrapper is missing, so it was not restored");
  }
  writeFileAtomic(ctx.paths.wrapper, original, { mode: 0o700 });
  rmSync(ctx.paths.backup, { force: true });
  return true;
}

export function clpctlGuardOrError(enabled: boolean, options?: ClpctlGuardOptions): ClpctlGuardStatus | { error: string } {
  try { return clpctlGuardStatus(enabled, options); }
  catch (error) { return { error: errorMessage(error) }; }
}

export { OUR_SHA256 };
