// The gateway's one duplex verb. What is pinned here is that root decides the
// session itself, copies bytes it never reads, and stops the worker when the
// session or the socket goes -- and that no other stream changed shape.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthActionServer } from "../cli/auth-action";
import { parseGatewayRequest } from "../lib/gateway-protocol";

let dir = "";
let ownerUid = 0;

function sessionFixture(): Buffer {
  return Buffer.from(
    readFileSync(join(import.meta.dir, "fixtures/session/authenticated.txt"), "utf8")
      .split(/\r?\n/)
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .join(""),
  );
}

function setRole(role: string, status = 1): string {
  const path = `${dir}/panel.sqlite`;
  rmSync(path, { force: true });
  const db = new Database(path);
  db.run("CREATE TABLE user (user_name TEXT, role TEXT, status INTEGER)");
  db.query("INSERT INTO user VALUES (?, ?, ?)").run("redacted_user", role, status);
  db.close();
  return path;
}

beforeAll(() => {
  dir = mkdtempSync(`${tmpdir()}/terminal-gateway-`);
  ownerUid = process.getuid?.() ?? 0;
  writeFileSync(`${dir}/sess_live`, sessionFixture());
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Spawned {
  argv: string[];
  options: Record<string, unknown>;
  proc: ReturnType<typeof Bun.spawn>;
}

/** A gateway whose worker is `command` in place of the CLI, recording each spawn. */
async function gateway(command: string[], options: { sessionRecheckMs?: number } = {}) {
  const spawned: Spawned[] = [];
  const socketPath = `${dir}/gw-${Math.random().toString(36).slice(2)}.sock`;
  const spawn = ((argv: string[], spawnOptions: Record<string, unknown>) => {
    const proc = Bun.spawn(command, spawnOptions as never);
    spawned.push({ argv, options: spawnOptions, proc });
    return proc;
  }) as unknown as typeof Bun.spawn;
  const server = createAuthActionServer({
    enforcePeer: false, sessionDir: dir, ownerUid, panelDb: `${dir}/panel.sqlite`, spawn, ...options,
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    spawned,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    connect: () => client(socketPath),
  };
}

async function client(socketPath: string) {
  let received = "";
  let closed = false;
  let resolveClosed: () => void = () => {};
  const done = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_socket, chunk) { received += Buffer.from(chunk).toString("utf8"); },
      close() { closed = true; resolveClosed(); },
      error() {},
    },
  });
  return {
    socket,
    done,
    get received() { return received; },
    get closed() { return closed; },
  };
}

async function until(condition: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
}

const terminalRequest = (extra: Record<string, unknown> = {}) => JSON.stringify({
  kind: "stream-action", addon: "terminal", verb: "session",
  args: ["--domain=www.example.com", "--cols=80", "--rows=24"], sessionId: "live", ...extra,
}) + "\n";

test("only the first line is the request; what follows is never parsed as part of it", () => {
  expect(parseGatewayRequest('{"kind":"panel-info"}\n{"kind":"auth","sessionId":"x"}\n')).toEqual({ kind: "panel-info" });
  expect(parseGatewayRequest(terminalRequest() + "garbage")).toMatchObject({ kind: "stream-action", sessionId: "live" });
});

test("an administrator's session starts the worker as that user and copies bytes both ways in order", async () => {
  setRole("ROLE_ADMIN");
  const gw = await gateway(["cat"]);
  try {
    const c = await gw.connect();
    c.socket.write(terminalRequest() + "first,");
    await until(() => gw.spawned.length === 1);
    c.socket.write("second,");
    await Bun.sleep(20);
    c.socket.write("third\n");
    await until(() => c.received.includes("third"));
    expect(c.received).toBe("first,second,third\n");
    const { argv, options } = gw.spawned[0]!;
    expect(argv.slice(1)).toEqual([
      "action", "terminal", "session", "--domain=www.example.com", "--cols=80", "--rows=24", "--panel-user=redacted_user",
    ]);
    expect(options.stdin).toBe("pipe");
    expect(Object.keys(options.env as object)).toEqual(["PATH"]);
    // The session id rides on the request, never on a command line.
    expect(argv.join(" ")).not.toContain("live");
    c.socket.end();
    await c.done;
  } finally {
    await gw.close();
  }
});

test("a request line split across reads still starts one worker", async () => {
  setRole("ROLE_ADMIN");
  const gw = await gateway(["cat"]);
  try {
    const c = await gw.connect();
    const line = terminalRequest();
    c.socket.write(line.slice(0, 30));
    await Bun.sleep(30);
    expect(gw.spawned.length).toBe(0);
    c.socket.write(line.slice(30) + "hello\n");
    await until(() => c.received.includes("hello"));
    expect(gw.spawned.length).toBe(1);
    c.socket.end();
    await c.done;
  } finally {
    await gw.close();
  }
});

for (const [label, prepare, sessionId] of [
  ["a forged session id", () => setRole("ROLE_ADMIN"), "forged"],
  ["a site manager's session", () => setRole("ROLE_SITE_MANAGER"), "live"],
  ["a deactivated administrator", () => setRole("ROLE_ADMIN", 0), "live"],
] as const) {
  test(`${label} starts nothing`, async () => {
    prepare();
    const gw = await gateway(["cat"]);
    try {
      const c = await gw.connect();
      c.socket.write(terminalRequest({ sessionId }));
      await c.done;
      expect(JSON.parse(c.received)).toEqual({ ok: false, error: "the panel session is not an active administrator's" });
      expect(gw.spawned.length).toBe(0);
    } finally {
      await gw.close();
    }
  });
}

test("the session is required for the duplex verb and refused for every other stream", async () => {
  setRole("ROLE_ADMIN");
  const gw = await gateway(["cat"]);
  try {
    const missing = await gw.connect();
    missing.socket.write(terminalRequest({ sessionId: undefined }));
    await missing.done;
    expect(JSON.parse(missing.received).error).toBe("a panel session is required");

    const other = await gw.connect();
    other.socket.write(JSON.stringify({ kind: "stream-action", addon: "manager", verb: "watch-job", args: ["--id=x"], sessionId: "live" }) + "\n");
    await other.done;
    expect(JSON.parse(other.received).error).toBe("invalid verb");
    expect(gw.spawned.length).toBe(0);
  } finally {
    await gw.close();
  }
});

test("the manager cannot name the panel user", async () => {
  setRole("ROLE_ADMIN");
  const gw = await gateway(["cat"]);
  try {
    const c = await gw.connect();
    c.socket.write(terminalRequest({ args: ["--domain=www.example.com", "--panel-user=someone-else"] }));
    await c.done;
    expect(JSON.parse(c.received).error).toBe("invalid arguments");
    expect(gw.spawned.length).toBe(0);
  } finally {
    await gw.close();
  }
});

test("a session that lapses mid-stream stops the worker within one recheck", async () => {
  setRole("ROLE_ADMIN");
  const gw = await gateway(["sleep", "30"], { sessionRecheckMs: 50 });
  try {
    const c = await gw.connect();
    c.socket.write(terminalRequest());
    await until(() => gw.spawned.length === 1);
    setRole("ROLE_USER");
    await c.done;
    await gw.spawned[0]!.proc.exited;
    expect(gw.spawned[0]!.proc.signalCode).toBe("SIGTERM");
  } finally {
    await gw.close();
  }
});

test("closing the socket stops the worker", async () => {
  setRole("ROLE_ADMIN");
  const gw = await gateway(["sleep", "30"]);
  try {
    const c = await gw.connect();
    c.socket.write(terminalRequest());
    await until(() => gw.spawned.length === 1);
    c.socket.end();
    await gw.spawned[0]!.proc.exited;
    expect(gw.spawned[0]!.proc.signalCode).toBe("SIGTERM");
  } finally {
    await gw.close();
  }
});

test("other streams still ignore what follows the request line", async () => {
  const gw = await gateway(["echo", '{"ok":true}']);
  try {
    const c = await gw.connect();
    c.socket.write(JSON.stringify({ kind: "stream-action", addon: "manager", verb: "watch-job", args: ["--id=x"] }) + "\nignored bytes");
    await c.done;
    expect(c.received).toBe('{"ok":true}\n');
    expect(gw.spawned[0]!.options.stdin).toBe("ignore");
  } finally {
    await gw.close();
  }
});
