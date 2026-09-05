// Resolving, downloading and verifying a release.
//
// These artifacts end up running as root, so the integrity checks here are
// load-bearing. A checksum file served next to the binary detects corruption,
// not substitution: anyone who can replace the binary can replace SHA256SUMS
// alongside it. The build provenance attestation is what ties an artifact to
// the workflow that produced it, so verification is on by default and skipping
// it takes an explicit flag.

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { REPO } from "./paths";
import { fatal, have, log, tryRun } from "./util";

const API = "https://api.github.com";
const VERSION_TAG_RE = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface ResolvedRelease {
  tag: string;
  assets: Map<string, string>;
}

async function gh(path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "clp-addons",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) fatal(`GitHub API ${path} returned ${res.status} ${res.statusText}`);
  return res.json();
}

interface GhRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string }[];
}

export async function resolveRelease(requested?: string): Promise<ResolvedRelease> {
  let rel: GhRelease;
  if (requested && requested !== "latest") {
    if (!VERSION_TAG_RE.test(requested)) {
      fatal(`'${requested}' is not a release tag; expected something like v0.1.0`);
    }
    rel = (await gh(`/repos/${REPO}/releases/tags/${requested}`)) as GhRelease;
  } else {
    rel = (await gh(`/repos/${REPO}/releases/latest`)) as GhRelease;
  }

  if (rel.draft) fatal(`release ${rel.tag_name} is a draft`);

  const assets = new Map(rel.assets.map((a) => [a.name, a.browser_download_url]));
  if (!assets.has("SHA256SUMS")) {
    fatal(`release ${rel.tag_name} has no SHA256SUMS asset; refusing to install unverified binaries`);
  }
  return { tag: rel.tag_name, assets };
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "clp-addons" },
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) fatal(`download failed: ${res.status} ${res.statusText} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Parse `sha256  name` lines, tolerating the ` *name` binary marker. */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(\S+)$/);
    if (m) sums.set(m[2]!, m[1]!);
  }
  return sums;
}

export interface FetchedArtifact {
  name: string;
  bytes: Buffer;
}

/**
 * Download the named artifacts and verify each against SHA256SUMS. Throws on
 * the first mismatch: a partially verified release is not installable.
 */
export async function fetchVerified(rel: ResolvedRelease, names: string[]): Promise<FetchedArtifact[]> {
  log.step(`fetching SHA256SUMS for ${rel.tag}`);
  const sums = parseSums((await download(rel.assets.get("SHA256SUMS")!)).toString("utf-8"));

  const out: FetchedArtifact[] = [];
  for (const name of names) {
    const url = rel.assets.get(name);
    if (!url) fatal(`release ${rel.tag} has no asset named ${name}`);

    const expected = sums.get(name);
    if (!expected) fatal(`SHA256SUMS for ${rel.tag} does not list ${name}`);

    log.step(`downloading ${name}`);
    const bytes = await download(url);
    const actual = sha256(bytes);
    if (actual !== expected) {
      fatal(
        `checksum mismatch for ${name}\n  expected ${expected}\n  actual   ${actual}\n` +
          `Refusing to install. The artifact is corrupt or has been substituted.`
      );
    }
    log.ok(`${name} matches its recorded checksum`);
    out.push({ name, bytes });
  }
  return out;
}

/**
 * Verify build provenance.
 *
 * Ties each artifact to the workflow run that produced it, which the checksum
 * file cannot: anyone who can replace a binary can replace SHA256SUMS beside
 * it. This is the control that detects substitution.
 *
 * The attestation bundle is fetched from the public attestations API and
 * verified offline. `gh attestation verify` on its own would reach for the API
 * itself and demand `gh auth login` or GH_TOKEN even for a public repo, which
 * would put a GitHub account in the path of every install. Fetching the bundle
 * first and passing --bundle keeps verification fully unauthenticated.
 */
export async function verifyAttestation(artifacts: FetchedArtifact[], skip: boolean): Promise<void> {
  if (skip) {
    log.warn("provenance verification skipped by --skip-attestation; checksums alone cannot detect substitution");
    return;
  }
  if (!have("gh")) {
    fatal(
      "provenance verification needs the GitHub CLI (gh), which is not installed.\n" +
        "  Debian/Ubuntu: https://github.com/cli/cli/blob/trunk/docs/install_linux.md\n" +
        "  Or re-run with --skip-attestation to accept checksum-only verification."
    );
  }

  const dir = mkdtempSync(`${tmpdir()}/clp-addons-attest-`);
  try {
    for (const a of artifacts) {
      const digest = sha256(a.bytes);
      const bundles = await fetchBundles(digest, a.name);

      const artifactPath = `${dir}/${a.name}`;
      writeFileSync(artifactPath, a.bytes);

      // More than one attestation can exist for a digest; the artifact is
      // trusted if any of them verifies against this repo.
      let verified = false;
      let lastError = "";
      for (const [i, bundle] of bundles.entries()) {
        const bundlePath = `${dir}/${a.name}.bundle.${i}.json`;
        writeFileSync(bundlePath, JSON.stringify(bundle));
        const r = tryRun("gh", [
          "attestation", "verify", artifactPath,
          "--bundle", bundlePath,
          "--repo", REPO,
        ]);
        if (r.ok) {
          verified = true;
          break;
        }
        lastError = r.out;
      }

      if (!verified) {
        fatal(
          `provenance verification failed for ${a.name}.\n` +
            `  The artifact does not match any attestation for ${REPO}.\n${lastError}`
        );
      }
      log.ok(`${a.name} provenance verified against ${REPO}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface AttestationsResponse {
  attestations?: { bundle?: unknown }[];
}

async function fetchBundles(digest: string, name: string): Promise<unknown[]> {
  const url = `${API}/repos/${REPO}/attestations/sha256:${digest}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "clp-addons",
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (res.status === 404) {
    fatal(
      `no build provenance attestation exists for ${name}.\n` +
        `  Every release artifact is attested, so this one was not produced by the\n` +
        `  release workflow. Refusing to install it.`
    );
  }
  if (!res.ok) fatal(`could not fetch the attestation for ${name}: ${res.status} ${res.statusText}`);

  const body = (await res.json()) as AttestationsResponse;
  const bundles = (body.attestations ?? []).map((a) => a.bundle).filter((b): b is unknown => b != null);
  if (bundles.length === 0) fatal(`the attestations API returned no bundle for ${name}`);
  return bundles;
}

/**
 * Load artifacts from a locally built dist/ directory instead of a release.
 *
 * This exists for staging: on a box where no release has been cut yet, there
 * is otherwise no way to exercise the install path at all. It still verifies
 * every artifact against dist/SHA256SUMS, so a half-finished build is caught,
 * but it cannot verify provenance because nothing signed it. Never the path
 * used on a production host.
 */
export function loadLocal(dir: string, names: string[]): FetchedArtifact[] {
  const sumsFile = `${dir}/SHA256SUMS`;
  if (!existsSync(sumsFile)) {
    fatal(`${sumsFile} not found. Run 'bun run build' and generate it with:\n  (cd ${dir} && sha256sum -- * > SHA256SUMS)`);
  }
  const sums = parseSums(readFileSync(sumsFile, "utf-8"));

  const out: FetchedArtifact[] = [];
  for (const name of names) {
    const path = `${dir}/${name}`;
    if (!existsSync(path)) fatal(`${path} not found; build it first`);
    const bytes = readFileSync(path);
    const expected = sums.get(name);
    if (!expected) fatal(`${sumsFile} does not list ${name}`);
    const actual = sha256(bytes);
    if (actual !== expected) {
      fatal(`checksum mismatch for ${name}\n  expected ${expected}\n  actual   ${actual}`);
    }
    log.ok(`${name} matches ${sumsFile}`);
    out.push({ name, bytes });
  }
  log.warn("installing from a local build: provenance was not verified");
  return out;
}

/** Version of the running CLI, injected at build time. */
export const CLI_VERSION: string = (() => {
  // Replaced by the release workflow via --define. Falls back for local builds.
  const injected = process.env.CLP_ADDONS_VERSION ?? "";
  return injected || "0.0.0-dev";
})();

export function readInstalledVersion(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8").trim() : null;
  } catch {
    return null;
  }
}
