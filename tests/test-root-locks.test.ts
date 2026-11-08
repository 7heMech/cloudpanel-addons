// Root locks: the gateway lets a locked addon's protections only move toward the safer state.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthActionServer } from "../cli/auth-action";
import { LOCKABLE_ADDONS, addonLocked, lockState, lockedAddons, switchesOnOnly } from "../lib/root-locks";
import { changeLock } from "../cli/lock-addon";
import { freshBox, lockNewInstall } from "../cli/install";
import { lockHint } from "../cli/update";

const uid = process.getuid?.() ?? 0;
let dir = "";

beforeAll(() => { dir = mkdtempSync(`${tmpdir()}/root-locks-`); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function locks(addons: string[], mode = 0o644): string {
  const file = `${dir}/locks-${Math.random().toString(36).slice(2)}.json`;
  writeFileSync(file, JSON.stringify({ addons }));
  chmodSync(file, mode);
  return file;
}

async function ask(file: string, addon: string, verb: string, input?: unknown): Promise<{ reply: unknown; ran: boolean }> {
  let ran = false;
  const spawn = ((_args: string[], options: Record<string, unknown>) => {
    ran = true;
    return Bun.spawn(["echo", '{"ok":true}'], options as never);
  }) as unknown as typeof Bun.spawn;
  const socketPath = `${dir}/gw-${Math.random().toString(36).slice(2)}.sock`;
  const server = createAuthActionServer({ enforcePeer: false, spawn, locks: { file, rootUid: uid } });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    let received = "";
    const done = Promise.withResolvers<void>();
    const socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) { received += Buffer.from(chunk).toString("utf8"); },
        close() { done.resolve(); },
        error() {},
      },
    });
    socket.write(JSON.stringify({ kind: "action", addon, verb, ...(input === undefined ? {} : { input: JSON.stringify(input) }) }) + "\n");
    await done.promise;
    return { reply: JSON.parse(received), ran };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("System Tweaks is lockable", () => {
  expect(LOCKABLE_ADDONS).toContain("system-tweaks");
});

test("a locked addon's protections are refused, and its other verbs still run", async () => {
  const file = locks(["system-tweaks"]);
  expect(await ask(file, "system-tweaks", "set-file-manager-guard")).toEqual({
    reply: { ok: false, error: "root has locked system-tweaks; run clp-addons unlock system-tweaks on the server" },
    ran: false,
  });
  expect((await ask(file, "system-tweaks", "state")).ran).toBe(true);
  expect((await ask(file, "system-tweaks", "set-updates")).ran).toBe(true);
});

test("an unlocked addon's protections run", async () => {
  expect((await ask(locks([]), "system-tweaks", "set-file-manager-guard")).ran).toBe(true);
  expect((await ask(`${dir}/missing.json`, "system-tweaks", "set-file-manager-guard")).ran).toBe(true);
});

test("a lock file others can write counts as locking everything", async () => {
  const file = locks([], 0o666);
  expect(() => lockedAddons(file, uid)).toThrow("not a trusted regular file");
  expect(addonLocked("system-tweaks", file, uid)).toBe(true);
  expect((await ask(file, "system-tweaks", "set-file-manager-guard")).ran).toBe(false);
});

test("a lock file root does not own counts as locking everything", () => {
  expect(addonLocked("system-tweaks", locks([]), uid + 1)).toBe(true);
});

test("a lock file that does not parse counts as locking everything", () => {
  const file = locks([]);
  writeFileSync(file, "{");
  expect(() => lockedAddons(file, uid)).toThrow("is not valid JSON");
  expect(addonLocked("system-tweaks", file, uid)).toBe(true);
});

test("the page can tell a damaged lock file from root's lock", () => {
  const file = locks(["system-tweaks"]);
  expect(lockState("system-tweaks", file, uid)).toBe("locked");
  expect(lockState("system-tweaks", locks([]), uid)).toBe("unlocked");
  writeFileSync(file, "{");
  expect(lockState("system-tweaks", file, uid)).toBe("damaged");
});

test("a lock directory others can write counts as locking everything", () => {
  const open = mkdtempSync(`${dir}/open-`);
  chmodSync(open, 0o777);
  expect(() => lockedAddons(`${open}/locks.json`, uid)).toThrow("is not a directory only root can write");
  // So `lock` tells root to fix the directory, not to remove a file that may be sound.
  expect(() => lockedAddons(`${open}/locks.json`, uid)).toThrow(expect.objectContaining({ directory: true }));
  expect(addonLocked("system-tweaks", `${open}/locks.json`, uid)).toBe(true);
});

test("a lock file reached through a link counts as locking everything", () => {
  const link = `${mkdtempSync(`${dir}/link-`)}/locks.json`;
  symlinkSync(locks([]), link);
  expect(addonLocked("system-tweaks", link, uid)).toBe(true);
});

test.skipIf(uid === 0)("a lock file that cannot be read counts as locking everything, not as no locks", () => {
  const shut = mkdtempSync(`${dir}/shut-`);
  writeFileSync(`${shut}/locks.json`, JSON.stringify({ addons: [] }));
  chmodSync(shut, 0o000);
  try {
    expect(addonLocked("system-tweaks", `${shut}/locks.json`, uid)).toBe(true);
  } finally {
    chmodSync(shut, 0o700);
  }
});

test("an addon with nothing to lock is never locked, even by a broken file", () => {
  const file = locks([]);
  writeFileSync(file, "{");
  expect(addonLocked("dns", file, uid)).toBe(false);
});

test.skipIf(uid === 0)("a lock file that cannot be opened reports why, not that it is untrusted", () => {
  const shut = mkdtempSync(`${dir}/unreadable-`);
  writeFileSync(`${shut}/locks.json`, JSON.stringify({ addons: [] }));
  chmodSync(`${shut}/locks.json`, 0o000);
  try {
    expect(() => lockedAddons(`${shut}/locks.json`, uid)).toThrow("EACCES");
    expect(lockState("system-tweaks", `${shut}/locks.json`, uid)).toBe("damaged");
  } finally {
    chmodSync(`${shut}/locks.json`, 0o644);
  }
});

test("a locked addon's switches can still go on, never off", async () => {
  const file = locks(["system-tweaks"]);
  expect((await ask(file, "system-tweaks", "set-file-manager-guard", { enabled: true })).ran).toBe(true);
  expect((await ask(file, "system-tweaks", "set-file-manager-guard", { enabled: false })).ran).toBe(false);
  expect((await ask(file, "system-tweaks", "set-login-jails", { ssh: true })).ran).toBe(true);
  expect((await ask(file, "system-tweaks", "set-login-jails", { panel: true, ssh: false })).ran).toBe(false);
  expect((await ask(file, "system-tweaks", "set-login-jails", {})).ran).toBe(false);
  expect((await ask(file, "system-tweaks", "set-telemetry", { enabled: "true" })).ran).toBe(false);
  // A damaged file locks too, and switching on is still allowed.
  const damaged = locks([], 0o666);
  expect((await ask(damaged, "system-tweaks", "set-file-manager-guard", { enabled: true })).ran).toBe(true);
  expect((await ask(damaged, "system-tweaks", "set-file-manager-guard", { enabled: false })).ran).toBe(false);
});

test("a locked panel PHP choice reaches the action, which allows only a newer version", async () => {
  expect((await ask(locks(["system-tweaks"]), "system-tweaks", "set-panel-php", { php: "" })).ran).toBe(true);
});

test("Lock settings is not itself held by the lock", async () => {
  expect((await ask(locks(["system-tweaks"]), "system-tweaks", "lock-settings")).ran).toBe(true);
});

test("only an object naming settings, every one true, switches on only", () => {
  expect(switchesOnOnly('{"enabled":true}')).toBe(true);
  expect(switchesOnOnly('{"panel":true,"ssh":true}')).toBe(true);
  for (const input of [undefined, "", "{", "true", "[true]", "{}", '{"enabled":false}', '{"enabled":1}', '{"a":true,"b":null}']) {
    expect(switchesOnOnly(input)).toBe(false);
  }
});

function lockFiles() {
  const own = mkdtempSync(`${dir}/files-`);
  return { file: `${own}/etc/locks.json`, rootUid: uid, lockFile: `${own}/locks.lock` };
}

test("a lock is added under the file lock, and a list root cannot trust is left alone", () => {
  const files = lockFiles();
  expect(changeLock("system-tweaks", true, files)).toBe(true);
  expect(changeLock("system-tweaks", true, files)).toBe(false);
  expect(lockedAddons(files.file, uid)).toEqual(["system-tweaks"]);
  expect(changeLock("system-tweaks", false, files)).toBe(true);
  expect(lockedAddons(files.file, uid)).toEqual([]);
  chmodSync(files.file, 0o666);
  expect(() => changeLock("system-tweaks", true, files)).toThrow("not a trusted regular file");
  expect(JSON.parse(readFileSync(files.file, "utf8"))).toEqual({ addons: [] });
});

test("a fresh install locks System Tweaks; a re-run of the installer and an update do not", () => {
  const fresh = lockFiles();
  expect(lockNewInstall(true, fresh)).toBe(true);
  expect(lockState("system-tweaks", fresh.file, uid)).toBe("locked");

  const rerun = lockFiles();
  expect(lockNewInstall(false, rerun)).toBe(false);
  expect(existsSync(rerun.file)).toBe(false);

  // Update only says how: the box stays unlocked.
  expect(lockHint(true, rerun.file, uid)).toContain("clp-addons lock system-tweaks");
  expect(existsSync(rerun.file)).toBe(false);
  expect(lockHint(true, fresh.file, uid)).toBeNull();
  // Nothing to suggest for an addon the box does not use.
  expect(lockHint(false, rerun.file, uid)).toBeNull();
});

// A manifest that cannot be read once made a re-run look like a first install.
test("only a box with no manifest at all and no addon enabled is fresh", () => {
  const box = mkdtempSync(join(tmpdir(), "clp-fresh-"));
  const manifest = join(box, "artifacts.json");
  expect(freshBox(manifest, 0)).toBe(true);
  expect(freshBox(manifest, 1)).toBe(false);
  writeFileSync(manifest, "{ truncated");
  expect(freshBox(manifest, 0)).toBe(false);
  rmSync(box, { recursive: true, force: true });
});
