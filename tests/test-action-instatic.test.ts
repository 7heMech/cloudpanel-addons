import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeSnapshot, parseInstaticAction, panelIdentityForInstatic, pruneSnapshots, validateInstaticDomain,
} from "../addons/instatic/action";
import { dashboardView, newInstanceView } from "../addons/instatic/app/views";
import type { InstanceView } from "../addons/instatic/app/service";
import { isNewerThan } from "../addons/instatic/app/tags";
import { ActionFailure, normalizeIdentityHostname, validateFlag, validatePort, validateTag } from "../cli/action-common";

function failureMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ActionFailure) return error.message;
    throw error;
  }
  throw new Error("expected an ActionFailure");
}

test("the Instatic action parser preserves the wrapper's ignored TLS option", () => {
  expect(parseInstaticAction(["list", "--tls", "maybe"]).verb).toBe("list");
  expect(failureMessage(() => parseInstaticAction(["list", "--domain", "x.example.com"]))).toBe("list takes no arguments");
  expect(failureMessage(() => parseInstaticAction(["list", "--tls"]))).toBe("--tls needs a value");
  expect(failureMessage(() => parseInstaticAction(["unknown"]))).toBe("unknown verb: 'unknown'");
});

test("the shared action validators retain the reserved-input contract", () => {
  expect(normalizeIdentityHostname("Panel.Example.Test.")).toBe("panel.example.test");
  expect(normalizeIdentityHostname("*.panel.example.test")).toBe("*.panel.example.test");
  expect(normalizeIdentityHostname("bad..example.test")).toBeNull();
  expect(validatePort("39000")).toBe(39000);
  expect(failureMessage(() => validatePort("40000"))).toContain("outside reserved range");
  expect(failureMessage(() => validatePort("39000\n"))).toContain("must be an integer");
  expect(validateTag("0.0.18")).toBe("0.0.18");
  expect(failureMessage(() => validateTag("latest"))).toContain("exact version");
  expect(failureMessage(() => validateTag("0.0.18\n"))).toContain("exact version");
  expect(validateFlag("yes", "tls")).toBe("yes");
  expect(failureMessage(() => validateFlag("true", "tls"))).toContain("takes yes or no");
});

test("domain validation is routed through the shared identity guard", () => {
  expect(failureMessage(() => validateInstaticDomain("not a hostname", "/no/such/identity"))).toBe("invalid domain: 'not a hostname'");
  expect(failureMessage(() => validateInstaticDomain("valid.example.com\n", "/no/such/identity"))).toBe("invalid domain: 'valid.example.com\n'");
  expect(failureMessage(() => validateInstaticDomain("valid.example.com", "/no/such/identity"))).toBe("the CloudPanel panel identity is missing or malformed");
});

test("action stdout is one JSON object and strips control characters from strings", () => {
  const script = [
    'import { emitActionOk } from "./cli/action-common.ts";',
    'emitActionOk({ text: "before\\u001bafter\\u0007\\nnext" });',
  ].join(" ");
  const stdout = execFileSync(process.execPath, ["-e", script], {
    cwd: join(import.meta.dir, ".."),
    encoding: "utf8",
  });
  expect(stdout.endsWith("\n")).toBe(true);
  expect(stdout.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(stdout)).toEqual({ ok: true, data: { text: "beforeafter\nnext" } });
});

test("the daemon invokes the unified binary action path", () => {
  const service = readFileSync(join(import.meta.dir, "../addons/instatic/app/service.ts"), "utf8");
  expect(service).toContain('callGatewayAction<T>("instatic", verb, args');
});

test("makeSnapshot archives non-SQLite regular data files", () => {
  const root = mkdtempSync(join(tmpdir(), "instatic-snapshot-test-"));
  try {
    const instance = join(root, "instance");
    const data = join(instance, "data");
    const archive = join(root, "snapshot.tar.gz");
    const restored = join(root, "restored");
    const file = join(data, "notes.txt");
    const mtime = new Date("2020-01-02T03:04:05.000Z");
    mkdirSync(data, { recursive: true });
    writeFileSync(file, "plain data\n");
    utimesSync(file, mtime, mtime);

    expect(makeSnapshot(instance, archive)).toBe(true);

    mkdirSync(restored);
    execFileSync("tar", ["-xzf", archive, "-C", restored]);
    const restoredFile = join(restored, "data", "notes.txt");
    expect(readFileSync(restoredFile, "utf8")).toBe("plain data\n");
    expect(statSync(restoredFile).mtimeMs).toBeCloseTo(mtime.getTime(), -2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("makeSnapshot does not dereference symlinks or archive symlinked host files", () => {
  const root = mkdtempSync(join(tmpdir(), "instatic-snapshot-symlink-test-"));
  try {
    const secretFile = join(root, "host-secret.txt");
    writeFileSync(secretFile, "SUPER_SECRET_CONTENT\n");

    const instance = join(root, "instance");
    const data = join(instance, "data");
    const uploads = join(instance, "uploads");
    const archive = join(root, "snapshot.tar.gz");
    const restored = join(root, "restored");

    mkdirSync(data, { recursive: true });
    mkdirSync(uploads, { recursive: true });

    // 1. Regular file in data
    writeFileSync(join(data, "normal.txt"), "normal content\n");

    // 2. Symlink in data pointing to host secret
    symlinkSync(secretFile, join(data, "leak-secret.txt"));

    // 3. Symlink in uploads pointing to host secret
    symlinkSync(secretFile, join(uploads, "upload-leak.txt"));

    // 4. Symlink env file pointing to host secret
    symlinkSync(secretFile, join(instance, "instatic.env"));

    expect(makeSnapshot(instance, archive)).toBe(true);

    mkdirSync(restored);
    execFileSync("tar", ["-xzf", archive, "-C", restored]);

    // Data should contain normal.txt
    expect(readFileSync(join(restored, "data", "normal.txt"), "utf8")).toBe("normal content\n");

    // Symlinks in data should not be archived
    expect(existsSync(join(restored, "data", "leak-secret.txt"))).toBe(false);

    // Symlink instatic.env should not be archived
    expect(existsSync(join(restored, "instatic.env"))).toBe(false);

    // In uploads, if tar extracted anything for upload-leak.txt, it must NOT be a dereferenced regular file
    const restoredUploadLeak = join(restored, "uploads", "upload-leak.txt");
    if (existsSync(restoredUploadLeak)) {
      const stat = lstatSync(restoredUploadLeak);
      expect(stat.isSymbolicLink()).toBe(true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Auto-update is off by default because Instatic is pre-1.0, and that is only
// a defensible policy if the dashboard says when a release happened. It did
// not: the registry listing was fetched for the New Site page only, and the
// update dialog was a free-text box, so learning about 0.0.19 meant going to
// look at ghcr.io.
describe("version awareness", () => {
  for (const [newer, older, expected] of [
    ["0.0.19", "0.0.18", true],
    ["0.0.18", "0.0.9", true],
    ["1.0.0", "0.9.9", true],
    ["0.0.18", "0.0.18", false],
    ["0.0.9", "0.0.18", false],
    // A tag that is not a version can never be behind one.
    ["latest", "0.0.18", false],
  ] as const) {
    test(`${newer} is ${expected ? "" : "not "}newer than ${older}`, () => {
      expect(isNewerThan(newer, older)).toBe(expected);
    });
  }

  const instance = (tag: string): InstanceView => ({
    domain: "demo.example.com", port: 39000, tag, container: "instatic-demo.example.com",
    siteUser: "addon-demoexam-abc123", createdAt: "2026-01-01T00:00:00Z", state: "running",
  });
  const live = (latest: string) => ({ tags: [latest], source: "registry" as const, latest });

  test("an out-of-date instance is badged and counted", () => {
    const html = dashboardView([instance("0.0.17")], 0, [], live("0.0.18"));
    expect(html).toInclude("0.0.18 available");
    expect(html).toMatch(/Updates available<\/div>\s*<div class="value"[^>]*>1</);
  });

  test("a current instance is not", () => {
    const html = dashboardView([instance("0.0.18")], 0, [], live("0.0.18"));
    expect(html).not.toInclude("available</span>");
    expect(html).toMatch(/Updates available<\/div>\s*<div class="value"[^>]*>0</);
  });

  // The offline list is one hardcoded version. Badging against it would invent
  // updates that do not exist, and claim an instance is behind a version that
  // may long since have been superseded.
  test("the offline fallback never claims an update", () => {
    const html = dashboardView([instance("0.0.17")], 0, [], { tags: ["0.0.18"], source: "fallback", latest: null });
    expect(html).not.toInclude("0.0.18 available");
    expect(html).toInclude("Could not reach ghcr.io");
  });
});

// make_snapshot used to prune its own output directory to the five newest
// archives. Correct for an instance's snapshots/ directory, which exists to
// roll back the update that just happened. Wrong for the pre-delete archive,
// which goes to /var/backups/clp-addons/<addon>: that directory holds one
// archive per deleted instance, each the last copy of data whose CloudPanel
// site is already gone. So `uninstall --purge` on six or more instances
// destroyed archives it had written itself earlier in the same run.
test("archiving an instance is not a rolling window", () => {
  const dir = mkdtempSync(`${tmpdir()}/clp-addons-archive-`);
  try {
    const inst = `${dir}/instance`;
    mkdirSync(`${inst}/data`, { recursive: true });
    mkdirSync(`${inst}/uploads`, { recursive: true });
    // A real SQLite file, so the native backup branch is exercised.
    const db = new Database(`${inst}/data/instatic.db`);
    db.run("create table t(x); insert into t values(1);");
    db.close();
    writeFileSync(`${inst}/instatic.env`, "INSTATIC_SECRET_KEY=deadbeef\n");

    const backups = `${dir}/backups`;
    mkdirSync(backups, { recursive: true });
    // Six deletions, the way uninstall --purge makes them: one archive each,
    // into the one shared directory.
    for (let i = 1; i <= 6; i++) {
      expect(makeSnapshot(inst, `${backups}/site${i}.example.com-deleted-2020010${i}.tar.gz`)).toBe(true);
    }
    const kept = readdirSync(backups).sort();
    expect(kept).toHaveLength(6);
    expect(kept).toContain("site1.example.com-deleted-20200101.tar.gz");

    // The rolling window itself still has to work, or update would fill the
    // root filesystem with pre-update snapshots instead.
    const rolling = `${dir}/snapshots`;
    mkdirSync(rolling, { recursive: true });
    for (let i = 1; i <= 7; i++) writeFileSync(`${rolling}/pre-update-0.0.${i}-2020010${i}.tar.gz`, "x");
    pruneSnapshots(rolling);
    expect(readdirSync(rolling)).toHaveLength(5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the TLS certificate option", () => {
  test("the New Site page offers it", () => {
    const html = newInstanceView(39001, { tags: ["0.0.18"], source: "registry", latest: "0.0.18" });
    expect(html).toInclude('<input type="checkbox" id="tls"');
    expect(html).toInclude("Request a Let's Encrypt certificate immediately");
  });

  test("the action takes the flag and asks the panel for the certificate", () => {
    const source = readFileSync(join(import.meta.dir, "../addons/instatic/action.ts"), "utf-8");
    expect(source).toInclude('flag === "--tls"');
    expect(source).toInclude('validateFlag(tls, "tls")');
    expect(source).toInclude('if (tls === "yes")');
    expect(source).toInclude("lets-encrypt:install:certificate");
  });

  test("the flag validator takes yes and no and nothing else", () => {
    expect(() => validateFlag("yes", "test")).not.toThrow();
    expect(() => validateFlag("no", "test")).not.toThrow();
    for (const bad of ["maybe", "true", ""]) {
      expect(() => validateFlag(bad, "test"), bad).toThrow();
    }
  });
});
