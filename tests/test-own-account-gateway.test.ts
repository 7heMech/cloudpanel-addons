// The one-shot actions that act on the caller's own panel account. The gateway
// reads whose account from the session it is sent, never from the manager.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthActionServer } from "../cli/auth-action";
import { mfaMark } from "../addons/security-keys/sign-ins";

let dir = "";

beforeAll(() => {
  dir = mkdtempSync(`${tmpdir()}/own-account-gateway-`);
  const session = readFileSync(join(import.meta.dir, "fixtures/session/authenticated.txt"), "utf8")
    .split(/\r?\n/).filter((line) => line.length > 0 && !line.startsWith("#")).join("");
  writeFileSync(`${dir}/sess_live`, session);
  // Signed in while the account had no 2FA, so CloudPanel never wrote the marker.
  writeFileSync(`${dir}/sess_nomfa`, session
    .replace('a:2:{s:16:"mfaAuthenticated";b:1;', "a:1:{")
    .replace("\u0000App\\Entity\\User\u0000mfa\";b:1;", "\u0000App\\Entity\\User\u0000mfa\";b:0;"));
  const db = new Database(`${dir}/panel.sqlite`);
  db.run("CREATE TABLE user (user_name TEXT, role TEXT, status INTEGER, mfa INTEGER, mfa_secret TEXT)");
  // An ordinary panel user: these verbs are for every account, not only admins.
  db.query("INSERT INTO user VALUES (?, ?, ?, ?, ?)").run("redacted_user", "ROLE_USER", 1, 1, "SECRET1");
  db.close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function ask(request: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<{ reply: unknown; argv: string[] | null; env?: Record<string, string> }> {
  let argv: string[] | null = null;
  let env: Record<string, string> = {};
  const spawn = ((args: string[], options: Record<string, unknown>) => {
    argv = args;
    env = options.env as Record<string, string>;
    return Bun.spawn(["echo", '{"ok":true}'], options as never);
  }) as unknown as typeof Bun.spawn;
  const socketPath = `${dir}/gw-${Math.random().toString(36).slice(2)}.sock`;
  const server = createAuthActionServer({
    enforcePeer: false, sessionDir: dir, ownerUid: process.getuid?.() ?? 0, panelDb: `${dir}/panel.sqlite`, spawn, ...extra,
  });
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
    socket.write(JSON.stringify({ kind: "action", ...request }) + "\n");
    await done.promise;
    // Only a worker that ran has an environment.
    return { reply: JSON.parse(received), argv, ...(argv ? { env } : {}) };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("the session's own user is passed on, and the session id is not", async () => {
  const { reply, argv } = await ask({ addon: "security-keys", verb: "keys", sessionId: "live" });
  expect(reply).toEqual({ ok: true });
  expect(argv!.slice(1)).toEqual(["action", "security-keys", "keys", "--panel-user=redacted_user"]);
  expect(argv!.join(" ")).not.toContain("live");
});

test("an own-account verb without a session, or with a bad one, never runs", async () => {
  expect(await ask({ addon: "security-keys", verb: "keys" })).toEqual({ reply: { ok: false, error: "a panel session is required" }, argv: null });
  expect(await ask({ addon: "security-keys", verb: "keys", sessionId: "gone" }))
    .toEqual({ reply: { ok: false, error: "the panel session is not valid" }, argv: null });
});

test("the manager cannot name the user itself", async () => {
  expect(await ask({ addon: "security-keys", verb: "remove", args: ["--panel-user=admin"], sessionId: "live" }))
    .toEqual({ reply: { ok: false, error: "invalid arguments" }, argv: null });
});

test("any other verb refuses a session rather than ignoring it", async () => {
  expect(await ask({ addon: "security-keys", verb: "users", sessionId: "live" })).toEqual({ reply: { ok: false, error: "invalid verb" }, argv: null });
  const { argv } = await ask({ addon: "security-keys", verb: "login-options" });
  expect(argv!.slice(1)).toEqual(["action", "security-keys", "login-options"]);
});

test("the worker is told whether the session passed 2FA, which the manager cannot claim", async () => {
  expect((await ask({ addon: "security-keys", verb: "keys", sessionId: "live" })).env!.CLP_ADDONS_SESSION_2FA).toBe("1");
  const unmarked = await ask({ addon: "security-keys", verb: "keys", sessionId: "nomfa" });
  expect(unmarked.argv!.at(-1)).toBe("--panel-user=redacted_user");
  expect(unmarked.env!.CLP_ADDONS_SESSION_2FA).toBe("0");
});

test("the worker is told when the gateway first saw the session, which later requests keep", async () => {
  const before = Date.now();
  const first = Number((await ask({ addon: "security-keys", verb: "keys", sessionId: "live" })).env!.CLP_ADDONS_SESSION_SEEN);
  expect(first).toBeLessThanOrEqual(Date.now());
  await Bun.sleep(5);
  expect(Number((await ask({ addon: "security-keys", verb: "keys", sessionId: "live" })).env!.CLP_ADDONS_SESSION_SEEN)).toBe(first);
  expect(first).toBeGreaterThan(0);
  expect(before - first).toBeLessThan(60_000);
});

test("a root verification is bound to the session it came with", async () => {
  const process_ = process.env;
  // The gateway's own environment never reaches the worker as a session's.
  process.env = { ...process_, CLP_ADDONS_SESSION_BINDING: "f".repeat(64) };
  try {
    const { env } = await ask({ addon: "terminal", verb: "root-auth-verify", sessionId: "live" });
    expect(env!.CLP_ADDONS_SESSION_BINDING).toBe(createHash("sha256").update("live").digest("hex"));
    const { env: sessionless } = await ask({ addon: "security-keys", verb: "login-options" });
    expect(sessionless!.CLP_ADDONS_SESSION_BINDING).toBe("");
  } finally {
    process.env = process_;
  }
});

test("a session CloudPanel opened from a passkey sign-in's token names that key", async () => {
  const keysDir = join(dir, "security-keys");
  mkdirSync(keysDir, { recursive: true });
  // The fixture session was created at 1893455900.
  const mark = mfaMark(`${dir}/panel.sqlite`, "redacted_user");
  const signIns = (at: number, mfa: string | null = mark) => {
    rmSync(join(keysDir, "sign-ins.json"), { force: true });
    writeFileSync(join(keysDir, "sign-ins.json"), JSON.stringify({ signIns: [{ user: "redacted_user", key: "k1", at, mfa }] }), { mode: 0o600 });
  };
  const state = { securityKeys: true, securityKeysState: { dir: keysDir, uid: process.getuid?.() ?? 0 } };
  const proof = async () => (await ask({ addon: "security-keys", verb: "keys", sessionId: "nomfa" }, state)).env!.CLP_ADDONS_SESSION_2FA;
  signIns(1893455890);
  expect(await proof()).toBe("passkey:k1");
  // Signed in while the account had no 2FA, a password session in the same window would look the same.
  signIns(1893455890, null);
  expect(await proof()).toBe("0");
  // 2FA set up again since the sign-in: it could have been off while this session signed in.
  signIns(1893455890, "0".repeat(64));
  expect(await proof()).toBe("0");
  // A sign-in whose token had expired before the session began is not this session's.
  signIns(1893455700);
  expect((await ask({ addon: "security-keys", verb: "keys", sessionId: "nomfa" }, state)).env!.CLP_ADDONS_SESSION_2FA).toBe("0");
  // Nor is any with Security Keys off.
  expect((await ask({ addon: "security-keys", verb: "keys", sessionId: "nomfa" }, { ...state, securityKeys: false })).env!.CLP_ADDONS_SESSION_2FA).toBe("0");
});
