import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ARTIFACTS = ["clp-addons-linux-x64", "clp-addons-linux-arm64"];

function bootstrap(
  version: string, checksum: "good" | "bad" = "good", addons = "instatic stager", machine = "x86_64", mirror: "up" | "down" = "down", github: "up" | "down" = "up",
): { status: number | null; events: string[]; output: string } {
  const root = mkdtempSync(`${tmpdir()}/installer-bootstrap-test-`);
  try {
    const bin = join(root, "bin");
    const fixtures = join(root, "fixtures");
    mkdirSync(bin);
    mkdirSync(fixtures);
    for (const cmd of ["bash", "sha256sum", "mktemp", "head", "awk", "install", "rm", "cp", "cat"]) {
      const executable = Bun.which(cmd);
      if (!executable) throw new Error(`test needs ${cmd}`);
      symlinkSync(executable, join(bin, cmd));
    }
    const binary = '#!/bin/sh\nprintf "clp:%s\\n" "$*" >> "$BOOTSTRAP_LOG"\n';
    const sum = checksum === "good" ? Bun.CryptoHasher.hash("sha256", binary, "hex") : "0".repeat(64);
    for (const artifact of ARTIFACTS) writeFileSync(join(fixtures, artifact), binary);
    writeFileSync(join(fixtures, "SHA256SUMS"), ARTIFACTS.map((artifact) => `${sum}  ${artifact}\n`).join(""));
    writeFileSync(join(fixtures, "latest"), "v1.2.3\n");

    // The architecture check and the download and install tail of the real
    // script, with fixture bytes in place of downloads and install without its
    // owner flags.
    const source = readFileSync(join(import.meta.dir, "..", "install.sh"), "utf8");
    const archStart = source.indexOf('case "$(uname -m)" in');
    const archEnd = source.indexOf("esac\n", archStart) + "esac\n".length;
    const start = source.indexOf('MIRROR="https://cp.7he.dev"');
    if (archStart === -1 || start === -1) throw new Error("installer architecture or download step was not found");
    const harness = `set -euo pipefail
REPO=7heMech/cloudpanel-addons
CLI_TARGET="$TEST_ROOT/clp-addons"
VERSION=${version}
ADDON_LIST=(${addons})
step() { :; }
ok() { :; }
warn() { printf '%s\\n' "$*" >&2; }
die() { printf '%s\\n' "$*" >&2; exit 1; }
uname() { printf '%s\\n' "$TEST_MACHINE"; }
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
  [[ $url != https://cp.7he.dev/* || $TEST_MIRROR == up ]] || return 22
  [[ $url != https://github.com/* || $TEST_GITHUB == up ]] || return 7
  if [[ -n $output ]]; then command cp "$TEST_ROOT/fixtures/\${url##*/}" "$output"; else command cat "$TEST_ROOT/fixtures/\${url##*/}"; fi
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
` + source.slice(archStart, archEnd) + source.slice(start);
    const script = join(root, "bootstrap.sh");
    writeFileSync(script, harness);
    const log = join(root, "events");
    const result = spawnSync("/bin/bash", [script], {
      env: { PATH: bin, TEST_ROOT: root, BOOTSTRAP_LOG: log, TEST_MACHINE: machine, TEST_MIRROR: mirror, TEST_GITHUB: github },
      encoding: "utf8",
      timeout: 10_000,
    });
    const events = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    return { status: result.status, events, output: result.stdout + result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const GITHUB = "https://github.com/7heMech/cloudpanel-addons/releases";
const MIRROR = "https://cp.7he.dev";
const install = (events: string[]) => events.filter((event) => event.startsWith("clp:"));

test("the latest release comes from GitHub, is checked and handed every addon in one call", () => {
  const result = bootstrap("latest", "good", "instatic stager", "x86_64", "up");
  expect(result.status, result.output).toBe(0);
  const base = `${GITHUB}/latest/download`;
  expect(result.events.slice(0, 2)).toEqual([`get:${base}/SHA256SUMS`, `get:${base}/clp-addons-linux-x64`]);
  expect(install(result.events)).toHaveLength(1);
  expect(install(result.events)[0]).toStartWith("clp:install instatic stager --local=");
});

test("the mirror serves the latest release when GitHub cannot", () => {
  const result = bootstrap("latest", "good", "instatic stager", "x86_64", "up", "down");
  expect(result.status, result.output).toBe(0);
  const base = `${MIRROR}/releases/v1.2.3`;
  expect(result.events.slice(0, 4)).toEqual([
    `get:${GITHUB}/latest/download/SHA256SUMS`, `get:${MIRROR}/latest`, `get:${base}/SHA256SUMS`, `get:${base}/clp-addons-linux-x64`,
  ]);
  expect(install(result.events)).toHaveLength(1);
});

test("--version downloads that tag, from the mirror when GitHub cannot, and refuses a prerelease before downloading", () => {
  const pinned = bootstrap("v1.2.3");
  expect(pinned.status, pinned.output).toBe(0);
  expect(pinned.events[0]).toBe(`get:${GITHUB}/download/v1.2.3/SHA256SUMS`);

  const mirrored = bootstrap("v1.2.3", "good", "", "x86_64", "up", "down");
  expect(mirrored.status, mirrored.output).toBe(0);
  expect(mirrored.events.slice(0, 2)).toEqual([`get:${GITHUB}/download/v1.2.3/SHA256SUMS`, `get:${MIRROR}/releases/v1.2.3/SHA256SUMS`]);

  const candidate = bootstrap("v1.3.0-rc.1");
  expect(candidate.status).not.toBe(0);
  expect(candidate.events).toEqual([]);
  expect(candidate.output).toContain("not a stable release tag");
});

test("a binary that does not match SHA256SUMS is never run, from either source", () => {
  const result = bootstrap("latest", "bad", "instatic stager", "x86_64", "up");
  expect(result.status).not.toBe(0);
  expect(install(result.events)).toEqual([]);
  expect(result.events).toContain(`get:${MIRROR}/releases/v1.2.3/clp-addons-linux-x64`);
  expect(result.output).toContain("checksum mismatch");
});

test("with no addons named, only the binary and its services are installed", () => {
  const result = bootstrap("latest", "good", "");
  expect(result.status, result.output).toBe(0);
  expect(install(result.events)[0]).toStartWith("clp:install --local=");
});

test("an aarch64 host downloads the arm64 binary", () => {
  const result = bootstrap("latest", "good", "", "aarch64");
  expect(result.status, result.output).toBe(0);
  expect(result.events[1]).toBe(`get:${GITHUB}/latest/download/clp-addons-linux-arm64`);
  expect(install(result.events)[0]).toStartWith("clp:install --local=");
});

test("an architecture no release is built for stops before downloading", () => {
  const result = bootstrap("latest", "good", "", "riscv64");
  expect(result.status).not.toBe(0);
  expect(result.events).toEqual([]);
  expect(result.output).toContain("unsupported architecture riscv64");
});
