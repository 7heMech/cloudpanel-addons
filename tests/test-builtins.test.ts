// Bun's built-ins replaced a set of Node and shell calls across the CLI. These
// assert both the behaviour and, where a regression would be silent, that the
// call site still reads the way it has to.
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadLocal } from "../cli/release";
import { reconcile, reconcileNginxProxy, type Injection } from "../cli/inject";
import { have, tryRun } from "../cli/util";
import { isNewerThan, listAvailableTags } from "../addons/instatic/app/tags";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf-8");
}

test("PATH probing uses Bun.which", () => {
  const utilSource = source("cli/util.ts");
  expect(utilSource).toInclude("Bun.which(cmd");
  expect(utilSource).not.toInclude('run("command", ["-v"');
});

test("have finds and rejects commands", () => {
  expect(have("sh")).toBe(true);
  expect(have("clp-addons-command-that-does-not-exist")).toBe(false);
});

test("tryRun decodes successful stdout", () => {
  const success = tryRun(process.execPath, ["-e", 'process.stdout.write("stdout");']);
  expect(success).toMatchObject({ ok: true, out: "stdout" });
});

test("tryRun prefers stderr for nonzero commands", () => {
  const result = tryRun(process.execPath, [
    "-e",
    'process.stdout.write("stdout"); process.stderr.write("stderr"); process.exit(7);',
  ]);
  expect(result).toMatchObject({ ok: false, out: "stderr" });
});

test("tryRun falls back to stdout", () => {
  const result = tryRun(process.execPath, ["-e", 'process.stdout.write("stdout"); process.exit(7);']);
  expect(result).toMatchObject({ ok: false, out: "stdout" });
});

test("tryRun preserves spawn-failure messages", () => {
  const result = tryRun("/no/such/clp-addons-command", []);
  expect(result.ok).toBe(false);
  expect(result.out).toMatch(/not found|ENOENT/i);
});

test("tryRun uses Bun.spawnSync", () => {
  expect(source("cli/util.ts")).toInclude("Bun.spawnSync([cmd, ...args]");
});

test("release checksums use Bun.CryptoHasher", () => {
  const releaseSource = source("cli/release.ts");
  expect(releaseSource).toInclude('Bun.CryptoHasher.hash("sha256", bytes, "hex")');
  expect(releaseSource).not.toInclude('from "node:crypto"');
});

test("inject hashes use Bun.CryptoHasher", () => {
  const injectSource = source("cli/inject.ts");
  expect(injectSource).toInclude('Bun.CryptoHasher.hash("sha256", s, "hex")');
  expect(injectSource).not.toInclude('from "node:crypto"');
});

test("loadLocal accepts a valid Bun SHA-256 checksum and rejects a mismatch", () => {
  const dir = mkdtempSync(`${tmpdir()}/release-builtins-test-`);
  try {
    const bytes = Buffer.from("checksum fixture\n", "utf-8");
    const expected = Bun.CryptoHasher.hash("sha256", bytes, "hex");
    writeFileSync(`${dir}/artifact`, bytes);
    writeFileSync(`${dir}/SHA256SUMS`, `${expected} *artifact\nnot-a-checksum artifact\n`);
    const loaded = loadLocal(dir, ["artifact"]);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.bytes.equals(bytes)).toBe(true);

    writeFileSync(`${dir}/artifact`, Buffer.from("tampered\n", "utf-8"));
    expect(() => loadLocal(dir, ["artifact"])).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inject records a Bun SHA-256 snapshot hash", () => {
  const dir = mkdtempSync(`${tmpdir()}/inject-builtins-test-`);
  try {
    const template = `${dir}/header.twig`;
    const state = `${dir}/state`;
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
      templatesDir: dir,
      stateDir: state,
    });
    const hashFile = readdirSync(state).find((entry) => entry.endsWith(".sha256"));
    expect(hashFile).toBeDefined();
    expect(readFileSync(`${state}/${hashFile}`, "utf-8").trim())
      .toBe(Bun.CryptoHasher.hash("sha256", original, "hex"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tag comparison remains numeric", () => {
  expect(isNewerThan("0.0.18", "0.0.9")).toBe(true);
  expect(isNewerThan("0.0.9", "0.0.18")).toBe(false);
});

test("strict tag filtering remains in place", () => {
  expect(source("addons/instatic/app/tags.ts")).toInclude("const VERSION_RE = /^\\d+\\.\\d+\\.\\d+$/;");
});

test("tag sorting uses reversed Bun semver order", () => {
  expect(source("addons/instatic/app/tags.ts")).toInclude("Bun.semver.order(b, a)");
});

test("registry tags are filtered and sorted descending", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
      if (String(input).includes("/token?")) return new Response(JSON.stringify({ token: "test-token" }));
      return new Response(JSON.stringify({ tags: ["1.0.9", "1.0.18", "not-a-version", "1.0.10"] }));
    }, { preconnect: originalFetch.preconnect }) satisfies typeof fetch;
    const listed = await listAvailableTags();
    expect(listed.tags).toEqual(["1.0.18", "1.0.10", "1.0.9"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Nginx status helper preserves stderr precedence", () => {
  const dir = mkdtempSync(`${tmpdir()}/nginx-builtins-test-`);
  const oldPath = process.env.PATH;
  try {
    const vhost = `${dir}/cloudpanel.conf`;
    const bin = `${dir}/bin`;
    mkdirSync(bin);
    writeFileSync(vhost, "server {\n    listen 8443 ssl;\n}\n");
    writeFileSync(`${bin}/nginx`, "#!/bin/sh\nprintf stdout-marker\nprintf stderr-marker >&2\nexit 1\n", { mode: 0o755 });
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    const result = reconcileNginxProxy({ vhostPath: vhost, stateDir: `${dir}/state` });
    expect(result.state).toBe("validation-failed");
    expect(result.detail).toInclude("stderr-marker");
    expect(result.detail).not.toInclude("stdout-marker");
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Nginx status helper uses Bun.spawnSync", () => {
  expect(source("cli/inject.ts")).toInclude("Bun.spawnSync([command, ...args]");
});
