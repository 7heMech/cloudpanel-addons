// The files an update replaces on disk, and the copy it keeps aside so a
// failed one can be undone. An update is the only thing that writes here.

import {
  ARTIFACT_MANIFEST_PATH, AUTH_SERVICE_UNIT, AUTH_SOCKET_UNIT, CLI_ARTIFACT, CLI_BIN, LIBEXEC_DIR,
  MANAGER_UNIT,
} from "./paths";
import { type FetchedArtifact } from "./release";
import { fatal, log, tryRun, writeAtomic } from "./util";
import {
  copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync,
} from "node:fs";
export function artifactNames(): string[] {
  return [CLI_ARTIFACT];
}

function artifact(artifacts: FetchedArtifact[], name: string): Buffer {
  const found = artifacts.find((item) => item.name === name);
  if (!found) fatal(`release did not contain ${name}`);
  return found.bytes;
}

function artifactPaths(): Map<string, string> {
  return new Map([[CLI_ARTIFACT, CLI_BIN]]);
}

function sha256(bytes: Buffer): string {
  return Bun.CryptoHasher.hash("sha256", bytes, "hex");
}

export function secureRegularFile(path: string, executable = false): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && stat.uid === 0 && (stat.mode & 0o022) === 0 && (!executable || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

export function currentArtifactsMatch(tag: string): boolean {
  if (!secureRegularFile(ARTIFACT_MANIFEST_PATH)) return false;

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(ARTIFACT_MANIFEST_PATH, "utf-8"));
  } catch {
    return false;
  }
  if (typeof manifest !== "object" || manifest === null) return false;
  const record = manifest as { version?: unknown; tag?: unknown; artifacts?: unknown };
  if (record.version !== 1 || record.tag !== tag || typeof record.artifacts !== "object" || record.artifacts === null) {
    return false;
  }

  const checksums = record.artifacts as Record<string, unknown>;
  for (const [name, path] of artifactPaths()) {
    const expected = checksums[name];
    if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected) || !secureRegularFile(path, true)) return false;
    try {
      if (sha256(readFileSync(path)) !== expected) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function writeArtifactManifest(tag: string, artifacts: FetchedArtifact[]): void {
  const checksums: Record<string, string> = {};
  for (const name of artifactPaths().keys()) checksums[name] = sha256(artifact(artifacts, name));
  writeAtomic(ARTIFACT_MANIFEST_PATH, JSON.stringify({ version: 1, tag, artifacts: checksums }) + "\n", 0o600);
  tryRun("chown", ["root:root", ARTIFACT_MANIFEST_PATH]);
}

/** Where the binary this update replaces is kept, in case it has to come back. */
const PREVIOUS_BIN = `${LIBEXEC_DIR}/clp-addons.previous`;
const PREVIOUS_MANIFEST = `${LIBEXEC_DIR}/artifacts.previous.json`;

function hardLinkOrCopy(from: string, to: string): void {
  rmSync(to, { force: true });
  try {
    linkSync(from, to);
  } catch {
    copyFileSync(from, to);
  }
}

/**
 * Keep the running binary and its manifest where a failed update can put them
 * back. Hard-linked rather than copied: it costs nothing and cannot be a
 * partial file. The manifest goes with it because `currentArtifactsMatch`
 * reads it -- restoring one without the other leaves the box claiming a
 * version it is not running.
 */
export function keepPreviousArtifacts(): void {
  rmSync(PREVIOUS_BIN, { force: true });
  rmSync(PREVIOUS_MANIFEST, { force: true });
  if (!existsSync(CLI_BIN)) return;
  mkdirSync(LIBEXEC_DIR, { recursive: true });
  hardLinkOrCopy(CLI_BIN, PREVIOUS_BIN);
  if (existsSync(ARTIFACT_MANIFEST_PATH)) hardLinkOrCopy(ARTIFACT_MANIFEST_PATH, PREVIOUS_MANIFEST);
}

/**
 * Whether the kept-aside binary is the release its kept-aside manifest names.
 *
 * `null` when there is nothing to compare against. The manifest is rewritten
 * only by the release install path, so a binary put in place by
 * `tools/deploy-stg.ts` or by hand leaves the previous release's manifest
 * beside it and the two legitimately disagree.
 */
function previousArtifactsAgree(): boolean | null {
  if (!secureRegularFile(PREVIOUS_MANIFEST)) return null;
  try {
    const manifest = JSON.parse(readFileSync(PREVIOUS_MANIFEST, "utf-8")) as { artifacts?: Record<string, unknown> };
    const expected = manifest.artifacts?.[CLI_ARTIFACT];
    if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) return null;
    return sha256(readFileSync(PREVIOUS_BIN)) === expected;
  } catch {
    return null;
  }
}

/**
 * Checked at the moment of use rather than trusted for having been written
 * here: this runs as root and hands the box back a binary to execute. A
 * checksum that disagrees is reported rather than refused -- refusing would
 * leave the box on the binary that just failed, which is worse.
 */
function restorePreviousArtifacts(): boolean {
  if (!secureRegularFile(PREVIOUS_BIN, true)) return false;
  if (previousArtifactsAgree() === false) {
    log.warn(`${PREVIOUS_BIN} does not match the checksum its manifest records; restoring it anyway`);
  }
  const staged = `${CLI_BIN}.rollback`;
  hardLinkOrCopy(PREVIOUS_BIN, staged);
  renameSync(staged, CLI_BIN);
  if (secureRegularFile(PREVIOUS_MANIFEST)) {
    const stagedManifest = `${ARTIFACT_MANIFEST_PATH}.rollback`;
    hardLinkOrCopy(PREVIOUS_MANIFEST, stagedManifest);
    renameSync(stagedManifest, ARTIFACT_MANIFEST_PATH);
  } else {
    rmSync(ARTIFACT_MANIFEST_PATH, { force: true });
  }
  return true;
}

export function replaceArtifacts(artifacts: FetchedArtifact[], tag: string): void {
  writeAtomic(CLI_BIN, artifact(artifacts, CLI_ARTIFACT), 0o755);
  tryRun("chown", ["root:root", CLI_BIN]);
  writeArtifactManifest(tag, artifacts);
}

export function installArtifacts(artifacts: FetchedArtifact[], tag: string): void {
  keepPreviousArtifacts();
  replaceArtifacts(artifacts, tag);
}

/**
 * Put the box back on the binary it was running.
 *
 * The parent is the old binary and it outlives the child it handed off to, so
 * it is the only process still able to act when the new one will not start,
 * fails part-way through provisioning, or leaves the services down.
 */
export function rollbackUpdate(previousVersion: string, reason: string): never {
  log.err(`the updated binary failed: ${reason}`);
  if (!restorePreviousArtifacts()) {
    fatal(
      `no usable earlier binary was kept, so the box is still running the update; ` +
      `run 'clp-addons repair' and check 'systemctl status ${MANAGER_UNIT}'`,
    );
  }
  const restart = tryRun("systemctl", ["restart", AUTH_SOCKET_UNIT, AUTH_SERVICE_UNIT, MANAGER_UNIT]);
  if (!restart.ok) log.err(`the background services did not restart: ${restart.out}`);
  // Only the two artifacts come back. Whatever the update had already written
  // -- config files, units, templates, Nginx fragments -- is the new version's
  // and stays, which is what repair exists to converge.
  fatal(
    `rolled the binary and its manifest back; the box is running clp-addons ${previousVersion}. ` +
    `Run 'clp-addons repair' to reconcile anything the update had already written`,
  );
}
