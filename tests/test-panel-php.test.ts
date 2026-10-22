import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../cli/action-common";
import { fastCgiRequest, parseCgiResponse } from "../lib/fastcgi";
import { DEFAULT_TWEAKS } from "../addons/panel-tweaks/action";
import { dashboardView, panelPhpLine } from "../addons/panel-tweaks/app/views";
import {
  panelPhpStatus, reconcilePanelPhp, setPanelPhp, withdrawPanelPhp, type PanelPhpOptions,
} from "../addons/panel-tweaks/panel-php";

const ARGS = "-R -F -y /home/clp/services/php-fpm/fpm/php-fpm.conf -c /home/clp/services/php-fpm/fpm/php.ini";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface Box {
  options: PanelPhpOptions;
  commands: string[];
  dropIn: string;
  stateFile: string;
  /** Versions whose panel answers 500 after a restart. */
  broken: Set<string>;
  /** Versions whose `php-fpm -t` fails. */
  rejected: Set<string>;
  releases: Record<string, [string, string]>;
  fragment: string;
  setStock(version: string): void;
  addDropIn(name: string, content: string): void;
}

function box(): Box {
  const root = mkdtempSync(join(tmpdir(), "panel-php-"));
  dirs.push(root);
  const bin = join(root, "sbin");
  const unitDir = join(root, "lib");
  const dropInDir = join(root, "etc", "clp-php-fpm.service.d");
  const proc = join(root, "proc");
  for (const dir of [bin, unitDir, join(proc, "4242")]) mkdirSync(dir, { recursive: true });
  for (const version of ["7.4", "8.1", "8.3", "8.4"]) writeFileSync(join(bin, `php-fpm${version}`), "");
  const fragment = join(unitDir, "clp-php-fpm.service");
  const extraDropIns: string[] = [];
  const setStock = (version: string) => writeFileSync(fragment,
    `[Unit]\nDescription=The CLP PHP ${version} FastCGI Process Manager\n\n[Service]\nType=notify\nExecStart=${bin}/php-fpm${version} ${ARGS}\nRestart=always\n`, { mode: 0o644 });
  setStock("8.1");
  const dropIn = join(dropInDir, "clp-addons-php.conf");
  const exe = join(proc, "4242", "exe");
  const effective = () => {
    for (const path of [...extraDropIns, dropIn]) {
      const found = existsSync(path) ? /ExecStart=(\S*php-fpm[0-9.]+)/.exec(readFileSync(path, "utf8"))?.[1] : undefined;
      if (found) return found;
    }
    return /ExecStart=(\S+)/.exec(readFileSync(fragment, "utf8"))![1]!;
  };
  const start = () => { rmSync(exe, { force: true }); symlinkSync(effective(), exe); };
  start();

  const state: Box = {
    commands: [],
    dropIn,
    stateFile: join(root, "state", "panel-php.json"),
    broken: new Set(),
    rejected: new Set(),
    releases: { "8.1": ["8.1.34-1+clp-bookworm", "8.1.34-1+clp-bookworm"], "8.3": ["8.3.36-1", "8.3.36-1"], "8.4": ["8.4.25-1+clp-bookworm", "8.4.27-1+clp-bookworm"] },
    fragment,
    setStock,
    addDropIn(name, content) {
      mkdirSync(dropInDir, { recursive: true });
      writeFileSync(join(dropInDir, name), content, { mode: 0o644 });
      extraDropIns.push(join(dropInDir, name));
    },
    options: {} as PanelPhpOptions,
  };
  const ok = (stdout = ""): CommandResult => ({ ok: true, stdout, stderr: "" });
  const running = () => /php-fpm([0-9.]+)$/.exec(effective())![1]!;
  state.options = {
    paths: {
      dropInFile: dropIn, fpmBinDir: bin, stateFile: state.stateFile, lockFile: join(root, "panel-php.lock"),
      procRoot: proc, rootUid: process.getuid!(),
    },
    healthTimeoutMs: 0,
    sleep: async () => {},
    run(command, args) {
      state.commands.push([command, ...args].join(" "));
      if (command === "systemctl" && args[0] === "show" && args.includes("MainPID")) return ok("4242\n");
      if (command === "systemctl" && args[0] === "show") {
        const dropIns = [...extraDropIns, ...(existsSync(dropIn) ? [dropIn] : [])];
        return ok(`FragmentPath=${fragment}\nDropInPaths=${dropIns.join(" ")}\n`);
      }
      if (command === "systemctl" && args[0] === "restart") { start(); return ok(); }
      if (command === "systemctl" && args[0] === "is-active") return ok("active\n");
      if (command === "systemctl") return ok();
      if (command === "apt-cache") {
        return ok(args.slice(1).map((pkg) => {
          const [installed, candidate] = state.releases[/php([0-9.]+)-fpm/.exec(pkg)![1]!] ?? ["(none)", "(none)"];
          return `${pkg}:\n  Installed: ${installed}\n  Candidate: ${candidate}\n  Version table:\n`;
        }).join(""));
      }
      const version = /php-fpm([0-9.]+)$/.exec(command)?.[1];
      if (version && args[0] === "-t") {
        return state.rejected.has(version) ? { ok: false, stdout: "", stderr: "ERROR: bad config" } : ok();
      }
      throw new Error(`unexpected command ${command} ${args.join(" ")}`);
    },
    async request(_socket, params) {
      expect(params.SCRIPT_FILENAME).toContain("/home/clp/htdocs/app/files/public/");
      return { status: state.broken.has(running()) ? 500 : 200, headers: {}, body: "" };
    },
  };
  return state;
}

test("status lists CloudPanel's own PHP and every newer installed one, with pending updates", () => {
  const { options } = box();
  expect(panelPhpStatus(options)).toEqual({
    wanted: "",
    stock: "8.1",
    running: "8.1",
    choices: [
      { version: "8.1", installed: "8.1.34" },
      { version: "8.3", installed: "8.3.36" },
      { version: "8.4", installed: "8.4.25", available: "8.4.27" },
    ],
  });
});

test("choosing a version writes a drop-in with CloudPanel's own arguments and proves the panel answers", async () => {
  const env = box();
  const status = await setPanelPhp("8.4", env.options);
  expect(status.running).toBe("8.4");
  expect(status.wanted).toBe("8.4");
  const dropIn = readFileSync(env.dropIn, "utf8");
  expect(dropIn).toContain("ExecStart=\n");
  expect(dropIn).toContain(`/php-fpm8.4 ${ARGS}\n`);
  expect(env.commands.some((command) => /php-fpm8\.4 -t -R -F -y/.test(command))).toBe(true);
  expect(JSON.parse(readFileSync(env.stateFile, "utf8"))).toEqual({ version: 1, php: "8.4" });

  env.commands.length = 0;
  await setPanelPhp("8.4", env.options);
  expect(env.commands.filter((command) => command.includes("restart"))).toEqual([]);

  await setPanelPhp("", env.options);
  expect(existsSync(env.dropIn)).toBe(false);
  expect(panelPhpStatus(env.options).running).toBe("8.1");
});

test("a panel that stops answering is put back on the previous PHP", async () => {
  const env = box();
  env.broken.add("8.4");
  await expect(setPanelPhp("8.4", env.options)).rejects.toThrow(
    "the panel did not come back on PHP 8.4: the login page answered 500; the panel is back on PHP 8.1");
  expect(existsSync(env.dropIn)).toBe(false);
  expect(panelPhpStatus(env.options)).toMatchObject({ wanted: "", running: "8.1" });

  await setPanelPhp("8.3", env.options);
  await expect(setPanelPhp("8.4", env.options)).rejects.toThrow("the panel is back on PHP 8.3");
  expect(readFileSync(env.dropIn, "utf8")).toContain("php-fpm8.3 ");
});

test("a config the new PHP rejects changes nothing", async () => {
  const env = box();
  env.rejected.add("8.4");
  await expect(setPanelPhp("8.4", env.options)).rejects.toThrow("PHP 8.4 rejected CloudPanel's FPM config: ERROR: bad config");
  expect(existsSync(env.dropIn)).toBe(false);
  expect(env.commands.some((command) => command.includes("restart"))).toBe(false);
  await expect(setPanelPhp("8.2", env.options)).rejects.toThrow("PHP 8.2 is not installed");
  await expect(setPanelPhp("8", env.options)).rejects.toThrow("choose a PHP version");
});

test("someone else's override is left alone and blocks a choice here", async () => {
  const env = box();
  env.addDropIn("override.conf", `[Service]\nExecStart=\nExecStart=/usr/sbin/php-fpm8.2 ${ARGS}\n`);
  expect(panelPhpStatus(env.options).overriddenBy).toEndWith("override.conf");
  await expect(setPanelPhp("8.4", env.options)).rejects.toThrow("override.conf already sets the panel's PHP");
  expect(existsSync(env.dropIn)).toBe(false);
});

test("repair reapplies the choice, records a failure once, and retries after an upgrade", async () => {
  const env = box();
  await setPanelPhp("8.4", env.options);
  rmSync(env.dropIn);
  expect(await reconcilePanelPhp(env.options)).toBe("panel runs on PHP 8.4");
  expect(await reconcilePanelPhp(env.options)).toBeNull();

  rmSync(env.dropIn);
  env.broken.add("8.4");
  await expect(reconcilePanelPhp(env.options)).rejects.toThrow("the panel is back on PHP 8.1");
  expect(panelPhpStatus(env.options).failure).toMatchObject({ php: "8.4", release: "8.4.25" });
  env.commands.length = 0;
  expect(await reconcilePanelPhp(env.options)).toBeNull();
  expect(env.commands.some((command) => command.includes("restart"))).toBe(false);

  env.broken.clear();
  env.releases["8.4"] = ["8.4.27-1+clp-bookworm", "8.4.27-1+clp-bookworm"];
  expect(await reconcilePanelPhp(env.options)).toBe("panel runs on PHP 8.4");
  expect(panelPhpStatus(env.options).failure).toBeUndefined();
});

test("once CloudPanel itself moves past the choice, the drop-in goes", async () => {
  const env = box();
  await setPanelPhp("8.3", env.options);
  env.setStock("8.4");
  expect(await reconcilePanelPhp(env.options)).toBe("panel runs on PHP 8.4");
  expect(existsSync(env.dropIn)).toBe(false);
  expect(panelPhpStatus(env.options).choices.map((choice) => choice.version)).toEqual(["8.4"]);
});

test("disabling the addon removes the drop-in and keeps the choice", async () => {
  const env = box();
  await setPanelPhp("8.4", env.options);
  withdrawPanelPhp(env.options);
  expect(existsSync(env.dropIn)).toBe(false);
  expect(panelPhpStatus(env.options)).toMatchObject({ wanted: "8.4", running: "8.1" });
});

test("an unfamiliar CloudPanel unit is not touched", async () => {
  const env = box();
  writeFileSync(env.fragment, "[Service]\nExecStart=/opt/clp/php/sbin/php-fpm -y /etc/clp.conf\n", { mode: 0o644 });
  expect(panelPhpStatus(env.options)).toMatchObject({ stock: null, choices: [] });
  await expect(setPanelPhp("8.4", env.options)).rejects.toThrow("is not the CloudPanel PHP-FPM unit");
});

test("the FastCGI client sends one request and reads the CGI reply", async () => {
  const root = mkdtempSync(join(tmpdir(), "fastcgi-"));
  dirs.push(root);
  const socket = join(root, "fpm.sock");
  let received = Buffer.alloc(0);
  const server = createServer((connection) => {
    connection.on("data", (data: Buffer) => {
      received = Buffer.concat([received, data]);
      // The request ends with an empty STDIN record.
      if (!received.subarray(-8).equals(Buffer.from([1, 5, 0, 1, 0, 0, 0, 0]))) return;
      const out = Buffer.from("Status: 302 Found\r\nLocation: /login\r\n\r\nmoved");
      const header = Buffer.from([1, 6, 0, 1, out.length >> 8, out.length & 255, 0, 0]);
      const end = Buffer.from([1, 3, 0, 1, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      connection.end(Buffer.concat([header, out, end]));
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const reply = await fastCgiRequest(socket, { SCRIPT_FILENAME: "/srv/index.php", REQUEST_URI: "/x".repeat(100) });
    expect(reply).toEqual({ status: 302, headers: { status: "302 Found", location: "/login" }, body: "moved" });
    expect(received.includes(Buffer.from("SCRIPT_FILENAME/srv/index.php"))).toBe(true);
  } finally {
    server.close();
  }
  expect(parseCgiResponse("Content-Type: text/html\n\nok").status).toBe(200);
});

test("the page offers the installed versions and says what the panel runs on", () => {
  const status = {
    wanted: "8.4", stock: "8.1", running: "8.4",
    choices: [{ version: "8.1", installed: "8.1.34" }, { version: "8.4", installed: "8.4.25", available: "8.4.27" }],
  };
  const page = dashboardView({ tweaks: DEFAULT_TWEAKS, sites: [], diskMeasuredAt: "" }, status);
  expect(page).toContain(`<option value="">CloudPanel&#x27;s own: PHP 8.1 (8.1.34)</option>`);
  expect(page).toContain(`<option value="8.4" selected>PHP 8.4 (8.4.25)</option>`);
  expect(page).toContain("which no longer gets security fixes");
  expect(panelPhpLine(status)).toBe("Running on PHP 8.4. 8.4.27 is available; run apt upgrade to install it.");

  const blocked = dashboardView({ tweaks: DEFAULT_TWEAKS, sites: [], diskMeasuredAt: "" },
    { ...status, wanted: "", running: "8.2", overriddenBy: "/etc/systemd/system/clp-php-fpm.service.d/override.conf" });
  expect(blocked).toContain(`onchange="setPanelPhp(this)" disabled>`);
  expect(blocked).toContain("override.conf sets this already. Remove it to choose here. Running on PHP 8.2.");
});
