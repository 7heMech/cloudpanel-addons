import { afterEach, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import * as paths from "../cli/paths";

// v1.5.2's bundles are validly signed for 7heMech/cloudpanel-addons. Expecting
// another repository leaves only the identity policy to refuse them.
mock.module("../cli/paths", () => ({ ...paths, REPO: "attacker/cloudpanel-addons" }));
const { verifyAttestation } = await import("../cli/release");

const fixtures = join(import.meta.dir, "fixtures/sigstore");
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("a validly signed attestation for another repository is refused by identity", async () => {
  globalThis.fetch = (async () => new Response(readFileSync(join(fixtures, "attestations-v1.5.2.jsonl")))) as unknown as typeof fetch;
  const trustedRoot = async () => TrustedRoot.fromJSON(JSON.parse(readFileSync(join(fixtures, "trusted_root.json"), "utf-8")));
  const release = { tag: "v1.5.2", assets: new Map([["attestations.jsonl", "https://example.invalid/attestations.jsonl"]]) };
  await expect(verifyAttestation(release, [{ name: "install.sh", bytes: readFileSync(join(fixtures, "install-v1.5.2.sh")) }], false, trustedRoot))
    .rejects.toThrow("certificate identity error");
});
