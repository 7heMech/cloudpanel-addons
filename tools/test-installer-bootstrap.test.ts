import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function bootstrap(failure?: "checksum" | "attestation"): { status: number | null; log: string; output: string } {
  const root = mkdtempSync(`${tmpdir()}/installer-trust-test-`);
  try {
    const bin = join(root, "bin");
    const fixtures = join(root, "fixtures");
    const folder = "gh_2.99.0_linux_amd64";
    mkdirSync(bin);
    mkdirSync(join(fixtures, folder, "bin"), { recursive: true });
    for (const cmd of ["bash", "tar", "gzip", "sha256sum", "mktemp", "sed", "head", "grep", "awk", "install", "dirname", "mv", "rm", "cp"]) {
      const executable = Bun.which(cmd);
      if (!executable) throw new Error(`test needs ${cmd}`);
      symlinkSync(executable, join(bin, cmd));
    }
    const addonBinary = '#!/bin/sh\nprintf "clp:%s\\n" "$*" >> "$BOOTSTRAP_LOG"\n';
    const ghBinary = '#!/bin/sh\nprintf "gh:%s\\n" "$*" >> "$BOOTSTRAP_LOG"\n' +
      (failure === "attestation" ? 'if [ "$2" = "verify" ]; then exit 1; fi\n' : "") + "exit 0\n";
    writeFileSync(join(fixtures, "clp-addons-linux-x64"), addonBinary);
    writeFileSync(join(fixtures, folder, "bin/gh"), ghBinary, { mode: 0o755 });
    const archive = join(fixtures, `${folder}.tar.gz`);
    execFileSync("tar", ["-czf", archive, "-C", fixtures, folder]);
    const ghSum = Bun.CryptoHasher.hash("sha256", readFileSync(archive), "hex");
    const addonSum = Bun.CryptoHasher.hash("sha256", addonBinary, "hex");
    writeFileSync(join(fixtures, "gh_2.99.0_checksums.txt"), `${failure === "checksum" ? "0".repeat(64) : ghSum}  ${folder}.tar.gz\n`);
    writeFileSync(join(fixtures, "SHA256SUMS"), `${addonSum}  clp-addons-linux-x64\n`);
    writeFileSync(join(fixtures, "attestations.jsonl"), "fixture bundle\n");

    // Exercise the actual trust/bootstrap tail without requiring a root
    // CloudPanel host. Downloads use fixture bytes and install drops only the
    // owner/group flags; tar, checksum, probes and publication are real.
    const source = readFileSync(join(import.meta.dir, "..", "install.sh"), "utf8");
    const start = source.indexOf("TMP=$(mktemp -d)");
    if (start === -1) throw new Error("installer trust bootstrap was not found");
    const harness = `set -euo pipefail
REPO=7heMech/cloudpanel-addons
CLI_ARTIFACT=clp-addons-linux-x64
ARTIFACTS=("$CLI_ARTIFACT")
CLI_TARGET="$TEST_ROOT/clp-addons"
GH_PRIVATE="$TEST_ROOT/libexec/gh"
TAG=v1.2.3
BASE="https://github.com/$REPO/releases/download/$TAG"
ADDON_LIST=(instatic stager)
SKIP_ATTESTATION=0
say() { printf '%s\\n' "$*"; }
step() { say "$*"; }
ok() { say "$*"; }
warn() { say "$*" >&2; }
die() { say "$*" >&2; exit 1; }
api() { printf '{"tag_name":"v2.99.0"}\\n'; }
curl() {
  local output= url=
  while (( $# )); do
    case "$1" in
      -o) output=$2; shift 2 ;;
      -*) shift ;;
      *) url=$1; shift ;;
    esac
  done
  command cp "$TEST_ROOT/fixtures/""\${url##*/}" "$output"
}
install() {
  local args=()
  while (( $# )); do
    case "$1" in
      -o|-g) shift 2 ;;
      *) args+=("$1"); shift ;;
    esac
  done
  command install "\${args[@]}"
}
` + source.slice(start);
    const script = join(root, "bootstrap.sh");
    writeFileSync(script, harness);
    const log = join(root, "events");
    const result = spawnSync("/bin/bash", [script], {
      env: { ...process.env, PATH: bin, TEST_ROOT: root, BOOTSTRAP_LOG: log },
      encoding: "utf8",
      timeout: 10_000,
    });
    return { status: result.status, output: result.stdout + result.stderr, log: existsSync(log) ? readFileSync(log, "utf8") : "" };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("first install bootstraps gh and verifies provenance before executing clp-addons", () => {
  const result = bootstrap();
  expect(result.status, result.output).toBe(0);
  const events = result.log.trim().split("\n");
  const attestation = events.findIndex((event) => event.startsWith("gh:attestation verify "));
  const execution = events.findIndex((event) => event.startsWith("clp:"));
  expect(attestation).toBeGreaterThanOrEqual(0);
  expect(execution).toBeGreaterThan(attestation);
  expect(events[attestation]).toContain("--repo 7heMech/cloudpanel-addons");
  expect(events[execution]).toStartWith("clp:install instatic --local=");
  expect(events[execution + 1]).toBe("clp:install stager");
});

test.each(["checksum", "attestation"] as const)("first install never executes clp-addons when gh %s verification fails", (failure) => {
  const result = bootstrap(failure);
  expect(result.status).not.toBe(0);
  expect(result.log).not.toContain("clp:");
  expect(result.output).toContain(failure === "checksum" ? "could not install a GitHub CLI" : "provenance verification failed");
});
