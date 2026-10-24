import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../cli/action-common";
import { conffilesReleased, endConffileRelease, releaseConffiles, upgradePending } from "../cli/conffiles";
import { aptUpgradeDropIn } from "../cli/provision";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "clp-conffiles-"));
  dirs.push(dir);
  return dir;
}

const ok = (stdout: string): CommandResult => ({ ok: true, stdout, stderr: "" });

function service(state: string) {
  return (command: string, args: string[]): CommandResult => {
    expect(`${command} ${args.join(" ")}`).toBe("systemctl is-active apt-daily-upgrade.service");
    return { ok: state === "active", stdout: `${state}\n`, stderr: "" };
  };
}

function apt(installed: string, candidate: string) {
  const calls: string[] = [];
  const run = (command: string, args: string[]): CommandResult => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "dpkg-query") return ok(`diversion by foo from: /etc/other\nnginx-common: ${args[1]}\n`);
    return ok(`nginx-common:\n  Installed: ${installed}\n  Candidate: ${candidate}\n  Version table:\n`);
  };
  return { run, calls };
}

test("an upgrade is pending only when apt's candidate differs from what is installed", () => {
  expect(upgradePending("/etc/nginx/nginx.conf", apt("1.30.6-1", "1.30.7-1").run)).toBe(true);
  expect(upgradePending("/etc/nginx/nginx.conf", apt("1.30.6-1", "1.30.6-1").run)).toBe(false);
  expect(upgradePending("/etc/nginx/nginx.conf", apt("(none)", "1.30.7-1").run)).toBe(false);
  const { run, calls } = apt("1", "2");
  upgradePending("/etc/nginx/nginx.conf", run);
  expect(calls).toEqual(["dpkg-query -S /etc/nginx/nginx.conf", "apt-cache policy nginx-common"]);
});

test("only edited files with an upgrade waiting are released, after the flag holds repair off", () => {
  const dir = tempDir();
  const flag = join(dir, "run", "released");
  const edited = join(dir, "nginx.conf");
  const untouched = join(dir, "global_settings");
  writeFileSync(edited, "#clp-addons:untrusted set_real_ip_from 0.0.0.0/0;\n");
  writeFileSync(untouched, "add_header X-Frame-Options SAMEORIGIN;\n");
  const flagUp: boolean[] = [];
  const release = () => { flagUp.push(existsSync(flag)); return true; };
  const edits = [
    { path: edited, marker: "#clp-addons:untrusted", release },
    { path: untouched, marker: "# clp-addons:maintenance:start", release },
  ];
  expect(releaseConffiles(edits, apt("1", "1").run, flag)).toEqual([]);
  expect(existsSync(flag)).toBe(false);
  expect(releaseConffiles(edits, apt("1", "2").run, flag)).toEqual([edited]);
  expect(flagUp).toEqual([true]);
  expect(conffilesReleased(flag, service("activating"))).toBe(true);
  expect(endConffileRelease(flag)).toBe(true);
  expect(conffilesReleased(flag, service("activating"))).toBe(false);
  expect(endConffileRelease(flag)).toBe(false);
});

test("the release holds repair off for as long as the upgrade runs, and not after it stopped without post", () => {
  const flag = join(tempDir(), "released");
  writeFileSync(flag, "");
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
  utimesSync(flag, old, old);
  expect(conffilesReleased(flag, service("activating"))).toBe(true);
  expect(conffilesReleased(flag, service("deactivating"))).toBe(true);
  expect(conffilesReleased(flag, service("inactive"))).toBe(false);
  expect(conffilesReleased(flag, service("failed"))).toBe(false);
  expect(conffilesReleased(flag, service(""))).toBe(false);
  writeFileSync(flag, "");
  expect(conffilesReleased(flag, service(""))).toBe(true);
});

test("the unattended-upgrades service runs the hook before and after, and its failures never stop the run", () => {
  const dropIn = aptUpgradeDropIn();
  expect(dropIn).toContain("ExecStartPre=-/usr/local/bin/clp-addons apt-hook pre\n");
  expect(dropIn).toContain("ExecStopPost=-/usr/local/bin/clp-addons apt-hook post\n");
});
