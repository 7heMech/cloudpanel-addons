// The Setup checklist: what each step makes of the state it reads, how the
// manager collects the steps, and what an administrator's skips and Hide keep.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADDONS } from "../addons/catalog";
import { automaticCheck, connectionCheck, panelHostCheck, permissionActions } from "../addons/dns/setup";
import { defaultServerCheck, defaultServerProblems } from "../addons/system-tweaks/default-server";
import { seededPolicy } from "../addons/dns/presets";
import { autoSslCheck } from "../addons/panel-tweaks/setup";
import { newSiteCategoryCheck } from "../addons/resource-limits/setup";
import { administratorKeys } from "../addons/security-keys/action";
import { passkeysCheck } from "../addons/security-keys/setup";
import { newSiteMailCheck, relayCheck } from "../addons/smtp/setup";
import { loginJailsCheck, panelCertCheck, phpMyAdminCheck, realIpCheck, updatesCheck } from "../addons/system-tweaks/setup";
import type { LoginJailsStatus } from "../addons/system-tweaks/login-jails";
import type { SetupStep } from "../lib/addon-definition";
import { issuedFor, panelCustomDomainCertificate } from "../lib/panel-custom-domain";
import {
  actionItems, CORE_SETUP, changeSetupPrefs, readSetupPrefs, remoteBackupsCheck, setupOff, setupStepIds, setupSteps, setupView, switchSetup,
} from "../manager/setup";
import { setupPanelHtml, setupShows, setupSuggests } from "../manager/setup-view";

const uid = process.getuid!();
let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "clp-setup-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function privateFile(path: string, body: unknown): void {
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body), { mode: 0o600 });
}

describe("each step's verdict", () => {
  test("panel certificate", () => {
    expect(panelCertCheck({ kind: "shared" }).state).toBe("todo");
    expect(panelCertCheck({ kind: "generated" }).state).toBe("done");
    expect(panelCertCheck({ kind: "own" }).state).toBe("done");
    expect(panelCertCheck({ kind: "unknown" }).state).toBe("na");
    expect(panelCertCheck({ kind: "generated", problem: "unreadable" })).toEqual({ state: "todo", reason: "unreadable" });
  });

  test("login jails count only when the panel jail runs", () => {
    const status = (over: Partial<LoginJailsStatus>): LoginJailsStatus => ({
      missing: [], service: "active", running: ["clp-addons-panel"], panelLog: true, customDomain: null, bans: [], sshd: null, problem: "", ...over,
    });
    expect(loginJailsCheck(status({}))).toEqual({ state: "done", reason: "Failed panel logins are banned" });
    expect(loginJailsCheck(status({ running: ["clp-addons-panel", "sshd"] })).reason).toBe("Failed panel and SSH logins are banned");
    expect(loginJailsCheck(status({ missing: ["fail2ban"], service: "inactive", running: [] }))).toEqual({ state: "todo", reason: "fail2ban is not installed" });
    expect(loginJailsCheck(status({ service: "inactive", running: [] })).state).toBe("todo");
    expect(loginJailsCheck(status({ running: ["sshd"] })).state).toBe("todo");
    expect(loginJailsCheck(status({ panelLog: false })).state).toBe("todo");
    expect(loginJailsCheck(status({ panelLog: null })).state).toBe("na");
  });

  test("forged visitor IPs, phpMyAdmin and automatic updates", () => {
    expect(realIpCheck({ trustsAnyAddress: false, problem: "" }).state).toBe("done");
    expect(realIpCheck({ trustsAnyAddress: true, problem: "" }).state).toBe("todo");
    expect(phpMyAdminCheck({ active: true, problem: "" }).state).toBe("done");
    expect(phpMyAdminCheck({ active: true, problem: "vhost unreadable" })).toEqual({ state: "todo", reason: "vhost unreadable" });
    expect(updatesCheck({ installed: true, enabled: true }).state).toBe("done");
    expect(updatesCheck({ installed: true, enabled: false }).state).toBe("todo");
    expect(updatesCheck({ installed: false, enabled: false }).reason).toBe("unattended-upgrades is not installed");
  });

  test("one administrator with a key is enough, if administrators may use keys", () => {
    expect(passkeysCheck({ admins: ["admin", "ops"], keyed: ["ops"], allowed: true })).toEqual({ state: "done", reason: "ops has a security key" });
    expect(passkeysCheck({ admins: ["admin"], keyed: [], allowed: true }).state).toBe("todo");
    expect(passkeysCheck({ admins: ["admin"], keyed: ["admin"], allowed: false }).state).toBe("todo");
  });

  test("mail relay, and mail for new sites", () => {
    expect(relayCheck({ relays: [], defaultProfile: null }).state).toBe("todo");
    expect(relayCheck({ relays: ["Example Mail"], defaultProfile: null })).toEqual({ state: "done", reason: "Relay: Example Mail" });
    expect(newSiteMailCheck({ relays: [], defaultProfile: null }).state).toBe("na");
    expect(newSiteMailCheck({ relays: ["Example Mail"], defaultProfile: null }).state).toBe("todo");
    expect(newSiteMailCheck({ relays: ["Example Mail"], defaultProfile: { name: "Don't send", relays: false } }).state).toBe("todo");
    expect(newSiteMailCheck({ relays: ["Example Mail"], defaultProfile: { name: "Example Mail", relays: true } }).state).toBe("done");
  });

  test("PHP limits, certificates at site creation and remote backups", () => {
    expect(newSiteCategoryCheck(null).state).toBe("todo");
    expect(newSiteCategoryCheck("Standard")).toEqual({ state: "done", reason: "New sites join Standard" });
    expect(autoSslCheck(true).state).toBe("done");
    expect(autoSslCheck(false).state).toBe("todo");
    expect(remoteBackupsCheck({})).toEqual({ state: "todo", reason: "Sites are backed up on this server only" });
    expect(remoteBackupsCheck({ remote_backup_enabled: "0", remote_backup_storage_provider: "amazon_s3" }).reason).toBe("Set up but switched off");
    expect(remoteBackupsCheck({ remote_backup_enabled: "1", remote_backup_storage_provider: "amazon_s3" })).toEqual({ state: "done", reason: "On, to amazon_s3" });
  });


  test("DNS connection, panel hostname and automatic records", () => {
    const policy = { ...seededPolicy(), connections: [{ id: "cf-1", label: "Agency" }] };
    const state = (over: object = {}) => ({ policy, tokens: new Set(["cf-1"]), reports: [], ...over });
    expect(connectionCheck(state({ policy: seededPolicy(), tokens: new Set() })).state).toBe("todo");
    expect(connectionCheck(state())).toEqual({ state: "done", reason: "Cloudflare: Agency" });
    expect(connectionCheck(state({ reports: [{ id: "cf-1", active: false, error: "Cloudflare: Invalid access token (9109)" }] })))
      .toEqual({ state: "todo", reason: "Cloudflare: Invalid access token (9109)" });
    expect(panelHostCheck(undefined, null).reason).toBe("CloudPanel has no custom domain");
    expect(panelHostCheck(undefined, "panel.example.com").reason).toContain("Enter panel.example.com");
    expect(panelHostCheck({ name: "panel.example.com", issued: false }, "panel.example.com").state).toBe("todo");
    expect(panelHostCheck({ name: "cp.example.org", issued: true }, null)).toEqual({ state: "done", reason: "CloudPanel answers at cp.example.org" });
    expect(automaticCheck(state({ policy: seededPolicy(), tokens: new Set() })).reason).toBe("Connect DNS first");
    expect(automaticCheck(state()).reason).toBe("DNS asks before it changes records");
    expect(automaticCheck(state({ policy: { ...policy, automatic: true, defaultProfileId: "web" } })).state).toBe("done");
  });
});

describe("what the steps read", () => {
  function panelDb(): string {
    const path = join(dir, "db.sq3");
    const db = new Database(path);
    db.exec("CREATE TABLE config (id INTEGER PRIMARY KEY, key TEXT, value TEXT)");
    db.exec("CREATE TABLE user (id INTEGER PRIMARY KEY, user_name TEXT, status INTEGER, role TEXT)");
    db.exec("INSERT INTO config (key, value) VALUES ('remote_backup_enabled', '1'), ('remote_backup_storage_provider', 'wasabi'), ('timezone', 'UTC')");
    db.exec("INSERT INTO user (id, user_name, status, role) VALUES (1, 'admin', 1, 'ROLE_ADMIN'), (2, 'ops', 1, 'ROLE_ADMIN'), (3, 'gone', 0, 'ROLE_ADMIN'), (4, 'mea', 1, 'ROLE_SITE_MANAGER')");
    db.close();
    return path;
  }

  test("remote backups come from CloudPanel's config table", async () => {
    const step = CORE_SETUP.find((candidate) => candidate.id === "remote-backups")!;
    expect(await step.check({ panelDb: panelDb() })).toEqual({ state: "done", reason: "On, to wasabi" });
  });

  test("an administrator's keys count only for their own account id, and only active administrators", () => {
    const stateDir = join(dir, "keys");
    mkdirSync(stateDir);
    const key = { id: "k1", name: "YubiKey" };
    privateFile(join(stateDir, "credentials.json"), {
      version: 1,
      users: {
        admin: { userId: 99, handle: "h", keys: [key] },
        gone: { userId: 3, handle: "h", keys: [key] },
        mea: { userId: 4, handle: "h", keys: [key] },
      },
    });
    const paths = { stateDir, panelDb: panelDb(), stateUid: uid };
    expect(administratorKeys({ paths })).toEqual({ admins: ["admin", "ops"], keyed: [], allowed: true });
    privateFile(join(stateDir, "credentials.json"), { version: 1, users: { ops: { userId: 2, handle: "h", keys: [key] } } });
    expect(administratorKeys({ paths }).keyed).toEqual(["ops"]);
    privateFile(join(stateDir, "settings.json"), { roles: ["ROLE_USER"], syncedPasskeys: true });
    expect(administratorKeys({ paths }).allowed).toBe(false);
  });


  test("a custom domain counts once a CA issued its certificate", () => {
    const openssl = (...args: string[]) => {
      const run = spawnSync("openssl", args, { cwd: dir, encoding: "utf8" });
      if (run.status !== 0) throw new Error(run.stderr);
    };
    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-subj", "/CN=Test CA");
    openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=panel.example.com");
    writeFileSync(join(dir, "ext"), "subjectAltName=DNS:panel.example.com\n");
    openssl("x509", "-req", "-in", "leaf.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.crt", "-days", "2", "-extfile", "ext");
    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "self.key", "-out", "self.crt", "-days", "2", "-subj", "/CN=panel.example.com",
      "-addext", "subjectAltName=DNS:panel.example.com");
    for (const file of ["leaf.crt", "self.crt"]) chmodSync(join(dir, file), 0o644);
    const leaf = readFileSync(join(dir, "leaf.crt"), "utf8");
    expect(issuedFor(leaf, "panel.example.com")).toBe(true);
    expect(issuedFor(leaf, "other.example.com")).toBe(false);
    expect(issuedFor(readFileSync(join(dir, "self.crt"), "utf8"), "panel.example.com")).toBe(false);
    expect(issuedFor(leaf, "panel.example.com", Date.now() + 5 * 86_400_000)).toBe(false);

    const paths = { file: join(dir, "custom_domain"), vhost: join(dir, "custom-domain.conf"), cert: join(dir, "leaf.crt") };
    expect(panelCustomDomainCertificate([uid], paths)).toBeUndefined();
    writeFileSync(paths.vhost, "server {}\n");
    writeFileSync(paths.file, "panel.example.com\n");
    expect(panelCustomDomainCertificate([uid], paths)).toEqual({ name: "panel.example.com", issued: true });
    expect(panelCustomDomainCertificate([uid], { ...paths, cert: join(dir, "self.crt") })).toEqual({ name: "panel.example.com", issued: false });
  });
});

describe("collecting the checklist", () => {
  const step = (id: string, level: SetupStep["level"], check: SetupStep["check"], extra: Partial<SetupStep> = {}): SetupStep =>
    ({ id, level, title: id, href: `/${id}`, check, ...extra });

  test("by level, an off addon offered with Enable unless its step is done without it, and a failed check is a suggestion", async () => {
    const items = await setupSteps({ skipped: ["skip-me", "done-anyway"] }, {
      core: [step("core", "sites", () => ({ state: "todo", reason: "core" }))],
      addons: [
        { name: "a", title: "Addon A", enabled: true, steps: [
          step("late", "provision", () => ({ state: "done", reason: "ok" })),
          step("skip-me", "secure", () => ({ state: "todo", reason: "x" })),
          step("done-anyway", "secure", () => ({ state: "done", reason: "y" })),
          step("broken", "domain", () => { throw new Error("unreadable"); }),
        ] },
        { name: "b", title: "Addon B", enabled: false, steps: [
          step("never-run", "secure", () => { throw new Error("must not run"); }),
          step("hand-made", "domain", () => ({ state: "done", reason: "by hand" }), { whileOff: true }),
          step("hand-missing", "domain", () => ({ state: "todo", reason: "no" }), { whileOff: true }),
        ] },
      ],
    });
    expect(items.map((item) => [item.id, item.state, item.reason])).toEqual([
      ["broken", "todo", "Could not be checked: unreadable"],
      ["hand-made", "done", "by hand"],
      ["hand-missing", "todo", "Addon B is off"],
      ["skip-me", "skipped", "x"],
      ["done-anyway", "done", "y"],
      ["never-run", "todo", "Addon B is off"],
      ["core", "todo", "core"],
      ["late", "done", "ok"],
    ]);
    expect(items.find((item) => item.id === "never-run")!.addon).toEqual({ name: "b", title: "Addon B", enabled: false });
    expect(items.find((item) => item.id === "core")!.addon).toBeNull();
  });

  test("every step id is unique and every step links somewhere", () => {
    const ids = setupStepIds();
    expect(new Set(ids).size).toBe(ids.length);
    for (const spec of Object.values(ADDONS)) {
      for (const each of spec.setup ?? []) expect(each.href).toMatch(/^\/(addons\/[a-z-]+\/(#[A-Za-z0-9-]+)?|security)$/);
    }
  });

  test("skips and Hide are kept per administrator", async () => {
    const file = join(dir, "setup.json");
    const source = { core: [step("one", "secure", () => ({ state: "todo", reason: "r" }))], addons: [] };
    changeSetupPrefs("admin", { skip: "one" }, file);
    changeSetupPrefs("admin", { hidden: true }, file);
    expect(readSetupPrefs(file)).toEqual({ admin: { hidden: true, skipped: ["one"] } });
    expect(await setupView("admin", file, source)).toMatchObject({ hidden: true, steps: [{ id: "one", state: "skipped" }] });
    expect(await setupView("ops", file, source)).toMatchObject({ hidden: false, steps: [{ id: "one", state: "todo" }] });
    changeSetupPrefs("admin", { unskip: "one" }, file);
    changeSetupPrefs("admin", { hidden: false }, file);
    expect(readSetupPrefs(file)).toEqual({});
  });

  test("a done step that falls back shows the helper again, but keeps a skip and a Hide", async () => {
    const file = join(dir, "setup.json");
    let tokenHolds = true;
    const source = { core: [], addons: [{ name: "dns", title: "DNS", enabled: true, steps: [
      step("dns-connection", "domain", () => tokenHolds
        ? { state: "done", reason: "Cloudflare: Agency" }
        : { state: "todo", reason: "Agency's token lacks API Tokens: Read" }),
      step("other", "secure", () => ({ state: "done", reason: "ok" })),
    ] }] };
    expect(setupShows(await setupView("admin", file, source))).toBe(false);
    tokenHolds = false;
    const fallen = await setupView("admin", file, source);
    expect(setupShows(fallen)).toBe(true);
    expect(setupPanelHtml(fallen)).toContain('href="/dns-connection"');
    changeSetupPrefs("admin", { hidden: true }, file);
    expect(setupShows(await setupView("admin", file, source))).toBe(false);
    changeSetupPrefs("ops", { skip: "dns-connection" }, file);
    expect(await setupView("ops", file, source)).toMatchObject({ steps: [{ id: "dns-connection", state: "skipped" }, { id: "other" }] });
    expect(setupShows(await setupView("ops", file, source))).toBe(false);
  });

  test("the panel suggests only while a step is left, with no counts", () => {
    const item = { id: "one", level: "secure" as const, title: "One <b>", href: "/addons/x/", addon: { name: "x", title: "X", enabled: false }, reason: "r" };
    const open = { off: false, hidden: false, actions: [], steps: [{ ...item, state: "todo" as const }] };
    expect(setupSuggests(open)).toBe(true);
    const html = setupPanelHtml(open);
    expect(html).toContain('data-setup-enable="x"');
    expect(html).toContain("One &lt;b&gt;");
    expect(html).not.toMatch(/\d+ of \d+|\d+\/\d+/);
    const settled = { off: false, hidden: false, actions: [], steps: [{ ...item, state: "skipped" as const }] };
    expect(setupSuggests(settled)).toBe(false);
    expect(setupPanelHtml(settled)).toContain('data-setup-unskip="one"');
  });
});

describe("Action needed", () => {
  const item = { title: "Token needs a permission", reason: "lacks API Tokens: Read", href: "/addons/dns/#dns-connection" };
  const never = () => new Promise<never>(() => {});

  test("only enabled addons raise it, and a check that fails or outlasts its limit raises nothing", async () => {
    const items = await actionItems({ core: [], addons: [
      { name: "dns", title: "DNS", enabled: true, steps: [], actions: [
        { id: "perm", check: () => [item, { ...item, title: "Second" }] },
        { id: "broken", check: () => { throw new Error("unreadable"); } },
        { id: "hung", check: never },
      ] },
      { name: "firewall", title: "Firewall", enabled: false, steps: [], actions: [{ id: "off", check: () => { throw new Error("must not run"); } }] },
    ] }, {}, 50);
    expect(items).toEqual([
      { ...item, id: "perm", addon: { name: "dns", title: "DNS" } },
      { ...item, title: "Second", id: "perm-1", addon: { name: "dns", title: "DNS" } },
    ]);
  });

  test("a step that outlasts its limit reads as not checked, and the others still answer", async () => {
    const step = (id: string, check: SetupStep["check"]): SetupStep => ({ id, level: "secure", title: id, href: "/x/", check });
    const items = await setupSteps({}, { core: [step("hung", never), step("quick", () => ({ state: "done", reason: "ok" }))], addons: [] }, {}, 50);
    expect(items.map((each) => [each.id, each.state, each.reason])).toEqual([
      ["hung", "todo", "Could not be checked: took longer than 0 seconds"],
      ["quick", "done", "ok"],
    ]);
  });

  test("it brings Setup back while hidden, shows only itself there, and has no Skip", () => {
    const action = { ...item, id: "perm", addon: { name: "dns", title: "DNS" } };
    const step = { id: "one", level: "secure" as const, title: "One", href: "/addons/x/", addon: null, state: "todo" as const, reason: "r" };
    const hidden = { off: false, hidden: true, actions: [action], steps: [step] };
    expect(setupShows(hidden)).toBe(true);
    const html = setupPanelHtml(hidden);
    expect(html).toContain("Action needed");
    expect(html).toContain("data-setup-show");
    expect(html).not.toContain("data-setup-hide");
    expect(html).not.toContain("data-setup-skip");
    expect(html).not.toContain(">One<");
    const open = setupPanelHtml({ ...hidden, hidden: false });
    expect(open.indexOf("Action needed")).toBeLessThan(open.indexOf(">One<"));
    expect(open).toContain('data-setup-skip="one"');
    expect(setupShows({ ...hidden, actions: [], steps: [] })).toBe(false);
  });

  test("root's switch turns Setup off: nothing is checked and nothing shows", async () => {
    const off = join(dir, "setup-off");
    expect(setupOff(off)).toBe(false);
    expect(switchSetup(false, off)).toBe(true);
    expect(switchSetup(false, off)).toBe(false);
    const view = await setupView("admin", join(dir, "setup.json"), { core: [], addons: [{ name: "dns", title: "DNS", enabled: true,
      steps: [{ id: "s", level: "domain", title: "s", href: "/x/", check: () => { throw new Error("must not run"); } }],
      actions: [{ id: "a", check: () => { throw new Error("must not run"); } }] }] }, {}, off);
    expect(view).toEqual({ off: true, hidden: false, actions: [], steps: [] });
    expect(setupShows(view)).toBe(false);
    expect(setupPanelHtml(view)).toContain("clp-addons setup on");
    expect(switchSetup(true, off)).toBe(true);
    expect(setupOff(off)).toBe(false);
  });

  test("DNS raises it per connection for a required permission the token lacks, never for an optional one", () => {
    const policy = { ...seededPolicy(), connections: [{ id: "cf-1", label: "Agency" }, { id: "cf-2", label: "Shop" }] };
    const unreadable = { owner: "user" as const, accountId: null, readable: false as const, reason: "refused" };
    const state = (refused: string[]) => ({
      policy, tokens: new Set(["cf-1", "cf-2"]),
      reports: [
        { id: "cf-1", active: true, error: null, token: unreadable, refused },
        { id: "cf-2", active: true, error: null },
      ],
    });
    expect(permissionActions(state([]))).toEqual([]);
    const [action, ...rest] = permissionActions(state(["API Tokens: Read"]));
    expect(rest).toEqual([]);
    expect(action).toMatchObject({ title: "Cloudflare token needs a permission", href: "/addons/dns/#dns-connection" });
    expect(action!.reason).toStartWith("Agency's token lacks API Tokens: Read");
    expect(permissionActions({ ...state(["API Tokens: Read"]), reports: [{ id: "cf-1", active: false, error: "x", token: unreadable, refused: ["API Tokens: Read"] }] })).toEqual([]);
  });
});

describe("unknown hostnames", () => {
  const stock = `# configuration file /etc/nginx/nginx.conf:
http {
  include /etc/nginx/sites-enabled/*;
# configuration file /etc/nginx/sites-enabled/default.conf:
server {
  listen 80 default_server;
  listen [::]:80 default_server;
  listen 443 quic reuseport default_server;
  listen 443 default_server ssl;
  listen [::]:443 quic reuseport default_server;
  listen [::]:443 default_server ssl;
  ssl_reject_handshake on;
  server_name _;
  return 444;
}
`;
  const site = (extra = "") => `# configuration file /etc/nginx/sites-enabled/www.example.com.conf:
server {
  listen 80${extra};
  listen [::]:80${extra};
  listen 443 quic;
  listen 443 ssl${extra};
  listen [::]:443 ssl${extra};
  server_name www.example.com; # a site
  location / { return 301 https://$host$request_uri; }
  root /home/example/htdocs/www.example.com;
}
server {
  listen 127.0.0.1:8080 default_server;
  server_name www.example.com;
}
`;
  const end = "}\n";

  test("CloudPanel's own default server refuses them", () => {
    expect(defaultServerProblems(stock + site() + end)).toEqual([]);
  });

  test("without it, or with a site taking default_server, the site answers them", () => {
    expect(defaultServerProblems(`http {\n${site()}${end}`)).toEqual(["On port 80, www.example.com answers them", "On port 443, www.example.com answers them"]);
    expect(defaultServerProblems(stock.replaceAll(" default_server", "") + site(" default_server") + end))
      .toEqual(["On port 80, www.example.com answers them", "On port 443, www.example.com answers them"]);
  });

  test("a default server that answers 443's handshake does not refuse them", () => {
    expect(defaultServerProblems(stock.replace("  ssl_reject_handshake on;\n", "") + site() + end)).toEqual(["On port 443, _ answers them".replace("_", "/etc/nginx/sites-enabled/default.conf")]);
  });

  test("the check raises one item, and nothing when nginx -T cannot run", () => {
    expect(defaultServerCheck({ dump: () => stock + site() + end })).toEqual([]);
    expect(defaultServerCheck({ dump: () => null })).toEqual([]);
    const [found] = defaultServerCheck({ dump: () => `http {\n${site()}${end}` });
    expect(found!.title).toBe("Unknown hostnames reach a site");
    expect(found!.href).toContain("system-tweaks.md#unknown-hostnames");
  });
});
