import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

interface ProbeOptions {
  privateGh?: "good" | "old";
  pathGh?: "good" | "old";
  checksum?: "bad" | "missing";
  badDownload?: boolean;
  badTag?: boolean;
  badCandidate?: boolean;
  symlinkCandidate?: boolean;
  renameFailure?: boolean;
  verify?: boolean;
  skip?: boolean;
  attestationFailure?: boolean;
}

// Isolate fetch/privilege mocks from the suites that mock cli/release itself.
// Only ownership is simulated: the archive, probes, rename and cleanup use
// real files and commands under a temporary directory, without root or GitHub.
const PROBE = String.raw`
  import { mock } from "bun:test";
  import * as fs from "node:fs";
  import { execFileSync } from "node:child_process";
  import { tmpdir } from "node:os";
  import * as paths from "./cli/paths.ts";
  import * as util from "./cli/util.ts";

  const options = JSON.parse(process.env.GH_PROBE_OPTIONS);
  const root = fs.mkdtempSync(tmpdir() + "/gh-lifecycle-test-");
  const privatePath = root + "/libexec/gh";
  const bin = root + "/bin";
  const attempts = root + "/attempts";
  const requests = [];
  const publications = [];
  const commands = [];
  const tag = "v2.99.0";
  const folder = "gh_2.99.0_linux_" + (process.arch === "arm64" ? "arm64" : "amd64");
  const tarball = folder + ".tar.gz";
  const base = "https://github.com/cli/cli/releases/download/" + tag;
  const good = '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GH_PROBE_ATTEMPTS"\nif [ "$1 $2" = "attestation --help" ]; then exit 0; fi\nif [ "$1 $2" = "attestation verify" ]; then exit ' + (options.attestationFailure ? "1" : "0") + '; fi\nexit 1\n';
  const old = "#!/bin/sh\nexit 1\n";
  const tar = Bun.which("tar");
  const gzip = Bun.which("gzip");
  const realLstat = fs.lstatSync;
  const realRename = fs.renameSync;
  const realRun = util.run;
  try {
    for (const path of [root + "/libexec", bin, root + "/tmp", root + "/archive/" + folder + "/bin"]) {
      fs.mkdirSync(path, { recursive: true, mode: 0o755 });
    }
    fs.symlinkSync(tar, bin + "/tar");
    fs.symlinkSync(gzip, bin + "/gzip");
    if (options.privateGh) fs.writeFileSync(privatePath, options.privateGh === "good" ? good : old, { mode: 0o755 });
    if (options.pathGh) fs.writeFileSync(bin + "/gh", options.pathGh === "good" ? good : old, { mode: 0o755 });
    const member = root + "/archive/" + folder + "/bin/gh";
    if (options.symlinkCandidate) fs.symlinkSync("/bin/true", member);
    else fs.writeFileSync(member, options.badCandidate ? old : good, { mode: 0o755 });
    execFileSync(tar, ["-czf", root + "/archive.tar.gz", "-C", root + "/archive", folder]);
    const bytes = fs.readFileSync(root + "/archive.tar.gz");
    const sum = Bun.CryptoHasher.hash("sha256", bytes, "hex");
    process.env.PATH = bin;
    process.env.TMPDIR = root + "/tmp";
    process.env.GH_PROBE_ATTEMPTS = attempts;

    mock.module("./cli/paths.ts", () => ({ ...paths, GH_PRIVATE: privatePath }));
    mock.module("./cli/util.ts", () => ({
      ...util,
      requireRoot: () => {},
      log: { step: () => {}, ok: () => {}, warn: () => {} },
      run(command, args) {
        commands.push(command);
        return realRun(command, args);
      },
    }));
    mock.module("node:fs", () => ({
      ...fs,
      lstatSync(path, ...args) {
        const stat = realLstat(path, ...args);
        if (String(path).startsWith(root + "/")) stat.uid = 0;
        return stat;
      },
      chownSync(path, uid, gid) {
        if (!String(path).startsWith(root + "/") || uid !== 0 || gid !== 0) throw new Error("unexpected chown");
      },
      renameSync(from, to) {
        if (to !== privatePath) throw new Error("unexpected publication");
        publications.push({
          previous: fs.existsSync(to) ? fs.readFileSync(to, "utf8") : null,
          mode: realLstat(from).mode & 0o777,
          probed: fs.existsSync(attempts) && fs.readFileSync(attempts, "utf8").includes("attestation --help"),
        });
        if (options.renameFailure) throw new Error("simulated atomic rename failure");
        realRename(from, to);
      },
    }));
    globalThis.fetch = async (url) => {
      requests.push(String(url));
      if (url === "https://api.github.com/repos/cli/cli/releases/latest") {
        return Response.json({ tag_name: options.badTag ? "../../bad" : tag, draft: false, prerelease: false });
      }
      if (url === base + "/gh_2.99.0_checksums.txt") {
        return new Response(options.checksum === "missing" ? "" : (options.checksum === "bad" ? "0".repeat(64) : sum) + " *" + tarball + "\n");
      }
      if (url === base + "/" + tarball) return new Response(options.badDownload ? "unavailable" : bytes, { status: options.badDownload ? 503 : 200 });
      if (url === "https://example.invalid/attestations.jsonl") return new Response("fixture bundle\n");
      throw new Error("unexpected network request: " + url);
    };
    const { ensureGh, verifyAttestation } = await import("./cli/release.ts");
    let chosen = null;
    let error = null;
    try {
      if (options.verify || options.skip) {
        await verifyAttestation({ tag: "v1.2.3", assets: new Map([["attestations.jsonl", "https://example.invalid/attestations.jsonl"]]) }, [
          { name: "clp-addons-linux-x64", bytes: Buffer.from("addon binary") },
        ], options.skip === true);
      } else {
        chosen = await ensureGh();
        const requestCount = requests.length;
        if (await ensureGh() !== chosen || requests.length !== requestCount) throw new Error("ensureGh is not idempotent");
      }
    } catch (e) {
      error = e.message;
    }
    const installed = fs.existsSync(privatePath) ? fs.readFileSync(privatePath, "utf8") : null;
    process.stdout.write(JSON.stringify({
      chosen: chosen === privatePath ? "private" : chosen === bin + "/gh" ? "PATH" : chosen,
      error, requests, commands, publications,
      installed: installed === good ? "good" : installed === old ? "old" : null,
      privateEntries: fs.readdirSync(root + "/libexec"),
      scratchEntries: fs.readdirSync(root + "/tmp"),
      attempts: fs.existsSync(attempts) ? fs.readFileSync(attempts, "utf8") : "",
    }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
`;

interface ProbeResult {
  chosen: "private" | "PATH" | null;
  error: string | null;
  requests: string[];
  commands: string[];
  publications: { previous: string | null; mode: number; probed: boolean }[];
  installed: "good" | "old" | null;
  privateEntries: string[];
  scratchEntries: string[];
  attempts: string;
}

function probe(options: ProbeOptions): ProbeResult {
  return JSON.parse(execFileSync(process.execPath, ["-e", PROBE], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, GH_PROBE_OPTIONS: JSON.stringify(options) },
    encoding: "utf8",
  }));
}

test("ensureGh prefers a private attesting gh and makes no network requests", () => {
  const result = probe({ privateGh: "good", pathGh: "good" });
  expect(result.error).toBeNull();
  expect(result.chosen).toBe("private");
  expect(result.requests).toEqual([]);
  expect(result.publications).toEqual([]);
});

test("ensureGh falls back to a suitable PATH gh when the private one is too old", () => {
  const result = probe({ privateGh: "old", pathGh: "good" });
  expect(result.error).toBeNull();
  expect(result.chosen).toBe("PATH");
  expect(result.requests).toEqual([]);
  expect(result.installed).toBe("old");
});

test.each([{}, { privateGh: "old", pathGh: "old" } satisfies ProbeOptions])("ensureGh installs an official checksum-verified tarball atomically and reuses it: %j", (options) => {
  const result = probe(options);
  expect(result.error).toBeNull();
  expect(result.chosen).toBe("private");
  expect(result.installed).toBe("good");
  expect(result.requests).toHaveLength(3);
  expect(result.publications).toHaveLength(1);
  expect(result.publications[0]?.mode).toBe(0o755);
  expect(result.publications[0]?.probed).toBe(true);
  expect(result.privateEntries).toEqual(["gh"]);
  expect(result.scratchEntries).toEqual([]);
});

test.each([
  { checksum: "bad" }, { checksum: "missing" }, { badDownload: true }, { badTag: true },
] satisfies ProbeOptions[])("ensureGh rejects unverified downloads before extraction: %j", (options) => {
  const result = probe({ privateGh: "old", ...options });
  expect(result.error).not.toBeNull();
  expect(result.installed).toBe("old");
  expect(result.commands).not.toContain("tar");
  expect(result.publications).toEqual([]);
  expect(result.scratchEntries).toEqual([]);
});

test.each([
  { badCandidate: true, message: "does not support attestation" },
  { symlinkCandidate: true, message: "regular gh executable" },
  { renameFailure: true, message: "simulated atomic rename failure" },
])("ensureGh preserves the old executable and cleans staging when installation fails: %j", (options) => {
  const result = probe({ privateGh: "old", ...options });
  expect(result.error).toContain(options.message);
  expect(result.installed).toBe("old");
  expect(result.privateEntries).toEqual(["gh"]);
  expect(result.scratchEntries).toEqual([]);
});

test("release attestation self-heals missing gh before invoking the repository-bound verifier", () => {
  const result = probe({ verify: true });
  expect(result.error).toBeNull();
  expect(result.installed).toBe("good");
  expect(result.attempts).toContain("attestation verify ");
  expect(result.attempts).toContain("--bundle ");
  expect(result.attempts).toContain("--repo 7heMech/cloudpanel-addons");
  expect(result.attempts).toContain("--signer-workflow 7heMech/cloudpanel-addons/.github/workflows/release.yml");
  expect(result.scratchEntries).toEqual([]);
});

test("an attestation failure still rejects the release after gh recovery", () => {
  const result = probe({ verify: true, attestationFailure: true });
  expect(result.error).toContain("provenance verification failed");
  expect(result.installed).toBe("good");
  expect(result.scratchEntries).toEqual([]);
});

test("explicitly skipped attestation neither installs nor invokes gh", () => {
  const result = probe({ skip: true });
  expect(result.error).toBeNull();
  expect(result.requests).toEqual([]);
  expect(result.publications).toEqual([]);
  expect(result.attempts).toBe("");
});
