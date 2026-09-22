import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeWpLoginAction, WP_LOGIN_FIELD, WORDPRESS_APPLICATIONS,
  type WpLoginActionOptions, type WpLoginResult, type WpRemoveResult, type WpSiteView,
} from "../addons/wp-login/action";
import { WP_LOGIN_TARGETS } from "../addons/wp-login/inject/targets";
import { ROW_ACTION_CLASS } from "../lib/row-actions";

const scriptTarget = WP_LOGIN_TARGETS.find((target) => target.slug === "sites-script")!;
const linkTarget = WP_LOGIN_TARGETS.find((target) => target.slug === "sites-action")!;

// --- what goes into CloudPanel's own page ---------------------------------

test("the link is per-site Twig for every role, and the script is emitted once", () => {
  // The action cell is inside the template's site loop, so the condition can be
  // Twig and the script cannot: it would be repeated for every row.
  // Before Manage, so the panel's own primary action keeps the rightmost place.
  expect(linkTarget.anchorBefore).toContain("Manage");
  expect(scriptTarget.anchorBefore).toBe('<div class="card card-table">');
  expect(linkTarget.template).toBe(scriptTarget.template);

  const link = linkTarget.snippet("/addons/wp-login");
  // Not administrator-only: CloudPanel lists a ROLE_USER only their own sites,
  // and the sign-in action checks the mapping again as root.
  expect(link).not.toContain("is_granted");
  expect(link).toContain("{{ site.domainName }}");
  // Marked, so Panel Tweaks' menu can put the panel's own actions above it.
  expect(link).toContain(ROW_ACTION_CLASS);
  for (const application of WORDPRESS_APPLICATIONS) expect(link).toContain(`'${application}'`);

  const script = scriptTarget.snippet("/addons/wp-login");
  expect(script).not.toContain("is_granted");
  expect(script).toContain("/addons/wp-login/api/sign-in");
  // The page belongs to CloudPanel, so the token has to be fetched rather than
  // assumed: a non-administrator has no addon page to have been given one by.
  expect(script).toContain("/addons/wp-login/api/session");
  // One listener on the document: the rows belong to the panel, and a filtered
  // or re-sorted table moves them out from under a per-row listener.
  expect(script).toContain('document.addEventListener("click"');
});

// Neither block may stop an install: the addon's own page signs in to the same
// sites whether or not CloudPanel's markup still matches.
test("neither block is required", () => {
  for (const target of WP_LOGIN_TARGETS) expect(target.required).toBe(false);
});

// The blocks are rendered by Twig before a browser sees them, and Twig reads
// `{{`, `{%` and `{#` wherever they appear -- including inside a <script>.
test("nothing in the script is markup Twig would take for its own", () => {
  const body = scriptTarget.snippet("/addons/wp-login");
  for (const sequence of ["{{", "{%", "{#"]) expect(body).not.toContain(sequence);
});

// --- the privileged action ------------------------------------------------

let root = "";

function options(extra: Partial<WpLoginActionOptions> = {}): WpLoginActionOptions {
  return {
    processUid: 0,
    emitReply: false,
    domainValidator: (value: string) => value,
    paths: {
      panelDb: join(root, "panel.sq3"),
      passwd: join(root, "passwd"),
      lockFile: join(root, "wp-login.lock"),
    },
    ...extra,
  };
}

function seedPanel(): void {
  const db = new Database(join(root, "panel.sq3"), { create: true });
  db.exec(`
    CREATE TABLE site (id INTEGER PRIMARY KEY, type TEXT, domain_name TEXT, root_directory TEXT,
      user TEXT, application TEXT);
    INSERT INTO site VALUES (1, 'php', 'shop.example.com', 'shop.example.com', 'shop', 'WordPress');
    INSERT INTO site VALUES (2, 'static', 'docs.example.com', 'docs.example.com', 'docs', 'Static');
    INSERT INTO site VALUES (3, 'php', 'blog.example.com', 'blog.example.com', 'blog', 'Generic');
    CREATE TABLE user (id INTEGER PRIMARY KEY, user_name TEXT, role TEXT, status INTEGER);
    INSERT INTO user VALUES (1, 'boss', 'ROLE_ADMIN', 1);
    INSERT INTO user VALUES (2, 'shopkeeper', 'ROLE_USER', 1);
    INSERT INTO user VALUES (3, 'nosy', 'ROLE_USER', 1);
    INSERT INTO user VALUES (4, 'gone', 'ROLE_USER', 0);
    INSERT INTO user VALUES (5, 'manager', 'ROLE_SITE_MANAGER', 1);
    CREATE TABLE user_sites (user_id INTEGER, site_id INTEGER);
    INSERT INTO user_sites VALUES (2, 1);
    INSERT INTO user_sites VALUES (4, 1);
  `);
  db.close();
}

function seedAccounts(): void {
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const users = ["shop", "docs", "blog"];
  writeFileSync(
    join(root, "passwd"),
    `${users.map((user) => `${user}:x:${uid}:${gid}::${join(root, "home", user)}:/bin/sh`).join("\n")}\n`,
  );
  for (const user of users) mkdirSync(join(root, "home", user), { recursive: true });
  // What a WordPress install always has, and what the sign-in refuses without:
  // wp-content is the site's own, never something this creates from nothing.
  for (const site of [["shop", "shop.example.com"], ["blog", "blog.example.com"]]) {
    for (const directory of ["wp-includes", "wp-content"]) {
      mkdirSync(join(root, "home", site[0]!, "htdocs", site[1]!, directory), { recursive: true });
    }
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clp-wp-login-"));
  seedPanel();
  seedAccounts();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function act<T>(argv: string[], extra: Partial<WpLoginActionOptions> = {}): Promise<T> {
  return await executeWpLoginAction(argv, options(extra)) as T;
}

function siteDir(user: string, domain: string): string {
  return join(root, "home", user, "htdocs", domain);
}

// The files decide, not the vhost template CloudPanel recorded: blog.example.com
// was created from Generic and is still a WordPress.
test("the site list is what is on disk, not what the panel's application column says", async () => {
  const { sites } = await act<{ sites: WpSiteView[] }>(["sites"]);
  expect(sites.map((site) => site.domain)).toEqual(["blog.example.com", "shop.example.com"]);
  expect(sites.every((site) => site.helper === false)).toBe(true);
});

// A non-administrator's request names itself, and the action holds it to the
// sites CloudPanel would list for that account.
test("a named panel user signs in only to the sites that are theirs", async () => {
  const mine = await act<WpLoginResult>(["sign-in", "--domain=shop.example.com", "--as-user=shopkeeper"]);
  expect(mine.url).toBe("https://shop.example.com/");

  await expect(act(["sign-in", "--domain=shop.example.com", "--as-user=nosy"]))
    .rejects.toThrow("that site is not yours");
  // Deactivated, though the mapping still says the site is theirs: the session
  // outlives the status change, so the status is checked too.
  await expect(act(["sign-in", "--domain=shop.example.com", "--as-user=gone"]))
    .rejects.toThrow("that site is not yours");
  await expect(act(["sign-in", "--domain=shop.example.com", "--as-user=ghost"]))
    .rejects.toThrow("that site is not yours");

  // The two roles CloudPanel shows every site to are not narrowed by the map.
  for (const user of ["boss", "manager"]) {
    const all = await act<WpLoginResult>(["sign-in", `--domain=blog.example.com`, `--as-user=${user}`]);
    expect(all.url).toBe("https://blog.example.com/");
  }

  await expect(act(["sign-in", "--domain=shop.example.com", "--as-user=not a name"]))
    .rejects.toThrow("not a valid panel user name");
  await expect(act(["sites", "--as-user=boss"])).rejects.toThrow("takes no --as-user");
});

test("a sign-in installs the loader, leaves a single-use secret, and names the site's own URL", async () => {
  const result = await act<WpLoginResult>(["sign-in", "--domain=shop.example.com"]);
  expect(result.url).toBe("https://shop.example.com/");
  expect(result.field).toBe(WP_LOGIN_FIELD);
  expect(result.token).toMatch(/^[0-9a-f]{64}$/);

  const site = siteDir("shop", "shop.example.com");
  const loader = readFileSync(join(site, "wp-content/mu-plugins/clp-addons-login.php"), "utf8");
  expect(loader).toContain("wp_set_auth_cookie");
  expect(loader).toContain("hash_equals");
  // Removed before it is compared, so a failed attempt spends the secret too.
  expect(loader.indexOf("unlink")).toBeLessThan(loader.indexOf("hash_equals"));

  const secret = readFileSync(join(site, "wp-content/mu-plugins/clp-addons/token.php"), "utf8");
  // The hash of the token, never the token, and only ever for the next minute.
  expect(secret).not.toContain(result.token);
  expect(secret).toContain(new Bun.CryptoHasher("sha256").update(result.token).digest("hex"));
  const expires = Number(/'expires' => (\d+)/.exec(secret)?.[1] ?? "0");
  expect(expires - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60);
  expect(expires - Math.floor(Date.now() / 1000)).toBeGreaterThan(50);

  const { sites } = await act<{ sites: WpSiteView[] }>(["sites"]);
  expect(sites.find((site) => site.domain === "shop.example.com")?.helper).toBe(true);
});

test("a WordPress site missing wp-content is refused rather than rebuilt", async () => {
  rmSync(join(siteDir("shop", "shop.example.com"), "wp-content"), { recursive: true, force: true });
  await expect(act(["sign-in", "--domain=shop.example.com"])).rejects.toThrow("does not look like a WordPress");
});

test("a site that is not WordPress, or not a site at all, gets no sign-in", async () => {
  await expect(act(["sign-in", "--domain=docs.example.com"])).rejects.toThrow("does not look like a WordPress");
  await expect(act(["sign-in", "--domain=absent.example.com"])).rejects.toThrow("no site called");
});

// Withdrawing the addon is the removal path: a loader left in somebody else's
// site because the addon went away would make it something an operator cannot
// fully take back.
test("remove takes the loader back out of every site that has it", async () => {
  await act(["sign-in", "--domain=shop.example.com"]);
  await act(["sign-in", "--domain=blog.example.com"]);
  const muPlugins = join(siteDir("shop", "shop.example.com"), "wp-content", "mu-plugins");
  expect(existsSync(join(muPlugins, "clp-addons-login.php"))).toBe(true);

  const result = await act<WpRemoveResult>(["remove"]);
  expect(result.removed).toBe(2);
  expect(existsSync(join(muPlugins, "clp-addons-login.php"))).toBe(false);
  expect(existsSync(join(muPlugins, "clp-addons"))).toBe(false);
  // The site's own wp-content survives; only what this addon put there goes.
  expect(existsSync(join(siteDir("shop", "shop.example.com"), "wp-content"))).toBe(true);

  expect((await act<WpRemoveResult>(["remove"])).removed).toBe(0);
});

test("an unknown verb, a stray argument and a non-root caller are all refused", async () => {
  await expect(act(["login"])).rejects.toThrow("unknown WordPress sign-in verb");
  await expect(act(["sites", "--domain=shop.example.com"])).rejects.toThrow("takes no --domain");
  await expect(act(["sign-in", "--domain=shop.example.com", "--force"])).rejects.toThrow("unexpected argument");
  await expect(executeWpLoginAction(["sites"], { ...options(), processUid: 1000 }))
    .rejects.toThrow("must run as root");
});
