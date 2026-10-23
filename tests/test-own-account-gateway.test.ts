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
  writeFileSync(`${dir}/sess_live`, readFileSync(join(import.meta.dir, "fixtures/session/authenticated.txt"), "utf8")
    .split(/\r?\n/).filter((line) => line.length > 0 && !line.startsWith("#")).join(""));
  const db = new Database(`${dir}/panel.sqlite`);
  db.run("CREATE TABLE user (user_name TEXT, role TEXT, status INTEGER)");
  // An ordinary panel user: these verbs are for every account, not only admins.
  db.query("INSERT INTO user VALUES (?, ?, ?)").run("redacted_user", "ROLE_USER", 1);
  db.close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function ask(request: Record<string, unknown>): Promise<{ reply: unknown; argv: string[] | null }> {
  let argv: string[] | null = null;
  const spawn = ((args: string[], options: Record<string, unknown>) => {
    argv = args;
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
    return { reply: JSON.parse(received), argv };
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
