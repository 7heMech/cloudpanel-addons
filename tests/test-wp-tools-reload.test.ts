import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reloadNginx } from "../addons/wp-tools/basic-auth";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clp-wp-reload-"));
  writeFileSync(join(root, "nginx.pid"), "100\n");
  mkdirSync(join(root, "100", "task", "100"), { recursive: true });
  workers(["101"]);
  title("101", "nginx: worker process");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function workers(pids: string[]): void {
  writeFileSync(join(root, "100", "task", "100", "children"), pids.join(" "));
}
function title(pid: string, text: string): void {
  mkdirSync(join(root, pid), { recursive: true });
  writeFileSync(join(root, pid, "cmdline"), `${text}\0     `);
}

test("a reload waits for the new workers and the old generation to stop accepting", async () => {
  let complete = false;
  const pending = reloadNginx(() => {
    workers(["101", "102"]);
    title("102", "nginx: worker process");
  }, join(root, "nginx.pid"), root, 1000).then(() => { complete = true; });
  await Bun.sleep(50);
  expect(complete).toBe(false);
  title("101", "nginx: worker process is shutting down");
  await pending;
  expect(complete).toBe(true);
});

test("disappearing old workers and ancillary Nginx processes are handled", async () => {
  await reloadNginx(() => {
    workers(["101", "102", "103"]);
    rmSync(join(root, "101"), { recursive: true });
    title("102", "nginx: worker process");
    title("103", "nginx: cache manager process");
  }, join(root, "nginx.pid"), root, 1000);
});

test("a reload that never hands over is bounded and reports failure", async () => {
  await expect(reloadNginx(() => {}, join(root, "nginx.pid"), root, 50)).rejects.toThrow("did not finish");
});

test("a failed reload signal is reported immediately", async () => {
  await expect(reloadNginx(() => { throw new Error("signal failed"); }, join(root, "nginx.pid"), root, 50)).rejects.toThrow("signal failed");
});
