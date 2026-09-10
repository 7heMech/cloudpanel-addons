import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  ADDONS, PANEL_GROUP, SERVICE_GROUP, SERVICE_USER,
} from "../cli/paths";
import { serviceUnit } from "../cli/provision";

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

test("manager unit hardens its namespace without changing the sudo boundary", () => {
  const unit = serviceUnit([ADDONS.instatic!, ADDONS.stager!]);

  expect(unit).toContain("ProtectSystem=full");
  expect(unit).toContain("ProtectHome=read-only");
  expect(unit).toContain("PrivateTmp=yes");
  expect(unit).toContain("ProtectKernelTunables=yes");
  expect(unit).toContain("RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6");
  expect(unit).toContain(
    "ReadWritePaths=/etc/nginx /etc/letsencrypt /etc/php /home /run/clp-addons /run/lock/clp-addons /var/backups/clp-addons /var/lib/clp-addons",
  );

  expect(unit).toContain("User=clp-addons");
  expect(unit).toContain("Group=clp-addons");
  expect(unit).toContain("SupplementaryGroups=clp");
  expect(unit).toContain("RuntimeDirectory=clp-addons");
  expect(unit).toContain("ExecStartPre=+/usr/local/bin/clp-addons ensure-key");
  expect(unit).toContain("ExecStart=/usr/local/bin/clp-addons serve");
  expect(unit).toContain("Restart=always");
  expect(unit).not.toContain("NoNewPrivileges=");
});
