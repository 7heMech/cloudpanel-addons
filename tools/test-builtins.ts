import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadLocal } from "../cli/release";
import { reconcile, reconcileNginxProxy, type Injection } from "../cli/inject";
import { have, tryRun } from "../cli/util";
import { isNewerThan, listAvailableTags } from "../addons/instatic/app/tags";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok    ${label}`);
    passed++;
  } else {
    console.log(`  FAIL  ${label}${detail ? `: ${detail}` : ""}`);
    failed++;
  }
}

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf-8");
}

function throws(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const utilSource = source("cli/util.ts");
const releaseSource = source("cli/release.ts");
const injectSource = source("cli/inject.ts");
const tagsSource = source("addons/instatic/app/tags.ts");

check("PATH probing uses Bun.which", utilSource.includes("Bun.which(cmd") && !utilSource.includes('run("command", ["-v"'));
check("have finds and rejects commands", have("sh") && !have("clp-addons-command-that-does-not-exist"));
check(
  "private GitHub CLI keeps absolute-path probing",
  releaseSource.includes('candidate !== "gh" && !existsSync(candidate)') && releaseSource.includes("GH_PRIVATE"),
);

const success = tryRun(process.execPath, ["-e", 'process.stdout.write("stdout");']);
check("tryRun decodes successful stdout", success.ok && success.out === "stdout", JSON.stringify(success));

const failedWithBoth = tryRun(process.execPath, [
  "-e",
  'process.stdout.write("stdout"); process.stderr.write("stderr"); process.exit(7);',
]);
check(
  "tryRun prefers stderr for nonzero commands",
  !failedWithBoth.ok && failedWithBoth.out === "stderr",
  JSON.stringify(failedWithBoth),
);

const failedWithStdout = tryRun(process.execPath, ["-e", 'process.stdout.write("stdout"); process.exit(7);']);
check("tryRun falls back to stdout", !failedWithStdout.ok && failedWithStdout.out === "stdout", JSON.stringify(failedWithStdout));

const spawnFailure = tryRun("/no/such/clp-addons-command", []);
check("tryRun preserves spawn-failure messages", !spawnFailure.ok && /not found|ENOENT/i.test(spawnFailure.out), JSON.stringify(spawnFailure));
check("tryRun uses Bun.spawnSync", utilSource.includes("Bun.spawnSync([cmd, ...args]"));

check(
  "release checksums use Bun.CryptoHasher",
  releaseSource.includes('Bun.CryptoHasher.hash("sha256", bytes, "hex")') && !releaseSource.includes('from "node:crypto"'),
);
check(
  "inject hashes use Bun.CryptoHasher",
  injectSource.includes('Bun.CryptoHasher.hash("sha256", s, "hex")') && !injectSource.includes('from "node:crypto"'),
);

const checksumDir = mkdtempSync(`${tmpdir()}/release-builtins-test-`);
try {
  const bytes = Buffer.from("checksum fixture\n", "utf-8");
  const expected = Bun.CryptoHasher.hash("sha256", bytes, "hex");
  writeFileSync(`${checksumDir}/artifact`, bytes);
  writeFileSync(`${checksumDir}/SHA256SUMS`, `${expected} *artifact\nnot-a-checksum artifact\n`);
  const loaded = loadLocal(checksumDir, ["artifact"]);
  check("loadLocal accepts a valid Bun SHA-256 checksum", loaded.length === 1 && loaded[0]?.bytes.equals(bytes));

  writeFileSync(`${checksumDir}/artifact`, Buffer.from("tampered\n", "utf-8"));
  check("loadLocal keeps rejecting checksum mismatches", throws(() => loadLocal(checksumDir, ["artifact"])));
} finally {
  rmSync(checksumDir, { recursive: true, force: true });
}

const injectDir = mkdtempSync(`${tmpdir()}/inject-builtins-test-`);
try {
  const template = `${injectDir}/header.twig`;
  const state = `${injectDir}/state`;
  const original = "<main>\n</main>\n";
  const target = {
    slug: "builtin-test",
    template: "header.twig",
    anchorAfter: "<main>",
    required: true,
    snippet: (url: string) => `\n<a href="${url}">built-in</a>`,
  };
  writeFileSync(template, original);
  reconcile([{ addon: "test", target, url: "https://example.test/addons" } satisfies Injection], {
    templatesDir: injectDir,
    stateDir: state,
  });
  const hashFile = readdirSync(state).find((entry) => entry.endsWith(".sha256"));
  const expected = Bun.CryptoHasher.hash("sha256", original, "hex");
  check("inject records a Bun SHA-256 snapshot hash", hashFile !== undefined && readFileSync(`${state}/${hashFile}`, "utf-8").trim() === expected);
} finally {
  rmSync(injectDir, { recursive: true, force: true });
}

check("tag comparison remains numeric", isNewerThan("0.0.18", "0.0.9") && !isNewerThan("0.0.9", "0.0.18"));
check("strict tag filtering remains in place", tagsSource.includes("const VERSION_RE = /^\\d+\\.\\d+\\.\\d+$/;"));
check("tag sorting uses reversed Bun semver order", tagsSource.includes("Bun.semver.order(b, a)"));

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/token?")) return new Response(JSON.stringify({ token: "test-token" }));
    return new Response(JSON.stringify({ tags: ["1.0.9", "1.0.18", "not-a-version", "1.0.10"] }));
  };
  const listed = await listAvailableTags();
  check("registry tags are filtered and sorted descending", listed.tags.join(",") === "1.0.18,1.0.10,1.0.9", listed.tags.join(","));
} finally {
  globalThis.fetch = originalFetch;
}

const nginxDir = mkdtempSync(`${tmpdir()}/nginx-builtins-test-`);
try {
  const vhost = `${nginxDir}/cloudpanel.conf`;
  const state = `${nginxDir}/state`;
  const bin = `${nginxDir}/bin`;
  mkdirSync(bin);
  writeFileSync(vhost, "server {\n    listen 8443 ssl;\n}\n");
  writeFileSync(`${bin}/nginx`, "#!/bin/sh\nprintf stdout-marker\nprintf stderr-marker >&2\nexit 1\n", { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  try {
    const result = reconcileNginxProxy({ vhostPath: vhost, stateDir: state });
    check(
      "Nginx status helper preserves stderr precedence",
      result.state === "validation-failed" && result.detail?.includes("stderr-marker") === true && !result.detail.includes("stdout-marker"),
      result.detail,
    );
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
} finally {
  rmSync(nginxDir, { recursive: true, force: true });
}

check("Nginx status helper uses Bun.spawnSync", injectSource.includes("Bun.spawnSync([command, ...args]"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
