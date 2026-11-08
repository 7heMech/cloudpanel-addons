import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ADDONS, ADDON_NAMES, addonHandler, templateWatchPaths } from "../addons/catalog";
import { type AddonSpec } from "../lib/addon-definition";
import { runNewSiteWork } from "../cli/addon-hooks";
import { CLI_ARTIFACT } from "../lib/paths";

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

test("the handler lookup answers for a name that is not an addon", () => {
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
  for (const name of ["cloudflare-ips", "instatic", "stager", "maintenance", "resource-limits", "git", "smtp", "terminal"]) {
    expect(typeof ADDONS[name]!.action).toBe("function");
  }
  // It is markup injected into the panel's login page and has nothing to do as
  // root; the absence is the declaration.
});

test("new-site work runs DNS before SMTP Relay", () => {
  const order = ADDON_NAMES.filter((name) => ADDONS[name]!.newSites);
  expect(order).toContain("dns");
  expect(order).toContain("smtp");
  expect(order.indexOf("dns")).toBeLessThan(order.indexOf("smtp"));
});

test("imports point from what changes most to what changes least", () => {
  const imports = (dir: string) => [...new Bun.Glob(`${dir}/**/*.ts`).scanSync(REPO)].flatMap((file) =>
    [...readFileSync(join(REPO, file), "utf8").matchAll(/from "(\.[^"]+)"/g)]
      .map((match) => ({ file, target: join(dirname(file), match[1]!) })));
  const offending = [
    // lib/ is shared by every side and imports only itself, plus the addons' verb tables, which import nothing.
    ...imports("lib").filter(({ target }) => !target.startsWith("lib/") && !/^addons\/[^/]+\/verbs$|^manager\/verbs$/.test(target)),
    // An addon builds on lib/ and on other addons, never on the commands or the manager.
    ...imports("addons").filter(({ target }) => target.startsWith("cli/") || target.startsWith("manager/")),
    ...imports("manager").filter(({ target }) => target.startsWith("cli/")),
  ];
  expect(offending).toEqual([]);
});

test("the manager and the auth gateway are not addons", () => {
  // They have no config file to enable, no mount path of their own and no
  // state to keep. Giving them definitions would make the catalog describe
  // things that cannot be toggled.
  expect(ADDON_NAMES).not.toContain("manager");
  expect(ADDON_NAMES).not.toContain("auth");
  // Both are still dispatched before the catalog is consulted, so neither is an
  // "unknown action addon".
  const root = process.getuid?.() === 0;
  const action = (addon: string) => {
    const result = Bun.spawnSync([process.execPath, join(REPO, "cli/index.ts"), "action", addon], {
      stdin: new Uint8Array(), stdout: "pipe", stderr: "pipe",
    });
    return `${result.stdout.toString()}${result.stderr.toString()}`;
  };
  const auth = action("auth");
  expect(auth).not.toContain("unknown action addon");
  expect(auth).toContain(root ? '"valid":false' : "'auth' modifies system state");
  const manager = action("manager");
  expect(manager).not.toContain("unknown action addon");
  expect(manager).toContain(root ? "unknown manager verb" : "'manager' modifies system state");
});

test("the installer downloads the artifact the updater does", () => {
  expect(readFileSync(join(REPO, "install.sh"), "utf8")).toContain(`ARTIFACT="${CLI_ARTIFACT}"`);
});

test("new-site work starts in catalog order and a slow addon only gets a head start", async () => {
  const events: string[] = [];
  const spec = (label: string, ms: number) => ({
    newSites: { label, run: async () => { events.push(`${label} start`); await Bun.sleep(ms); events.push(`${label} end`); return null; } },
  }) as unknown as AddonSpec;
  await runNewSiteWork([spec("DNS", 150), spec("SMTP", 1)], 20);
  expect(events).toEqual(["DNS start", "SMTP start", "SMTP end", "DNS end"]);

  events.length = 0;
  await runNewSiteWork([spec("DNS", 1), spec("SMTP", 1)], 1000);
  expect(events).toEqual(["DNS start", "DNS end", "SMTP start", "SMTP end"]);
});
