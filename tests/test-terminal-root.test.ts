// Root shells: only administrators root allowed, and only while the account
// and its sign-in credentials are the ones root allowed.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ActionFailure } from "../cli/action-common";
import {
  parseTerminalRequest, resolveTerminalTarget, runTerminalAction, runuserCommand, type TerminalActionPaths,
} from "../addons/terminal/action";
import { readRootGrants, rootAccess } from "../addons/terminal/root-access";
import { TERMINAL_TARGETS } from "../addons/terminal/inject/targets";
import { renderLayout } from "../lib/app-ui";
import { ownerOf, TerminalSessions, type StreamOpener } from "../addons/terminal/app/sessions";
import { dashboardView, popupPage } from "../addons/terminal/app/views";

const uid = process.getuid?.() ?? 0;
const base = realpathSync(mkdtempSync(`${tmpdir()}/terminal-root-`));
let paths: TerminalActionPaths;

afterAll(() => rmSync(base, { recursive: true, force: true }));

function db(): Database {
  return new Database(paths.panelDb);
}

beforeEach(() => {
  rmSync(`${base}/box`, { recursive: true, force: true });
  mkdirSync(`${base}/box/etc`, { recursive: true });
  chmodSync(`${base}/box/etc`, 0o755);
  paths = {
    panelDb: `${base}/box/panel.sqlite`, passwd: `${base}/box/passwd`, runuser: "/usr/sbin/runuser", homes: `${base}/box/home`,
    rootAccess: { panelDb: `${base}/box/panel.sqlite`, grants: `${base}/box/etc/terminal-root.json`, rootUid: uid },
  };
  const panel = db();
  panel.run(`CREATE TABLE user (id INTEGER PRIMARY KEY, user_name TEXT, role TEXT, status INTEGER,
    password TEXT, mfa INTEGER, mfa_secret TEXT)`);
  panel.run(`INSERT INTO user VALUES (1, 'alice', 'ROLE_ADMIN', 1, '$2y$13$alice', 1, 'a'),
    (2, 'bob', 'ROLE_ADMIN', 1, '$2y$13$bob', 1, 'b')`);
  panel.close();
  writeFileSync(paths.passwd, "root:x:0:0:root:/root:/bin/bash\n");
});

function allow(...users: string[]): void {
  const panel = db();
  const grants = users.map((user) => ({
    user, id: panel.query<{ id: number }, [string]>("SELECT id FROM user WHERE user_name = ?").get(user)!.id,
  }));
  panel.close();
  writeFileSync(paths.rootAccess.grants, JSON.stringify({ users: grants }));
  chmodSync(paths.rootAccess.grants, 0o600);
}

const change = (sql: string) => { const panel = db(); panel.run(sql); panel.close(); };
const access = (user: string) => rootAccess(user, paths.rootAccess);

test("only an administrator root allowed gets a root shell", () => {
  expect(access("alice")).toEqual({ granted: false, problem: null });
  allow("alice");
  expect(access("alice")).toEqual({ granted: true, problem: null });
  expect(access("bob")).toEqual({ granted: false, problem: null });
});

test("two-factor must be on; switched off it pauses the grant, and back on it works without root", () => {
  allow("alice");
  change("UPDATE user SET mfa = 0 WHERE user_name = 'alice'");
  expect(access("alice")).toEqual({ granted: true, problem: "A root terminal needs two-factor authentication: turn it on under Account → Security" });
  change("UPDATE user SET mfa = 1, mfa_secret = 'new' WHERE user_name = 'alice'");
  expect(access("alice")).toEqual({ granted: true, problem: null });
});

test("a password change, by the account or by another administrator, leaves the grant alone", () => {
  allow("alice");
  change("UPDATE user SET password = '$2y$13$reset' WHERE user_name = 'alice'");
  expect(access("alice").problem).toBeNull();
});

test("a name deleted and created again, a demotion or a deactivation is refused", () => {
  allow("alice");
  change("DELETE FROM user WHERE user_name = 'alice'; INSERT INTO user VALUES (3, 'alice', 'ROLE_ADMIN', 1, '$2y$13$alice', 1, 'a')");
  expect(access("alice").problem).toContain("is not the account root allowed");
  allow("alice");
  change("UPDATE user SET role = 'ROLE_SITE_MANAGER' WHERE user_name = 'alice'");
  expect(access("alice").problem).toContain("no longer an administrator");
  change("UPDATE user SET role = 'ROLE_ADMIN', status = 0 WHERE user_name = 'alice'");
  expect(access("alice").problem).toContain("deactivated");
});

test("a grants file others could write, or a link, lets nobody in", () => {
  allow("alice");
  chmodSync(paths.rootAccess.grants, 0o666);
  expect(() => readRootGrants(paths.rootAccess.grants, uid)).toThrow("not a trusted regular file");
  expect(access("alice").problem).toContain("cannot be read");
  chmodSync(paths.rootAccess.grants, 0o600);
  const link = `${base}/box/etc/link.json`;
  symlinkSync(paths.rootAccess.grants, link);
  expect(rootAccess("alice", { ...paths.rootAccess, grants: link }).problem).toContain("cannot be read");
  expect(rootAccess("alice", { ...paths.rootAccess, rootUid: uid + 1 }).problem).toContain("cannot be read");
});

test("the worker takes --root in place of a domain, and resolves it only for an allowed administrator", () => {
  const request = parseTerminalRequest(["session", "--root", "--panel-user=alice", "--cols=80", "--rows=24"]);
  expect(request).toEqual({ domain: null, panelUser: "alice", cols: 80, rows: 24 });
  expect(() => parseTerminalRequest(["session", "--root", "--domain=a.test", "--panel-user=alice", "--cols=1", "--rows=1"],
    { domainValidator: (value) => value })).toThrow(ActionFailure);
  expect(() => parseTerminalRequest(["session", "--root=yes", "--panel-user=alice", "--cols=1", "--rows=1"])).toThrow(ActionFailure);
  expect(() => resolveTerminalTarget(request, paths)).toThrow("root has not allowed you a root shell");
  allow("alice");
  expect(resolveTerminalTarget(request, paths)).toEqual({ user: "root", dir: "/root" });
});

test("an open root shell ends once its grant does", async () => {
  allow("alice");
  const audit: string[] = [];
  const calls: string[][] = [];
  const running = runTerminalAction(["session", "--root", "--panel-user=alice", "--cols=80", "--rows=24"], {
    paths, processUid: 0, env: { CLP_ADDONS_DUPLEX_WORKER: "1" }, rootRecheckMs: 20,
    audit: (line) => audit.push(line),
    spawn: ((argv: string[]) => { calls.push(argv); return Bun.spawn(["sleep", "30"]); }) as unknown as typeof Bun.spawn,
  });
  await Bun.sleep(60);
  change("UPDATE user SET mfa = 0 WHERE user_name = 'alice'");
  await running;
  expect(calls).toEqual([runuserCommand(paths, "root")]);
  expect(audit[0]).toBe("alice opened a root shell as root");
  expect(audit.some((line) => line.includes("root shell ended: A root terminal needs two-factor authentication"))).toBe(true);
  expect(audit.at(-1)).toContain("alice closed a root shell as root");
});

test("the manager asks for --root, and a ready line must agree on who the shell runs as", async () => {
  const opened: string[][] = [];
  let ready = { user: "root", dir: "/root" };
  const opener: StreamOpener = (request, handlers) => {
    opened.push([request.domain === null ? "--root" : `--domain=${request.domain}`]);
    queueMicrotask(() => handlers.onLine(JSON.stringify({ ready })));
    return { write() {}, close() {} };
  };
  const store = new TerminalSessions({ opener });
  const owner = ownerOf("alice", "s");
  expect((await store.open(owner, { domain: null, cols: 80, rows: 24, sessionId: "s" })).ok).toBe(true);
  ready = { user: "example", dir: "/home/example" };
  expect(await store.open(owner, { domain: null, cols: 80, rows: 24, sessionId: "s" }))
    .toEqual({ ok: false, error: "the terminal sent something unexpected" });
  ready = { user: "root", dir: "/root" };
  expect(await store.open(owner, { domain: "a.test", cols: 80, rows: 24, sessionId: "s" }))
    .toEqual({ ok: false, error: "the terminal sent something unexpected" });
  expect(opened[0]).toEqual(["--root"]);
});

test("the page's button opens a root shell only for an allowed administrator, and otherwise says why", () => {
  const allowed = dashboardView([], { granted: true, problem: null }, "alice");
  expect(allowed).toContain(`onclick="clpOpenTerminal(CLP_BASE, '', event.shiftKey)">Root terminal<`);
  expect(allowed).not.toContain("data-refusal");
  const refused = dashboardView([], { granted: true, problem: "A root terminal needs two-factor authentication: turn it on under Account → Security" }, "alice");
  expect(refused).toContain('data-refusal="A root terminal needs two-factor authentication: turn it on under Account → Security"');
  expect(refused).not.toContain("clpOpenTerminal(");
  const other = dashboardView([], { granted: false, problem: null }, "bob");
  expect(other).toContain("clp-addons terminal root allow bob on the server.");
  expect(other).toContain(`onclick="notify(this.dataset.refusal, 'error')"`);
  const popup = popupPage(null);
  expect(popup).toContain('data-domain=""');
  expect(popup).toContain('<span class="badge tone-bad">root</span>');
});

test("the header control is in both of CloudPanel's headers and the addons' own, for administrators, hidden until root answers", () => {
  const headers = TERMINAL_TARGETS.filter((target) => target.slug.startsWith("root-shell"));
  expect(headers.map((target) => target.template)).toEqual(["Frontend/Partial/header.html.twig", "Admin/Partial/header.html.twig"]);
  for (const target of headers) {
    const snippet = target.snippet("/addons/terminal");
    expect(snippet).toContain("{% if is_granted('ROLE_ADMIN') %}");
    expect(snippet).toContain('data-clp-root-shell style="display: none;"');
    expect(snippet).toContain('fetch("/addons/terminal/api/root-access"');
    // Twig would read these as its own tags.
    expect(snippet.replace("{% if is_granted('ROLE_ADMIN') %}", "").replace("{% endif %}", "")).not.toMatch(/\{[{%#]/);
  }
  const page = renderLayout("Terminal", "", { brand: "Terminal", base: "/addons/terminal", nav: [], script: "" });
  expect(page).toContain('id="clp-root-shell" data-clp-root-shell hidden');
  expect(renderLayout("Terminal", "", { brand: "Terminal", base: "/addons/terminal", nav: [], script: "", admin: false })).not.toContain("clp-root-shell");
});
