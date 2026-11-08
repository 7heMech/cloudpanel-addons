// Root shells: only administrators root allowed, and only while the account
// and its sign-in credentials are the ones root allowed.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { ActionFailure } from "../lib/action";
import {
  parseTerminalRequest, resolveTerminalTarget, runTerminalAction, type TerminalActionPaths,
} from "../addons/terminal/action";
import { rootAuth, totp } from "../addons/terminal/root-auth";
import { clearRootAuth, readRootGrants, rootAccess } from "../addons/terminal/root-access";
import { TERMINAL_TARGETS } from "../addons/terminal/inject/targets";
import { renderLayout } from "../lib/app-ui";
import { ownerOf, TerminalSessions, type StreamOpener } from "../addons/terminal/app/sessions";
import { dashboardView, popupPage } from "../addons/terminal/app/views";

const uid = process.getuid?.() ?? 0;
const base = realpathSync(mkdtempSync(`${tmpdir()}/terminal-root-`));
let paths: TerminalActionPaths;
const binding = "a".repeat(64);
const authStorage = { dir: `${base}/box/auth`, lock: `${base}/locks/auth.lock`, securityKeys: `${base}/box/security-keys.conf` };
/** `seen`, when the gateway first saw the session signed in, defaults to long ago. */
function auth(verb: "options" | "verify" | "consume", input: Record<string, unknown> = {}, now = Date.now(), session = binding, seen: number | null = 1) {
  return rootAuth(verb, "alice", { proof: "1", binding: session, seen }, input, paths.rootAccess, now, authStorage) as any;
}
/** The code the app shows one step after a prompt opened at `opened`, entered then. */
function nextCode(opened: number, secret = SECRET) {
  const at = opened + 30_000;
  return { at, code: totp(secret, Math.floor(at / 30000)) };
}
const SECRET = "JBSWY3DPEHPK3PXP";
/** A well-formed code that none of the three accepted steps matches. */
function wrongCode(now: number) {
  const step = Math.floor(now / 30000);
  const valid = [step - 1, step, step + 1].map((n) => totp(SECRET, n));
  return ["000000", "000001", "000002", "000003"].find((code) => !valid.includes(code))!;
}
function ticket(now = Date.now()) {
  change("UPDATE user SET mfa_secret = 'JBSWY3DPEHPK3PXP' WHERE user_name = 'alice'");
  allow("alice");
  const next = nextCode(now);
  return auth("verify", { ...auth("options", {}, now), code: next.code }, next.at).ticket;
}

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
    rootAccess: { panelDb: `${base}/box/panel.sqlite`, grants: `${base}/box/etc/terminal-root.json`, securityKeys: `${base}/box/security-keys`, rootUid: uid },
  };
  const panel = db();
  panel.run(`CREATE TABLE user (id INTEGER PRIMARY KEY, user_name TEXT, role TEXT, status INTEGER,
    password TEXT, mfa INTEGER, mfa_secret TEXT)`);
  panel.run(`INSERT INTO user VALUES (1, 'alice', 'ROLE_ADMIN', 1, '$2y$13$alice', 1, 'a'),
    (2, 'bob', 'ROLE_ADMIN', 1, '$2y$13$bob', 1, 'b')`);
  panel.close();
  writeFileSync(paths.passwd, "root:x:0:0:root:/root:/bin/bash\n");
});

/** What `terminal root allow` writes: the account's id and a digest of its 2FA secret then. */
function allow(...users: string[]): void {
  const panel = db();
  const grants = users.map((user) => {
    const { id, mfa_secret } = panel.query<{ id: number; mfa_secret: string }, [string]>("SELECT id, mfa_secret FROM user WHERE user_name = ?").get(user)!;
    return { user, id, mfa: createHash("sha256").update(`clp-addons terminal root\0${mfa_secret}`).digest("hex"), keys: ["alice-key"] };
  });
  panel.close();
  writeFileSync(paths.rootAccess.grants, JSON.stringify({ users: grants }));
  chmodSync(paths.rootAccess.grants, 0o600);
}

const change = (sql: string) => { const panel = db(); panel.run(sql); panel.close(); };
const access = (user: string, session = "1") => rootAccess(user, paths.rootAccess, session);

test("only an administrator root allowed gets a root shell", () => {
  expect(access("alice")).toEqual({ granted: false, problem: null });
  allow("alice");
  expect(access("alice")).toEqual({ granted: true, problem: null });
  expect(access("bob")).toEqual({ granted: false, problem: null });
});

test("a grant holds the 2FA the owner had: switched off it stops, and set up again it needs root again", () => {
  allow("alice");
  change("UPDATE user SET mfa = 0 WHERE user_name = 'alice'");
  expect(access("alice")).toEqual({ granted: true, problem: "A root terminal needs 2FA: turn it on in Account → Security, then ask root to allow you again." });
  // Whoever set it up again -- after a password reset, any administrator -- is not who root allowed.
  change("UPDATE user SET mfa = 1, mfa_secret = 'new' WHERE user_name = 'alice'");
  expect(access("alice").problem).toBe("alice's 2FA was set up again after root allowed it; root can run clp-addons terminal root allow alice again");
  allow("alice");
  expect(access("alice")).toEqual({ granted: true, problem: null });
});

test("a grant written without a 2FA digest lets nobody in", () => {
  writeFileSync(paths.rootAccess.grants, JSON.stringify({ users: [{ user: "alice", id: 1 }] }));
  chmodSync(paths.rootAccess.grants, 0o600);
  expect(access("alice")).toEqual({ granted: false, problem: null });
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
  expect(access("alice").problem).toContain("cannot be trusted");
  chmodSync(paths.rootAccess.grants, 0o600);
  const link = `${base}/box/etc/link.json`;
  symlinkSync(paths.rootAccess.grants, link);
  expect(rootAccess("alice", { ...paths.rootAccess, grants: link }, "1").problem).toContain("cannot be trusted");
  expect(rootAccess("alice", { ...paths.rootAccess, rootUid: uid + 1 }, "1").problem).toContain("cannot be trusted");
  expect(rootAccess("alice", { ...paths.rootAccess, rootUid: uid + 1 }, "1").unreadable).toBeUndefined();
});

test("the worker takes --root in place of a domain, and resolves it only for an allowed administrator", () => {
  const request = parseTerminalRequest(["session", "--root", "--panel-user=alice", "--cols=80", "--rows=24"]);
  expect(request).toEqual({ domain: null, panelUser: "alice", cols: 80, rows: 24 });
  expect(() => parseTerminalRequest(["session", "--root", "--domain=a.test", "--panel-user=alice", "--cols=1", "--rows=1"],
    { domainValidator: (value) => value })).toThrow(ActionFailure);
  expect(() => parseTerminalRequest(["session", "--root=yes", "--panel-user=alice", "--cols=1", "--rows=1"])).toThrow(ActionFailure);
  expect(() => resolveTerminalTarget(request, paths)).toThrow("root has not allowed you a root shell");
  allow("alice");
  expect(resolveTerminalTarget(request, paths, "1")).toEqual({ user: "root", dir: "/root" });
  // The account has 2FA on, but this sign-in never passed it.
  expect(() => resolveTerminalTarget(request, paths, "0")).toThrow("This sign-in used neither your 2FA code nor a passkey");
});

test("an open root shell ends once its grant does", async () => {
  allow("alice");
  const audit: string[] = [];
  const calls: string[][] = [];
  const running = runTerminalAction(["session", "--root", "--panel-user=alice", "--cols=80", "--rows=24"], {
    paths, rootAuthStorage: authStorage, processUid: 0, env: { CLP_ADDONS_TICKET: ticket(), CLP_ADDONS_SESSION_BINDING: binding, CLP_ADDONS_DUPLEX_WORKER: "1", CLP_ADDONS_SESSION_2FA: "1" }, rootRecheckMs: 20,
    audit: (line) => audit.push(line),
    spawn: ((argv: string[]) => { calls.push(argv); return Bun.spawn(["sleep", "30"]); }) as unknown as typeof Bun.spawn,
  });
  await Bun.sleep(60);
  change("UPDATE user SET mfa = 0 WHERE user_name = 'alice'");
  await running;
  expect(calls).toEqual([[
    "/usr/sbin/runuser", "--login", "--whitelist-environment=TERM,CLP_SITE_DIR,CLP_PTY_SIZE,CLP_ROOT_SHELL",
    "--command=exec /usr/local/bin/clp-addons terminal-pty", "--", "root",
  ]]);
  expect(audit[0]).toBe("alice opened a root shell as root, verified with an authenticator code");
  expect(audit.some((line) => line.includes("root shell ended: A root terminal needs 2FA"))).toBe(true);
  expect(audit.at(-1)).toContain("alice closed a root shell as root");
});

function rootSession(extra: Record<string, unknown>, child: () => ReturnType<typeof Bun.spawn>) {
  const audit: string[] = [];
  const running = runTerminalAction(["session", "--root", "--panel-user=alice", "--cols=80", "--rows=24"], {
    paths, rootAuthStorage: authStorage, processUid: 0, env: { CLP_ADDONS_TICKET: ticket(), CLP_ADDONS_SESSION_BINDING: binding, CLP_ADDONS_DUPLEX_WORKER: "1", CLP_ADDONS_SESSION_2FA: "1" }, rootRecheckMs: 20,
    audit: (line) => audit.push(line),
    spawn: child as unknown as typeof Bun.spawn,
    ...extra,
  });
  return { audit, running };
}

test("a database that cannot be read is refused for a new shell, but an open one gets three checks first", async () => {
  allow("alice");
  const away = `${paths.panelDb}.away`;
  const unreadable = { ...paths, rootAccess: { ...paths.rootAccess, panelDb: away } };
  expect(rootAccess("alice", unreadable.rootAccess, "1")).toMatchObject({ granted: true, unreadable: true });
  expect(() => resolveTerminalTarget({ domain: null, panelUser: "alice", cols: 80, rows: 24 }, unreadable)).toThrow("cannot be read");
  let started = 0;
  const { audit, running } = rootSession({}, () => {
    renameSync(paths.panelDb, away);
    started = Date.now();
    return Bun.spawn(["sleep", "30"]);
  });
  await running;
  expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  expect(audit.filter((line) => line.includes("root shell ended"))).toHaveLength(1);
  expect(audit.some((line) => line.includes("CloudPanel's user list cannot be read"))).toBe(true);
});

test("a revoked shell that ignores the hangup is killed", async () => {
  allow("alice");
  const { audit, running } = rootSession({ killAfterMs: 50 }, () => Bun.spawn(["sh", "-c", "trap '' TERM; sleep 30"]));
  await Bun.sleep(30);
  change("UPDATE user SET status = 0 WHERE user_name = 'alice'");
  await running;
  expect(audit.at(-1)).toContain("signal SIGKILL");
});

test("root-access, like every terminal verb, answers only root", async () => {
  allow("alice");
  const write = process.stdout.write;
  const errWrite = process.stderr.write;
  let printed = "";
  process.stdout.write = ((chunk: string) => { printed += chunk; return true; }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    expect(await runTerminalAction(["root-access", "--panel-user=alice"], { paths, processUid: 1000 })).toBe(1);
    expect(JSON.parse(printed).error).toBe("terminal actions must run as root");
    printed = "";
    expect(await runTerminalAction(["root-access", "--panel-user=alice"], { paths, processUid: 0, env: { CLP_ADDONS_SESSION_2FA: "1" } })).toBe(0);
    expect(JSON.parse(printed).data).toEqual({ granted: true, problem: null });
  } finally {
    process.stdout.write = write;
    process.stderr.write = errWrite;
  }
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
  const refused = dashboardView([], { granted: true, problem: "A root terminal needs 2FA: turn it on in Account → Security." }, "alice");
  expect(refused).toContain('data-refusal="A root terminal needs 2FA: turn it on in Account → Security."');
  expect(refused).not.toContain("clpOpenTerminal(");
  const other = dashboardView([], { granted: false, problem: null }, "bob");
  expect(other).toContain("clp-addons terminal root allow bob on the server.");
  expect(other).toContain(`onclick="notify(this.dataset.refusal, 'error', { text: 'Account → Security', href: '/security' })"`);
  const popup = popupPage(null);
  expect(popup).toContain('data-domain=""');
  expect(popup).toContain('<span class="badge tone-bad">root</span>');
});

test("the header control is in both of CloudPanel's headers and the addons' own, for administrators, hidden until root answers", () => {
  const headers = TERMINAL_TARGETS.filter((target) => target.slug.startsWith("root-shell"));
  expect(headers.map((target) => target.template)).toEqual([
    "Frontend/Partial/header.html.twig", "Admin/Partial/header.html.twig",
    "Frontend/Partial/header.html.twig", "Admin/Partial/header.html.twig",
  ]);
  for (const target of headers) {
    const snippet = target.snippet("/addons/terminal");
    expect(snippet).toContain("{% if is_granted('ROLE_ADMIN') %}");
    expect(snippet).toContain('data-clp-root-shell style="display: none;"');
    // The account menu's copy, for phones, rides on the header item's script.
    if (target.slug.endsWith("-menu")) expect(snippet).toContain('<a class="dropdown-item" href="/addons/terminal/root"');
    else expect(snippet).toContain('fetch("/addons/terminal/api/root-access"');
    // Twig would read these as its own tags.
    expect(snippet.replace("{% if is_granted('ROLE_ADMIN') %}", "").replace("{% endif %}", "")).not.toMatch(/\{[{%#]/);
  }
  const page = renderLayout("Terminal", "", { base: "/addons/terminal", script: "" });
  expect(page).toContain('id="clp-root-shell" data-clp-root-shell hidden');
  expect(page).toContain('class="clp-root-shell-menu" data-clp-root-shell hidden');
  expect(renderLayout("Terminal", "", { base: "/addons/terminal", script: "", admin: false })).not.toContain("data-clp-root-shell");
});

test("a root access check that fails says so, rather than that root never allowed the account", async () => {
  const { mock } = await import("bun:test");
  // Module mocks outlive the test in the same process, so the real client goes back after it.
  const realGateway = { ...(await import("../lib/gateway-client")) };
  let calls = 0;
  mock.module("../lib/gateway-client", () => ({
    ...realGateway,
    callGatewayAction: async () => [
      { ok: false, error: "gateway unavailable" },
      { ok: true, data: { granted: true, problem: "CloudPanel's user list cannot be read: database is locked", unreadable: true } },
      { ok: true, data: { granted: true, problem: null } },
    ][Math.min(calls++, 2)],
  }));
  try {
    const { handle } = await import("../addons/terminal/app/index");
    const ask = async () => (await (await handle(new Request("http://x/api/root-access", { headers: { cookie: "cloudpanel=abcdef0123456789abcdef01" } }),
      "/api/root-access", null, undefined, { user: "carol", roles: ["ROLE_ADMIN"] })).json() as { data: { granted: boolean; problem: string | null } }).data;
    expect(await ask()).toEqual({ granted: false, problem: "Root terminal access could not be checked: gateway unavailable" });
    // Neither failure is cached: each next look asks again.
    expect((await ask()).problem).toContain("cannot be read");
    expect(await ask()).toEqual({ granted: true, problem: null });
  } finally {
    mock.module("../lib/gateway-client", () => realGateway);
  }
});

test("a passkey sign-in opens it with a key the account had when root allowed it, and not with a later one", () => {
  allow("alice");
  const store = (keys: string[]) => {
    mkdirSync(paths.rootAccess.securityKeys, { recursive: true });
    writeFileSync(`${paths.rootAccess.securityKeys}/credentials.json`,
      JSON.stringify({ users: { alice: { userId: 1, keys: keys.map((id) => ({ id, name: id })) } } }), { mode: 0o600 });
  };
  store(["alice-key", "added-later"]);
  expect(access("alice", "passkey:alice-key")).toEqual({ granted: true, problem: null });
  expect(access("alice", "passkey:added-later").problem).toBe("This passkey was added after root allowed you: sign in with your 2FA code, or ask root to allow you again.");
  expect(access("alice", "0").problem).toContain("used neither your 2FA code nor a passkey");
  // Removed or revoked, the key no longer opens one, even from the session it signed in.
  store(["added-later"]);
  expect(access("alice", "passkey:alice-key").problem).toContain("no longer on your account");
});


test("TOTP matches the RFC 6238 SHA-1 test vector", () => {
  expect(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1)).toBe("287082");
});
test("root verification tickets are bound to a session and single-use", () => {
  const proof = ticket();
  expect(() => auth("consume", { ticket: proof }, Date.now(), "b".repeat(64))).toThrow("Verify with 2FA");
  auth("consume", { ticket: proof });
  expect(() => auth("consume", { ticket: proof })).toThrow("Verify with 2FA");
});
test("expired tickets and challenges, replayed codes and revoked grants are refused", () => {
  const now = Date.now();
  const proof = ticket(now);
  const used = nextCode(now);
  expect(() => auth("consume", { ticket: proof }, used.at + 60001)).toThrow("Verify with 2FA");
  const challenge = auth("options", {}, now).challenge;
  expect(() => auth("verify", { challenge, code: used.code }, used.at)).toThrow("used already");
  const expired = auth("options", {}, now).challenge;
  expect(() => auth("verify", { challenge: expired, code: "123456" }, now + 300001)).toThrow("expired");
  change("UPDATE user SET mfa = 0 WHERE user_name = 'alice'");
  expect(() => auth("consume", { ticket: proof })).toThrow("needs 2FA");
});
test("the code showing counts at once, unless the session signed in with it", () => {
  change(`UPDATE user SET mfa_secret = '${SECRET}' WHERE user_name = 'alice'`);
  allow("alice");
  const now = Date.now();
  const step = Math.floor(now / 30000);
  // Signed in long ago: the code the app shows now works on a prompt that just opened.
  expect(auth("verify", { ...auth("options", {}, now), code: totp(SECRET, step) }, now).ticket).toBeString();
  clearRootAuth("alice", authStorage);
  // Signed in just now: any code CloudPanel could have taken, up to two steps ahead, is refused, however often.
  for (let i = 0; i < 3; i++) {
    for (const n of [step - 1, step, step + 1]) {
      expect(() => auth("verify", { ...auth("options", {}, now, binding, now), code: totp(SECRET, n) }, now, binding, now)).toThrow("the one you signed in with");
    }
  }
  // Not one of those spent the budget: a code from three steps on works once it shows.
  const later = (step + 3) * 30000;
  expect(auth("verify", { ...auth("options", {}, later, binding, now), code: totp(SECRET, step + 3) }, later, binding, now).ticket).toBeString();
  expect(() => auth("verify", { ...auth("options", {}, later, binding, now), code: totp(SECRET, step + 3) }, later, binding, now)).toThrow("used already");
});
test("without the gateway's sighting, the prompt's opening stands in for the sign-in", () => {
  change(`UPDATE user SET mfa_secret = '${SECRET}' WHERE user_name = 'alice'`);
  allow("alice");
  const now = Date.now();
  const step = Math.floor(now / 30000);
  const { challenge } = auth("options", {}, now, binding, null);
  expect(() => auth("verify", { challenge, code: totp(SECRET, step + 1) }, now + 30000, binding, null)).toThrow("signed in with");
  const later = (step + 3) * 30000;
  expect(auth("verify", { ...auth("options", {}, now, binding, null), code: totp(SECRET, step + 3) }, later, binding, null).ticket).toBeString();
});

test("five wrong codes throttle the account across sessions; malformed ones do not count", () => {
  change(`UPDATE user SET mfa_secret = '${SECRET}' WHERE user_name = 'alice'`);
  allow("alice");
  expect(() => auth("verify", { ...auth("options"), code: "bad" })).toThrow("six-digit");
  for (let i = 0; i < 5; i++) {
    const now = Date.now();
    expect(() => auth("verify", { ...auth("options", {}, now), code: wrongCode(now) }, now)).toThrow("Invalid code");
  }
  expect(() => auth("options", {}, Date.now(), "b".repeat(64))).toThrow("Too many failed verifications");
});
test("a session opening prompt after prompt keeps only its latest, so cancelling never fills the cap", () => {
  change(`UPDATE user SET mfa_secret = '${SECRET}' WHERE user_name = 'alice'`);
  allow("alice");
  const now = Date.now();
  let first = "";
  for (let i = 0; i < 25; i++) {
    const { challenge } = auth("options", {}, now);
    if (i === 0) first = challenge;
  }
  const next = nextCode(now);
  // The first prompt was replaced; the latest still answers.
  expect(() => auth("verify", { challenge: first, code: next.code }, next.at)).toThrow("expired");
  expect(auth("verify", { ...auth("options", {}, now), code: next.code }, next.at).ticket).toBeString();
});

test("twenty wrong codes in a day throttle the account even when spread out", () => {
  change(`UPDATE user SET mfa_secret = '${SECRET}' WHERE user_name = 'alice'`);
  allow("alice");
  const start = Date.now();
  for (let i = 0; i < 20; i++) {
    const now = start + i * 100_000;
    expect(() => auth("verify", { ...auth("options", {}, now), code: wrongCode(now) }, now)).toThrow("Invalid code");
  }
  expect(() => auth("options", {}, start + 20 * 100_000)).toThrow("Too many failed verifications");
  // Root allowing the account again lets its owner back in.
  clearRootAuth("alice", authStorage);
  expect(auth("options", {}, start + 20 * 100_000).challenge).toBeString();
});
test("only failed proofs spend the attempt budget", () => {
  change("UPDATE user SET mfa_secret = 'JBSWY3DPEHPK3PXP' WHERE user_name = 'alice'");
  allow("alice");
  const start = Date.now();
  for (let i = 0; i < 6; i++) {
    const now = start + i * 30_000;
    const next = nextCode(now);
    expect(auth("verify", { ...auth("options", {}, now), code: next.code }, next.at).ticket).toBeString();
  }
});
test("passkeys are offered only while Security Keys is on, and only those the account still has", () => {
  allow("alice");
  mkdirSync(paths.rootAccess.securityKeys, { recursive: true });
  const store = (keys: string[]) => writeFileSync(`${paths.rootAccess.securityKeys}/credentials.json`,
    JSON.stringify({ users: { alice: { userId: 1, keys: keys.map((id) => ({ id, name: id })) } } }), { mode: 0o600 });
  store(["alice-key"]);
  expect(auth("options").keys).toEqual([]);
  writeFileSync(authStorage.securityKeys, "");
  expect(auth("options").keys).toEqual(["alice-key"]);
  store([]);
  expect(auth("options").keys).toEqual([]);
});
test("a challenge cannot be answered from a different session", () => {
  allow("alice");
  const challenge = auth("options").challenge;
  expect(() => auth("verify", { challenge, code: "123456" }, Date.now(), "b".repeat(64))).toThrow("expired");
});
test("a root worker refuses a direct request without fresh verification", async () => {
  allow("alice");
  let spawned = false;
  const result = await runTerminalAction(["session", "--root", "--panel-user=alice", "--cols=80", "--rows=24"], {
    paths, rootAuthStorage: authStorage, processUid: 0,
    env: { CLP_ADDONS_SESSION_BINDING: binding, CLP_ADDONS_DUPLEX_WORKER: "1", CLP_ADDONS_SESSION_2FA: "1" },
    spawn: (() => { spawned = true; throw new Error("must not spawn"); }) as any,
  });
  expect(result).toBe(1);
  expect(spawned).toBe(false);
});
