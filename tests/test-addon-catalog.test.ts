import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ADDONS, ADDON_NAMES, addonHandler, addonMaintenance, addonNewSites, templateWatchPaths } from "../cli/addon-catalog";
import { mountPath } from "../lib/mount";
import {
  CLOUDFLARE_IPS_ALLOWED_VERBS, GIT_ALLOWED_VERBS, INSTATIC_ALLOWED_VERBS, MAINTENANCE_ALLOWED_VERBS,
  PANEL_TWEAKS_ALLOWED_VERBS, PHP_RESOURCES_ALLOWED_VERBS, SMTP_ALLOWED_VERBS, STAGER_ALLOWED_VERBS,
  TERMINAL_ALLOWED_VERBS, WP_LOGIN_ALLOWED_VERBS,
} from "../lib/gateway-protocol";
import { CLI_ARTIFACT, CLI_BIN, LIBEXEC_DIR, SERVICE_USER, SOCKET_PATH } from "../cli/paths";

const REPO = join(import.meta.dir, "..");

const GATEWAY_VERBS = new Map<string, Set<string>>([
  ["cloudflare-ips", CLOUDFLARE_IPS_ALLOWED_VERBS], ["git", GIT_ALLOWED_VERBS], ["instatic", INSTATIC_ALLOWED_VERBS],
  ["maintenance", MAINTENANCE_ALLOWED_VERBS], ["panel-tweaks", PANEL_TWEAKS_ALLOWED_VERBS],
  ["php-resources", PHP_RESOURCES_ALLOWED_VERBS], ["smtp", SMTP_ALLOWED_VERBS], ["stager", STAGER_ALLOWED_VERBS],
  ["terminal", TERMINAL_ALLOWED_VERBS], ["wp-login", WP_LOGIN_ALLOWED_VERBS],
]);

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
  for (const name of ["cloudflare-ips", "instatic", "stager", "maintenance", "php-resources", "git", "smtp", "terminal"]) {
    expect(typeof ADDONS[name]!.action).toBe("function");
  }
  // It is markup injected into the panel's login page and has nothing to do as
  // root; the absence is the declaration.
});

test("required systemd dependencies survive into the catalog", () => {
  expect(ADDONS.instatic!.requiresUnits).toEqual(["docker"]);
  expect(ADDONS.smtp!.requiresUnits).toEqual(["postfix"]);
  for (const name of ADDON_NAMES.filter((item) => item !== "instatic" && item !== "smtp")) {
    expect(ADDONS[name]!.requiresUnits ?? []).toEqual([]);
  }
});

test("repair upkeep is the addons that ask for it, in catalog order", () => {
  const all = ADDON_NAMES.map((name) => ADDONS[name]!);
  expect(addonMaintenance(all).map((spec) => spec.name)).toEqual(["dns", "instatic", "stager", "php-resources", "git", "panel-tweaks", "wp-login", "smtp"]);
  // Gated on being installed: repair passes the installed set, not every addon.
  expect(addonMaintenance([ADDONS.stager!]).map((spec) => spec.name)).toEqual(["stager"]);
  expect(addonMaintenance([ADDONS.maintenance!])).toEqual([]);
});

test("new-site work runs DNS before SMTP Relay, and only for installed addons", () => {
  const all = ADDON_NAMES.map((name) => ADDONS[name]!);
  expect(addonNewSites(all).map((spec) => spec.name)).toEqual(["dns", "smtp"]);
  expect(addonNewSites([ADDONS.smtp!]).map((spec) => spec.name)).toEqual(["smtp"]);
});

test("the path constants do not import any addon", () => {
  // cli/paths.ts held the registry, so the module owning the project's paths
  // imported every addon's target list to describe them. A leaf that imports
  // its consumers is the shape a dependency cycle grows out of.
  const source = readFileSync(join(REPO, "cli/paths.ts"), "utf8");
  expect(source).not.toMatch(/from "\.\.\/addons\//);
  expect(source).not.toContain("export const ADDONS");
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

// Help is how an operator finds actions from a shell, so every addon with one
// is listed, and a line that spells out its verbs names each the gateway allows.
test("help lists every addon's action and the verbs the gateway allows", () => {
  const source = readFileSync(join(REPO, "cli/index.ts"), "utf8");
  for (const name of ADDON_NAMES.filter((candidate) => ADDONS[candidate]!.action)) {
    const line = source.split("\n").find((text) => text.trim().startsWith(`clp-addons action ${name} `));
    expect(line, `help has no action line for ${name}`).toBeDefined();
    const listed = line!.match(/<([a-z-]+(?:\|[a-z-]+)+)>/)?.[1]?.split("|");
    if (!listed) continue;
    for (const verb of GATEWAY_VERBS.get(name) ?? []) expect(listed, `${name} help omits ${verb}`).toContain(verb);
  }
});

// One binary, one socket, one service account. The layout these name is what
// provisioning writes and what the units reference, so a change to any of them
// is a change every addon's action inherits.
test("the active layout has one binary and direct helpers", () => {
  expect(CLI_BIN).toBe("/usr/local/bin/clp-addons");
  expect(LIBEXEC_DIR).toBe("/usr/local/libexec/clp-addons");
  expect(SOCKET_PATH).toBe("/run/clp-addons/manager.sock");
  expect(SERVICE_USER).toBe("clp-addons");
  expect(CLI_ARTIFACT).toBe("clp-addons-linux-x64");
});
