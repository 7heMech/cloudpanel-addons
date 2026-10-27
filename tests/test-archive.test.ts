import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeArchiveAction, type ArchiveJobView, type ArchivePaths, type ArchiveState } from "../addons/archive/action";
import { dashboardContent } from "../addons/archive/app/views";
import { ARCHIVE_TARGETS } from "../addons/archive/inject/targets";
import { ROW_ACTION_CLASS } from "../lib/row-actions";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** CloudPanel's CLI as far as archiving uses it: exports, and deletes that take the panel's row. */
function fakeClpctl(dir: string, panelDb: string): string {
  const path = join(dir, "clpctl");
  writeFileSync(path, `#!${process.execPath}
import { Database } from "bun:sqlite";
import { appendFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
const [verb, ...args] = process.argv.slice(2);
const arg = (name) => args.find((value) => value.startsWith("--" + name + "="))?.slice(name.length + 3) ?? "";
appendFileSync(${JSON.stringify(join(dir, "calls"))}, [verb, ...args].join(" ") + "\\n");
if (process.env.FAIL_VERB === verb) process.exit(1);
if (verb === "db:export") await Bun.write(arg("file"), gzipSync("-- dump of " + arg("databaseName")));
if (verb === "site:delete") {
  const db = new Database(${JSON.stringify(panelDb)});
  const site = db.query("SELECT id FROM site WHERE domain_name = ?").get(arg("domainName"));
  db.run("DELETE FROM database WHERE site_id = ?", [site.id]);
  db.run("DELETE FROM site WHERE id = ?", [site.id]);
}
`);
  chmodSync(path, 0o755);
  return path;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "archive-test-"));
  dirs.push(dir);
  const panelDb = join(dir, "db.sq3");
  const db = new Database(panelDb);
  db.exec(`
    CREATE TABLE site (id INTEGER PRIMARY KEY, domain_name TEXT, type TEXT, application TEXT, user TEXT, root_directory TEXT, vhost_template TEXT, reverse_proxy_url TEXT);
    CREATE TABLE php_settings (site_id INTEGER, php_version TEXT);
    CREATE TABLE nodejs_settings (site_id INTEGER, nodejs_version TEXT, port INTEGER);
    CREATE TABLE python_settings (site_id INTEGER, python_version TEXT, port INTEGER);
    CREATE TABLE database (id INTEGER PRIMARY KEY, site_id INTEGER, name TEXT);
    CREATE TABLE database_user (id INTEGER PRIMARY KEY, database_id INTEGER, user_name TEXT, password TEXT, permissions TEXT);
    CREATE TABLE ssh_user (site_id INTEGER, user_name TEXT);
    CREATE TABLE ftp_user (site_id INTEGER, user_name TEXT);
    CREATE TABLE cron_job (site_id INTEGER, minute TEXT, hour TEXT, day TEXT, month TEXT, weekday TEXT, command TEXT);
    INSERT INTO site VALUES (1, 'old-shop.example', 'php', 'WordPress', 'oldshop', 'old-shop.example', 'server { {{root}} }', NULL);
    INSERT INTO php_settings VALUES (1, '8.3');
    INSERT INTO database VALUES (1, 1, 'oldshop_wp');
    INSERT INTO ssh_user VALUES (1, 'oldshop-deploy');
    INSERT INTO cron_job VALUES (1, '*/5', '*', '*', '*', '*', 'php wp-cron.php');
    INSERT INTO site VALUES (2, 'docs.example', 'static', 'Static', 'docs', 'docs.example', 'server {}', NULL);
    INSERT INTO site VALUES (3, 'cms.example', 'reverse-proxy', 'ReverseProxy', 'cms', 'cms.example', 'server {}', 'http://127.0.0.1:39001');
    INSERT INTO site VALUES (4, 'old-name.example', 'static', 'Static', 'oldname', 'old-name.example', 'server {}', NULL);
  `);
  db.close();
  for (const user of ["oldshop", "docs"]) {
    mkdirSync(join(dir, "home", user, "htdocs"), { recursive: true });
    writeFileSync(join(dir, "home", user, "htdocs", "index.php"), `<?php echo "${user}";`);
  }
  mkdirSync(join(dir, "instatic", "cms.example"), { recursive: true });
  writeFileSync(join(dir, "instatic", "cms.example", "meta.json"), "{}");
  writeFileSync(join(dir, "standins.json"), JSON.stringify({ "old-name.example": {} }), { mode: 0o600 });
  writeFileSync(join(dir, "dns.conf"), "enabled");
  const paths: Partial<ArchivePaths> = {
    panelDb, clpctl: fakeClpctl(dir, panelDb), homeRoot: join(dir, "home"), archiveDir: join(dir, "archives"), jobsDir: join(dir, "jobs"),
    lockFile: join(dir, "archive.lock"), dnsConfig: join(dir, "dns.conf"), instaticDir: join(dir, "instatic"), standIns: join(dir, "standins.json"),
    rootUid: process.getuid!(),
  };
  const dns: { verb: string; body: unknown }[] = [];
  const env = {
    dir, paths, dns,
    async act<T>(argv: string[], body?: unknown): Promise<T> {
      return await executeArchiveAction(argv, {
        paths, processUid: 0, input: body === undefined ? undefined : JSON.stringify(body),
        start: () => ({ ok: true, stdout: "", stderr: "" }),
        dns: async (verb, request) => {
          dns.push({ verb, body: request });
          return verb === "list" ? { sites: [] } : { redirect: "old-shop.example", applied: true, reason: "" };
        },
      }) as T;
    },
    async runJob(argv: string[], body: unknown): Promise<ArchiveJobView> {
      const { job } = await env.act<{ job: ArchiveJobView }>(argv, body);
      await env.act(["run", `--job=${job.id}`]);
      return (await env.act<{ job: ArchiveJobView }>(["job", `--job=${job.id}`])).job;
    },
    calls: () => existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n") : [],
  };
  return env;
}

describe("the site list", () => {
  test("leaves out DNS's stand-ins and says why Instatic's sites are archived there", async () => {
    const state = await setup().act<ArchiveState>(["list"]);
    expect(state.sites.map((site) => `${site.domain} ${site.blocked}`)).toEqual([
      "cms.example Instatic keeps its own final archive when it deletes a site; delete it there",
      "docs.example ",
      "old-shop.example ",
    ]);
    expect(state.dns).toBe(true);
  });

  test("refuses to queue a site it cannot archive", async () => {
    const env = setup();
    await expect(env.act(["archive"], { domains: ["cms.example"] })).rejects.toThrow("Instatic keeps its own final archive");
    await expect(env.act(["archive"], { domains: ["gone.example"] })).rejects.toThrow("CloudPanel has no site gone.example");
  });
});

describe("archiving", () => {
  test("backs up the home and every database, reads them back, and only then deletes the site", async () => {
    const env = setup();
    const job = await env.runJob(["archive"], { domains: ["old-shop.example", "docs.example"], redirect: null });
    expect(job.state).toBe("done");
    expect(job.result).toEqual({ done: ["old-shop.example", "docs.example"], failed: [], notes: [] });
    expect(env.calls()).toEqual([
      expect.stringMatching(/^db:export --databaseName=oldshop_wp --file=.*\/db-oldshop_wp\.sql\.gz$/),
      "site:delete --domainName=old-shop.example --force",
      "site:delete --domainName=docs.example --force",
    ]);
    const state = await env.act<ArchiveState>(["list"]);
    expect(state.sites.map((site) => site.domain)).toEqual(["cms.example"]);
    const archive = state.archives.find((entry) => entry.domain === "old-shop.example")!;
    expect(archive).toMatchObject({ type: "php", application: "WordPress", siteUser: "oldshop", phpVersion: "8.3", databases: ["oldshop_wp"],
      sshUsers: ["oldshop-deploy"], cronJobs: ["*/5 * * * * php wp-cron.php"], redirect: null });
    const dir = join(env.dir, "archives", archive.id);
    expect((statSync(join(env.dir, "archives")).mode & 0o777)).toBe(0o700);
    expect(readdirSync(dir).sort()).toEqual(["db-oldshop_wp.sql.gz", "home.tar.gz", "meta.json"]);
    for (const file of readdirSync(dir)) expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
    expect(dashboardContent(state)).toContain("Archived old-shop.example, docs.example.");
  });

  test("a backup that cannot be made deletes nothing and leaves no half archive", async () => {
    const env = setup();
    process.env.FAIL_VERB = "db:export";
    try {
      const job = await env.runJob(["archive"], { domains: ["old-shop.example"] });
      expect(job.state).toBe("failed");
      expect(job.error).toContain("The database oldshop_wp could not be exported");
    } finally {
      delete process.env.FAIL_VERB;
    }
    expect(env.calls().some((call) => call.startsWith("site:delete"))).toBe(false);
    const state = await env.act<ArchiveState>(["list"]);
    expect(state.sites.map((site) => site.domain)).toContain("old-shop.example");
    expect(state.archives).toEqual([]);
  });

  test("hands the domain to DNS as a redirect once the site is gone, with the profile DNS had for it", async () => {
    const env = setup();
    const job = await env.runJob(["archive"], {
      domains: ["old-shop.example"], redirect: { target: "https://shop.example", status: 301, keepPath: true, keepQuery: true },
    });
    expect(job.state).toBe("done");
    expect(env.dns).toEqual([{ verb: "archive-redirect", body: { source: "old-shop.example", target: "https://shop.example", status: 301, keepPath: true, keepQuery: true } }]);
    const archive = (await env.act<ArchiveState>(["list"])).archives[0]!;
    expect(archive.redirect).toEqual({ target: "https://shop.example", applied: true, reason: "" });
  });

  test("one job at a time, and a redirect only with DNS enabled", async () => {
    const env = setup();
    await env.act(["archive"], { domains: ["docs.example"] });
    await expect(env.act(["archive"], { domains: ["old-shop.example"] })).rejects.toThrow("Wait for the archive job to finish");
    const other = setup();
    rmSync(join(other.dir, "dns.conf"));
    await expect(other.act(["archive"], { domains: ["docs.example"], redirect: { target: "https://example.com" } }))
      .rejects.toThrow("Enable DNS to make an archived site a redirect");
  });
});

describe("restoring", () => {
  test("refuses while the site exists, and while the domain is a DNS redirect", async () => {
    const env = setup();
    await env.runJob(["archive"], { domains: ["docs.example"] });
    const id = (await env.act<ArchiveState>(["list"])).archives[0]!.id;
    const db = new Database(env.paths.panelDb!);
    db.run("INSERT INTO site VALUES (9, 'docs.example', 'static', 'Static', 'docs2', 'docs.example', 'server {}', NULL)");
    db.close();
    const job = await env.runJob(["restore"], { id });
    expect(job.error).toBe("docs.example: CloudPanel already has a site docs.example");
  });

  test("deleting an archive removes its files", async () => {
    const env = setup();
    await env.runJob(["archive"], { domains: ["docs.example"] });
    const id = (await env.act<ArchiveState>(["list"])).archives[0]!.id;
    expect((await env.runJob(["delete"], { id })).state).toBe("done");
    expect((await env.act<ArchiveState>(["list"])).archives).toEqual([]);
    expect(readdirSync(join(env.dir, "archives"))).toEqual([]);
    await expect(env.act(["delete"], { id: "../etc--20261027T000000Z" })).rejects.toThrow("that is not an archive");
  });
});

test("the Sites row's Archive link sits before Manage, in the row's menu", () => {
  const action = ARCHIVE_TARGETS.find((target) => target.slug === "site-list-action")!;
  expect(action.anchorBefore).toContain("{% trans %}Manage{% endtrans %}");
  expect(action.snippet("/addons/archive")).toContain(`class="${ROW_ACTION_CLASS} clp-addons-menu-only" href="/addons/archive/?site={{ site.domainName|url_encode }}"`);
});
