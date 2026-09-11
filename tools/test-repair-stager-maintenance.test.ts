// Stager's stale-job recovery, job-record expiry, and orphaned-vhost
// recovery (cmdPrune) was reachable only through an explicit
// `clp-addons action stager prune`. Nothing in provision.ts, no systemd unit,
// and not install.sh ever ran it, so a clone killed by OOM, `systemctl stop`,
// or a reboot left its job record stuck `running` forever -- and cmdClone
// refuses to clone into a target that already has a `queued` or `running`
// record, so the hostname was permanently blocked until a human ran prune by
// hand. These tests exercise the automatic entry point (repair) rather than
// calling cmdPrune directly, which is the exact gap the previous coverage
// (a source-text check of cmdPrune's own body, not of anything that calls
// it) left open.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const repo = join(import.meta.dir, "..");

// Everything here except addons/stager/action.ts is stubbed: cli/index.ts's
// addon-agnostic repair machinery (service user, sudoers, systemd units, the
// master nginx vhost) genuinely touches the host, and this process is not
// actually root. Stager's own action module is left real in the first test
// so the job-state flip and the clone refusal are the real production code,
// not a stand-in for it.
const mockPrelude = String.raw`
  import { mock } from "bun:test";
  Object.defineProperty(process, "getuid", { value: () => 0, configurable: true });

  function parseFlags(argv) {
    const positional = [];
    const flags = {};
    for (const arg of argv) {
      if (!arg.startsWith("--")) { positional.push(arg); continue; }
      const equal = arg.indexOf("=");
      flags[arg.slice(2, equal === -1 ? undefined : equal)] = equal === -1 ? true : arg.slice(equal + 1);
    }
    return { positional, flags };
  }

  const realPaths = await import("./cli/paths.ts");
  mock.module("./cli/paths.ts", () => ({ ...realPaths }));
  mock.module("./cli/release.ts", () => ({
    CLI_VERSION: "1.0.0",
    fetchVerified: async () => [],
    loadLocal: () => [],
    resolveRelease: async () => ({ tag: "v1.0.0", assets: new Map() }),
    verifyAttestation: async () => {},
  }));
  mock.module("./cli/provision.ts", () => ({
    ensureDirs: () => {},
    ensureAuthHelperReady: () => {},
    ensureServiceUser: () => {},
    ensureTimerArmed: () => {},
    hardenBackups: () => {},
    installSudoers: () => {},
    installUnits: () => false,
    installedConfig: (spec) => spec.name === "stager",
    purgeTwigCache: () => {},
    removeLegacyInstall: () => {},
    removeLegacyUnits: () => {},
    removeLegacyUsers: () => {},
    removeSudoers: () => {},
    startUnits: () => {},
    stopUnits: () => {},
    unitActive: () => "active",
    unitPid: () => null,
    warnIfPanelSessionUnreadable: () => {},
    writeConfig: () => {},
  }));
  mock.module("./cli/inject.ts", () => ({
    KNOWN_GOOD_PANEL_VERSIONS: [],
    inspect: () => ({ state: "ok" }),
    inspectNginxProxy: () => ({ state: "ok" }),
    masterVhostHost: () => null,
    panelVersion: () => "test",
    purgeTwigCache: () => {},
    reconcile: () => ({ statuses: [], changed: false }),
    reconcileNginxProxy: () => ({ state: "ok", changed: false }),
  }));
  globalThis.__repairLog = [];
  class TestFatal extends Error {}
  mock.module("./cli/util.ts", () => ({
    Fatal: TestFatal,
    fatal: (message) => { throw new TestFatal(message); },
    log: {
      step: () => {},
      ok: (m) => globalThis.__repairLog.push(["ok", m]),
      warn: (m) => globalThis.__repairLog.push(["warn", m]),
      err: (m) => globalThis.__repairLog.push(["err", m]),
      plain: () => {},
    },
    parseFlags,
    requireRoot: () => {},
    tryRun: () => ({ ok: true, out: "" }),
    writeAtomic: () => {},
  }));
  mock.module("./lib/panel-snapshot.ts", () => ({ generateSnapshot: () => {} }));
  mock.module("./lib/sso-auth.ts", () => ({ authenticateRequest: async () => ({ response: null }) }));
  mock.module("./cli/auth-action.ts", () => ({ runAuthActionStdin: async () => 0 }));
  mock.module("./addons/instatic/app/index.ts", () => ({ handle: async () => new Response() }));
  mock.module("./addons/stager/app/index.ts", () => ({ handle: async () => new Response() }));
  mock.module("./lib/mount.ts", () => ({ splitMount: () => null }));
  mock.module("./lib/app-http.ts", () => ({ SECURITY_HEADERS: {}, esc: (v) => v, escJs: (v) => v }));
  mock.module("./lib/app-ui.ts", () => ({ renderLayout: () => "" }));
  mock.module("./lib/update-check.ts", () => ({ checkCliUpdate: async () => null }));
`;

function makeRoot(): { root: string; jobsDir: string; jobDir: string } {
  const root = mkdtempSync(join(tmpdir(), "clp-repair-stager-"));
  const jobsDir = join(root, "jobs");
  const jobDir = join(jobsDir, "20260908T120000Z-aaaaaa");
  mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  chmodSync(jobDir, 0o700);
  for (const [field, value] of Object.entries({ target: "stg.example.com", state: "running", createdAt: "2026-09-08T12:00:00Z" })) {
    writeFileSync(join(jobDir, field), `${value}\n`, { mode: 0o600 });
    chmodSync(join(jobDir, field), 0o600);
  }
  // Ten minutes old: past the five-minute threshold cmdPrune checks against
  // the job directory's own mtime (findOlderThan), not a stored field.
  const old = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(jobDir, old, old);
  return { root, jobsDir, jobDir };
}

function stagerPaths(root: string, jobsDir: string, bin: string): Record<string, string> {
  return {
    lockDir: join(root, "locks"),
    dataBaseDir: join(root, "data"),
    jobsDir,
    panelDb: join(root, "panel.db"),
    clpctl: join(bin, "clpctl"),
    panelIdentityFile: join(root, "identity"),
    nginxVhostDir: join(root, "vhosts"),
    instaticDataDir: join(root, "instatic"),
    actionBinary: join(bin, "clp-addons"),
    tempDir: join(root, "tmp"),
    sqlite3: "sqlite3",
  };
}

test.serial("repair's automatic entry point runs prune for real: a stuck job flips to failed and the target unblocks", () => {
  const { root, jobsDir, jobDir } = makeRoot();
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  // systemd-run is stubbed so the clone attempt below does not try to talk
  // to a real service manager; the point of this test is which record wins
  // the refusal check, not whether this sandbox can start a transient unit.
  writeFileSync(join(bin, "systemd-run"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(join(bin, "systemd-run"), 0o755);
  mkdirSync(join(root, "vhosts"), { recursive: true });
  mkdirSync(join(root, "tmp"), { recursive: true });

  const seedDb = String.raw`
    import { Database } from "bun:sqlite";
    const db = new Database(${JSON.stringify(join(root, "panel.db"))});
    db.run("CREATE TABLE site (id INTEGER PRIMARY KEY, domain_name TEXT, type TEXT, user TEXT, root_directory TEXT, application TEXT)");
    db.query("INSERT INTO site (id, domain_name, type, user, root_directory, application) VALUES (1, 'example.com', 'php', 'example', '/home/example/htdocs/example.com', '')").run();
    db.close();
  `;
  spawnSync(process.execPath, ["-e", seedDb], { cwd: repo, encoding: "utf8" });

  const paths = stagerPaths(root, jobsDir, bin);
  const script = `${mockPrelude}
    const realIdentity = await import("./cli/action-common.ts");
    mock.module("./cli/action-common.ts", () => ({
      ...realIdentity,
      readPanelIdentity: () => ({ primary: "panel.example.test", aliases: [] }),
    }));

    const paths = ${JSON.stringify(paths)};
    const { runStagerMaintenance } = await import("./cli/index.ts");
    const stagerSpec = { name: "stager", title: "Stager", description: "", configFile: "", stateDir: "", targets: [] };
    const maintenanceOutput = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      maintenanceOutput.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    };
    try {
      await runStagerMaintenance([stagerSpec], { paths });
    } finally {
      process.stdout.write = originalWrite;
    }

    const { readFileSync } = await import("node:fs");
    const state = readFileSync(${JSON.stringify(jobDir)} + "/state", "utf8").trim();

    const { runStagerAction } = await import("./addons/stager/action.ts");
    const cloneCode = await runStagerAction(["clone", "--source", "example.com", "--target", "stg.example.com"], { paths });

    process.stdout.write(JSON.stringify({ state, cloneCode, maintenanceOutput: maintenanceOutput.join("") }));
  `;
  try {
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    expect(result.status, result.stderr).toBe(0);
    // The automatic repair path suppresses prune's action reply. The manual
    // clone action below still emits its normal reply before this summary.
    const lastLine = result.stdout.trim().split("\n").pop() ?? "";
    const output = JSON.parse(lastLine) as { state: string; cloneCode: number; maintenanceOutput: string };
    expect(output.state).toBe("failed");
    expect(output.cloneCode).toBe(0);
    expect(output.maintenanceOutput).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.serial("a throwing prune does not stop the rest of repair", () => {
  const { root, jobsDir } = makeRoot();
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const paths = stagerPaths(root, jobsDir, bin);

  const script = `${mockPrelude}
    const realAction = await import("./addons/stager/action.ts");
    globalThis.__pruneCalls = [];
    mock.module("./addons/stager/action.ts", () => ({
      ...realAction,
      runStagerAction: async (argv) => {
        globalThis.__pruneCalls.push(argv);
        throw new Error("stager maintenance exploded");
      },
    }));

    const { cmdRepair } = await import("./cli/index.ts");
    let threw = false;
    try {
      await cmdRepair([]);
    } catch {
      threw = true;
    }
    process.stdout.write(JSON.stringify({
      threw,
      pruneCalls: globalThis.__pruneCalls,
      log: globalThis.__repairLog,
    }));
  `;
  try {
    const result = spawnSync(process.execPath, ["-e", script], { cwd: repo, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim()) as {
      threw: boolean;
      pruneCalls: string[][];
      log: [string, string][];
    };
    // Reachability: repair's automatic path really does call into the stager
    // action layer asking for "prune", with no other arguments.
    expect(output.pruneCalls).toEqual([["prune"]]);
    // Isolation: even though that call threw, cmdRepair itself did not, and
    // ran all the way to its final "repair complete" log line.
    expect(output.threw).toBe(false);
    expect(output.log.some(([level, message]) => level === "warn" && message.includes("prune"))).toBe(true);
    expect(output.log.some(([level, message]) => level === "ok" && message.includes("repair complete"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cmdRepair calls the stager maintenance sweep after nginx/anchor reconciliation, and --anchors-only skips it", () => {
  const source = readFileSync(join(repo, "cli/index.ts"), "utf8");
  const repairStart = source.indexOf("export async function cmdRepair");
  expect(repairStart).toBeGreaterThan(-1);
  const repairBody = source.slice(repairStart);

  expect(repairBody.includes("await runStagerMaintenance(all)")).toBe(true);
  expect(repairBody.indexOf("await runStagerMaintenance(all)"))
    .toBeGreaterThan(repairBody.indexOf("reconcileNginx(quiet)"));
  expect(repairBody.indexOf("await runStagerMaintenance(all)"))
    .toBeGreaterThan(repairBody.indexOf("reconcileAnchors(quiet)"));

  const anchorsOnlyStart = repairBody.indexOf('flags["anchors-only"]');
  const anchorsOnlyReturn = repairBody.indexOf("return;", anchorsOnlyStart);
  const anchorsOnlyBranch = repairBody.slice(anchorsOnlyStart, anchorsOnlyReturn);
  expect(anchorsOnlyBranch.includes("runStagerMaintenance")).toBe(false);
});
