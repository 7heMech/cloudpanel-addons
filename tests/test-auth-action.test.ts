// The root auth action is the only thing that reads CloudPanel's session files.
// It answers one line of stdin with one line of JSON, so its whole contract is
// what it accepts, what it refuses, and that nothing from the session blob
// comes back out with the answer.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_AUTH_INPUT_BYTES, createAuthActionServer, runAuthAction } from "../cli/auth-action";

const DENIED = '{"valid":false}\n';

let sessionDir = "";
let ownerUid = 0;

function authenticatedFixture(): Buffer {
  return Buffer.from(
    readFileSync(join(import.meta.dir, "fixtures/session/authenticated.txt"), "utf8")
      .split(/\r?\n/)
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .join(""),
  );
}

/** A panel database naming one user, so the DB authorization path has input. */
function panelDb(role: string, status: number): string {
  const path = `${sessionDir}/panel.sqlite`;
  rmSync(path, { force: true });
  const db = new Database(path);
  db.run("CREATE TABLE user (user_name TEXT, role TEXT, status INTEGER)");
  db.query("INSERT INTO user VALUES (?, ?, ?)").run("redacted_user", role, status);
  db.close();
  return path;
}

beforeAll(() => {
  sessionDir = mkdtempSync(`${tmpdir()}/auth-action-`);
  ownerUid = typeof process.getuid === "function" ? process.getuid() : 0;
  writeFileSync(`${sessionDir}/sess_live`, authenticatedFixture());
});

afterAll(() => {
  rmSync(sessionDir, { recursive: true, force: true });
});

test("the action emits one validated principal and expiry", async () => {
  const reply = JSON.parse(await runAuthAction("live\n", { sessionDir, ownerUid })) as Record<string, unknown>;
  expect(reply).toMatchObject({ valid: true, user: "redacted_user", expiresAt: 1893457440 });
  expect(reply.roles).toEqual(["ROLE_ADMIN"]);
});

test("the action's output contains no serialized session fields", async () => {
  const reply = await runAuthAction("live\n", { sessionDir, ownerUid });
  expect(reply).not.toInclude("_sf2_attributes");
  expect(reply).not.toInclude("mfaSecret");
});

for (const [label, input] of [
  ["a missing newline", "live"],
  ["an extra stdin field", "live\nextra\n"],
  ["oversized stdin", "a".repeat(MAX_AUTH_INPUT_BYTES + 1)],
  ["a missing session file", "missing\n"],
] as const) {
  test(`the action rejects ${label}`, async () => {
    expect(await runAuthAction(input, { sessionDir, ownerUid })).toBe(DENIED);
  });
}

test("the action rejects an invalid file owner", async () => {
  expect(await runAuthAction("live\n", { sessionDir, ownerUid: ownerUid + 1 })).toBe(DENIED);
});

// The session blob records the role the user had when they signed in. The panel
// database records the role they have now, and that is the one that decides.
test("the action reads the role from the panel database when one exists", async () => {
  const reply = JSON.parse(await runAuthAction("live\n", { sessionDir, ownerUid, panelDb: panelDb("ROLE_ADMIN", 1) }));
  expect(reply.valid).toBe(true);
  expect(reply.roles).toEqual(["ROLE_ADMIN"]);
});

test("the action honours a demotion in the panel database immediately", async () => {
  const reply = JSON.parse(await runAuthAction("live\n", { sessionDir, ownerUid, panelDb: panelDb("ROLE_SITE_MANAGER", 1) }));
  expect(reply.valid).toBe(true);
  expect(reply.roles).toEqual(["ROLE_SITE_MANAGER"]);
});

test("the action rejects a user the panel database marks inactive", async () => {
  expect(await runAuthAction("live\n", { sessionDir, ownerUid, panelDb: panelDb("ROLE_ADMIN", 0) })).toBe(DENIED);
});

test("the action rejects a user missing from the panel database", async () => {
  const path = panelDb("ROLE_ADMIN", 1);
  const db = new Database(path);
  db.run("DELETE FROM user WHERE user_name = 'redacted_user'");
  db.close();
  expect(await runAuthAction("live\n", { sessionDir, ownerUid, panelDb: path })).toBe(DENIED);
});

test("the action's daemon answers the same contract over a unix socket", async () => {
  const sockPath = `${sessionDir}/test.sock`;
  const server = createAuthActionServer({ sessionDir, ownerUid });
  await new Promise<void>((resolve) => server.listen(sockPath, resolve));
  let reply = "";
  await new Promise<void>((resolve) => {
    Bun.connect({
      unix: sockPath,
      socket: {
        open: (conn) => { conn.write("live\n"); },
        data: (_conn, chunk) => { reply += Buffer.from(chunk).toString("utf8"); },
        close: () => resolve(),
      },
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  expect(JSON.parse(reply)).toMatchObject({ valid: true, user: "redacted_user" });
});
