import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ADDONS, ADDON_NAMES, addonHandler, offeredAddonNames, templateWatchPaths } from "../addons/catalog";
import { addonSupportsArch, archRefusal, type AddonSpec } from "../lib/addon-definition";
import { dashboardUrlFor, resolveEnableable } from "../cli/addons";
import { runNewSiteWork } from "../cli/addon-hooks";
import { CLI_ARTIFACT, cliArtifactForArch } from "../lib/paths";

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
  for (const name of ["firewall", "instatic", "stager", "maintenance", "resource-limits", "git", "smtp", "terminal"]) {
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

test("server and panel addons appear before site tools in catalog order", () => {
  const foundational = ["system-tweaks", "firewall", "dns", "security-keys", "panel-tweaks", "resource-limits", "smtp"];
  const siteTools = ["wp-tools", "stager", "maintenance", "git", "instatic", "terminal"];
  expect(ADDON_NAMES.slice(0, foundational.length)).toEqual(foundational);
  expect(ADDON_NAMES.slice(foundational.length)).toEqual(siteTools);
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

test("each release architecture has its own artifact, and the installer downloads the one the updater does", () => {
  expect(cliArtifactForArch("x64")).toBe("clp-addons-linux-x64");
  expect(cliArtifactForArch("arm64")).toBe("clp-addons-linux-arm64");
  expect(() => cliArtifactForArch("ia32")).toThrow("no clp-addons release is built for ia32");
  expect(CLI_ARTIFACT).toBe(cliArtifactForArch(process.arch));
  const installer = readFileSync(join(REPO, "install.sh"), "utf8");
  for (const arch of ["x64", "arm64"]) expect(installer).toContain(`ARTIFACT="${cliArtifactForArch(arch)}"`);
});

test("Instatic, whose image is amd64 only, is refused and left out on arm64 unless already enabled", () => {
  const instatic = ADDONS.instatic!;
  expect(addonSupportsArch(instatic, "x64")).toBe(true);
  expect(addonSupportsArch(instatic, "arm64")).toBe(false);
  expect(archRefusal(instatic, "x64")).toBeNull();
  expect(archRefusal(instatic, "arm64")).toBe("instatic is not available on arm64 servers; it runs on x64 only");
  expect(ADDON_NAMES.filter((name) => !addonSupportsArch(ADDONS[name]!, "arm64"))).toEqual(["instatic"]);

  expect(resolveEnableable("instatic", "x64").name).toBe("instatic");
  expect(() => resolveEnableable("instatic", "arm64")).toThrow("instatic is not available on arm64 servers");
  expect(resolveEnableable("stager", "arm64").name).toBe("stager");

  const off = { ...instatic, configFile: join(REPO, "no-such-config") };
  const on = { ...instatic, configFile: join(REPO, "package.json") };
  const stager = { ...ADDONS.stager!, configFile: join(REPO, "no-such-config") };
  expect(offeredAddonNames("x64", [off, stager])).toEqual(["instatic", "stager"]);
  expect(offeredAddonNames("arm64", [off, stager])).toEqual(["stager"]);
  expect(offeredAddonNames("arm64", [on, stager])).toEqual(["instatic", "stager"]);
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

test("the dashboard URL is the custom domain, else port 8443 by hostname or public address", () => {
  const addresses = { ipv4: "203.0.113.7", ipv6: "2001:db8::7" };
  expect(dashboardUrlFor({ customDomain: "panel.example.com", vhostHost: "box.example.com", addresses })).toBe("https://panel.example.com/addons/");
  expect(dashboardUrlFor({ vhostHost: "box.example.com", addresses })).toBe("https://box.example.com:8443/addons/");
  expect(dashboardUrlFor({ vhostHost: null, addresses })).toBe("https://203.0.113.7:8443/addons/");
  // IPv6-only, or more than one IPv4 that cannot be told apart.
  expect(dashboardUrlFor({ vhostHost: null, addresses: { ipv4: null, ipv6: "2001:db8::7" } })).toBe("https://[2001:db8::7]:8443/addons/");
  expect(dashboardUrlFor({ vhostHost: null, addresses: { ipv4: null, ipv6: "" } })).toBe("https://<server-ip>:8443/addons/");
});
