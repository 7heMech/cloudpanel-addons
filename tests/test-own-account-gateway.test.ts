// The one-shot actions that act on the caller's own panel account. The gateway
// reads whose account from the session it is sent, never from the manager.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthActionServer } from "../cli/auth-action";

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
  db.run("CREATE TABLE user (user_name TEXT, role TEXT, status INTEGER)");
  // An ordinary panel user: these verbs are for every account, not only admins.
  db.query("INSERT INTO user VALUES (?, ?, ?)").run("redacted_user", "ROLE_USER", 1);
  db.close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function ask(request: Record<string, unknown>): Promise<{ reply: unknown; argv: string[] | null; env?: Record<string, string> }> {
  let argv: string[] | null = null;
  let env: Record<string, string> = {};
  const spawn = ((args: string[], options: Record<string, unknown>) => {
    argv = args;
    env = options.env as Record<string, string>;
    return Bun.spawn(["echo", '{"ok":true}'], options as never);
  }) as unknown as typeof Bun.spawn;
  const socketPath = `${dir}/gw-${Math.random().toString(36).slice(2)}.sock`;
  const server = createAuthActionServer({
    enforcePeer: false, sessionDir: dir, ownerUid: process.getuid?.() ?? 0, panelDb: `${dir}/panel.sqlite`, spawn,
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
