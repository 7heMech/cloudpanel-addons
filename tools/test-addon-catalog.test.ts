import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ADDONS, ADDON_NAMES, addonHandler, addonMaintenance, templateWatchPaths } from "../cli/addon-catalog";
import { mountPath } from "../lib/mount";

const REPO = join(import.meta.dir, "..");

test("every addon is named once and its paths come from its name", () => {
  expect(new Set(ADDON_NAMES).size).toBe(ADDON_NAMES.length);
  for (const name of ADDON_NAMES) {
    const spec = ADDONS[name]!;
    expect(spec.name).toBe(name);
    // Derived, not declared: a definition cannot name a config file that is
    // not the one provisioning, repair and uninstall will look for.
    expect(spec.configFile).toBe(`/etc/clp-addons/${name}.conf`);
    expect(spec.stateDir).toBe(`/var/lib/clp-addons/${name}`);
    expect(spec.title).toBeTruthy();
    expect(spec.description).toBeTruthy();
  }
});

test("a mounted addon has exactly one handler and a valid mount path", () => {
  for (const name of ADDON_NAMES) {
    expect(addonHandler(name)).toBe(ADDONS[name]!.handler!);
    expect(mountPath(name)).toBe(`/addons/${name}`);
  }
  // Every addon currently mounts pages; the lookup still has to answer for one
  // that does not, rather than throw.
  expect(addonHandler("not-an-addon")).toBeUndefined();
});

test("every declared injection target is represented in the watch paths", () => {
  const watched = templateWatchPaths();
  for (const name of ADDON_NAMES) {
    for (const target of ADDONS[name]!.targets) {
      expect(watched).toContain(`/home/clp/htdocs/app/files/templates/${target.template}`);
    }
  }
  expect(new Set(watched).size).toBe(watched.length);
  expect([...watched].sort()).toEqual(watched);
});

test("every addon with privileged verbs declares them", () => {
  for (const name of ["cloudflare-ips", "instatic", "stager", "maintenance", "php-resources"]) {
    expect(typeof ADDONS[name]!.action).toBe("function");
  }
  // It is markup injected into the panel's login page and has nothing to do as
  // root; the absence is the declaration.
});

test("required systemd dependencies survive into the catalog", () => {
  expect(ADDONS.instatic!.requiresUnits).toEqual(["docker"]);
  for (const name of ADDON_NAMES.filter((item) => item !== "instatic")) {
    expect(ADDONS[name]!.requiresUnits ?? []).toEqual([]);
  }
});

test("repair upkeep is the addons that ask for it, in catalog order", () => {
  const all = ADDON_NAMES.map((name) => ADDONS[name]!);
  expect(addonMaintenance(all).map((spec) => spec.name)).toEqual(["instatic", "stager", "php-resources", "panel-tweaks"]);
  // Gated on being installed: repair passes the installed set, not every addon.
  expect(addonMaintenance([ADDONS.stager!]).map((spec) => spec.name)).toEqual(["stager"]);
  expect(addonMaintenance([ADDONS.maintenance!])).toEqual([]);
});

test("the path constants do not import any addon", () => {
  // cli/paths.ts held the registry, so the module owning the project's paths
  // imported every addon's target list to describe them. A leaf that imports
  // its consumers is the shape a dependency cycle grows out of.
  const source = readFileSync(join(REPO, "cli/paths.ts"), "utf8");
  expect(source).not.toMatch(/from "\.\.\/addons\//);
  expect(source).not.toContain("export const ADDONS");
});

test("a new addon is one definition and one catalog line, not edits across the platform", () => {
  // The claim the catalog exists to make: adding an addon must not mean finding
  // a handler map, an action conditional and a repair call in three other
  // files. This adds a synthetic definition to the list and asserts that
  // dispatch, paths, watch paths and upkeep all pick it up with no other edit.
  const script = `
    import { mock } from "bun:test";
    const real = await import("./cli/addon-catalog.ts");
    const synthetic = {
      name: "synthetic",
      title: "Synthetic",
      description: "a test addon",
      targets: [{ slug: "s", template: "Synthetic/page.html.twig", anchorAfter: "x", snippet: () => "", required: false }],
      handler: async () => new Response("ok"),
      action: () => 0,
      maintenance: { label: "synthetic upkeep", run: () => { globalThis.__ranUpkeep = true; return "did something"; } },
    };
    const spec = {
      ...synthetic,
      configFile: "/etc/clp-addons/synthetic.conf",
      stateDir: "/var/lib/clp-addons/synthetic",
    };
    mock.module("./cli/addon-catalog.ts", () => ({
      ...real,
      ADDONS: { ...real.ADDONS, synthetic: spec },
      ADDON_NAMES: [...real.ADDON_NAMES, "synthetic"],
      addonHandler: (name) => (name === "synthetic" ? spec.handler : real.addonHandler(name)),
    }));
    const catalog = await import("./cli/addon-catalog.ts");
    const { runAddonMaintenance } = await import("./cli/index.ts");
    await runAddonMaintenance([spec]);
    console.log(JSON.stringify({
      named: catalog.ADDON_NAMES.includes("synthetic"),
      handler: typeof catalog.addonHandler("synthetic"),
      action: typeof catalog.ADDONS.synthetic.action,
      upkeep: globalThis.__ranUpkeep === true,
    }));
  `;
  const out = execFileSync(process.execPath, ["-e", script], { cwd: REPO, encoding: "utf8" });
  const result = JSON.parse(out.trim().split("\n").at(-1)!) as Record<string, unknown>;
  expect(result).toEqual({ named: true, handler: "function", action: "function", upkeep: true });
});

test("the manager and the auth gateway are not addons", () => {
  // They have no config file to enable, no mount path of their own and no
  // state to keep. Giving them definitions would make the catalog describe
  // things that cannot be toggled.
  expect(ADDON_NAMES).not.toContain("manager");
  expect(ADDON_NAMES).not.toContain("auth");
  const source = readFileSync(join(REPO, "cli/index.ts"), "utf8");
  // Both are still dispatched before the catalog is consulted.
  expect(source).toContain('if (addon === "auth") return runAuthActionStdin(rest);');
  expect(source).toContain('if (addon === "manager") return runManagerAction(rest, MANAGER_OPS);');
});
