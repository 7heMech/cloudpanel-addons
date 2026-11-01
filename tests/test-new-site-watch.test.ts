import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NEW_SITE_ROW_WAIT_MS, syncNewSites, sitesInFlight, type NewSiteWatchPaths } from "../cli/new-sites";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function box(): NewSiteWatchPaths & { addRow: (domain: string) => void; addVhost: (name: string, ageMs?: number) => void } {
  const root = mkdtempSync(join(tmpdir(), "clp-new-site-watch-"));
  roots.push(root);
  const paths = { panelDb: join(root, "db.sq3"), vhostDir: join(root, "sites-enabled"), seenFile: join(root, "state", "seen.json") };
  mkdirSync(paths.vhostDir);
  const db = new Database(paths.panelDb, { create: true });
  db.exec("CREATE TABLE site (id INTEGER PRIMARY KEY AUTOINCREMENT, domain_name TEXT NOT NULL)");
  db.close();
  return {
    ...paths,
    addRow: (domain) => {
      const writer = new Database(paths.panelDb);
      writer.query("INSERT INTO site (domain_name) VALUES (?)").run(domain);
      writer.close();
    },
    addVhost: (name, ageMs = 0) => {
      const file = join(paths.vhostDir, name);
      writeFileSync(file, "server {}\n");
      if (ageMs) utimesSync(file, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
    },
  };
}

function recorder(onHooks: () => void = () => {}, waiting: () => boolean = () => false) {
  const calls: string[] = [];
  return {
    calls,
    ops: {
      runHooks: async () => { calls.push("hooks"); onHooks(); },
      resumePending: async () => { const still = waiting(); calls.push(still ? "waiting" : "ready"); return still; },
      watchRows: (on: boolean) => { calls.push(on ? "watch" : "unwatch"); },
    },
  };
}

test("a vhost without its row arms the rows watcher, and the row's commit runs the hooks and disarms it", async () => {
  const panel = box();
  panel.addRow("old.example.com");
  panel.addVhost("old.example.com.conf");
  const first = recorder();
  await syncNewSites(first.ops, panel);
  // No record yet: the hooks run once, and nothing is waiting.
  expect(first.calls).toEqual(["hooks", "ready", "unwatch"]);

  // CloudPanel writes the WordPress site's vhost; its row comes when the install ends.
  panel.addVhost("wp.example.com.conf");
  const vhostEvent = recorder();
  await syncNewSites(vhostEvent.ops, panel);
  expect(vhostEvent.calls).toEqual(["ready", "watch"]);

  // Panel writes that add no site cost no hook and keep watching.
  const unrelatedWrite = recorder();
  await syncNewSites(unrelatedWrite.ops, panel);
  expect(unrelatedWrite.calls).toEqual(["ready", "watch"]);

  panel.addRow("wp.example.com");
  const rowEvent = recorder();
  await syncNewSites(rowEvent.ops, panel);
  expect(rowEvent.calls).toEqual(["hooks", "ready", "unwatch"]);

  // Later vhost rewrites of a known site set run nothing.
  const rewrite = recorder();
  await syncNewSites(rewrite.ops, panel);
  expect(rewrite.calls).toEqual(["ready", "unwatch"]);
});

test("a row that lands while the hooks run is handled before the service ends", async () => {
  const panel = box();
  panel.addRow("a.example.com");
  panel.addVhost("a.example.com.conf");
  panel.addVhost("b.example.com.conf");
  let landed = false;
  // A systemd path unit drops a change made while its service runs, so this run must see it itself.
  const run = recorder(() => {
    if (!landed) { landed = true; panel.addRow("b.example.com"); }
  });
  await syncNewSites(run.ops, panel);
  expect(run.calls).toEqual(["hooks", "ready", "watch", "hooks", "ready", "unwatch"]);
});

test("a deleted site's vhost goes first, and the row's removal runs the hooks", async () => {
  const panel = box();
  panel.addRow("a.example.com");
  panel.addRow("gone.example.com");
  panel.addVhost("a.example.com.conf");
  panel.addVhost("gone.example.com.conf");
  await syncNewSites(recorder().ops, panel);

  rmSync(join(panel.vhostDir, "gone.example.com.conf"));
  const vhostEvent = recorder();
  await syncNewSites(vhostEvent.ops, panel);
  expect(vhostEvent.calls).toEqual(["ready", "watch"]);

  const writer = new Database(panel.panelDb);
  writer.query("DELETE FROM site WHERE domain_name = ?").run("gone.example.com");
  writer.close();
  const rowEvent = recorder();
  await syncNewSites(rowEvent.ops, panel);
  expect(rowEvent.calls).toEqual(["hooks", "ready", "unwatch"]);
});

test("a site deleted and added again at its domain runs the hooks, though the deletion went unseen", async () => {
  const panel = box();
  panel.addRow("a.example.com");
  panel.addVhost("a.example.com.conf");
  await syncNewSites(recorder().ops, panel);

  const writer = new Database(panel.panelDb);
  writer.query("DELETE FROM site WHERE domain_name = ?").run("a.example.com");
  writer.close();
  panel.addRow("a.example.com");
  const run = recorder();
  await syncNewSites(run.ops, panel);
  expect(run.calls).toEqual(["hooks", "ready", "unwatch"]);
});

test("an addon waiting for a new site keeps the watcher running, and is asked once more before the service ends", async () => {
  const panel = box();
  panel.addRow("a.example.com");
  panel.addVhost("a.example.com.conf");
  await syncNewSites(recorder().ops, panel);
  panel.addRow("wp.example.com");
  panel.addVhost("wp.example.com.conf");
  // The row's commit: the hooks run, and the addon still waits for WordPress.
  const rowEvent = recorder(() => {}, () => true);
  await syncNewSites(rowEvent.ops, panel);
  expect(rowEvent.calls).toEqual(["hooks", "waiting", "watch", "waiting", "watch"]);

  // What it waits for lands while the service runs: the second look sees it and stops the watcher.
  let asked = 0;
  const lands = recorder(() => {}, () => ++asked === 1);
  await syncNewSites(lands.ops, panel);
  expect(lands.calls).toEqual(["waiting", "watch", "ready", "unwatch"]);
});

test("no addon is asked to wait an hour after the sites last changed", async () => {
  const panel = box();
  panel.addRow("a.example.com");
  panel.addVhost("a.example.com.conf", NEW_SITE_ROW_WAIT_MS + 60_000);
  await syncNewSites(recorder().ops, panel);
  const later = recorder(() => {}, () => true);
  await syncNewSites({ ...later.ops, now: () => Date.now() + NEW_SITE_ROW_WAIT_MS + 1000 }, panel);
  expect(later.calls).toEqual(["unwatch"]);
});

test("an unreadable panel database runs the hooks as before and looks again at its next write", async () => {
  const panel = box();
  rmSync(panel.panelDb);
  const run = recorder();
  await syncNewSites(run.ops, panel);
  expect(run.calls).toEqual(["hooks", "watch"]);
});

test("only a recent vhost named for a domain, or a row whose vhost has just gone, is in flight", () => {
  const panel = box();
  panel.addVhost("default.conf");
  panel.addVhost("custom-domain.conf");
  panel.addVhost("00-clp-addons-maintenance-client-ip.conf");
  panel.addVhost("Known.Example.com.conf");
  panel.addVhost("orphan.example.com.conf", NEW_SITE_ROW_WAIT_MS + 60_000);
  panel.addVhost("new.example.com.conf");
  panel.addVhost("Upper.Example.com.conf");
  panel.addVhost("notes.txt");
  const now = Date.now();
  expect(sitesInFlight(panel.vhostDir, ["known.example.com", "deleted.example.com"], now))
    .toEqual(expect.arrayContaining(["new.example.com", "upper.example.com", "deleted.example.com"]));
  expect(sitesInFlight(panel.vhostDir, ["known.example.com", "deleted.example.com"], now)).toHaveLength(3);
  // An hour after the directory last changed, nothing is on its way: a row without a vhost is the operator's to look at.
  const later = now + NEW_SITE_ROW_WAIT_MS + 1;
  expect(sitesInFlight(panel.vhostDir, ["known.example.com", "deleted.example.com"], later)).toEqual([]);
  expect(sitesInFlight(join(panel.vhostDir, "missing"), [], now)).toEqual([]);
});
