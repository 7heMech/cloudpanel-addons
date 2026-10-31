import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { executeWpToolsAction, type WpToolsActionOptions } from "../addons/wp-tools/action";
import { handle } from "../addons/wp-tools/app/index";
import { searchDirectory } from "../addons/wp-tools/app/plugin-search";
import { wpToolsService } from "../addons/wp-tools/app/service";
import { WP_TOOLS_TARGETS, newSiteDoneSnippet, newSiteFormSnippet } from "../addons/wp-tools/inject/targets";
import { jobDir, jobGet, jobSet } from "../cli/job-store";
import { wpJobView, type WpJobView } from "../addons/wp-tools/jobs";
import {
  MAX_STAGED_UPLOADS, UPLOAD_PART_BYTES, claimUploads, discardUpload, downloadDirectoryPlugin, pruneUploads, stageUploadPart,
  type NewSiteResult,
} from "../addons/wp-tools/new-site-plugins";
import { inspectPluginZip } from "../addons/wp-tools/plugin-zip";
import type { WpCommand } from "../addons/wp-tools/wp-cli";
import { webVerb } from "../lib/gateway-protocol";

// --- a zip writer, so every refusal is about one thing ---------------------

interface ZipFile {
  name: string;
  data?: string;
  /** Unix mode in the top half of the external attributes. */
  mode?: number;
  stored?: boolean;
  encrypted?: boolean;
  /** The name the local header gives, when it should disagree. */
  localName?: string;
}

function zip(files: ZipFile[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const plain = Buffer.from(file.data ?? "");
    const body = file.stored || file.name.endsWith("/") ? plain : deflateRawSync(plain);
    const method = file.stored || file.name.endsWith("/") ? 0 : 8;
    const name = Buffer.from(file.name);
    const localName = Buffer.from(file.localName ?? file.name);
    const flags = (file.encrypted ? 1 : 0) | 0x800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(Bun.hash.crc32(plain), 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(plain.length, 22); local.writeUInt16LE(localName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(Bun.hash.crc32(plain), 16); central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(plain.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((file.mode ?? (file.name.endsWith("/") ? 0o040755 : 0o100644)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, localName, body);
    centrals.push(central, name);
    offset += 30 + localName.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

const HEADER = (name: string, version = "1.2.3") => `<?php\n/**\n * Plugin Name: ${name}\n * Version: ${version}\n */\n`;
const plugin = (slug = "acme-payments", name = "Acme Payments") => zip([
  { name: `${slug}/` },
  { name: `${slug}/readme.txt`, data: "=== Acme ===" },
  { name: `${slug}/${slug}.php`, data: HEADER(name) },
  { name: `${slug}/includes/class.php`, data: "<?php // nothing" },
]);

test("a plugin zip names its folder, its plugin and its version", () => {
  expect(inspectPluginZip(plugin())).toMatchObject({ slug: "acme-payments", name: "Acme Payments", version: "1.2.3" });
  // Stored rather than deflated, a header WordPress would find after other comments, and macOS's resource forks.
  const other = zip([
    { name: "js_composer/" },
    { name: "js_composer/js_composer.php", data: `<?php\n// WPBakery\n/*\nPlugin Name: WPBakery Page Builder */\n`, stored: true },
    { name: "__MACOSX/js_composer/._js_composer.php", data: "x" },
  ]);
  expect(inspectPluginZip(other)).toMatchObject({ slug: "js_composer", name: "WPBakery Page Builder" });
});

test("a zip that would write outside its folder, or is not a plain plugin, is refused", () => {
  const refused: [string, Uint8Array][] = [
    ["leaves its folder", zip([{ name: "acme/acme.php", data: HEADER("A") }, { name: "acme/../../evil.php", data: "<?php" }])],
    ["leaves its folder", zip([{ name: "acme/acme.php", data: HEADER("A") }, { name: "acme/./x.php", data: "" }])],
    ["absolute path", zip([{ name: "/etc/cron.d/evil", data: "x" }])],
    ["absolute path", zip([{ name: "C:/evil.php", data: "x" }])],
    ["unusable name", zip([{ name: "acme\\..\\evil.php", data: "x" }])],
    ["unusable name", zip([{ name: "acme/a\nb.php", data: "x" }])],
    ["link or a special file", zip([{ name: "acme/acme.php", data: HEADER("A") }, { name: "acme/wp-config.php", data: "/home/other/wp-config.php", mode: 0o120777 }])],
    ["single folder", zip([{ name: "acme/acme.php", data: HEADER("A") }, { name: "other/other.php", data: HEADER("B") }])],
    ["single folder", zip([{ name: "acme.php", data: HEADER("A") }])],
    ["no WordPress plugin", zip([{ name: "acme/readme.txt", data: "Plugin Name: not PHP" }])],
    ["no WordPress plugin", zip([{ name: "acme/deep/acme.php", data: HEADER("Too deep") }])],
    ["encrypted", zip([{ name: "acme/acme.php", data: HEADER("A"), encrypted: true }])],
    ["directory is damaged", zip([{ name: "acme/acme.php", data: HEADER("A"), localName: "acme/other.php" }])],
    ["same file twice", zip([{ name: "acme/acme.php", data: HEADER("A") }, { name: "acme/acme.php", data: HEADER("B") }])],
    ["not a plain name", zip([{ name: "-rf/-rf.php", data: HEADER("A") }])],
    ["not a zip file", new TextEncoder().encode("<?php /* Plugin Name: not a zip */")],
  ];
  for (const [reason, bytes] of refused) expect(() => inspectPluginZip(bytes), reason).toThrow(reason);
  // An empty PHP file beside the main one is skipped, not taken for damage.
  expect(inspectPluginZip(zip([{ name: "acme/" }, { name: "acme/a-empty.php", data: "" }, { name: "acme/plugin.php", data: HEADER("Acme") }])).name).toBe("Acme");
  expect(() => inspectPluginZip(plugin(), 100)).toThrow("larger than");
});

// --- staging uploads -----------------------------------------------------

let root = "";
const uploads = () => join(root, "uploads");

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

test("an upload is staged part by part, in order, and only a plugin is kept", () => {
  root = mkdtempSync(join(tmpdir(), "clp-wp-upload-"));
  try {
    const bytes = plugin();
    const half = Math.ceil(bytes.byteLength / 2);
    const first = stageUploadPart(uploads(), { part: 0, last: false }, base64(bytes.subarray(0, half)));
    expect(first.id).toMatch(/^[a-f0-9]{32}$/);
    expect(() => stageUploadPart(uploads(), { id: first.id, part: 2, last: true }, base64(bytes.subarray(half)))).toThrow("out of order");
    const done = stageUploadPart(uploads(), { id: first.id, part: 1, last: true }, base64(bytes.subarray(half)));
    expect(done.upload).toMatchObject({ id: first.id, slug: "acme-payments", name: "Acme Payments" });
    // A finished upload takes no more parts.
    expect(() => stageUploadPart(uploads(), { id: first.id, part: 2, last: true }, base64(bytes))).toThrow("not in progress");

    // Not a plugin: refused, and nothing of it stays.
    const bad = zip([{ name: "evil/../../x.php", data: "<?php" }]);
    expect(() => stageUploadPart(uploads(), { part: 0, last: true }, base64(bad))).toThrow("leaves its folder");
    expect(readdirSync(uploads())).toEqual([first.id]);

    expect(() => stageUploadPart(uploads(), { part: 0, last: true }, "not base64!")).toThrow("not base64");
    expect(() => stageUploadPart(uploads(), { part: 0, last: true }, base64(new Uint8Array(UPLOAD_PART_BYTES + 1)))).toThrow("wrong size");
    expect(() => stageUploadPart(uploads(), { part: 1, last: true }, base64(bytes))).toThrow("starts with part 0");
    expect(() => stageUploadPart(uploads(), { id: "../../etc", part: 1, last: true }, base64(bytes))).toThrow("not an upload id");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an upload past 32 MB is dropped part-way", () => {
  root = mkdtempSync(join(tmpdir(), "clp-wp-upload-"));
  try {
    const part = base64(new Uint8Array(UPLOAD_PART_BYTES));
    let id = stageUploadPart(uploads(), { part: 0, last: false }, part).id;
    let index = 1;
    expect(() => {
      for (; index < 100; index++) id = stageUploadPart(uploads(), { id, part: index, last: false }, part).id;
    }).toThrow("at most 32 MB");
    expect(readdirSync(uploads())).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("waiting uploads are bounded, expire, and a claimed one belongs to its job", () => {
  root = mkdtempSync(join(tmpdir(), "clp-wp-upload-"));
  try {
    const ids = Array.from({ length: MAX_STAGED_UPLOADS }, () => stageUploadPart(uploads(), { part: 0, last: true }, base64(plugin())).id);
    expect(() => stageUploadPart(uploads(), { part: 0, last: true }, base64(plugin()))).toThrow("too many plugin uploads");
    expect(claimUploads(uploads(), [ids[0]!])).toMatchObject([{ id: ids[0], slug: "acme-payments" }]);
    expect(() => claimUploads(uploads(), [ids[0]!])).toThrow("no longer waiting");
    expect(discardUpload(uploads(), ids[0]!)).toBe(false);
    expect(discardUpload(uploads(), ids[1]!)).toBe(true);
    // Six hours later the unclaimed ones are gone; the claimed one waits two days for its job.
    expect(pruneUploads(uploads(), new Date(Date.now() + 7 * 3_600_000))).toBe(MAX_STAGED_UPLOADS - 2);
    expect(readdirSync(uploads())).toEqual([ids[0]!]);
    expect(pruneUploads(uploads(), new Date(Date.now() + 49 * 3_600_000))).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- WordPress.org --------------------------------------------------------

function directory(options: { link?: string; slug?: string; zipSlug?: string; status?: number } = {}) {
  const asked: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    asked.push({ url, init });
    if (url.startsWith("https://api.wordpress.org/")) {
      return Response.json({
        slug: options.slug ?? "woocommerce", name: "WooCommerce &amp; Friends", version: "9.3.3",
        download_link: options.link ?? "https://downloads.wordpress.org/plugin/woocommerce.9.3.3.zip",
      }, { status: options.status ?? 200 });
    }
    return new Response(plugin(options.zipSlug ?? "woocommerce", "WooCommerce"));
  };
  return { asked, fetchImpl };
}

test("a WordPress.org plugin comes from its API and its download host, and nowhere else", async () => {
  const ok = directory();
  const downloaded = await downloadDirectoryPlugin("woocommerce", ok.fetchImpl);
  expect(downloaded.name).toBe("WooCommerce & Friends");
  expect(ok.asked.map((call) => new URL(call.url).host)).toEqual(["api.wordpress.org", "downloads.wordpress.org"]);
  expect(new URL(ok.asked[0]!.url).searchParams.get("request[slug]")).toBe("woocommerce");
  // A redirect would be a way to another host.
  expect(ok.asked.every((call) => call.init?.redirect === "error")).toBe(true);

  await expect(downloadDirectoryPlugin("woocommerce", directory({ link: "https://evil.example/plugin/woocommerce.zip" }).fetchImpl)).rejects.toThrow("outside downloads.wordpress.org");
  await expect(downloadDirectoryPlugin("woocommerce", directory({ link: "http://downloads.wordpress.org/plugin/woocommerce.zip" }).fetchImpl)).rejects.toThrow("outside downloads.wordpress.org");
  await expect(downloadDirectoryPlugin("woocommerce", directory({ link: "https://downloads.wordpress.org.evil.example/plugin/w.zip" }).fetchImpl)).rejects.toThrow("outside downloads.wordpress.org");
  await expect(downloadDirectoryPlugin("woocommerce", directory({ slug: "other" }).fetchImpl)).rejects.toThrow("no plugin with that slug");
  await expect(downloadDirectoryPlugin("woocommerce", directory({ zipSlug: "other" }).fetchImpl)).rejects.toThrow("not the plugin that was chosen");
  await expect(downloadDirectoryPlugin("woocommerce", directory({ status: 404 }).fetchImpl)).rejects.toThrow("no plugin with that slug");
  for (const slug of ["../x", "Woo", "woo_commerce", "-woo", "woo-", "a b", "woo/../x", "x".repeat(101)]) {
    const never = directory();
    await expect(downloadDirectoryPlugin(slug, never.fetchImpl)).rejects.toThrow("not a WordPress.org plugin slug");
    expect(never.asked).toEqual([]);
  }
});

test("the directory search keeps only what the form shows, as text", async () => {
  const results = await searchDirectory("shop", async () => Response.json({ plugins: [
    { slug: "woocommerce", name: "WooCommerce", author: '<a href="https://woo.com/">Automattic</a>', active_installs: 7000000, short_description: "Sell <b>anything</b> &amp; more", version: "9.3.3" },
    { slug: "../evil", name: "Evil" },
    { slug: "EVIL", name: "Evil" },
    { name: "No slug" },
  ] }));
  expect(results).toEqual([{ slug: "woocommerce", name: "WooCommerce", version: "9.3.3", author: "Automattic", activeInstalls: 7000000, summary: "Sell anything & more" }]);
});

// --- the root action ------------------------------------------------------

let commands: WpCommand[];
let started: unknown[];
let installed: Record<string, Record<string, boolean>>;
let failing: Set<string>;
let fetched: string[];
let sleeps: number;
let onSleep: (() => void) | null;

function options(extra: Partial<WpToolsActionOptions> = {}): WpToolsActionOptions {
  return {
    processUid: 0,
    paths: {
      configFile: join(root, "wp-tools.conf"), panelDb: join(root, "panel.sq3"), passwd: join(root, "passwd"),
      lockFile: join(root, "wp.lock"), varnishState: join(root, "varnish.json"), varnishLockFile: join(root, "wp-varnish.lock"),
      mainwpState: join(root, "mainwp.json"), mainwpLockFile: join(root, "wp-mainwp.lock"),
      jobsDir: join(root, "jobs"), jobsLockFile: join(root, "wp-jobs.lock"), actionBinary: "/usr/local/bin/clp-addons",
      uploadsDir: uploads(), pluginsLockFile: join(root, "wp-plugins.lock"), newSiteAccessState: join(root, "new-site-access.json"),
    },
    startJob: (unit) => { started.push(unit); return { ok: true, stdout: "", stderr: "" }; },
    domainValidator: (domain) => domain.toLowerCase(),
    fetch: async (url) => {
      fetched.push(url);
      if (url.startsWith("https://api.wordpress.org/")) {
        const slug = new URL(url).searchParams.get("request[slug]")!;
        return Response.json({ slug, name: slug === "woocommerce" ? "WooCommerce" : slug, download_link: `https://downloads.wordpress.org/plugin/${slug}.zip` });
      }
      const slug = /\/plugin\/(.+)\.zip$/.exec(url)![1]!;
      return new Response(plugin(slug, slug));
    },
    waits: { siteMs: 60_000, wordpressMs: 60_000, pollMs: 1 },
    sleep: async () => { sleeps++; onSleep?.(); },
    runWpCommand: async (command) => {
      commands.push(command);
      const user = command.argv[2]!;
      const site = installed[user] ??= {};
      if (command.argv.includes("/bin/sh")) return "/tmp/tmp.AbCdEf1234";
      if (command.argv.includes("rm")) return "";
      if (command.argv.includes("is-installed")) return "";
      if (command.argv.includes("eval")) return `Notice: noise\nCLP-ADDONS-PLUGINS:${JSON.stringify({ multisite: false, plugins: site })}`;
      const install = command.argv.indexOf("install");
      if (install >= 0) {
        const slug = /\/([^/]+)\.zip$/.exec(command.argv[install + 1]!)![1]!;
        if (failing.has(slug)) throw new Error("WP-CLI failed: Error: could not unpack");
        site[slug] = command.argv.includes("--activate");
        return "Success";
      }
      const activate = command.argv.indexOf("activate");
      if (activate >= 0) { site[command.argv[activate + 1]!] = true; return "Success"; }
      throw new Error(`unexpected command ${command.argv.join(" ")}`);
    },
    ...extra,
  };
}

async function act<T = unknown>(argv: string[], extra: Partial<WpToolsActionOptions> = {}): Promise<T> {
  return await executeWpToolsAction(argv, options(extra)) as T;
}

function addSite(domain: string, user: string, createdAt = new Date().toISOString().slice(0, 19).replace("T", " "), wordpress = true): void {
  const db = new Database(join(root, "panel.sq3"));
  try {
    const id = (db.query("SELECT COUNT(*) AS n FROM site").get() as { n: number }).n + 1;
    db.run("INSERT INTO site VALUES (?, 'php', ?, ?, ?, 'WordPress', 0, ?)", [id, domain, domain, user, createdAt]);
    db.run("INSERT INTO php_settings VALUES (?, '8.3')", [id]);
  } finally {
    db.close();
  }
  const uid = 1100 + readdirSync(join(root, "home")).length;
  writeFileSync(join(root, "passwd"), `${user}:x:${uid}:${uid}::${join(root, "home", user)}:/bin/sh\n`, { flag: "a" });
  mkdirSync(join(root, "home", user, "htdocs", domain), { recursive: true });
  if (wordpress) for (const folder of ["wp-includes", "wp-content"]) mkdirSync(join(root, "home", user, "htdocs", domain, folder), { recursive: true });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clp-wp-new-site-"));
  writeFileSync(join(root, "wp-tools.conf"), "");
  writeFileSync(join(root, "passwd"), "");
  mkdirSync(join(root, "home"));
  commands = []; started = []; installed = {}; failing = new Set(); fetched = []; sleeps = 0; onSleep = null;
  const db = new Database(join(root, "panel.sq3"), { create: true });
  db.exec(`
    CREATE TABLE site (id INTEGER PRIMARY KEY, type TEXT, domain_name TEXT, root_directory TEXT, user TEXT, application TEXT, varnish_cache INTEGER, created_at TEXT);
    CREATE TABLE php_settings (site_id INTEGER, php_version TEXT);
    CREATE TABLE user (id INTEGER PRIMARY KEY, user_name TEXT, role TEXT, status INTEGER);
    CREATE TABLE event (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT, user_name TEXT, user_role TEXT, event_name TEXT, event_data TEXT);
    INSERT INTO user VALUES (1, 'admin', 'ROLE_ADMIN', 1), (2, 'mgr', 'ROLE_SITE_MANAGER', 1), (3, 'other-mgr', 'ROLE_SITE_MANAGER', 1),
      (4, 'client', 'ROLE_USER', 1), (5, 'gone', 'ROLE_SITE_MANAGER', 0);
  `);
  db.close();
  addSite("existing.example.com", "existing", "2026-01-01 00:00:00");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function upload(slug = "acme-payments", name = "Acme Payments"): string {
  return stageUploadPart(uploads(), { part: 0, last: true }, base64(plugin(slug, name))).upload!.id;
}

test("the gateway admits the plugin verbs and still no runner", () => {
  for (const verb of ["plugin-upload", "plugin-discard", "new-site", "new-site-status", "new-site-access", "new-site-settings"]) {
    expect((webVerb("wp-tools", verb) !== null)).toBe(true);
  }
  expect((webVerb("wp-tools", "run") !== null)).toBe(false);
});

test("the upload verb stages parts from stdin and refuses anything but its own arguments", async () => {
  const bytes = plugin();
  const reply = await act<{ id: string; upload: { slug: string } }>(["plugin-upload", "--part=0", "--last"], { input: base64(bytes) });
  expect(reply.upload.slug).toBe("acme-payments");
  for (const argv of [
    ["plugin-upload"], ["plugin-upload", "--part=0", "--path=/etc/passwd"], ["plugin-upload", "--upload=../x", "--part=1"],
    // Uploading is an administrator's: there is no way to say it is for anyone else.
    ["plugin-upload", "--part=0", "--last", "--as-user=mgr"], ["plugin-discard", `--upload=${"0".repeat(32)}`, "--as-user=mgr"],
  ]) {
    await expect(act(argv, { input: base64(bytes) })).rejects.toThrow();
  }
  rmSync(join(root, "wp-tools.conf"));
  await expect(act(["plugin-upload", "--part=0", "--last"], { input: base64(bytes) })).rejects.toThrow("must be enabled");
});

test("plugins are chosen only for a site that does not exist yet, by strict slug or by upload id", async () => {
  await expect(act(["new-site", "--domain=existing.example.com", "--plugins=woocommerce:1"])).rejects.toThrow("already has a site called existing.example.com");
  await expect(act(["new-site", "--domain=EXISTING.example.com", "--plugins=woocommerce:1"])).rejects.toThrow("already has a site");
  for (const plugins of ["../x:1", "Woo:1", "woocommerce", "woocommerce:yes", "woo commerce:1"]) {
    await expect(act(["new-site", "--domain=new.example.com", `--plugins=${plugins}`])).rejects.toThrow("not a valid");
  }
  await expect(act(["new-site", "--domain=new.example.com", `--plugins=${Array.from({ length: 21 }, (_, i) => `p${i}:1`).join(",")}`])).rejects.toThrow("at most 20");
  await expect(act(["new-site", "--domain=new.example.com", `--uploads=${"0".repeat(32)}:1`])).rejects.toThrow("no longer waiting");
  await expect(act(["new-site", "--domain=new.example.com", "--plugins=acme-payments:1", `--uploads=${upload()}:1`])).rejects.toThrow("chosen twice");
  await expect(act(["start", "--task=new-site-plugins", "--domains=new.example.com"])).rejects.toThrow("choose a job");
  expect(started).toEqual([]);

  const id = upload();
  const { job } = await act<{ job: WpJobView }>(["new-site", "--domain=New.Example.com", "--plugins=woocommerce:1,contact-form-7:0", `--uploads=${id}:0`]);
  expect(job).toMatchObject({ task: "new-site-plugins", policy: "plugins", domains: ["new.example.com"], state: "queued" });
  // Directory plugins first, so an uploaded add-on finds what it extends.
  expect(job.plugins).toEqual([
    { source: "wordpress.org", slug: "woocommerce", name: "woocommerce", activate: true },
    { source: "wordpress.org", slug: "contact-form-7", name: "contact-form-7", activate: false },
    { source: "upload", slug: "acme-payments", name: "Acme Payments", activate: false, upload: id },
  ]);
  expect(started).toHaveLength(1);
  expect(() => claimUploads(uploads(), [id])).toThrow("no longer waiting");
});

async function runJob(id: string, extra: Partial<WpToolsActionOptions> = {}): Promise<WpJobView> {
  await act(["run", "--job", id], extra);
  return wpJobView(join(root, "jobs"), id)!;
}

test("the job waits for the site and for WordPress, then installs each plugin as the site's user", async () => {
  const id = upload();
  const { job } = await act<{ job: WpJobView }>(["new-site", "--domain=new.example.com", "--plugins=woocommerce:1,akismet:1", `--uploads=${id}:0`]);
  // CloudPanel creates the site a little after the form is submitted, and WordPress a little after that.
  onSleep = () => {
    if (sleeps === 2) addSite("new.example.com", "newsite", undefined, false);
    if (sleeps === 4) for (const folder of ["wp-includes", "wp-content"]) mkdirSync(join(root, "home", "newsite", "htdocs", "new.example.com", folder));
  };
  installed.newsite = { akismet: false };
  const done = await runJob(job.id);
  expect(done.state).toBe("done");
  expect(done.result).toEqual({
    outcome: "done",
    plugins: [
      { source: "wordpress.org", slug: "woocommerce", name: "WooCommerce", activate: true, status: "activated", error: "" },
      // Shipped with WordPress: left in place and activated as asked.
      { source: "wordpress.org", slug: "akismet", name: "akismet", activate: true, status: "present", error: "" },
      { source: "upload", slug: "acme-payments", name: "Acme Payments", activate: false, status: "installed", error: "" },
    ],
  } satisfies NewSiteResult);
  expect(installed.newsite).toEqual({ akismet: true, woocommerce: true, "acme-payments": false });
  // Akismet was already there: nothing fetched for it.
  expect(fetched.map((url) => new URL(url).host)).toEqual(["api.wordpress.org", "downloads.wordpress.org"]);

  for (const command of commands) {
    expect(command.argv.slice(0, 4)).toEqual(["/usr/sbin/runuser", "-u", "newsite", "--"]);
    expect(command.cwd).toBe("/");
    expect(Object.keys(command.env).sort()).toEqual(command.argv.includes("--path=" + join(root, "home", "newsite", "htdocs", "new.example.com"))
      ? ["HOME", "PATH", "WP_CLI_CONFIG_PATH"] : ["HOME", "PATH"]);
  }
  // The zip goes to the site's user on stdin, into a directory it makes, and that directory goes after.
  const staged = commands.filter((command) => command.argv.includes("/bin/sh"));
  expect(staged).toHaveLength(2);
  expect(staged.every((command) => command.stdinBytes && inspectPluginZip(command.stdinBytes).slug)).toBe(true);
  const install = commands.filter((command) => command.argv.includes("install")).map((command) => command.argv.slice(command.argv.indexOf("plugin")));
  expect(install).toEqual([
    ["plugin", "install", "/tmp/tmp.AbCdEf1234/woocommerce.zip", "--activate"],
    ["plugin", "install", "/tmp/tmp.AbCdEf1234/acme-payments.zip"],
  ]);
  expect(commands.filter((command) => command.argv.includes("rm")).map((command) => command.argv.slice(4))).toEqual([
    ["rm", "-rf", "--", "/tmp/tmp.AbCdEf1234"], ["rm", "-rf", "--", "/tmp/tmp.AbCdEf1234"],
  ]);
  // The job's upload is gone once the job is.
  expect(existsSync(join(uploads(), id))).toBe(false);
});

test("one plugin failing does not stop the rest, and the result says which and why", async () => {
  failing.add("broken");
  const { job } = await act<{ job: WpJobView }>(["new-site", "--domain=new.example.com", "--plugins=broken:1,woocommerce:1"]);
  addSite("new.example.com", "newsite");
  const done = await runJob(job.id);
  const result = done.result as NewSiteResult;
  expect(result.plugins.map((plugin) => [plugin.slug, plugin.status])).toEqual([["broken", "failed"], ["woocommerce", "activated"]]);
  expect(result.plugins[0]!.error).toContain("could not unpack");
});

test("a site that existed before the plugins were chosen is left alone", async () => {
  const { job } = await act<{ job: WpJobView }>(["new-site", "--domain=new.example.com", "--plugins=woocommerce:1"]);
  addSite("new.example.com", "newsite", "2025-06-01 10:00:00");
  const done = await runJob(job.id);
  expect(done.state).toBe("failed");
  expect(done.error).toContain("existed before its plugins were chosen");
  expect(commands).toEqual([]);
});

test("a form CloudPanel sent back ends its job quietly, and a resubmission takes over its uploads", async () => {
  const id = upload();
  const first = (await act<{ job: WpJobView }>(["new-site", "--domain=new.example.com", `--uploads=${id}:1`])).job;
  // Another domain's waiting job is never touched: it may be a site CloudPanel is still creating.
  const elsewhere = (await act<{ job: WpJobView }>(["new-site", "--domain=other.example.com", "--plugins=woocommerce:1"])).job;
  // Submitted again for the same domain, with the same upload.
  const second = (await act<{ job: WpJobView }>(["new-site", "--domain=new.example.com", `--uploads=${id}:1`, "--plugins=contact-form-7:1"])).job;
  expect(jobGet(jobDir(join(root, "jobs"), elsewhere.id), "superseded")).toBe("");
  expect(jobGet(jobDir(join(root, "jobs"), first.id), "superseded")).toBe("1");
  const replaced = await runJob(first.id);
  expect(replaced.result).toEqual({ outcome: "superseded", plugins: [] });
  // The upload is the second job's now, and still there.
  expect(existsSync(join(uploads(), id))).toBe(true);

  // No site of that name ever appears: nothing is installed, and the upload goes.
  const lapsed = await runJob(second.id, { waits: { siteMs: 0, wordpressMs: 0, pollMs: 1 } });
  expect(lapsed.result).toEqual({ outcome: "not-created", plugins: [] });
  expect(existsSync(join(uploads(), id))).toBe(false);
  expect(commands).toEqual([]);
});

test("a job that found its site is not replaced", async () => {
  const { job } = await act<{ job: WpJobView }>(["new-site", "--domain=new.example.com", "--plugins=woocommerce:1"]);
  jobSet(jobDir(join(root, "jobs"), job.id), "phase", "installing");
  await act(["new-site", "--domain=new.example.com", "--plugins=woocommerce:1"]);
  expect(jobGet(jobDir(join(root, "jobs"), job.id), "superseded")).toBe("");
});

test("submitted again with every plugin removed, the earlier choice is cleared and its uploads deleted", async () => {
  const id = upload();
  const { job } = await act<{ job: WpJobView }>(["new-site", "--domain=new.example.com", "--plugins=woocommerce:1", `--uploads=${id}:1`]);
  expect(await act<{ job: WpJobView | null }>(["new-site", "--domain=new.example.com"])).toEqual({ job: null });
  expect(jobGet(jobDir(join(root, "jobs"), job.id), "superseded")).toBe("1");
  expect(existsSync(join(uploads(), id))).toBe(false);
  expect(started).toHaveLength(1);
  // Clearing names no plugin, so it is refused for no site, existing or not.
  expect(await act<{ job: WpJobView | null }>(["new-site", "--domain=existing.example.com"])).toEqual({ job: null });
  const cleared = await runJob(job.id);
  expect(cleared.result).toEqual({ outcome: "superseded", plugins: [] });
  expect(commands).toEqual([]);
});

test("a site CloudPanel recorded no creation time for is left alone", async () => {
  const { job } = await act<{ job: WpJobView }>(["new-site", "--domain=new.example.com", "--plugins=woocommerce:1"]);
  addSite("new.example.com", "newsite", "");
  const done = await runJob(job.id);
  expect(done.error).toContain("no creation time");
  expect(commands).toEqual([]);
});

test("every running new-site job is listed, however many finished ones there are", async () => {
  for (let i = 0; i < 12; i++) await act(["new-site", `--domain=site${i}.example.com`, "--plugins=woocommerce:1"]);
  const { newSiteJobs } = await import("../addons/wp-tools/jobs");
  expect(newSiteJobs(join(root, "jobs"))).toHaveLength(12);
});

test("the WordPress Tools page lists what new sites' jobs did, and not the forms that were sent back", async () => {
  const kept = (await act<{ job: WpJobView }>(["new-site", "--domain=new.example.com", "--plugins=woocommerce:1"])).job;
  addSite("new.example.com", "newsite");
  await runJob(kept.id);
  const lapsed = (await act<{ job: WpJobView }>(["new-site", "--domain=gone.example.com", "--plugins=woocommerce:1"])).job;
  await runJob(lapsed.id, { waits: { siteMs: 0, wordpressMs: 0, pollMs: 1 } });
  const sites = await act<{ newSites: WpJobView[]; jobs: { varnish: unknown; mainwp: unknown } }>(["sites"]);
  expect(sites.newSites.map((job) => job.domains[0])).toEqual(["new.example.com"]);
  expect(sites.jobs).toEqual({ varnish: null, mainwp: null });
});

test("repair's upkeep drops uploads no form claimed", async () => {
  const id = upload();
  const old = new Date(Date.now() - 7 * 3_600_000);
  writeFileSync(join(uploads(), id, "meta.json"), JSON.stringify({ createdAt: old.toISOString(), parts: 1, received: 1, plugin: { slug: "a", name: "A", version: "", size: 1 } }));
  utimesSync(join(uploads(), id), old, old);
  const { pruneWpJobs } = await import("../addons/wp-tools/action");
  pruneWpJobs(options());
  expect(existsSync(join(uploads(), id))).toBe(false);
});

// --- site managers --------------------------------------------------------

async function allowSiteManagers(on: boolean): Promise<void> {
  expect(await act<{ newSiteAccess: { siteManagers: boolean } }>(["new-site-settings", `--site-managers=${on}`])).toEqual({ newSiteAccess: { siteManagers: on } });
}

test("a site manager chooses only while an administrator allows it, and only as one", async () => {
  // Off when never set.
  await expect(act(["new-site", "--domain=new.example.com", "--plugins=woocommerce:1", "--as-user=mgr"])).rejects.toThrow("has not let site managers");
  await expect(act(["new-site-access", "--as-user=mgr"])).rejects.toThrow("has not let site managers");
  expect(await act<{ uploads: boolean }>(["new-site-access"])).toEqual({ uploads: true });
  await allowSiteManagers(true);
  expect(await act<{ uploads: boolean }>(["new-site-access", "--as-user=mgr"])).toEqual({ uploads: false });
  const { job } = await act<{ job: WpJobView }>(["new-site", "--domain=new.example.com", "--plugins=woocommerce:1", "--as-user=mgr"]);
  expect(job.chosenBy).toBe("mgr");
  // CloudPanel's own record of the account decides, not the session that named it.
  for (const user of ["client", "gone", "nobody"]) {
    await expect(act(["new-site", "--domain=other.example.com", "--plugins=woocommerce:1", `--as-user=${user}`])).rejects.toThrow("only administrators and site managers");
  }
  await expect(act(["new-site", "--domain=other.example.com", "--plugins=woocommerce:1", "--as-user=bad name"])).rejects.toThrow("not a valid panel user name");
  await allowSiteManagers(false);
  await expect(act(["new-site", "--domain=other.example.com", "--plugins=woocommerce:1", "--as-user=mgr"])).rejects.toThrow("has not let site managers");
  await expect(act(["new-site-settings", "--site-managers=true", "--as-user=mgr"])).rejects.toThrow("--site-managers=true|false");
});

test("a site manager cannot upload, and cannot reach a site that exists", async () => {
  await allowSiteManagers(true);
  const id = upload();
  await expect(act(["new-site", "--domain=new.example.com", `--uploads=${id}:1`, "--as-user=mgr"])).rejects.toThrow("only an administrator can upload");
  await expect(act(["new-site", "--domain=new.example.com", "--plugins=woocommerce:1", `--uploads=${id}:1`, "--as-user=mgr"])).rejects.toThrow("only an administrator can upload");
  // The upload is still the administrator's to use.
  expect(claimUploads(uploads(), [id])).toHaveLength(1);
  await expect(act(["new-site", "--domain=existing.example.com", "--plugins=woocommerce:1", "--as-user=mgr"])).rejects.toThrow("already has a site called existing.example.com");
  expect(started).toEqual([]);
});

test("a site manager replaces and clears only their own choices", async () => {
  await allowSiteManagers(true);
  const admins = (await act<{ job: WpJobView }>(["new-site", "--domain=new.example.com", "--plugins=woocommerce:1"])).job;
  const others = (await act<{ job: WpJobView }>(["new-site", "--domain=new.example.com", "--plugins=akismet:1", "--as-user=other-mgr"])).job;
  const mine = (await act<{ job: WpJobView }>(["new-site", "--domain=new.example.com", "--plugins=contact-form-7:1", "--as-user=mgr"])).job;
  const superseded = (id: string) => jobGet(jobDir(join(root, "jobs"), id), "superseded");
  expect([superseded(admins.id), superseded(others.id)]).toEqual(["", ""]);
  expect(await act<{ job: WpJobView | null }>(["new-site", "--domain=new.example.com", "--as-user=mgr"])).toEqual({ job: null });
  expect([superseded(admins.id), superseded(others.id), superseded(mine.id)]).toEqual(["", "", "1"]);
  // An administrator's choice replaces anyone's.
  await act(["new-site", "--domain=new.example.com"]);
  expect([superseded(admins.id), superseded(others.id)]).toEqual(["1", "1"]);
});

test("a site manager is told the status of their own choice and of nothing else", async () => {
  await allowSiteManagers(true);
  const id = upload();
  const admins = (await act<{ job: WpJobView }>(["new-site", "--domain=a.example.com", `--uploads=${id}:1`])).job;
  const others = (await act<{ job: WpJobView }>(["new-site", "--domain=b.example.com", "--plugins=akismet:1", "--as-user=other-mgr"])).job;
  const mine = (await act<{ job: WpJobView }>(["new-site", "--domain=c.example.com", "--plugins=akismet:1", "--as-user=mgr"])).job;
  const status = await act<{ job: Record<string, unknown> }>(["new-site-status", `--job=${mine.id}`, "--as-user=mgr"]);
  expect(Object.keys(status.job).sort()).toEqual(["completed", "domain", "error", "id", "result", "site", "state", "step", "total"]);
  expect(status.job).toMatchObject({ id: mine.id, domain: "c.example.com", state: "queued" });
  for (const id of [admins.id, others.id]) await expect(act(["new-site-status", `--job=${id}`, "--as-user=mgr"])).rejects.toThrow("no such job");
  await expect(act(["new-site-status", `--job=${mine.id}`, "--as-user=client"])).rejects.toThrow("no such job");
  // An administrator sees any, still without the upload ids the plan holds.
  const admin = await act<{ job: unknown }>(["new-site-status", `--job=${admins.id}`]);
  expect(JSON.stringify(admin)).not.toContain(id);
  await expect(act(["new-site-status", "--job=../../etc"])).rejects.toThrow("takes --job");
});

test("the setting is the administrator's page's, and an unreadable one reads as off", async () => {
  await allowSiteManagers(true);
  const sites = await act<{ newSiteAccess: { siteManagers: boolean }; newSiteAccessError: string }>(["sites"]);
  expect(sites).toMatchObject({ newSiteAccess: { siteManagers: true }, newSiteAccessError: "" });
  writeFileSync(join(root, "new-site-access.json"), "{");
  const broken = await act<{ newSiteAccess: { siteManagers: boolean }; newSiteAccessError: string }>(["sites"]);
  expect(broken.newSiteAccess.siteManagers).toBe(false);
  expect(broken.newSiteAccessError).toContain("cannot be read");
  await expect(act(["new-site", "--domain=new.example.com", "--plugins=woocommerce:1", "--as-user=mgr"])).rejects.toThrow("cannot be read");
});

/** What CloudPanel's event log records when an account creates a WordPress site. */
function logCreation(domain: string, user: string, at = new Date()): void {
  const db = new Database(join(root, "panel.sq3"));
  try {
    db.run("INSERT INTO event (created_at, user_name, user_role, event_name, event_data) VALUES (?, ?, 'ROLE_SITE_MANAGER', 'SITE_WORDPRESS_CREATE', ?)",
      [at.toISOString().slice(0, 19).replace("T", " "), user, JSON.stringify({ site: domain, siteUser: "x" })]);
  } finally {
    db.close();
  }
}

test("a site manager's plugins go only into a site that account created", async () => {
  await allowSiteManagers(true);
  // Someone else made a site of that name before the choice, in the same second; it does not count.
  logCreation("new.example.com", "other-mgr");
  const { job } = await act<{ job: WpJobView }>(["new-site", "--domain=new.example.com", "--plugins=woocommerce:1", "--as-user=mgr"]);
  addSite("new.example.com", "newsite");
  // CloudPanel logs the creation a little after the site appears; the job waits for it.
  onSleep = () => { if (sleeps === 2) logCreation("New.Example.com", "mgr"); };
  const done = await runJob(job.id);
  expect(done.state).toBe("done");
  expect(sleeps).toBeGreaterThanOrEqual(2);
  expect((done.result as NewSiteResult).plugins.map((plugin) => plugin.status)).toEqual(["activated"]);
});

test("a site manager's plugins are not installed into a site another account created", async () => {
  await allowSiteManagers(true);
  // The manager's own earlier creation of that name, logged just before the choice, is not this site's.
  logCreation("new.example.com", "mgr");
  const { job } = await act<{ job: WpJobView }>(["new-site", "--domain=new.example.com", "--plugins=woocommerce:1", "--as-user=mgr"]);
  addSite("new.example.com", "newsite");
  logCreation("new.example.com", "admin");
  const done = await runJob(job.id);
  expect(done.state).toBe("failed");
  expect(done.error).toContain("was created by another account");
  expect(commands).toEqual([]);
  // An administrator's choice is not held to it.
  const admins = (await act<{ job: WpJobView }>(["new-site", "--domain=fresh.example.com", "--plugins=woocommerce:1"])).job;
  addSite("fresh.example.com", "fresh");
  logCreation("fresh.example.com", "mgr");
  expect((await runJob(admins.id)).state).toBe("done");
});

test("a site manager whose site's creation CloudPanel never logs gets nothing installed", async () => {
  await allowSiteManagers(true);
  // Only an entry from before the choice, which does not count.
  logCreation("new.example.com", "mgr");
  const { job } = await act<{ job: WpJobView }>(["new-site", "--domain=new.example.com", "--plugins=woocommerce:1", "--as-user=mgr"]);
  addSite("new.example.com", "newsite");
  const done = await runJob(job.id, { waits: { siteMs: 60_000, wordpressMs: 0, pollMs: 1 } });
  expect(done.error).toContain("CloudPanel has not recorded who created it");
  expect(commands).toEqual([]);
});

// --- the manager's routes -------------------------------------------------

const originals = { ...wpToolsService };
afterEach(() => Object.assign(wpToolsService, originals));

const userOf = (roles: string[]) => roles.includes("ROLE_ADMIN") ? "admin" : roles.includes("ROLE_SITE_MANAGER") ? "mgr" : "someone";

function post(path: string, body: string | Uint8Array, roles = ["ROLE_ADMIN"], type = "application/json") {
  const csrf = "a".repeat(64);
  return handle(new Request(`https://panel.example.com/addons/wp-tools${path}`, {
    method: "POST", body,
    headers: { Host: "panel.example.com", Origin: "https://panel.example.com", Cookie: `clp_addons_csrf=${csrf}`, "X-CLP-Addons-CSRF": csrf, "Content-Type": type },
  }), path, undefined, undefined, { user: userOf(roles), roles });
}

function get(path: string, roles: string[]) {
  return handle(new Request(`https://panel.example.com/addons/wp-tools${path}`), path.split("?")[0]!, undefined, undefined, { user: userOf(roles), roles });
}

test("a panel user may not search, upload or choose plugins, even past the manager's gate", async () => {
  const called: string[] = [];
  wpToolsService.uploadPlugin = async () => { called.push("upload"); return { ok: true }; };
  wpToolsService.newSite = async () => { called.push("new-site"); return { ok: true }; };
  wpToolsService.discardUpload = async () => { called.push("discard"); return { ok: true }; };
  wpToolsService.newSiteStatus = async () => { called.push("status"); return { ok: true }; };
  wpToolsService.newSiteAccess = async () => { called.push("access"); return { ok: true }; };
  wpToolsService.newSiteSettings = async () => { called.push("settings"); return { ok: true }; };
  const roles = ["ROLE_USER"];
  expect((await post("/api/plugin-upload", plugin(), roles, "application/octet-stream")).status).toBe(404);
  expect((await post("/api/new-site", JSON.stringify({ domain: "new.example.com", plugins: [{ slug: "woocommerce", activate: true }] }), roles)).status).toBe(404);
  expect((await post("/api/plugin-discard", JSON.stringify({ id: "0".repeat(32) }), roles)).status).toBe(404);
  expect((await post("/api/new-site-settings", JSON.stringify({ siteManagers: true }), roles)).status).toBe(404);
  expect((await get("/api/plugin-search?q=woo", roles)).status).toBe(404);
  expect((await get(`/api/new-site-status?job=20261029T192025Z-4a8d82`, roles)).status).toBe(404);
  expect(called).toEqual([]);
});

test("a site manager chooses WordPress.org plugins on their own account's behalf, and nothing else", async () => {
  const called: unknown[] = [];
  wpToolsService.uploadPlugin = async () => { called.push("upload"); return { ok: true }; };
  wpToolsService.discardUpload = async () => { called.push("discard"); return { ok: true }; };
  wpToolsService.newSiteSettings = async () => { called.push("settings"); return { ok: true }; };
  wpToolsService.newSite = async (choice) => { called.push(choice); return { ok: true, data: { job: null } }; };
  wpToolsService.newSiteStatus = async (id, asUser) => { called.push(["status", id, asUser]); return { ok: true }; };
  wpToolsService.newSiteAccess = async (asUser) => { called.push(["access", asUser]); return { ok: false, error: "an administrator has not let site managers choose plugins for new sites" }; };
  const roles = ["ROLE_SITE_MANAGER"];
  expect((await post("/api/plugin-upload", plugin(), roles, "application/octet-stream")).status).toBe(404);
  expect((await post("/api/plugin-discard", JSON.stringify({ id: "0".repeat(32) }), roles)).status).toBe(404);
  expect((await post("/api/new-site-settings", JSON.stringify({ siteManagers: true }), roles)).status).toBe(404);
  const withUpload = await post("/api/new-site", JSON.stringify({ domain: "new.example.com", uploads: [{ id: "0".repeat(32), activate: true }] }), roles);
  expect(withUpload.status).toBe(403);
  expect(called).toEqual([]);
  expect((await post("/api/new-site", JSON.stringify({ domain: "new.example.com", plugins: [{ slug: "woocommerce", activate: true }] }), roles)).status).toBe(200);
  expect((await get("/api/new-site-status?job=20261029T192025Z-4a8d82", roles)).status).toBe(200);
  // The search asks root first, and does not run while the switch is off.
  expect((await get("/api/plugin-search?q=woo", roles)).status).toBe(403);
  expect(called).toEqual([
    { domain: "new.example.com", plugins: [{ slug: "woocommerce", activate: true }], uploads: [], asUser: "mgr" },
    ["status", "20261029T192025Z-4a8d82", "mgr"],
    ["access", "mgr"],
  ]);
});

test("saving who may choose renders CloudPanel's templates again", async () => {
  const called: unknown[] = [];
  wpToolsService.newSiteSettings = async (on) => { called.push(["settings", on]); return { ok: true, data: { newSiteAccess: { siteManagers: on } } }; };
  wpToolsService.renderPanelTemplates = async () => { called.push("render"); return { ok: false, error: "the panel's templates changed" }; };
  const response = await post("/api/new-site-settings", JSON.stringify({ siteManagers: true }));
  expect(response.status).toBe(500);
  expect(((await response.json()) as { error: string }).error).toContain("Saved, but CloudPanel's new-site form still shows the old choice");
  expect(called).toEqual([["settings", true], "render"]);
  expect((await post("/api/new-site-settings", JSON.stringify({ siteManagers: "yes" }))).status).toBe(400);
});

test("the new-site route checks the choice before root sees it", async () => {
  const sent: unknown[] = [];
  wpToolsService.newSite = async (choice) => { sent.push(choice); return { ok: true, data: { job: {} as WpJobView } }; };
  const refused: [unknown, string][] = [
    [{ domain: "", plugins: [{ slug: "woocommerce", activate: true }] }, "domain name"],
    [{ domain: "new.example.com", plugins: [{ slug: "../x", activate: true }] }, "slug"],
    [{ domain: "new.example.com", plugins: [{ slug: "woocommerce", activate: "yes" }] }, "slug"],
    [{ domain: "new.example.com", uploads: [{ id: "/etc/passwd", activate: true }] }, "upload it again"],
    [{ domain: "new.example.com", plugins: Array.from({ length: 21 }, () => ({ slug: "woocommerce", activate: true })) }, "at most 20"],
  ];
  for (const [body, error] of refused) {
    const response = await post("/api/new-site", JSON.stringify(body));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(error);
  }
  expect(sent).toEqual([]);
  expect((await post("/api/new-site", JSON.stringify({ domain: " New.Example.com ", plugins: [{ slug: "woocommerce", activate: false }] }))).status).toBe(200);
  expect(sent).toEqual([{ domain: "new.example.com", plugins: [{ slug: "woocommerce", activate: false }], uploads: [] }]);
  // No plugins at all clears an earlier choice; root decides what that touches.
  expect((await post("/api/new-site", JSON.stringify({ domain: "new.example.com", plugins: [], uploads: [] }))).status).toBe(200);
  expect(sent[1]).toEqual({ domain: "new.example.com", plugins: [], uploads: [] });
});

test("an upload over 32 MB is refused before root sees any of it", async () => {
  let called = false;
  wpToolsService.uploadPlugin = async () => { called = true; return { ok: true }; };
  const response = await post("/api/plugin-upload", new Uint8Array(32 * 1024 * 1024 + 1), ["ROLE_ADMIN"], "application/octet-stream");
  expect(response.status).toBe(413);
  expect(called).toBe(false);
});

test("an upload travels to root in parts the gateway accepts", async () => {
  const { MAX_GATEWAY_INPUT_BYTES } = await import("../lib/gateway-protocol");
  // A part's base64 and its JSON request line stay under the gateway's limit.
  expect(Math.ceil(UPLOAD_PART_BYTES / 3) * 4 + 1024).toBeLessThan(MAX_GATEWAY_INPUT_BYTES);
});

// --- what goes into CloudPanel's pages ------------------------------------

test("the new-site blocks are for administrators, and site managers only while allowed, submit no field of their own, and parse", () => {
  for (const managers of [false, true]) {
    for (const block of [newSiteFormSnippet("/addons/wp-tools", managers), newSiteDoneSnippet("/addons/wp-tools", managers)]) {
      expect(block.trim().startsWith(managers
        ? "{% if is_granted('ROLE_ADMIN') or is_granted('ROLE_SITE_MANAGER') %}"
        : "{% if is_granted('ROLE_ADMIN') %}")).toBe(true);
      expect(block.trim().endsWith("{% endif %}")).toBe(true);
      expect(block).not.toMatch(/<(?:input|select|textarea)[^>]*\sname=/);
      for (const source of block.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new Function(source[1]!)).not.toThrow();
    }
    // The upload control is an administrator's whatever the switch says.
    expect(newSiteFormSnippet("/addons/wp-tools", managers)).toMatch(/\{% if is_granted\('ROLE_ADMIN'\) %\}<label[^{]*id="clp-wp-plugin-file"[^{]*\{% endif %\}/);
  }
  // What the form's script calls is what the handler answers.
  const form = newSiteFormSnippet("/addons/wp-tools", true);
  for (const route of ["/api/plugin-search", "/api/plugin-upload", "/api/plugin-discard", "/api/new-site", "/api/session"]) {
    expect(form).toContain(`'${route}`);
  }
  expect(newSiteDoneSnippet("/addons/wp-tools", true)).toContain("'/api/new-site-status?job='");
  // Only an administrator's landing page links to WordPress Tools' own page.
  expect(newSiteDoneSnippet("/addons/wp-tools", true)).toContain("{% if is_granted('ROLE_ADMIN') %} data-admin{% endif %}");
  expect(newSiteDoneSnippet("/addons/wp-tools", true)).toContain("ask an administrator");
  const targets = WP_TOOLS_TARGETS.filter((target) => target.slug.startsWith("new-site"));
  expect(targets.map((target) => [target.template, target.required])).toEqual([
    ["Frontend/Site/New/wordpress.html.twig", false],
    ["Frontend/Site/New/wordpress-installed.html.twig", false],
  ]);
});

test("Create waits for an upload still in progress, even when it is the only plugin chosen", () => {
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const node = (): any => ({
    hidden: false, textContent: "", value: "", style: {}, files: [] as unknown[],
    classList: { add() {}, remove() {} },
    addEventListener: (type: string, fn: (event: unknown) => void) => { (listeners[type] ??= []).push(fn); },
    appendChild() {}, setAttribute() {}, getAttribute: () => "/addons/wp-tools", querySelectorAll: () => [],
  });
  const form = node();
  const domain = Object.assign(node(), { value: "new.example.test" });
  form.querySelector = () => domain;
  const nodes: Record<string, any> = Object.fromEntries(
    ["clp-wp-plugins", "clp-wp-plugin-search", "clp-wp-plugin-results", "clp-wp-plugin-chosen", "clp-wp-plugin-file", "clp-wp-plugins-error"].map((id) => [id, node()]),
  );
  nodes["clp-wp-plugins"].closest = () => form;
  const document = {
    cookie: "clp_addons_csrf=token", getElementById: (id: string) => nodes[id], createElement: node,
    addEventListener: (type: string, fn: (event: unknown) => void) => { (listeners[`document ${type}`] ??= []).push(fn); },
  };
  const storage = new Map<string, string>([["clp-addons-new-site-job", JSON.stringify({ domain: "old.example.test", id: "j1" })]]);
  const sessionStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) };
  const fetched: string[] = [];
  const fetch = (url: string) => { fetched.push(url); return new Promise(() => {}); };
  const source = readFileSync(join(import.meta.dir, "../addons/wp-tools/inject/new-site.client.js"), "utf8");
  new Function("document", "sessionStorage", "fetch", source)(document, sessionStorage, fetch);

  nodes["clp-wp-plugin-file"].files = [{ name: "big.zip", size: 1024 }];
  for (const fn of listeners.change!) fn({});
  let stopped = 0;
  const submit = { target: form, preventDefault: () => { stopped++; }, stopImmediatePropagation: () => { stopped++; } };
  for (const fn of listeners["document submit"]!) fn(submit);
  expect(stopped).toBe(2);
  expect(nodes["clp-wp-plugins-error"].textContent).toBe("Wait for the upload to finish, then create the site.");
  expect(storage.has("clp-addons-new-site-job")).toBe(true);
  expect(fetched.some((url) => url.endsWith("/api/new-site"))).toBe(false);
});
