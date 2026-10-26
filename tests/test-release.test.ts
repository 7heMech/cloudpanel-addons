import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { newestRelease, verifyAttestation } from "../cli/release";

// v1.5.2's install.sh and the bundles published with it, checked against a
// copy of Sigstore's trusted root, so nothing here needs the network.
const fixtures = join(import.meta.dir, "fixtures/sigstore");
const installSh = readFileSync(join(fixtures, "install-v1.5.2.sh"));
const bundles = readFileSync(join(fixtures, "attestations-v1.5.2.jsonl"), "utf-8");
const trustedRoot = async () => TrustedRoot.fromJSON(JSON.parse(readFileSync(join(fixtures, "trusted_root.json"), "utf-8")));
const release = { tag: "v1.5.2", assets: new Map([["attestations.jsonl", "https://example.invalid/attestations.jsonl"]]) };

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function serve(body: string): string[] {
  const requests: string[] = [];
  globalThis.fetch = (async (url: string) => {
    requests.push(String(url));
    return new Response(body);
  }) as typeof fetch;
  return requests;
}

function forged(): string {
  return bundles.trim().split("\n").map((line) => {
    const bundle = JSON.parse(line);
    const signature = Buffer.from(bundle.dsseEnvelope.signatures[0].sig, "base64");
    signature[10]! ^= 1;
    bundle.dsseEnvelope.signatures[0].sig = signature.toString("base64");
    return JSON.stringify(bundle);
  }).join("\n");
}

test("a released artifact verifies against the provenance published with it", async () => {
  serve(bundles);
  await verifyAttestation(release, [{ name: "install.sh", bytes: installSh }], false, trustedRoot);
});

test("an attestation signed for another tag does not vouch for this release", async () => {
  serve(bundles);
  await expect(verifyAttestation({ ...release, tag: "v9.9.9" }, [{ name: "install.sh", bytes: installSh }], false, trustedRoot))
    .rejects.toThrow("provenance verification failed for install.sh");
});

test("bytes no attestation names are refused", async () => {
  serve(bundles);
  const changed = Buffer.concat([installSh, Buffer.from("\n")]);
  await expect(verifyAttestation(release, [{ name: "install.sh", bytes: changed }], false, trustedRoot))
    .rejects.toThrow("no attestation names these bytes");
});

test("an attestation whose signature was altered is refused", async () => {
  serve(forged());
  await expect(verifyAttestation(release, [{ name: "install.sh", bytes: installSh }], false, trustedRoot))
    .rejects.toThrow("provenance verification failed for install.sh");
});

test("keys that do not chain to Sigstore's are refused", async () => {
  serve(bundles);
  const empty = async () => TrustedRoot.fromJSON({ mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1" });
  await expect(verifyAttestation(release, [{ name: "install.sh", bytes: installSh }], false, empty))
    .rejects.toThrow("provenance verification failed for install.sh");
});

test("a release without bundles is refused", async () => {
  await expect(verifyAttestation({ tag: "v1.5.2", assets: new Map() }, [{ name: "install.sh", bytes: installSh }], false, trustedRoot))
    .rejects.toThrow("has no attestations.jsonl");
});

test("trusted keys that cannot be loaded stop the update", async () => {
  serve(bundles);
  const unreachable = async () => { throw new Error("tuf-repo-cdn.sigstore.dev unreachable"); };
  await expect(verifyAttestation(release, [{ name: "install.sh", bytes: installSh }], false, unreachable))
    .rejects.toThrow("could not load Sigstore's trusted keys: tuf-repo-cdn.sigstore.dev unreachable");
});

test("skipped verification neither downloads bundles nor loads keys", async () => {
  const requests = serve(bundles);
  let loaded = false;
  await verifyAttestation(release, [{ name: "install.sh", bytes: Buffer.from("anything") }], true, async () => {
    loaded = true;
    return trustedRoot();
  });
  expect(requests).toEqual([]);
  expect(loaded).toBe(false);
});

test("--allow-prerelease without a version takes the newest published release, pre-releases included", () => {
  const release = (tag_name: string, draft = false) => ({ tag_name, draft });
  expect(newestRelease([release("v1.5.2"), release("v2.0.0-rc.2"), release("v2.0.0-rc.1"), release("v2.1.0-rc.1", true)])?.tag_name).toBe("v2.0.0-rc.2");
  expect(newestRelease([release("v2.0.0-rc.2"), release("v2.0.0"), release("not-a-tag")])?.tag_name).toBe("v2.0.0");
  expect(newestRelease([release("v2.1.0", true)])).toBeUndefined();
});
