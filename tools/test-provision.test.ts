import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const REPO = join(import.meta.dir, "..");

function provisionProbe(): {
  identityPath: string;
  validatorPath: string;
  paths: string[];
  ghPaths: string[];
  rule: string;
  identity: { primary: string; aliases: string[] } | null;
  unsafeIdentity: { primary: string; aliases: string[] } | null;
} {
  const script = `
    import { ADDONS } from "./cli/paths.ts";
    import {
      PANEL_IDENTITY_PATH, SESSION_VALIDATOR_PATH,
      panelIdentityFromVhost, sudoersCommandPaths, sudoersRule,
    } from "./cli/provision.ts";
    const specs = [ADDONS.instatic, ADDONS.stager];
    const ghSpec = { ...ADDONS.instatic, wrapperPath: "/usr/local/libexec/clp-addons/gh" };
    console.log(JSON.stringify({
      identityPath: PANEL_IDENTITY_PATH,
      validatorPath: SESSION_VALIDATOR_PATH,
      paths: sudoersCommandPaths(specs),
      ghPaths: sudoersCommandPaths([...specs, ghSpec]),
      rule: sudoersRule(specs),
      identity: panelIdentityFromVhost(
        "server { listen 8443 ssl; server_name PANEL.Example.Test. www.PANEL.Example.Test. *.panel.example.test; }",
      ),
      unsafeIdentity: panelIdentityFromVhost(
        "server { listen 8443 ssl; server_name panel.example.test ~^.+$; }",
      ),
    }));
  `;
  return JSON.parse(execFileSync(process.execPath, ["-e", script], {
    cwd: REPO,
    encoding: "utf8",
  }));
}

test("sudoers names only the installed wrappers and session validator", () => {
  const result = provisionProbe();
  const paths = result.paths;
  const rule = result.rule;

  expect(paths).toEqual([
    "/usr/local/libexec/clp-addons/clp-action-instatic",
    "/usr/local/libexec/clp-addons/clp-action-stager",
    "/usr/local/libexec/clp-addons/clp-verify-session",
  ].sort());
  expect(rule).toBe(
    `clp-addons ALL=(root) NOPASSWD: ${paths.join(", ")}`,
  );
  expect(rule).not.toContain("*");
  expect(rule).not.toContain("/usr/local/libexec/clp-addons/gh");
  expect(rule).toContain("/usr/local/libexec/clp-addons/clp-verify-session");
  expect(rule).toContain("/usr/local/libexec/clp-addons/clp-action-instatic");
  expect(rule).toContain("/usr/local/libexec/clp-addons/clp-action-stager");
  expect(result.ghPaths).not.toContain("/usr/local/libexec/clp-addons/gh");
});

test("an empty installed set still grants the exact session validator", () => {
  const result = execFileSync(process.execPath, [
    "-e",
    'import { sudoersCommandPaths, sudoersRule } from "./cli/provision.ts"; console.log(JSON.stringify({ paths: sudoersCommandPaths([]), rule: sudoersRule([]) }));',
  ], { cwd: REPO, encoding: "utf8" });
  expect(JSON.parse(result)).toEqual({
    paths: ["/usr/local/libexec/clp-addons/clp-verify-session"],
    rule: "clp-addons ALL=(root) NOPASSWD: /usr/local/libexec/clp-addons/clp-verify-session",
  });
});

test("panel identity extraction normalizes exact, alias, and wildcard names", () => {
  const { identity } = provisionProbe();

  expect(identity).toEqual({
    primary: "panel.example.test",
    aliases: ["*.panel.example.test", "www.panel.example.test"],
  });
});

test("panel identity extraction rejects missing or unsafe names", () => {
  const { unsafeIdentity } = provisionProbe();
  expect(unsafeIdentity).toBeNull();
});

test("the identity file is a separate root-owned wrapper input", () => {
  expect(provisionProbe().identityPath).toBe("/etc/clp-addons/panel-identity.conf");
  const stager = readFileSync(join(import.meta.dir, "../addons/stager/wrapper/clp-action-stager"), "utf8");
  const instatic = readFileSync(join(import.meta.dir, "../addons/instatic/wrapper/clp-action-instatic"), "utf8");
  expect(stager).toContain(
    'PANEL_IDENTITY_FILE="/etc/clp-addons/panel-identity.conf"',
  );
  expect(instatic).toContain(
    'PANEL_IDENTITY_FILE="/etc/clp-addons/panel-identity.conf"',
  );
});
