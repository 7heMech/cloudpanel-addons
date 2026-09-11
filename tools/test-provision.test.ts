import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  ADDONS, PANEL_GROUP, SERVICE_GROUP, SERVICE_USER,
} from "../cli/paths";
import {
  ensurePanelSessionReadable, serviceUnit, sudoersCommandPaths, sudoersRule, warnIfPanelSessionUnreadable,
} from "../cli/provision";
// Other suites in this process mock.module("../cli/provision"); the query suffix keeps
// these assertions bound to the real implementation regardless of file order.
const realProvision = async (): Promise<typeof import("../cli/provision")> =>
  await import("../cli/provision?provision-test-real" as "../cli/provision");

const REPO = join(import.meta.dir, "..");

function serviceUserProbe(options: {
  dockerGroup: boolean;
  groups?: string[];
  primary?: string;
  failedCommand?: string;
}): { ok: boolean; error?: string; calls: Array<{ command: string; args: string[] }> } {
  const script = `
    import { PANEL_GROUP, SERVICE_GROUP, SERVICE_USER } from "./cli/paths.ts";
    import { ensureServiceUser } from "./cli/provision.ts";
    const options = ${JSON.stringify(options)};
    const calls = [];
    const groups = new Set(options.groups ?? [SERVICE_GROUP, PANEL_GROUP]);
    let primary = options.primary ?? SERVICE_GROUP;
    const runner = {
      run(command, args) {
        calls.push({ command, args: [...args] });
        return "";
      },
      tryRun(command, args) {
        calls.push({ command, args: [...args] });
        const invocation = command + " " + args.join(" ");
        if (invocation === options.failedCommand) return { ok: false, out: "permission denied" };
        if (command === "id" && args[0] === "-u") return { ok: true, out: "998" };
        if (command === "id" && args[0] === "-gn") return { ok: true, out: primary };
        if (command === "id" && args[0] === "-nG") return { ok: true, out: [...groups].join(" ") };
        if (command === "getent" && args[0] === "passwd") {
          return { ok: true, out: SERVICE_USER + ":x:998:998::/nonexistent:/usr/sbin/nologin" };
        }
        if (command === "getent" && args[0] === "group" && args[1] === SERVICE_GROUP) {
          return { ok: true, out: SERVICE_GROUP + ":x:998:" + SERVICE_USER };
        }
        if (command === "getent" && args[0] === "group" && args[1] === PANEL_GROUP) {
          return { ok: true, out: PANEL_GROUP + ":x:996:" + SERVICE_USER };
        }
        if (command === "getent" && args[0] === "group" && args[1] === "docker") {
          if (!options.dockerGroup) return { ok: false, out: "" };
          return { ok: true, out: "docker:x:999:" + (groups.has("docker") ? SERVICE_USER : "") };
        }
        if (command === "passwd" && args[0] === "-S") return { ok: true, out: SERVICE_USER + " L" };
        if (command === "passwd" && args[0] === "-l") return { ok: true, out: "" };
        if (command === "usermod" && args[0] === "--gid") {
          primary = args[1];
          groups.delete("docker");
          return { ok: true, out: "" };
        }
        if (command === "gpasswd" && args[0] === "--delete") {
          groups.delete("docker");
          return { ok: true, out: "" };
        }
        return { ok: true, out: "" };
      },
    };
    try {
      ensureServiceUser(true, runner);
      console.log(JSON.stringify({ ok: true, calls }));
    } catch (error) {
      console.log(JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        calls,
      }));
    }
  `;
  return JSON.parse(execFileSync(process.execPath, ["-e", script], {
    cwd: REPO,
    encoding: "utf8",
  }));
}

test("removes an existing supplementary docker membership", () => {
  const result = serviceUserProbe({
    dockerGroup: true,
    groups: [SERVICE_GROUP, PANEL_GROUP, "docker"],
  });

  expect(result.ok).toBe(true);

  expect(result.calls).toContainEqual({
    command: "gpasswd",
    args: ["--delete", SERVICE_USER, "docker"],
  });
  expect(result.calls).not.toContainEqual({
    command: "usermod",
    args: ["--gid", SERVICE_GROUP, SERVICE_USER],
  });
});

test("leaves systems without a docker group unchanged", () => {
  const result = serviceUserProbe({ dockerGroup: false });

  expect(result.ok).toBe(true);

  expect(result.calls).not.toContainEqual({
    command: "gpasswd",
    args: ["--delete", SERVICE_USER, "docker"],
  });
  expect(result.calls.some(({ command, args }) => command === "id" && args[0] === "-gn")).toBe(false);
});

test("fails clearly when docker membership cannot be removed", () => {
  const result = serviceUserProbe({
    dockerGroup: true,
    groups: [SERVICE_GROUP, PANEL_GROUP, "docker"],
    failedCommand: `gpasswd --delete ${SERVICE_USER} docker`,
  });

  expect(result.ok).toBe(false);
  expect(result.error).toBe(
    `could not remove ${SERVICE_USER} from the docker group: permission denied`,
  );
});

function provisionProbe(): {
  identityPath: string;
  paths: string[];
  extraPaths: string[];
  rule: string;
  identity: { primary: string; aliases: string[] } | null;
  unsafeIdentity: { primary: string; aliases: string[] } | null;
} {
  const script = `
    import { ADDONS } from "./cli/paths.ts";
    import {
      PANEL_IDENTITY_PATH,
      panelIdentityFromVhost, sudoersCommandPaths, sudoersRule,
    } from "./cli/provision.ts";
    const specs = [ADDONS.instatic, ADDONS.stager];
    console.log(JSON.stringify({
      identityPath: PANEL_IDENTITY_PATH,
      paths: sudoersCommandPaths(specs),
      extraPaths: sudoersCommandPaths([...specs, { ...ADDONS.instatic, name: "unlisted" }]),
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

test("sudoers names only the unified action binary and action namespace", () => {
  const result = provisionProbe();
  const paths = result.paths;
  const rule = result.rule;

  expect(paths).toEqual(["/usr/local/bin/clp-addons"]);
  expect(rule).toBe("clp-addons ALL=(root) NOPASSWD: /usr/local/bin/clp-addons action *");
  expect(rule).toContain("/usr/local/bin/clp-addons action *");
  expect(rule).not.toMatch(/NOPASSWD: \/usr\/local\/bin\/clp-addons(?:,|$)/);
  expect(rule).not.toContain(" install");
  expect(rule).not.toContain(" update");
  expect(rule).not.toContain(" repair");
  expect(rule).not.toContain(" status");
  expect(rule).not.toContain(" uninstall");
  expect(rule).not.toContain(" serve");
  expect(result.extraPaths).toEqual(["/usr/local/bin/clp-addons"]);
});

test("an empty installed set grants no sudo commands", () => {
  expect(sudoersCommandPaths([])).toEqual([]);
  expect(sudoersRule([])).toBe("");
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

test("the identity file is a separate root-owned action input", () => {
  expect(provisionProbe().identityPath).toBe("/etc/clp-addons/panel-identity.conf");
});

test("manager unit hardens its namespace without changing the sudo boundary", () => {
  const unit = serviceUnit([ADDONS.instatic!, ADDONS.stager!]);

  expect(unit).toContain("ProtectSystem=full");
  expect(unit).toContain("ProtectHome=read-only");
  expect(unit).toContain("PrivateTmp=yes");
  expect(unit).toContain("ProtectKernelTunables=yes");
  expect(unit).toContain("RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6");
  const readWrite = unit.match(/^ReadWritePaths=(.*)$/m)?.[1]?.split(" ") ?? [];
  expect(readWrite).toContain("-/etc/letsencrypt");
  expect(readWrite).toContain("/var/backups/clp-addons");
  expect(readWrite).not.toContain("/etc/letsencrypt");

  expect(unit).toContain("User=clp-addons");
  expect(unit).toContain("Group=clp-addons");
  expect(unit).toContain("SupplementaryGroups=clp");
  expect(unit).toContain("RuntimeDirectory=clp-addons");
  expect(unit).toContain("ExecStart=/usr/local/bin/clp-addons serve");
  expect(unit).toContain("Restart=always");
  expect(unit).not.toContain("NoNewPrivileges=");
  expect(unit).not.toContain("ExecStartPre=+");
  expect(unit).not.toContain("hmac");
});

test("provisioning creates every project-owned writable directory", () => {
  const result = execFileSync(process.execPath, [
    "-e",
    `import { ADDONS } from "./cli/paths.ts";
     import { ensureDirs } from "./cli/provision.ts";
     const created = [];
     const commands = { run: () => "", tryRun: () => ({ ok: true, out: "" }) };
     const fs = { mkdir: (path) => created.push(path), exists: () => false };
     ensureDirs([ADDONS.instatic, ADDONS.stager], false, commands, fs);
     console.log(JSON.stringify(created));`,
  ], { cwd: REPO, encoding: "utf8" });
  const created = JSON.parse(result) as string[];
  expect(created).toContain("/var/backups/clp-addons");
  expect(created).toContain("/run/clp-addons");
  expect(created).toContain("/run/lock/clp-addons");
  expect(created).toContain("/var/lib/clp-addons");
});

test("provisioning verifies the fixed session directory owner and mode", () => {
  const sessionDir = mkdtempSync(`${tmpdir()}/panel-session-`);
  chmodSync(sessionDir, 0o770);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  const calls: Array<{ command: string; args: string[] }> = [];
  try {
    ensurePanelSessionReadable({
      run: (command, args) => { calls.push({ command, args }); return ""; },
      tryRun: (command, args) => { calls.push({ command, args }); return { ok: true, out: "" }; },
    }, sessionDir, uid, gid);
    expect(calls).toEqual([]);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("does not fail when the session directory has no live session yet", () => {
  const sessionDir = mkdtempSync(`${tmpdir()}/panel-session-empty-`);
  chmodSync(sessionDir, 0o770);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  try {
    expect(() => ensurePanelSessionReadable({
      run: () => "",
      tryRun: () => ({ ok: true, out: "" }),
    }, sessionDir, uid, gid)).not.toThrow();
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("provisioning probes the root auth helper without exposing session data", async () => {
  const { ensureAuthHelperReady } = await realProvision();
  const calls: Array<{ command: string; args: string[] }> = [];
  ensureAuthHelperReady({
    run: () => "",
    tryRun: (command, args) => {
      calls.push({ command, args });
      return { ok: true, out: '{"valid":false}\n' };
    },
  }, "/usr/bin/true");
  expect(calls).toEqual([{ command: "/usr/bin/true", args: ["action", "auth"] }]);
});

test("provisioning rejects an auth helper with the wrong probe contract", async () => {
  const { ensureAuthHelperReady } = await realProvision();
  expect(() => ensureAuthHelperReady({
    run: () => "",
    tryRun: () => ({ ok: true, out: '{"valid":true}\n' }),
  }, "/usr/bin/true")).toThrow(/invalid-session probe/);
});

// Run in a fresh subprocess (rather than in-process, like the tests above) so the
// console.warn capture below cannot be polluted by other test files in this suite that
// mock.module("../cli/util") to silence logging for their own purposes.
function panelSessionWarningProbe(sessionDir: string): { threw: boolean; warnings: string[] } {
  const script = `
    import { warnIfPanelSessionUnreadable } from "./cli/provision.ts";
    const warnings = [];
    console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
    const commands = { run: () => "", tryRun: () => ({ ok: true, out: "" }) };
    let threw = false;
    try {
      warnIfPanelSessionUnreadable(commands, ${JSON.stringify(sessionDir)}, process.getuid?.(), process.getgid?.());
    } catch {
      threw = true;
    }
    console.log(JSON.stringify({ threw, warnings }));
  `;
  return JSON.parse(execFileSync(process.execPath, ["-e", script], { cwd: REPO, encoding: "utf8" }));
}

test("warnIfPanelSessionUnreadable stays quiet when the session directory is empty", () => {
  const sessionDir = mkdtempSync(`${tmpdir()}/panel-session-empty-`);
  chmodSync(sessionDir, 0o770);
  try {
    const result = panelSessionWarningProbe(sessionDir);
    expect(result.threw).toBe(false);
    expect(result.warnings.some((line) => line.includes("panel session check failed"))).toBe(false);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("warnIfPanelSessionUnreadable never aborts, even when the session directory does not exist at all", () => {
  const missingDir = `${mkdtempSync(`${tmpdir()}/panel-session-missing-`)}/does-not-exist`;
  const result = panelSessionWarningProbe(missingDir);
  expect(result.threw).toBe(false);
  expect(result.warnings.some((line) => line.includes("panel session check failed"))).toBe(true);
});
