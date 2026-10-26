import { existsSync, readFileSync } from "node:fs";
import { bundleFromJSON } from "@sigstore/bundle";
import type { TrustedRoot } from "@sigstore/protobuf-specs";
import { getTrustedRoot } from "@sigstore/tuf";
import { Verifier, toSignedEntity, toTrustMaterial } from "@sigstore/verify";
import { REPO, SIGSTORE_DIR } from "./paths";
import { fatal, log } from "./util";

const API = "https://api.github.com";
const VERSION_TAG_RE = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const BUNDLES_ASSET = "attestations.jsonl";

export interface ResolvedRelease {
  tag: string;
  assets: Map<string, string>;
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "clp-addons" },
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) fatal(`download failed: ${response.status} ${response.statusText} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function github(path: string): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "clp-addons",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) fatal(`GitHub API ${path} returned ${response.status} ${response.statusText}`);
  return response.json();
}

interface GithubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string }[];
}

export async function resolveRelease(requested?: string, allowPrerelease = false): Promise<ResolvedRelease> {
  let release: GithubRelease;
  if (requested && requested !== "latest") {
    if (!VERSION_TAG_RE.test(requested)) fatal(`'${requested}' is not a release tag; expected something like v1.0.0`);
    release = (await github(`/repos/${REPO}/releases/tags/${requested}`)) as GithubRelease;
  } else {
    release = (await github(`/repos/${REPO}/releases/latest`)) as GithubRelease;
  }
  if (release.draft) fatal(`release ${release.tag_name} is a draft`);
  if (!VERSION_TAG_RE.test(release.tag_name)) fatal(`release tag ${release.tag_name} is invalid`);
  if (release.prerelease && !allowPrerelease) {
    fatal(`release ${release.tag_name} is a prerelease; pass --allow-prerelease to install it`);
  }
  const assets = new Map(release.assets.map((asset) => [asset.name, asset.browser_download_url]));
  if (!assets.has("SHA256SUMS")) fatal(`release ${release.tag_name} has no SHA256SUMS asset`);
  return { tag: release.tag_name, assets };
}

function sha256(bytes: Buffer): string {
  return Bun.CryptoHasher.hash("sha256", bytes, "hex");
}

export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(\S+)$/);
    if (match) sums.set(match[2]!, match[1]!);
  }
  return sums;
}

export interface FetchedArtifact {
  name: string;
  bytes: Buffer;
}

export async function fetchVerified(rel: ResolvedRelease, names: string[]): Promise<FetchedArtifact[]> {
  log.step(`fetching checksums for ${rel.tag}`);
  const sums = parseSums((await download(rel.assets.get("SHA256SUMS")!)).toString("utf-8"));
  const artifacts: FetchedArtifact[] = [];
  for (const name of names) {
    const url = rel.assets.get(name);
    if (!url) fatal(`release ${rel.tag} has no asset named ${name}`);
    const expected = sums.get(name);
    if (!expected) fatal(`SHA256SUMS for ${rel.tag} does not list ${name}`);
    log.step(`downloading ${name}`);
    const bytes = await download(url);
    const actual = sha256(bytes);
    if (actual !== expected) {
      fatal(`checksum mismatch for ${name}\n  expected ${expected}\n  actual   ${actual}`);
    }
    log.ok(`${name} checksum verified`);
    artifacts.push({ name, bytes });
  }
  return artifacts;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * What `gh attestation verify --repo --signer-workflow` checks: a SLSA
 * provenance statement for these bytes, signed in Sigstore's public log by a
 * certificate GitHub Actions issued to this repository's release workflow for
 * this release's own tag, so an attestation of another tag does not vouch for
 * it. The source repository is checked apart from the workflow because a
 * reusable workflow signs for whichever repository calls it.
 */
export const provenancePolicy = (tag: string) => ({
  subjectAlternativeName: new RegExp(`^https://github\\.com/${escapeRegExp(REPO)}/\\.github/workflows/release\\.yml@refs/tags/${escapeRegExp(tag)}$`),
  extensions: { issuer: "https://token.actions.githubusercontent.com" },
  oids: [{ oid: { id: [1, 3, 6, 1, 4, 1, 57264, 1, 12] }, value: derUtf8(`https://github.com/${REPO}`) }],
});

function derUtf8(text: string): Buffer {
  const bytes = Buffer.from(text, "utf-8");
  return Buffer.concat([Buffer.from([0x0c, bytes.length]), bytes]);
}

interface Statement {
  predicateType?: string;
  subject?: { digest?: { sha256?: string } }[];
}

function statementOf(bundle: { dsseEnvelope?: { payload?: string } }): Statement | null {
  try {
    return JSON.parse(Buffer.from(bundle.dsseEnvelope?.payload ?? "", "base64").toString("utf-8")) as Statement;
  } catch {
    return null;
  }
}

/** Sigstore's current keys, refreshed through its TUF repository into a root-only cache. */
function sigstoreTrustedRoot(): Promise<TrustedRoot> {
  return getTrustedRoot({ cachePath: SIGSTORE_DIR });
}

export async function verifyAttestation(
  rel: ResolvedRelease,
  artifacts: FetchedArtifact[],
  skip: boolean,
  trustedRoot: () => Promise<TrustedRoot> = sigstoreTrustedRoot,
): Promise<void> {
  if (skip) {
    log.warn("provenance verification skipped; checksums alone cannot detect substitution");
    return;
  }
  const bundlesUrl = rel.assets.get(BUNDLES_ASSET);
  if (!bundlesUrl) fatal(`release ${rel.tag} has no ${BUNDLES_ASSET} asset`);
  const lines = (await download(bundlesUrl)).toString("utf-8").split("\n").filter((line) => line.trim());
  let bundles: { dsseEnvelope?: { payload?: string } }[];
  try {
    bundles = lines.map((line) => JSON.parse(line));
  } catch {
    fatal(`${BUNDLES_ASSET} in release ${rel.tag} is not valid JSON lines`);
  }
  let verifier: Verifier;
  try {
    verifier = new Verifier(toTrustMaterial(await trustedRoot()));
  } catch (error) {
    fatal(`could not load Sigstore's trusted keys: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const artifact of artifacts) {
    const digest = sha256(artifact.bytes);
    const bundle = bundles.find((candidate) => {
      const statement = statementOf(candidate);
      return statement?.predicateType === "https://slsa.dev/provenance/v1" &&
        statement.subject?.some((subject) => subject.digest?.sha256 === digest);
    });
    if (!bundle) fatal(`provenance verification failed for ${artifact.name}: no attestation names these bytes`);
    try {
      verifier.verify(toSignedEntity(bundleFromJSON(bundle)), provenancePolicy(rel.tag));
    } catch (error) {
      fatal(`provenance verification failed for ${artifact.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    log.ok(`${artifact.name} provenance verified`);
  }
}

export function loadLocal(dir: string, names: string[]): FetchedArtifact[] {
  const sumsPath = `${dir}/SHA256SUMS`;
  if (!existsSync(sumsPath)) fatal(`${sumsPath} not found`);
  const sums = parseSums(readFileSync(sumsPath, "utf-8"));
  const artifacts: FetchedArtifact[] = [];
  for (const name of names) {
    const path = `${dir}/${name}`;
    if (!existsSync(path)) fatal(`${path} not found`);
    const bytes = readFileSync(path);
    const expected = sums.get(name);
    if (!expected) fatal(`${sumsPath} does not list ${name}`);
    const actual = sha256(bytes);
    if (actual !== expected) fatal(`checksum mismatch for ${name}`);
    artifacts.push({ name, bytes });
  }
  log.warn("installing from a local build; provenance was verified by the caller");
  return artifacts;
}

export const CLI_VERSION: string = process.env.CLP_ADDONS_VERSION || "0.0.0-dev";
