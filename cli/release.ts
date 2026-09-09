import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { GH_PRIVATE, REPO } from "./paths";
import { fatal, have, log, tryRun } from "./util";

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

function attestingGh(): string | null {
  for (const candidate of [GH_PRIVATE, "gh"]) {
    if (candidate !== "gh" && !existsSync(candidate)) continue;
    if (tryRun(candidate, ["attestation", "--help"]).ok) return candidate;
  }
  return null;
}

export async function verifyAttestation(
  rel: ResolvedRelease,
  artifacts: FetchedArtifact[],
  skip: boolean,
): Promise<void> {
  if (skip) {
    log.warn("provenance verification skipped; checksums alone cannot detect substitution");
    return;
  }
  const gh = attestingGh();
  if (!gh) {
    fatal(
      have("gh")
        ? "the installed GitHub CLI does not support `gh attestation`"
        : "provenance verification needs the GitHub CLI (gh)",
    );
  }
  const bundlesUrl = rel.assets.get(BUNDLES_ASSET);
  if (!bundlesUrl) fatal(`release ${rel.tag} has no ${BUNDLES_ASSET} asset`);

  const directory = mkdtempSync(`${tmpdir()}/clp-addons-attest-`);
  try {
    const bundlePath = `${directory}/${BUNDLES_ASSET}`;
    writeFileSync(bundlePath, await download(bundlesUrl));
    for (const artifact of artifacts) {
      const artifactPath = `${directory}/${artifact.name}`;
      writeFileSync(artifactPath, artifact.bytes);
      const result = tryRun(gh, [
        "attestation", "verify", artifactPath,
        "--bundle", bundlePath,
        "--repo", REPO,
        "--signer-workflow", `${REPO}/.github/workflows/release.yml`,
      ]);
      if (!result.ok) fatal(`provenance verification failed for ${artifact.name}:\n${result.out}`);
      log.ok(`${artifact.name} provenance verified`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
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
