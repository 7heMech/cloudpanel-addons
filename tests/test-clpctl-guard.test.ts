import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  applyClpctlGuard, clpctlGuardStatus, restoreClpctlWrapper, type ClpctlGuardOptions,
} from "../addons/system-tweaks/clpctl-guard";
import WRAPPER_SCRIPT from "../addons/system-tweaks/clpctl-wrapper.sh" with { type: "text" };

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "clp-clpctl-"));
  dirs.push(dir);
  return dir;
}

// The exact /usr/bin/clpctlWrapper this mitigation was built against (cloudpanel
// 2.5.4-3), base64'd. Its SHA-256 is in KNOWN_ORIGINAL_SHA256, so the module
// treats it as a known original.
const ORIGINAL_B64 =
  "IyEvYmluL2Jhc2gKYWRkc2xhc2hlcygpewogIGxvY2FsIGlucHV0PSIkMSIKICBsb2NhbCBlc2Nh" +
  "cGVkPSIke2lucHV0Ly9cXC9cXFxcfSIKICBlc2NhcGVkPSIke2VzY2FwZWQvL1xgL1xcXGB9Igog" +
  "IGVzY2FwZWQ9IiR7ZXNjYXBlZC8vXCgvXFxcKH0iCiAgZXNjYXBlZD0iJHtlc2NhcGVkLy9cKS9c" +
  "XFwpfSIKICBlc2NhcGVkPSIke2VzY2FwZWQvL1wkL1xcXCR9IgogIGVzY2FwZWQ9IiR7ZXNjYXBl" +
  "ZC8vXFxcIi9cXFxcXCJ9IgogIGVjaG8gIiRlc2NhcGVkIgp9CmlmIFsgIiQjIiAtZXEgMCBdOyB0" +
  "aGVuCiAgQ09NTUFORD0iL3Vzci9iaW4vcGhwOC4xIC1jIC9ob21lL2NscC9zZXJ2aWNlcy9waHAt" +
  "ZnBtL2NsaS9waHAuaW5pIC9ob21lL2NscC9odGRvY3MvYXBwL2ZpbGVzL2Jpbi9jbHBjdGwgJEAi" +
  "CmVsc2UKICBhcmdzPSQoYWRkc2xhc2hlcyAiJChwcmludGYgJyAiJXEiJyAiJEAiKSIpCiAgaWYg" +
  "ZWNobyAiJGFyZ3MiIHwgZ3JlcCAtcSAnXFxuJzt0aGVuCiAgICBlY2hvICJJbnZhbGlkIGNvbW1h" +
  "bmQiO2V4aXQKICBlbGlmIGVjaG8gIiRhcmdzIiB8IGdyZXAgLXEgJ1xccic7dGhlbgogICAgZWNo" +
  "byAiSW52YWxpZCBjb21tYW5kIjtleGl0CiAgZmkKICBDT01NQU5EPSIvdXNyL2Jpbi9waHA4LjEg" +
  "LWMgL2hvbWUvY2xwL3NlcnZpY2VzL3BocC1mcG0vY2xpL3BocC5pbmkgL2hvbWUvY2xwL2h0ZG9j" +
  "cy9hcHAvZmlsZXMvYmluL2NscGN0bCAkYXJncyIKZmkKc3UgLXMgL2Jpbi9iYXNoIC1jICIkQ09N" +
  "TUFORCIgY2xw";
const ORIGINAL = Buffer.from(ORIGINAL_B64, "base64").toString("utf8");

interface Fixture {
  dir: string;
  options: ClpctlGuardOptions;
  wrapper: string;
  backup: string;
  writeWrapper: (bytes: string) => void;
}

function fixture(version: string | null = "2.5.4-3"): Fixture {
  const dir = tempDir();
  const uid = process.getuid!();
  const wrapper = join(dir, "clpctlWrapper");
  const backup = join(dir, "state", "clpctlWrapper.orig");
  const writeWrapper = (bytes: string) => writeFileSync(wrapper, bytes, { mode: 0o700 });
  return {
    dir, wrapper, backup, writeWrapper,
    options: { version, paths: { wrapper, backup, rootUid: uid } },
  };
}

test("a known CloudPanel wrapper on a known version is replaced, and its original saved", () => {
  const f = fixture();
  f.writeWrapper(ORIGINAL);
  expect(clpctlGuardStatus(true, f.options)).toMatchObject({ active: false, applicable: true, wrapper: "known-original" });

  const result = applyClpctlGuard(f.options);
  expect(result).toEqual({ changed: true, active: true });
  expect(readFileSync(f.wrapper, "utf8")).toBe(WRAPPER_SCRIPT);
  expect(readFileSync(f.backup, "utf8")).toBe(ORIGINAL);
  expect(clpctlGuardStatus(true, f.options)).toMatchObject({ active: true, applicable: true, wrapper: "ours" });

  // Applying again changes nothing.
  expect(applyClpctlGuard(f.options)).toEqual({ changed: false, active: true });
});

test("a CloudPanel version this release does not know leaves the wrapper in place", () => {
  const f = fixture("2.6.0-1");
  f.writeWrapper(ORIGINAL);
  const result = applyClpctlGuard(f.options);
  expect(result.changed).toBe(false);
  expect(result.active).toBe(false);
  expect(result.reason).toContain("2.6.0-1");
  expect(readFileSync(f.wrapper, "utf8")).toBe(ORIGINAL);
  expect(clpctlGuardStatus(true, f.options).applicable).toBe(false);
});

test("a wrapper whose bytes we do not recognise is never touched", () => {
  const f = fixture();
  f.writeWrapper("#!/bin/bash\n# some other wrapper CloudPanel shipped later\nexit 0\n");
  const result = applyClpctlGuard(f.options);
  expect(result.changed).toBe(false);
  expect(result.reason).toContain("left in place");
  expect(readFileSync(f.wrapper, "utf8")).toContain("some other wrapper");
  expect(clpctlGuardStatus(true, f.options).wrapper).toBe("unknown");
});

test("a missing wrapper is reported, not created", () => {
  const f = fixture();
  const status = clpctlGuardStatus(true, f.options);
  expect(status).toMatchObject({ active: false, applicable: false, wrapper: "missing" });
  expect(applyClpctlGuard(f.options).changed).toBe(false);
});

test("repair re-applies after a CloudPanel update reinstalls the original", () => {
  const f = fixture();
  f.writeWrapper(ORIGINAL);
  applyClpctlGuard(f.options);
  // CloudPanel's package reinstalls its own wrapper over ours.
  f.writeWrapper(ORIGINAL);
  expect(clpctlGuardStatus(true, f.options).active).toBe(false);
  expect(applyClpctlGuard(f.options)).toEqual({ changed: true, active: true });
  expect(readFileSync(f.wrapper, "utf8")).toBe(WRAPPER_SCRIPT);
});

test("ours without a saved original is paused rather than trusted", () => {
  const f = fixture();
  f.writeWrapper(WRAPPER_SCRIPT);
  const status = clpctlGuardStatus(true, f.options);
  expect(status.wrapper).toBe("ours");
  expect(status.active).toBe(false);
  expect(status.reason).toContain("saved copy");
});

test("switching off restores CloudPanel's original byte for byte and drops the copy", () => {
  const f = fixture();
  f.writeWrapper(ORIGINAL);
  applyClpctlGuard(f.options);
  expect(restoreClpctlWrapper(f.options)).toBe(true);
  expect(readFileSync(f.wrapper, "utf8")).toBe(ORIGINAL);
  expect(() => readFileSync(f.backup, "utf8")).toThrow();
});

test("restoring does nothing when ours is not installed", () => {
  const f = fixture();
  f.writeWrapper(ORIGINAL);
  expect(restoreClpctlWrapper(f.options)).toBe(false);
  expect(readFileSync(f.wrapper, "utf8")).toBe(ORIGINAL);
});

test("an older hardened wrapper from a past release is recognised as ours and upgraded", () => {
  const f = fixture();
  const OLD = "#!/bin/bash\n# an earlier clp-addons hardened wrapper\nexit 0\n";
  const oldSha = createHash("sha256").update(OLD).digest("hex");
  const opts = { ...f.options, shippedSha256: [oldSha] };
  f.writeWrapper(OLD);
  mkdirSync(join(f.dir, "state"), { recursive: true });
  writeFileSync(f.backup, ORIGINAL, { mode: 0o700 });
  // A past-release wrapper classifies as ours, not unknown.
  expect(clpctlGuardStatus(true, opts)).toMatchObject({ active: true, wrapper: "ours" });
  // Apply upgrades it to the current script and keeps the saved original.
  expect(applyClpctlGuard(opts)).toEqual({ changed: true, active: true });
  expect(readFileSync(f.wrapper, "utf8")).toBe(WRAPPER_SCRIPT);
  expect(readFileSync(f.backup, "utf8")).toBe(ORIGINAL);
});

test("an unrecognised wrapper keeps its saved original instead of being stranded", () => {
  const f = fixture();
  f.writeWrapper("#!/bin/bash\n# a wrapper this build does not know\nexit 0\n");
  mkdirSync(join(f.dir, "state"), { recursive: true });
  writeFileSync(f.backup, ORIGINAL, { mode: 0o700 });
  expect(clpctlGuardStatus(true, f.options).wrapper).toBe("unknown");
  // Switching off must not delete the backup: it is the only path back to a
  // working clpctl if that wrapper turns out to be an older hardened one.
  expect(restoreClpctlWrapper(f.options)).toBe(false);
  expect(existsSync(f.backup)).toBe(true);
  expect(readFileSync(f.backup, "utf8")).toBe(ORIGINAL);
});

test("a known original on a known version reads as off, not as a version mismatch", () => {
  const f = fixture();
  f.writeWrapper(ORIGINAL);
  const status = clpctlGuardStatus(false, f.options);
  expect(status).toMatchObject({ enabled: false, active: false, applicable: true, wrapper: "known-original" });
  expect(status.reason).not.toContain("newer");
});

// --- the hardened wrapper's own checks, run through bash ---------------------

interface Shell {
  dir: string;
  home: string;
  path: string;
  wrapper: string;
  origLog: string;
}

function shell(): Shell {
  const dir = tempDir();
  const home = join(dir, "home", "siteuser");
  mkdirSync(home, { recursive: true });
  // A stub for the original wrapper that records what it was handed.
  const origLog = join(dir, "orig.log");
  const orig = join(dir, "state", "clpctlWrapper.orig");
  mkdirSync(join(dir, "state"));
  writeFileSync(orig, `#!/bin/bash\nprintf 'ORIG' > ${JSON.stringify(origLog)}\nfor a in "$@"; do printf ' [%s]' "$a" >> ${JSON.stringify(origLog)}; done\n`, { mode: 0o700 });
  // A getent shim, so the wrapper resolves a home we control without a real account.
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const getent = join(binDir, "getent");
  writeFileSync(getent, `#!/bin/bash\n# only answers passwd lookups used by the wrapper\necho "$2:x:1001:1001::${home}:/bin/bash"\n`, { mode: 0o755 });
  // Our wrapper, with its saved-original path pointed at the stub.
  const wrapper = join(dir, "clpctlWrapper");
  writeFileSync(wrapper, WRAPPER_SCRIPT.replace("/var/lib/clp-addons/system-tweaks/clpctlWrapper.orig", orig), { mode: 0o700 });
  return { dir, home, path: `${binDir}:${process.env.PATH}`, wrapper, origLog };
}

function callWrapper(sh: Shell, caller: string, args: string[]): { code: number; ranOriginal: string | null } {
  const result = spawnSync("/bin/bash", [sh.wrapper, ...args], {
    env: { PATH: sh.path, SUDO_USER: caller },
    encoding: "utf8",
  });
  let ranOriginal: string | null = null;
  try { ranOriginal = readFileSync(sh.origLog, "utf8"); } catch { ranOriginal = null; }
  return { code: result.status ?? -1, ranOriginal };
}

test("root and clp pass straight through to CloudPanel's wrapper", () => {
  const sh = shell();
  for (const caller of ["root", "clp", ""]) {
    rmSync(sh.origLog, { force: true });
    const { code, ranOriginal } = callWrapper(sh, caller, ["user:list"]);
    expect(code).toBe(0);
    expect(ranOriginal).toBe("ORIG [user:list]");
  }
});

test("a site user may run only export, permissions reset and purge", () => {
  const sh = shell();
  for (const command of ["user:list", "db:add", "site:delete", "db:show:master-credentials", "db:import"]) {
    rmSync(sh.origLog, { force: true });
    const { code, ranOriginal } = callWrapper(sh, "siteuser", [command, "--force"]);
    expect(code).toBe(1);
    expect(ranOriginal).toBeNull();
  }
});

test("db:import is refused for a site user, since clpctl runs it as the database admin", () => {
  const sh = shell();
  const { code, ranOriginal } = callWrapper(sh, "siteuser", ["db:import", "--databaseName=shop", "--file=dump.sql"]);
  expect(code).toBe(1);
  expect(ranOriginal).toBeNull();
  // Root still imports through the pass-through path.
  rmSync(sh.origLog, { force: true });
  const asRoot = callWrapper(sh, "root", ["db:import", "--databaseName=shop", "--file=dump.sql"]);
  expect(asRoot.code).toBe(0);
  expect(asRoot.ranOriginal).toBe("ORIG [db:import] [--databaseName=shop] [--file=dump.sql]");
});

test("a site user's legitimate commands reach the original with validated values", () => {
  const sh = shell();
  // The reset path is normalised to the resolved home, so `.` and the home both
  // reach the original as --path=<home>.
  const cases: { input: string[]; want: string[] }[] = [
    { input: ["db:export", "--databaseName=shop-db", `--file=${sh.home}/dump.sql.gz`],
      want: ["db:export", "--databaseName=shop-db", `--file=${sh.home}/dump.sql.gz`] },
    { input: ["db:export", "--databaseName=shop", "--file=sub/dump.sql.gz"],
      want: ["db:export", "--databaseName=shop", "--file=sub/dump.sql.gz"] },
    { input: ["system:permissions:reset", "--directories=770", "--files=660", `--path=${sh.home}`],
      want: ["system:permissions:reset", "--directories=770", "--files=660", `--path=${sh.home}`] },
    { input: ["system:permissions:reset", "--directories=770", "--files=660", "--path=."],
      want: ["system:permissions:reset", "--directories=770", "--files=660", `--path=${sh.home}`] },
    { input: ["system:permissions:reset", "--directories", "770", "--files", "660"],
      want: ["system:permissions:reset", "--directories=770", "--files=660"] },
    { input: ["varnish-cache:purge", "--purge=all"], want: ["varnish-cache:purge", "--purge=all"] },
    { input: ["varnish-cache:purge", "--purge=tag1,tag2"], want: ["varnish-cache:purge", "--purge=tag1,tag2"] },
    { input: ["varnish-cache:purge", "--purge=https://shop.example.com/page.html"],
      want: ["varnish-cache:purge", "--purge=https://shop.example.com/page.html"] },
  ];
  for (const { input, want } of cases) {
    rmSync(sh.origLog, { force: true });
    const { code, ranOriginal } = callWrapper(sh, "siteuser", input);
    expect(code).toBe(0);
    expect(ranOriginal).toBe(`ORIG${want.map((a) => ` [${a}]`).join("")}`);
  }
});

test("a value carrying a shell metacharacter is refused before anything runs", () => {
  const sh = shell();
  const cases: string[][] = [
    ["db:export", `--databaseName=shop";id;"`],
    ["db:export", "--databaseName=shop`id`"],
    ["db:export", "--databaseName=shop$(id)"],
    ["db:export", "--databaseName=shop", "--file=/etc/passwd"],
    ["db:export", "--databaseName=shop", `--file=${sh.home}/../../etc/passwd`],
    ["db:export", "--databaseName=shop", "--file=a b.sql"],
    ["db:export", "--databaseName=shop", String.raw`--file=dump\".sql`],
    ["db:export", "--databaseName=shop", "--file=a;id"],
    ["system:permissions:reset", "--files=660", "--path=/etc"],
    ["system:permissions:reset", "--files=0660;rm", `--path=${sh.home}`],
    ["system:permissions:reset", "--directories=770", `--path=${sh.home}`, "--files=6\\60"],
    ["varnish-cache:purge", "--purge=all;id"],
    ["varnish-cache:purge", "--purge=$(id)"],
    ["db:export", "--databaseName=shop", "--file=dump.sql", "--extra=1"],
    // An inline value on a flag that takes none is unchecked, so it is refused.
    ["db:export", "--databaseName=shop", "--quiet=x\";id;\""],
    ["db:export", "--no-interaction=1", "--databaseName=shop"],
  ];
  for (const args of cases) {
    rmSync(sh.origLog, { force: true });
    const { code, ranOriginal } = callWrapper(sh, "siteuser", args);
    expect(code).toBe(1);
    expect(ranOriginal).toBeNull();
  }
});

test("db:export --file and permissions:reset --path are confined to the home", () => {
  const sh = shell();
  symlinkSync("/etc", join(sh.home, "escape")); // a symlink inside the home pointing out
  const cases: string[][] = [
    ["db:export", "--databaseName=shop", `--file=${sh.home}/escape/passwd`], // absolute through a symlink
    ["db:export", "--databaseName=shop", "--file=escape/passwd"], // relative, resolved against home, through a symlink
    ["db:export", "--databaseName=shop", "--file=../siteuser/../../etc/passwd"], // relative steps escaping home
    ["system:permissions:reset", "--directories=770", "--files=660", `--path=${sh.home}/escape`], // target is /etc
    ["system:permissions:reset", "--directories=770", "--files=660", `--path=${sh.home}/htdocs`], // a subfolder, not the home
    ["system:permissions:reset", "--directories=770", "--files=660", "--path=/home"], // another user's parent
  ];
  for (const args of cases) {
    rmSync(sh.origLog, { force: true });
    const { code, ranOriginal } = callWrapper(sh, "siteuser", args);
    expect(code).toBe(1);
    expect(ranOriginal).toBeNull();
  }
});

test("db:export reaches the original through an in-home symlink", () => {
  const sh = shell();
  mkdirSync(join(sh.home, "htdocs"));
  symlinkSync(join(sh.home, "htdocs"), join(sh.home, "site")); // a symlink that stays inside the home
  rmSync(sh.origLog, { force: true });
  const { code, ranOriginal } = callWrapper(sh, "siteuser", ["db:export", "--databaseName=shop", "--file=site/dump.sql.gz"]);
  expect(code).toBe(0);
  expect(ranOriginal).toBe("ORIG [db:export] [--databaseName=shop] [--file=site/dump.sql.gz]");
});
