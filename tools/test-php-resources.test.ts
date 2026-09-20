import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CATEGORY_PROFILE, executePhpResourcesAction, parseProfile, readProfileFromPool, renderPool,
  PRESET_CATEGORIES, STOCK_PROFILE,
  type PhpResourcesActionOptions, type PhpResourcesActionPaths, type PhpResourcesResult,
  type PhpResourcesState, type PoolProfile, type PoolSiteState, type ReconcileResult,
} from "../addons/php-resources/action";
import type { CommandResult } from "../cli/action-common";
import { dashboardView } from "../addons/php-resources/app/views";

/** CloudPanel's PoolBuilder output, byte for byte, with no trailing newline. */
const STOCK_POOL = `[shop.example.com]
listen = 127.0.0.1:17001
user = shop
group = shop
listen.allowed_clients = 127.0.0.1
pm = ondemand
pm.max_children = 250
pm.process_idle_timeout = 10s
pm.max_requests = 100
listen.backlog = 65535
pm.status_path = /status
request_terminate_timeout = 7200s
rlimit_files = 131072
rlimit_core = unlimited
catch_workers_output = yes`;

test("CloudPanel's own pool file reads back as the stock profile", () => {
  expect(readProfileFromPool(STOCK_POOL)).toEqual(STOCK_PROFILE);
});

test("rendering keeps the pool's identity and rewrites only the limits", () => {
  const rendered = renderPool(STOCK_POOL, { ...STOCK_PROFILE, maxChildren: 40, maxRequests: 500 });
  // What CloudPanel owns is untouched, in its original order.
  for (const line of [
    "[shop.example.com]", "listen = 127.0.0.1:17001", "user = shop", "group = shop",
    "listen.allowed_clients = 127.0.0.1", "listen.backlog = 65535", "pm.status_path = /status",
    "rlimit_core = unlimited", "catch_workers_output = yes",
  ]) {
    expect(rendered.split("\n")).toContain(line);
  }
  expect(rendered).toContain("pm.max_children = 40");
  expect(rendered).toContain("pm.max_requests = 500");
  expect(rendered).not.toContain("pm.max_children = 250");
  // Rewritten in place: the line count cannot move when nothing was added.
  expect(rendered.split("\n").length).toBe(STOCK_POOL.split("\n").length);
  expect(readProfileFromPool(rendered)).toEqual({ ...STOCK_PROFILE, maxChildren: 40, maxRequests: 500 });
});

test("a mode only gets the directives php-fpm reads under it", () => {
  const dynamic = renderPool(STOCK_POOL, {
    ...STOCK_PROFILE, pm: "dynamic", maxChildren: 20, startServers: 4, minSpareServers: 2, maxSpareServers: 8,
  });
  expect(dynamic).toContain("pm = dynamic");
  expect(dynamic).toContain("pm.start_servers = 4");
  expect(dynamic).toContain("pm.min_spare_servers = 2");
  expect(dynamic).toContain("pm.max_spare_servers = 8");
  // ondemand's idle timeout is meaningless under dynamic and is taken out.
  expect(dynamic).not.toContain("pm.process_idle_timeout");

  const staticPool = renderPool(dynamic, { ...STOCK_PROFILE, pm: "static", maxChildren: 12 });
  expect(staticPool).toContain("pm = static");
  expect(staticPool).not.toContain("pm.start_servers");
  expect(staticPool).not.toContain("pm.process_idle_timeout");

  // Back to ondemand: the directive it needs is put back even though the file
  // it is rendered from no longer has the line.
  const back = renderPool(staticPool, STOCK_PROFILE);
  expect(readProfileFromPool(back)).toEqual(STOCK_PROFILE);
});

test("a directive the file has lost is put back among its own kind", () => {
  const stripped = STOCK_POOL.split("\n").filter((line) => !line.startsWith("pm")).join("\n");
  const rendered = renderPool(stripped, STOCK_PROFILE).split("\n");
  // Beside the managed directives that are still there, in the order a stock
  // pool file has them, rather than appended after `catch_workers_output`.
  const line = (text: string) => rendered.indexOf(text);
  expect(line("pm = ondemand")).toBeLessThan(line("pm.max_children = 250"));
  expect(line("pm.max_children = 250")).toBeLessThan(line("pm.process_idle_timeout = 10s"));
  expect(line("pm.process_idle_timeout = 10s")).toBeLessThan(line("pm.max_requests = 100"));
  expect(line("pm.max_requests = 100")).toBeLessThan(line("request_terminate_timeout = 7200s"));
  expect(line("pm = ondemand")).toBeLessThan(line("rlimit_core = unlimited"));
  expect(readProfileFromPool(rendered.join("\n"))).toEqual(STOCK_PROFILE);
});

test("rendering is settled: a second pass over its own output changes nothing", () => {
  const once = renderPool(STOCK_POOL, { ...STOCK_PROFILE, pm: "dynamic", maxChildren: 30 });
  expect(renderPool(once, { ...STOCK_PROFILE, pm: "dynamic", maxChildren: 30 })).toBe(once);
});

test("a profile php-fpm would refuse is refused here first", () => {
  const dynamic = { ...STOCK_PROFILE, pm: "dynamic" as const };
  expect(() => parseProfile({ ...dynamic, minSpareServers: 9, maxSpareServers: 3 }))
    .toThrow(/min spare servers cannot be greater/);
  expect(() => parseProfile({ ...dynamic, startServers: 1, minSpareServers: 2, maxSpareServers: 4 }))
    .toThrow(/start servers must be between/);
  expect(() => parseProfile({ ...dynamic, maxChildren: 4, startServers: 5, minSpareServers: 5, maxSpareServers: 5 }))
    .toThrow(/max spare servers cannot be greater/);
  expect(() => parseProfile({ ...STOCK_PROFILE, pm: "sometimes" })).toThrow(/process manager must be one of/);
  expect(() => parseProfile({ ...STOCK_PROFILE, maxChildren: 0 })).toThrow(/max children must be between/);
  expect(() => parseProfile({ ...STOCK_PROFILE, maxChildren: 12.5 })).toThrow(/whole number/);
  // The dynamic-only fields are not checked against each other under a mode
  // that never writes them, so a form can keep what was typed.
  expect(parseProfile({ ...STOCK_PROFILE, minSpareServers: 9, maxSpareServers: 3 }).maxSpareServers).toBe(3);
});

interface Box {
  paths: PhpResourcesActionPaths;
  root: string;
  commands: string[][];
  /** Command prefixes that should report failure, e.g. "php-fpm8.2 -t". */
  failing: Set<string>;
  addSite: (domain: string, phpVersion: string) => void;
  poolOf: (domain: string, phpVersion: string) => string;
  run: (command: string, args: string[]) => CommandResult;
}

function poolFor(domain: string, port: number): string {
  return STOCK_POOL.replace("[shop.example.com]", `[${domain}]`)
    .replace("listen = 127.0.0.1:17001", `listen = 127.0.0.1:${port}`)
    .replace(/(user|group) = shop/g, (_m, key: string) => `${key} = ${domain.split(".")[0]}`);
}

function makeBox(): Box {
  const root = mkdtempSync(join(tmpdir(), "clp-php-resources-"));
  const panelDb = join(root, "db.sq3");
  const db = new Database(panelDb, { create: true });
  db.exec(`CREATE TABLE site (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, domain_name TEXT, user TEXT);
           CREATE TABLE php_settings (id INTEGER PRIMARY KEY AUTOINCREMENT, site_id INTEGER, php_version TEXT);`);
  db.close();

  mkdirSync(join(root, "sbin"), { recursive: true });
  const commands: string[][] = [];
  const failing = new Set<string>();

  const paths: PhpResourcesActionPaths = {
    panelDb,
    phpRoot: join(root, "etc/php"),
    sbinDir: join(root, "sbin"),
    policyFile: join(root, "state/policy.json"),
    lockFile: join(root, "lock/php-resources.lock"),
    systemctl: "systemctl",
    rootUid: process.getuid?.() ?? 0,
  };

  let nextPort = 17001;
  const poolOf = (domain: string, phpVersion: string) =>
    join(paths.phpRoot, phpVersion, "fpm/pool.d", `${domain}.conf`);

  return {
    paths,
    root,
    commands,
    failing,
    poolOf,
    addSite(domain, phpVersion) {
      const panel = new Database(panelDb);
      panel.query("INSERT INTO site (type, domain_name, user) VALUES (?, ?, ?);")
        .run("php", domain, domain.split(".")[0]!);
      const id = panel.query<{ id: number }, []>("SELECT last_insert_rowid() AS id;").get()!.id;
      panel.query("INSERT INTO php_settings (site_id, php_version) VALUES (?, ?);").run(id, phpVersion);
      panel.close();

      const dir = join(paths.phpRoot, phpVersion, "fpm/pool.d");
      mkdirSync(dir, { recursive: true });
      const file = poolOf(domain, phpVersion);
      writeFileSync(file, poolFor(domain, nextPort++));
      chmodSync(file, 0o644);
      const binary = join(paths.sbinDir, `php-fpm${phpVersion}`);
      writeFileSync(binary, "");
      chmodSync(binary, 0o755);
    },
    run(command, args) {
      commands.push([command, ...args]);
      const key = `${command.split("/").pop()} ${args.join(" ")}`;
      const ok = !failing.has(key);
      return { ok, stdout: "", stderr: ok ? "" : "configuration is refused", exitCode: ok ? 0 : 1 };
    },
  };
}

function options(box: Box, input?: string): PhpResourcesActionOptions {
  return {
    paths: box.paths,
    processUid: 0,
    run: box.run,
    domainValidator: (value: string) => value.toLowerCase(),
    ...(input === undefined ? {} : { input }),
  };
}

function reloadsOf(box: Box, version: string): number {
  return box.commands.filter((command) => command.join(" ") === `systemctl reload php${version}-fpm`).length;
}

function siteIn(state: PhpResourcesState, domain: string): PoolSiteState {
  return state.sites.find((site) => site.domain === domain)!;
}

const tuned: PoolProfile = { ...STOCK_PROFILE, pm: "dynamic", maxChildren: 24, startServers: 3, minSpareServers: 2, maxSpareServers: 6, maxRequests: 400 };
const BUSY = PRESET_CATEGORIES.find((category) => category.id === "busy-site")!;

function assign(box: Box, domains: string[], categoryId: string | null): Promise<unknown> {
  return executePhpResourcesAction(["assign"], options(box, JSON.stringify({ domains, categoryId })));
}

test("a server that has saved nothing already has the preset categories", async () => {
  const box = makeBox();
  try {
    box.addSite("shop.example.com", "8.2");
    const state = await executePhpResourcesAction(["list"], options(box)) as PhpResourcesState;
    expect(state.categories.map((category) => category.id)).toEqual(["small-site", "busy-site", "high-traffic"]);
    expect(state.categories.map((category) => ({
      mode: category.profile.pm,
      maxChildren: category.profile.maxChildren,
      maxRequests: category.profile.maxRequests,
    }))).toEqual([
      { mode: "ondemand", maxChildren: 3, maxRequests: 200 },
      { mode: "ondemand", maxChildren: 8, maxRequests: 200 },
      { mode: "dynamic", maxChildren: 12, maxRequests: 200 },
    ]);
    expect(state.categories[2]!.profile).toMatchObject({
      startServers: 2, minSpareServers: 1, maxSpareServers: 3,
    });
    expect(DEFAULT_CATEGORY_PROFILE).toEqual(state.categories[0]!.profile);
    const page = dashboardView(state);
    expect(page).toContain("Limits apply to every site separately");
    expect(page).toContain("data-default-profile=");
    expect(page).toContain("&quot;maxChildren&quot;:3");
    expect(state.defaultCategoryId).toBeNull();
    expect(siteIn(state, "shop.example.com").categoryId).toBeNull();
    expect(readFileSync(box.poolOf("shop.example.com", "8.2"), "utf8")).toBe(STOCK_POOL);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("assigning a fleet writes every pool and reloads each PHP version once", async () => {
  const box = makeBox();
  try {
    box.addSite("shop.example.com", "8.2");
    box.addSite("blog.example.com", "8.2");
    box.addSite("news.example.com", "8.3");
    box.addSite("untouched.example.com", "8.3");

    const result = await assign(box, ["shop.example.com", "blog.example.com", "news.example.com"], "busy-site") as PhpResourcesResult;
    expect(result.failures).toEqual([]);
    for (const [domain, version] of [["shop.example.com", "8.2"], ["blog.example.com", "8.2"], ["news.example.com", "8.3"]]) {
      expect(siteIn(result, domain!).categoryName).toBe("Busy site");
      expect(readProfileFromPool(readFileSync(box.poolOf(domain!, version!), "utf8"))).toEqual(BUSY.profile);
    }
    // One decision, one reload of each service, however many sites it covered.
    expect(reloadsOf(box, "8.2")).toBe(1);
    expect(reloadsOf(box, "8.3")).toBe(1);
    // The site nobody named keeps CloudPanel's own pool.
    expect(siteIn(result, "untouched.example.com").categoryId).toBeNull();
    expect(readProfileFromPool(readFileSync(box.poolOf("untouched.example.com", "8.3"), "utf8"))).toEqual(STOCK_PROFILE);

    // The configuration is tested before anything is reloaded.
    const tested = box.commands.findIndex((command) => command[1] === "-t");
    const reloaded = box.commands.findIndex((command) => command[1] === "reload");
    expect(tested).toBeGreaterThanOrEqual(0);
    expect(tested).toBeLessThan(reloaded);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("editing a category rewrites every pool that follows it", async () => {
  const box = makeBox();
  try {
    box.addSite("shop.example.com", "8.2");
    box.addSite("blog.example.com", "8.2");
    await assign(box, ["shop.example.com"], "busy-site");

    const saved = await executePhpResourcesAction(["save-category"], options(box, JSON.stringify({
      id: "busy-site", name: "Busy site", description: BUSY.description, profile: tuned,
    }))) as PhpResourcesResult;
    expect(saved.failures).toEqual([]);
    expect(readProfileFromPool(readFileSync(box.poolOf("shop.example.com", "8.2"), "utf8"))).toEqual(tuned);
    // A site in no category is nobody's to rewrite.
    expect(readFileSync(box.poolOf("blog.example.com", "8.2"), "utf8")).toBe(poolFor("blog.example.com", 17002));
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("a category is created by name, and a name is used once", async () => {
  const box = makeBox();
  try {
    const created = await executePhpResourcesAction(["save-category"], options(box, JSON.stringify({
      name: "Import worker", description: "Long running imports.", profile: tuned,
    }))) as PhpResourcesResult;
    const added = created.categories.find((category) => category.id === "import-worker")!;
    expect(added.name).toBe("Import worker");
    expect(added.profile).toEqual(tuned);

    await expect(executePhpResourcesAction(["save-category"], options(box, JSON.stringify({
      name: "import worker", profile: tuned,
    })))).rejects.toThrow(/already exists/);
    await expect(executePhpResourcesAction(["save-category"], options(box, JSON.stringify({
      name: "   ", profile: tuned,
    })))).rejects.toThrow(/category name is required/);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("taking a site out of a category restores CloudPanel's own pool file", async () => {
  const box = makeBox();
  try {
    box.addSite("shop.example.com", "8.2");
    await assign(box, ["shop.example.com"], "busy-site");
    const released = await assign(box, ["shop.example.com"], null) as PhpResourcesResult;
    expect(siteIn(released, "shop.example.com").categoryId).toBeNull();
    expect(readFileSync(box.poolOf("shop.example.com", "8.2"), "utf8")).toBe(STOCK_POOL);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("deleting a category gives the sites in it CloudPanel's limits back", async () => {
  const box = makeBox();
  try {
    box.addSite("shop.example.com", "8.2");
    await assign(box, ["shop.example.com"], "busy-site");
    await executePhpResourcesAction(["set-default"], options(box, JSON.stringify({ categoryId: "busy-site" })));

    const after = await executePhpResourcesAction(
      ["delete-category"],
      options(box, JSON.stringify({ id: "busy-site" })),
    ) as PhpResourcesResult;
    expect(after.categories.map((category) => category.id)).toEqual(["small-site", "high-traffic"]);
    expect(after.defaultCategoryId).toBeNull();
    expect(siteIn(after, "shop.example.com").categoryId).toBeNull();
    expect(readFileSync(box.poolOf("shop.example.com", "8.2"), "utf8")).toBe(STOCK_POOL);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("a PHP version whose service is not running is written but not reloaded", async () => {
  const box = makeBox();
  try {
    box.addSite("shop.example.com", "8.2");
    // What `systemctl is-active --quiet` reports for a version no site has
    // been moved onto yet. CloudPanel starts that service itself when it
    // moves one, and the pool file is what it reads when it does.
    box.failing.add("systemctl is-active --quiet php8.2-fpm");

    const result = await assign(box, ["shop.example.com"], "busy-site") as PhpResourcesResult;
    expect(siteIn(result, "shop.example.com").categoryId).toBe("busy-site");
    expect(readProfileFromPool(readFileSync(box.poolOf("shop.example.com", "8.2"), "utf8"))).toEqual(BUSY.profile);
    expect(reloadsOf(box, "8.2")).toBe(0);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("a configuration php-fpm refuses leaves the pool file as it was", async () => {
  const box = makeBox();
  try {
    box.addSite("shop.example.com", "8.2");
    box.failing.add("php-fpm8.2 -t");
    await expect(assign(box, ["shop.example.com"], "busy-site")).rejects.toThrow(/configuration test failed/);
    expect(readFileSync(box.poolOf("shop.example.com", "8.2"), "utf8")).toBe(STOCK_POOL);
    // Nothing was assigned either, so the next reconciliation will not write it.
    const state = await executePhpResourcesAction(["list"], options(box)) as PhpResourcesState;
    expect(siteIn(state, "shop.example.com").categoryId).toBeNull();
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("the default category reaches sites created after it, and no others", async () => {
  const box = makeBox();
  try {
    box.addSite("shop.example.com", "8.2");
    await executePhpResourcesAction(["set-default"], options(box, JSON.stringify({ categoryId: "busy-site" })));

    // The site that already existed is left alone.
    let result = await executePhpResourcesAction(["reconcile"], options(box)) as ReconcileResult;
    expect(result).toEqual({ discovered: 0, applied: 0, repaired: 0 });
    expect(readFileSync(box.poolOf("shop.example.com", "8.2"), "utf8")).toBe(STOCK_POOL);

    box.addSite("new.example.com", "8.2");
    result = await executePhpResourcesAction(["reconcile"], options(box)) as ReconcileResult;
    expect(result.discovered).toBe(1);
    expect(result.applied).toBe(1);
    expect(readProfileFromPool(readFileSync(box.poolOf("new.example.com", "8.2"), "utf8"))).toEqual(BUSY.profile);

    // And only once: a second pass has nothing left to do.
    result = await executePhpResourcesAction(["reconcile"], options(box)) as ReconcileResult;
    expect(result).toEqual({ discovered: 0, applied: 0, repaired: 0 });

    // Choosing no default changes nothing that already joined.
    await executePhpResourcesAction(["set-default"], options(box, JSON.stringify({ categoryId: null })));
    const state = await executePhpResourcesAction(["list"], options(box)) as PhpResourcesState;
    expect(state.defaultCategoryId).toBeNull();
    expect(siteIn(state, "new.example.com").categoryId).toBe("busy-site");
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("a site taken out of a category is not a new site the default can claim", async () => {
  const box = makeBox();
  try {
    box.addSite("shop.example.com", "8.2");
    await assign(box, ["shop.example.com"], null);
    await executePhpResourcesAction(["set-default"], options(box, JSON.stringify({ categoryId: "busy-site" })));
    box.addSite("new.example.com", "8.2");

    await executePhpResourcesAction(["reconcile"], options(box));
    const state = await executePhpResourcesAction(["list"], options(box)) as PhpResourcesState;
    expect(siteIn(state, "shop.example.com").categoryId).toBeNull();
    expect(siteIn(state, "new.example.com").categoryId).toBe("busy-site");
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("a pool file CloudPanel rewrote for a new PHP version is restored", async () => {
  const box = makeBox();
  try {
    box.addSite("shop.example.com", "8.2");
    await assign(box, ["shop.example.com"], "busy-site");

    // What changing the PHP version in the panel leaves behind: the old pool
    // file deleted, a stock one written under the new version.
    rmSync(box.poolOf("shop.example.com", "8.2"), { force: true });
    const panel = new Database(box.paths.panelDb);
    panel.query("UPDATE php_settings SET php_version = '8.3';").run();
    panel.close();
    box.addSite("ignored.example.com", "8.3");
    mkdirSync(join(box.paths.phpRoot, "8.3/fpm/pool.d"), { recursive: true });
    const moved = box.poolOf("shop.example.com", "8.3");
    writeFileSync(moved, poolFor("shop.example.com", 17005));
    chmodSync(moved, 0o644);

    const before = await executePhpResourcesAction(["site", "--domain=shop.example.com"], options(box)) as PoolSiteState;
    expect(before.drifted).toBe(true);

    const result = await executePhpResourcesAction(["reconcile"], options(box)) as ReconcileResult;
    expect(result.repaired).toBe(1);
    expect(readProfileFromPool(readFileSync(moved, "utf8"))).toEqual(BUSY.profile);

    const after = await executePhpResourcesAction(["site", "--domain=shop.example.com"], options(box)) as PoolSiteState;
    expect(after.drifted).toBe(false);
    expect(after.phpVersion).toBe("8.3");
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("a site CloudPanel no longer has stops being carried", async () => {
  const box = makeBox();
  try {
    box.addSite("shop.example.com", "8.2");
    box.addSite("keep.example.com", "8.2");
    await assign(box, ["shop.example.com"], "busy-site");
    const panel = new Database(box.paths.panelDb);
    panel.query("DELETE FROM site WHERE domain_name = 'shop.example.com';").run();
    panel.close();

    await executePhpResourcesAction(["reconcile"], options(box));
    expect(JSON.parse(readFileSync(box.paths.policyFile, "utf8")).assignments).toEqual({});
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("a site with no PHP settings has no pool to assign", async () => {
  const box = makeBox();
  try {
    const panel = new Database(box.paths.panelDb);
    panel.query("INSERT INTO site (type, domain_name, user) VALUES ('static', 'static.example.com', 'static');").run();
    panel.close();
    await expect(assign(box, ["static.example.com"], "busy-site"))
      .rejects.toThrow(/no CloudPanel site with PHP settings/);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("only root may change a pool, and only the declared verbs exist", async () => {
  const box = makeBox();
  try {
    await expect(executePhpResourcesAction(["list"], { ...options(box), processUid: 1000 }))
      .rejects.toThrow(/must run as root/);
    await expect(executePhpResourcesAction(["reload"], options(box))).rejects.toThrow(/usage:/);
    await expect(executePhpResourcesAction(["list", "--domain=shop.example.com"], options(box)))
      .rejects.toThrow(/takes no arguments/);
    await expect(assign(box, ["shop.example.com"], "no-such-category"))
      .rejects.toThrow(/there is no category/);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});
