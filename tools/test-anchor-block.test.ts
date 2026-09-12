// Regression coverage for enabling an addon whose required Twig anchor fails
// to patch. `reconcileAnchors` has always computed a `blocked` flag for a
// failed `required: true` target, but `applyEnable`/`cmdInstall` used to
// discard that flag outright -- unlike the Nginx proxy result on the very
// next line, which they do check. That let an addon's "own" template patch
// fail completely silently: the manager job still reported "done", the addon
// card still read "Enabled", and nothing ever told the operator the page was
// never actually patched.
//
// Two failure states are covered because they used to be treated
// differently: "anchor-not-found-in-markup" (the template exists but its
// markup no longer contains the anchor) already contributed to `blocked`
// before this fix -- the missing piece was `applyEnable` checking the return
// value at all. "template-absent" (the template file itself does not exist)
// used to be excluded from `blocked` outright, regardless of `required`. That
// second gap is what let login-theme's real bug -- its target named
// Frontend/Security/login.html.twig, but CloudPanel actually serves the login
// page from Frontend/Login/login.html.twig -- report "login-theme enabled"
// on a real CloudPanel 2.5.4-3+clp-bookworm box while never touching the
// real login template at all.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");

// Keep the module mocks inside a child process, matching tools/test-repair.test.ts:
// Bun's mock.module overrides stick around for the whole test process, and a
// top-level mock here would otherwise leak into other test files.
function probeFor(state: "anchor-not-found-in-markup" | "template-absent"): string {
  return String.raw`
  import { mock } from "bun:test";

  class TestFatal extends Error {}

  function parseFlags(argv) {
    const positional = [];
    const flags = {};
    for (const arg of argv) {
      if (!arg.startsWith("--")) {
        positional.push(arg);
        continue;
      }
      const equal = arg.indexOf("=");
      flags[arg.slice(2, equal === -1 ? undefined : equal)] = equal === -1 ? true : arg.slice(equal + 1);
    }
    return { positional, flags };
  }

  const realProvision = await import("./cli/provision.ts?anchor-block-test-real");
  mock.module("./cli/provision.ts", () => ({
    ...realProvision,
    ensureDirs: () => {},
    ensureAuthHelperReady: () => {},
    warnIfPanelSessionUnreadable: () => {},
    ensureServiceUser: () => {},
    reconcilePanelIdentity: () => {},
    installUnits: () => false,
    purgeTwigCache: () => {},
    removeLegacyInstall: () => {},
    removeLegacyUnits: () => {},
    removeLegacyUsers: () => {},
    startUnits: () => { throw new Error("startUnits must not run once a required anchor is blocked"); },
    writeConfig: () => {},
  }));

  mock.module("./cli/inject.ts", () => ({
    KNOWN_GOOD_PANEL_VERSIONS: ["2.5.4-3+clp-bookworm"],
    inspect: () => ({ state: "ok" }),
    inspectNginxProxy: () => ({ state: "missing" }),
    masterVhostHost: () => null,
    panelVersion: () => "9.9.9-test",
    purgeTwigCache: () => {},
    // Simulates the actual template for a required target failing to patch:
    // "${state}".
    reconcile: (injections) => ({
      statuses: injections.map((injection) => ({
        addon: injection.addon,
        slug: injection.target.slug,
        state: "${state}",
        found: '<div class="changed-markup">',
      })),
      changed: false,
    }),
    reconcileNginxProxy: () => ({ state: "ok", changed: false }),
  }));

  mock.module("./cli/util.ts", () => ({
    Fatal: TestFatal,
    fatal: (message) => { throw new TestFatal(message); },
    log: { step: () => {}, ok: () => {}, warn: () => {}, err: () => {}, plain: () => {} },
    parseFlags,
    requireRoot: () => {},
    tryRun: () => ({ ok: true, out: "" }),
    writeAtomic: () => {},
  }));

  const { applyEnable } = await import("./cli/index.ts");

  let threw = false;
  let message = "";
  try {
    await applyEnable("login-theme");
  } catch (error) {
    threw = error instanceof TestFatal;
    message = error instanceof Error ? error.message : String(error);
  }

  process.stdout.write(JSON.stringify({ threw, message }));
`;
}

function runProbe(state: "anchor-not-found-in-markup" | "template-absent"): { threw: boolean; message: string } {
  const result = spawnSync(process.execPath, ["-e", probeFor(state)], { cwd: REPO, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

test("enabling an addon aborts when a required anchor's markup can't be found", () => {
  const result = runProbe("anchor-not-found-in-markup");
  expect(result.threw).toBe(true);
  expect(result.message).toContain("CloudPanel templates");
});

test("enabling an addon aborts when a required target's template does not exist", () => {
  const result = runProbe("template-absent");
  expect(result.threw).toBe(true);
  expect(result.message).toContain("CloudPanel templates");
});
