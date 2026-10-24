import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function bootstrap(version: string, checksum: "good" | "bad" = "good"): { status: number | null; events: string[]; output: string } {
  const root = mkdtempSync(`${tmpdir()}/installer-bootstrap-test-`);
  try {
    const bin = join(root, "bin");
    const fixtures = join(root, "fixtures");
    mkdirSync(bin);
    mkdirSync(fixtures);
    for (const cmd of ["bash", "sha256sum", "mktemp", "head", "awk", "install", "rm", "cp"]) {
      const executable = Bun.which(cmd);
      if (!executable) throw new Error(`test needs ${cmd}`);
      symlinkSync(executable, join(bin, cmd));
    }
    const binary = '#!/bin/sh\nprintf "clp:%s\\n" "$*" >> "$BOOTSTRAP_LOG"\n';
    const sum = checksum === "good" ? Bun.CryptoHasher.hash("sha256", binary, "hex") : "0".repeat(64);
    writeFileSync(join(fixtures, "clp-addons-linux-x64"), binary);
    writeFileSync(join(fixtures, "SHA256SUMS"), `${sum}  clp-addons-linux-x64\n`);

    // The download and install tail of the real script, with fixture bytes in
    // place of downloads and install without its owner flags.
    const source = readFileSync(join(import.meta.dir, "..", "install.sh"), "utf8");
    const start = source.indexOf('if [[ $VERSION == "latest" ]]; then');
    if (start === -1) throw new Error("installer download step was not found");
    const harness = `set -euo pipefail
REPO=7heMech/cloudpanel-addons
ARTIFACT=clp-addons-linux-x64
CLI_TARGET="$TEST_ROOT/clp-addons"
VERSION=${version}
ADDON_LIST=(instatic stager)
step() { :; }
ok() { :; }
die() { printf '%s\\n' "$*" >&2; exit 1; }
curl() {
  local output= url=
  while (( $# )); do
    case "$1" in
      -o) output=$2; shift 2 ;;
      -*) shift ;;
      *) url=$1; shift ;;
    esac
  done
  printf 'get:%s\\n' "$url" >> "$BOOTSTRAP_LOG"
  command cp "$TEST_ROOT/fixtures/\${url##*/}" "$output"
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
      env: { PATH: bin, TEST_ROOT: root, BOOTSTRAP_LOG: log },
      encoding: "utf8",
      timeout: 10_000,
    });
    const events = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    return { status: result.status, events, output: result.stdout + result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the latest release is downloaded, checked and handed every addon in one call", () => {
  const result = bootstrap("latest");
  expect(result.status, result.output).toBe(0);
  const base = "https://github.com/7heMech/cloudpanel-addons/releases/latest/download";
  expect(result.events.slice(0, 2)).toEqual([`get:${base}/SHA256SUMS`, `get:${base}/clp-addons-linux-x64`]);
  expect(result.events.slice(2)).toHaveLength(1);
  expect(result.events[2]).toStartWith("clp:install instatic stager --local=");
});

test("--version downloads that tag, and refuses a prerelease before downloading", () => {
  const pinned = bootstrap("v1.2.3");
  expect(pinned.status, pinned.output).toBe(0);
  expect(pinned.events[0]).toBe("get:https://github.com/7heMech/cloudpanel-addons/releases/download/v1.2.3/SHA256SUMS");

  const candidate = bootstrap("v1.3.0-rc.1");
  expect(candidate.status).not.toBe(0);
  expect(candidate.events).toEqual([]);
  expect(candidate.output).toContain("not a stable release tag");
});

test("a binary that does not match SHA256SUMS is never run", () => {
  const result = bootstrap("latest", "bad");
  expect(result.status).not.toBe(0);
  expect(result.events.some((event) => event.startsWith("clp:"))).toBe(false);
  expect(result.output).toContain("checksum mismatch");
});
