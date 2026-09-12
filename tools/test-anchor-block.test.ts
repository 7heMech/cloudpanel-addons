// Regression coverage for enabling an addon whose required Twig anchor fails
// to patch. `reconcileAnchors` has always computed a `blocked` flag for a
// failed `required: true` target, but `applyEnable`/`cmdInstall` used to
// discard that flag outright -- unlike the Nginx proxy result on the very
// next line, which they do check. That let an addon's "own" template patch
// (e.g. login-theme's dark-mode script never landing in
// Frontend/Security/login.html.twig because the anchor markup didn't match
// the running CloudPanel version) fail completely silently: the manager job
// still reported "done", the addon card still read "Enabled", and nothing
// ever told the operator the page was never actually patched.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");

// Keep the module mocks inside a child process, matching tools/test-repair.test.ts:
// Bun's mock.module overrides stick around for the whole test process, and a
// top-level mock here would otherwise leak into other test files.
const PROBE = String.raw`
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
    // Simulates the running CloudPanel's login.html.twig no longer containing
    // the anchor markup login-theme splices before -- e.g. a panel upgrade
    // changed the markup, or it never matched on this build in the first place.
    reconcile: (injections) => ({
      statuses: injections.map((injection) => ({
        addon: injection.addon,
        slug: injection.target.slug,
        state: "anchor-not-found-in-markup",
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

test("enabling an addon aborts when a required Twig anchor fails to patch", () => {
  const result = spawnSync(process.execPath, ["-e", PROBE], { cwd: REPO, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.threw).toBe(true);
  expect(parsed.message).toContain("CloudPanel templates");
});
