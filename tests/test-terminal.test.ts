// The Terminal addon below the gateway: the root worker that decides which
// account a shell runs as, the helper that owns the PTY as that account, and
// the manager's session table that treats everything the helper says as
// hostile.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionFailure } from "../cli/action-common";
import {
  parseTerminalRequest, resolveTerminalTarget, runTerminalAction, runuserCommand, type TerminalActionPaths,
} from "../addons/terminal/action";
import { MAX_INPUT_LINE_BYTES, parsePtyMessage, parsePtySize, shellEnvironment } from "../addons/terminal/pty";
import {
  ownerOf, parseHelperLine, RING_BYTES, TerminalSessions, type OpenRequest, type StreamOpener,
} from "../addons/terminal/app/sessions";

const REPO = join(import.meta.dir, "..");
let root = "";
let paths: TerminalActionPaths;

interface FixtureSite { domain: string; user: string; uid: number; shell?: string; root?: string; owner?: string }

function fixture(sites: FixtureSite[]): void {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(`${root}/home`, { recursive: true });
  const db = new Database(`${root}/panel.sqlite`);
  db.run("CREATE TABLE user (id INTEGER PRIMARY KEY, user_name TEXT, role TEXT, status INTEGER)");
  db.run("CREATE TABLE site (id INTEGER PRIMARY KEY, domain_name TEXT, user TEXT, root_directory TEXT)");
  db.run("CREATE TABLE user_sites (user_id INTEGER, site_id INTEGER)");
  db.run("INSERT INTO user VALUES (1, 'admin', 'ROLE_ADMIN', 1), (2, 'customer', 'ROLE_USER', 1)");
  const passwd: string[] = ["root:x:0:0:root:/root:/bin/bash", "clp:x:1000:1000::/home/clp:/usr/sbin/nologin"];
  sites.forEach((site, index) => {
    db.query("INSERT INTO site VALUES (?, ?, ?, ?)").run(index + 1, site.domain, site.user, site.root ?? site.domain);
    if (site.owner === "customer") db.query("INSERT INTO user_sites VALUES (2, ?)").run(index + 1);
    const home = `${root}/home/${site.user}`;
    mkdirSync(`${home}/htdocs/${site.domain}`, { recursive: true });
    passwd.push(`${site.user}:x:${site.uid}:${site.uid}::${home}:${site.shell ?? "/bin/bash"}`);
  });
  db.close();
  writeFileSync(`${root}/passwd`, passwd.join("\n") + "\n");
}

beforeAll(() => {
  root = mkdtempSync(`${tmpdir()}/terminal-action-`);
  root = realpathSync(root);
  paths = { panelDb: `${root}/panel.sqlite`, passwd: `${root}/passwd`, runuser: "/usr/sbin/runuser", homes: `${root}/home` };
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const asIs = { domainValidator: (value: string) => value };
const request = (domain: string, panelUser = "admin") => ({ domain, panelUser, cols: 80, rows: 24 });

function refusal(domain: string, panelUser = "admin"): string {
  try {
    resolveTerminalTarget(request(domain, panelUser), paths);
  } catch (error) {
    expect(error).toBeInstanceOf(ActionFailure);
    return (error as Error).message;
  }
  throw new Error(`${domain} was not refused`);
}

describe("the root worker", () => {
  test("parses only the four arguments it takes, each once", () => {
    expect(parseTerminalRequest(["session", "--domain=a.test", "--panel-user=admin", "--cols=120", "--rows=40"], asIs))
      .toEqual({ domain: "a.test", panelUser: "admin", cols: 120, rows: 40 });
    for (const argv of [
      ["shell", "--domain=a.test", "--panel-user=admin", "--cols=1", "--rows=1"],
      ["session", "--domain=a.test", "--panel-user=admin", "--cols=1", "--rows=1", "--user=root"],
      ["session", "--domain=a.test", "--panel-user=admin", "--panel-user=x", "--cols=1", "--rows=1"],
      ["session", "--domain=a.test", "--panel-user=admin", "--cols=0", "--rows=1"],
      ["session", "--domain=a.test", "--panel-user=admin", "--cols=1001", "--rows=1"],
      ["session", "--domain=a.test", "--cols=1", "--rows=1"],
    ]) {
      expect(() => parseTerminalRequest(argv, asIs)).toThrow(ActionFailure);
    }
  });

  test("resolves a site to its user and its real site root", () => {
    fixture([{ domain: "www.example.test", user: "example", uid: 2001 }]);
    expect(resolveTerminalTarget(request("www.example.test"), paths))
      .toEqual({ user: "example", dir: `${root}/home/example/htdocs/www.example.test` });
  });

  test("a site whose root is gone starts in the home", () => {
    fixture([{ domain: "www.example.test", user: "example", uid: 2001, root: "missing" }]);
    expect(resolveTerminalTarget(request("www.example.test"), paths).dir).toBe(`${root}/home/example`);
  });

  test("refuses every account it must not act as", () => {
    fixture([
      { domain: "ok.test", user: "ok", uid: 2001 },
      { domain: "root.test", user: "root", uid: 2002 },
      { domain: "clp.test", user: "clp", uid: 2003 },
      { domain: "low.test", user: "low", uid: 999 },
      { domain: "twin-a.test", user: "twina", uid: 2010 },
      { domain: "twin-b.test", user: "twinb", uid: 2010 },
      { domain: "nologin.test", user: "nologin", uid: 2020, shell: "/usr/sbin/nologin" },
      { domain: "false.test", user: "falseuser", uid: 2021, shell: "/bin/false" },
      { domain: "escape.test", user: "escape", uid: 2030, root: "../../.." },
    ]);
    expect(refusal("missing.test")).toContain("has no site");
    expect(refusal("ok.test", "customer")).toBe("that site is not yours to open");
    expect(refusal("ok.test", "nobody")).toBe("that site is not yours to open");
    expect(refusal("root.test")).toContain("cannot be used");
    expect(refusal("clp.test")).toContain("cannot be used");
    expect(refusal("low.test")).toContain("system account");
    expect(refusal("twin-a.test")).toContain("shares Unix UID 2010");
    expect(refusal("nologin.test")).toContain("no login shell");
    expect(refusal("false.test")).toContain("no login shell");
    expect(refusal("escape.test")).toContain("not inside its htdocs");
  });

  test("refuses a site root that a symlink takes outside the home", () => {
    fixture([{ domain: "link.test", user: "link", uid: 2001, root: "public" }]);
    symlinkSync("/etc", `${root}/home/link/htdocs/public`);
    expect(refusal("link.test")).toContain("resolves outside its home");
  });

  test("a non-administrator's own site is allowed through the same rules", () => {
    fixture([{ domain: "mine.test", user: "mine", uid: 2001, owner: "customer" }]);
    expect(resolveTerminalTarget(request("mine.test", "customer"), paths).user).toBe("mine");
  });

  test("runs one fixed runuser and hands it the pipes", async () => {
    fixture([{ domain: "www.example.test", user: "example", uid: 2001 }]);
    const calls: { argv: string[]; options: Record<string, unknown> }[] = [];
    const audit: string[] = [];
    let clock = 1_000;
    const code = await runTerminalAction(
      ["session", "--domain=www.example.test", "--panel-user=admin", "--cols=100", "--rows=30"],
      {
        ...asIs,
        paths,
        processUid: 0,
        env: { CLP_ADDONS_DUPLEX_WORKER: "1" },
        audit: (line) => audit.push(line),
        now: () => (clock += 61_000),
        spawn: ((argv: string[], options: Record<string, unknown>) => {
          calls.push({ argv, options });
          return Bun.spawn(["sh", "-c", "exit 3"]);
        }) as unknown as typeof Bun.spawn,
      },
    );
    expect(code).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toEqual(runuserCommand(paths, "example"));
    expect(calls[0]!.argv).toEqual([
      "/usr/sbin/runuser", "--login", "--whitelist-environment=TERM,CLP_SITE_DIR,CLP_PTY_SIZE",
      "--command=exec /usr/local/bin/clp-addons terminal-pty", "--", "example",
    ]);
    expect(calls[0]!.options.stdin).toBe("inherit");
    expect(calls[0]!.options.stdout).toBe("inherit");
    expect(calls[0]!.options.stderr).toBe("pipe");
    expect(calls[0]!.options.env).toEqual({
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      TERM: "xterm-256color",
      CLP_SITE_DIR: `${root}/home/example/htdocs/www.example.test`,
      CLP_PTY_SIZE: "100x30",
    });
    expect(audit).toEqual([
      "admin opened www.example.test as example",
      "admin closed www.example.test as example after 1m1s, exit 3",
    ]);
  });

  test("logs why a start failed, bounded and unable to pass for another journal line", async () => {
    fixture([{ domain: "www.example.test", user: "example", uid: 2001 }]);
    const audit: string[] = [];
    const code = await runTerminalAction(
      ["session", "--domain=www.example.test", "--panel-user=admin", "--cols=80", "--rows=24"],
      {
        ...asIs,
        paths,
        processUid: 0,
        env: { CLP_ADDONS_DUPLEX_WORKER: "1" },
        audit: (line) => audit.push(line),
        spawn: (() => Bun.spawn(
          ["sh", "-c", "printf 'runuser: cannot open session\\n\\033[2J\\r[terminal] admin opened x\\n' >&2; head -c 100000 /dev/zero | tr '\\0' x >&2; exit 1"],
          { stderr: "pipe" },
        )) as unknown as typeof Bun.spawn,
      },
    );
    expect(code).toBe(1);
    const logged = audit.filter((line) => line.includes(" stderr: "));
    expect(logged[0]).toBe("www.example.test stderr: runuser: cannot open session");
    expect(logged[1]).toBe("www.example.test stderr: ?[2J?[terminal] admin opened x");
    expect(logged.join("").length).toBeLessThan(8 * 1024);
    expect(audit.at(-1)).toContain("closed www.example.test as example");
  });

  test("an empty login shell field is /bin/sh, not a refusal", () => {
    fixture([{ domain: "sh.test", user: "plain", uid: 2001, shell: "" }]);
    expect(resolveTerminalTarget(request("sh.test"), paths).user).toBe("plain");
  });

  test("starts nothing unless the gateway's checked stream started it", async () => {
    fixture([{ domain: "www.example.test", user: "example", uid: 2001 }]);
    let spawned = false;
    const write = process.stdout.write;
    const errWrite = process.stderr.write;
    let printed = "";
    process.stdout.write = ((chunk: string) => { printed += chunk; return true; }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const code = await runTerminalAction(
        ["session", "--domain=www.example.test", "--panel-user=admin", "--cols=80", "--rows=24"],
        { ...asIs, paths, processUid: 0, env: {}, spawn: (() => { spawned = true; }) as unknown as typeof Bun.spawn },
      );
      expect(code).toBe(1);
    } finally {
      process.stdout.write = write;
      process.stderr.write = errWrite;
    }
    expect(spawned).toBe(false);
    expect(JSON.parse(printed).error).toBe("terminal sessions start only through the gateway's stream");
  });

  test("never reads its own stdin", () => {
    const source = Bun.file(join(REPO, "addons/terminal/action.ts"));
    return source.text().then((text) => {
      expect(text).not.toMatch(/Bun\.stdin|process\.stdin/);
    });
  });
});

describe("the helper", () => {
  test("accepts input and clamped resizes, and nothing else", () => {
    expect(parsePtyMessage('{"i":"ls\\r"}')).toEqual({ input: "ls\r" });
    expect(parsePtyMessage('{"r":[0,5000]}')).toEqual({ resize: [1, 1000] });
    expect(parsePtyMessage('{"r":[80.7,24]}')).toEqual({ resize: [80, 24] });
    for (const line of ['{"i":"a","r":[1,1]}', '{"r":[1]}', '{"r":["a",1]}', '{"x":1}', "[]", "nope", '{"i":1}']) {
      expect(parsePtyMessage(line)).toBeNull();
    }
    expect(parsePtyMessage(JSON.stringify({ i: "a".repeat(MAX_INPUT_LINE_BYTES) }))).toBeNull();
  });

  test("reads its size and drops what the addon passed down from the shell's environment", () => {
    expect(parsePtySize("120x40")).toEqual([120, 40]);
    expect(parsePtySize("0x99999")).toEqual([80, 24]);
    expect(parsePtySize(undefined)).toEqual([80, 24]);
    const env = shellEnvironment({ HOME: "/home/a", CLP_SITE_DIR: "/x", CLP_PTY_SIZE: "1x1", TERM: "dumb" }, "en_US.UTF-8");
    expect(env).toEqual({ HOME: "/home/a", TERM: "xterm-256color", LANG: "en_US.UTF-8" });
  });

  test("runs a shell in a terminal and reports how it exited", async () => {
    const dir = mkdtempSync(`${tmpdir()}/terminal-pty-`);
    try {
      const proc = Bun.spawn(["bun", "cli/index.ts", "terminal-pty"], {
        cwd: REPO,
        stdin: "pipe",
        stdout: "pipe",
        env: { PATH: process.env.PATH, HOME: dir, SHELL: "/bin/sh", CLP_SITE_DIR: dir, CLP_PTY_SIZE: "90x20" },
      });
      proc.stdin.write('{"i":"stty size; exit 7\\n"}\n');
      await proc.stdin.flush();
      const lines = (await new Response(proc.stdout).text()).trim().split("\n").map((line) => JSON.parse(line));
      expect(lines[0]).toEqual({ ready: { user: expect.any(String), dir } });
      const output = lines.filter((line) => line.o).map((line) => Buffer.from(line.o, "base64").toString()).join("");
      expect(output).toContain("20 90");
      expect(lines.at(-1)).toEqual({ exit: { code: 7, signal: null } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("hangs up on a line it does not accept", async () => {
    const proc = Bun.spawn(["bun", "cli/index.ts", "terminal-pty"], {
      cwd: REPO, stdin: "pipe", stdout: "pipe", env: { PATH: process.env.PATH, HOME: tmpdir(), SHELL: "/bin/sh" },
    });
    proc.stdin.write("not json\n");
    await proc.stdin.flush();
    // stdin stays open, so only the hang-up ends the shell. dash dies of the
    // SIGHUP or exits on the closed terminal, depending on which it sees first.
    const last = (await new Response(proc.stdout).text()).trim().split("\n").at(-1)!;
    expect([{ code: null, signal: "SIGHUP" }, { code: 0, signal: null }]).toContainEqual(JSON.parse(last).exit);
  });
});

describe("the manager's sessions", () => {
  interface FakeStream {
    request: OpenRequest;
    lines(...lines: unknown[]): void;
    close(error?: string): void;
    written: string[];
    closed: boolean;
  }

  function fakeOpener() {
    const streams: FakeStream[] = [];
    const opener: StreamOpener = (request, handlers) => {
      const stream: FakeStream = {
        request,
        written: [],
        closed: false,
        lines: (...lines) => { for (const line of lines) handlers.onLine(typeof line === "string" ? line : JSON.stringify(line)); },
        close: (error) => handlers.onClose(error),
      };
      streams.push(stream);
      return {
        write: (line) => { stream.written.push(line); },
        close: () => { stream.closed = true; },
      };
    };
    return { opener, streams };
  }

  const owner = ownerOf("admin", "session-a");
  const opening = { domain: "www.example.test", cols: 80, rows: 24, sessionId: "session-a" };
  const out = (text: string) => ({ o: Buffer.from(text).toString("base64") });

  async function opened(store: TerminalSessions, streams: FakeStream[]) {
    const pending = store.open(owner, opening);
    streams.at(-1)!.lines("Welcome to a noisy .profile", { ready: { user: "example", dir: "/home/example" } });
    const result = await pending;
    if (!result.ok) throw new Error(result.error);
    return { id: result.id, stream: streams.at(-1)! };
  }

  /** Reads server-sent events until `stop` says enough. */
  async function events(response: Response, stop: (seen: { event: string; data: string; id?: string }[]) => boolean) {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const seen: { event: string; data: string; id?: string }[] = [];
    let buffer = "";
    while (!stop(seen)) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += typeof value === "string" ? value : decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (block.startsWith(":")) continue;
        const fields = Object.fromEntries(block.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]));
        seen.push({ event: fields.event ?? "message", data: fields.data ?? "", id: fields.id });
      }
    }
    void reader.cancel().catch(() => {});
    return seen;
  }

  const attachRequest = (lastEventId?: string) =>
    new Request("https://panel.test/events", { headers: lastEventId ? { "Last-Event-ID": lastEventId } : {} });

  test("skips login noise, reports the root worker's refusal, and opens on ready", async () => {
    const { opener, streams } = fakeOpener();
    const store = new TerminalSessions({ opener });
    const refused = store.open(owner, opening);
    streams[0]!.lines({ ok: false, error: "that site is not yours to open" });
    expect(await refused).toEqual({ ok: false, error: "that site is not yours to open" });
    expect(streams[0]!.closed).toBe(true);

    const { id } = await opened(store, streams);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(streams[1]!.request).toEqual(opening);
  });

  test("a session belongs to one panel user and one sign-in", async () => {
    const { opener, streams } = fakeOpener();
    const store = new TerminalSessions({ opener });
    const { id } = await opened(store, streams);
    for (const other of [ownerOf("admin", "session-b"), ownerOf("someone", "session-a")]) {
      expect(store.attach(id, other, attachRequest())).toBeNull();
      expect(store.input(id, other, { data: "x" })).toBe(false);
      expect(store.close(id, other)).toBe(false);
    }
    expect(store.attach("unknown-id-unknown-id0", owner, attachRequest())).toBeNull();
  });

  test("replays from the last event id, or resets when that has left the ring", async () => {
    const { opener, streams } = fakeOpener();
    const store = new TerminalSessions({ opener });
    const { id, stream } = await opened(store, streams);
    stream.lines(out("hello "), out("world"));

    const first = await events(store.attach(id, owner, attachRequest())!, (seen) => seen.length >= 2);
    expect(first[0]).toEqual({ event: "session", data: JSON.stringify({ domain: "www.example.test", user: "example" }), id: undefined });
    expect(first[1]).toEqual({ event: "reset", data: Buffer.from("hello world").toString("base64"), id: "11" });

    const replay = await events(store.attach(id, owner, attachRequest("6"))!, (seen) => seen.length >= 2);
    expect(replay[1]).toEqual({ event: "message", data: Buffer.from("world").toString("base64"), id: "11" });

    // The helper coalesces to 32 KiB, so a ring's worth arrives in pieces.
    for (let sent = 0; sent < RING_BYTES; sent += 32 * 1024) stream.lines(out("x".repeat(32 * 1024)));
    const stale = await events(store.attach(id, owner, attachRequest("6"))!, (seen) => seen.length >= 2);
    expect(stale[1]!.event).toBe("reset");
    expect(Buffer.from(stale[1]!.data, "base64").byteLength).toBe(RING_BYTES);
  });

  test("anything but an exact message from the helper ends the session", async () => {
    const { opener, streams } = fakeOpener();
    const store = new TerminalSessions({ opener });
    const { id, stream } = await opened(store, streams);
    const seen = events(store.attach(id, owner, attachRequest())!, (all) => all.some((item) => item.event === "ended"));
    await Bun.sleep(10);
    stream.lines({ o: "aGk=", extra: true });
    const ended = (await seen).find((item) => item.event === "ended")!;
    expect(JSON.parse(ended.data)).toEqual({ reason: "protocol", code: null });
    expect(stream.closed).toBe(true);
    expect(store.size).toBe(0);
  });

  test("parses only the messages the helper sends", () => {
    expect(parseHelperLine('{"o":"aGk="}')).toEqual({ kind: "output", bytes: Buffer.from("hi"), encoded: "aGk=" });
    expect(parseHelperLine('{"exit":{"code":0,"signal":null}}')).toEqual({ kind: "exit", code: 0, signal: null });
    for (const line of [
      '{"o":"not base64!"}', '{"o":"aGk"}', '{"exit":{"code":256,"signal":null}}', '{"exit":{"code":0,"signal":"kill"}}',
      '{"ready":{"user":"Root User","dir":"/"}}', '{"ready":{"user":"a","dir":"/\\u001b[2J"}}', '{"ok":true,"data":{}}',
    ]) {
      expect(parseHelperLine(line)).toBeNull();
    }
  });

  test("input goes out in pieces under the helper's line limit, size first", async () => {
    const { opener, streams } = fakeOpener();
    const store = new TerminalSessions({ opener });
    const { id, stream } = await opened(store, streams);
    const paste = "\u0001".repeat(20_000);
    expect(store.input(id, owner, { data: paste, size: [100, 30] })).toBe(true);
    expect(JSON.parse(stream.written[0]!)).toEqual({ r: [100, 30] });
    const pieces = stream.written.slice(1).map((line) => JSON.parse(line).i as string);
    expect(pieces.join("")).toBe(paste);
    for (const line of stream.written) expect(Buffer.byteLength(line)).toBeLessThan(MAX_INPUT_LINE_BYTES);
  });

  test("a session nobody is watching ends after its grace, and a closing popup gets a shorter one", async () => {
    const { opener, streams } = fakeOpener();
    const store = new TerminalSessions({ opener, detachedGraceMs: 40, closingGraceMs: 10 });
    const detached = await opened(store, streams);
    await Bun.sleep(80);
    expect(detached.stream.closed).toBe(true);

    const slow = new TerminalSessions({ opener, detachedGraceMs: 5_000, closingGraceMs: 20 });
    const closing = await opened(slow, streams);
    expect(slow.close(closing.id, owner)).toBe(true);
    await Bun.sleep(60);
    expect(closing.stream.closed).toBe(true);
  });

  test("an operator who signs out loses the session", async () => {
    const { opener, streams } = fakeOpener();
    const store = new TerminalSessions({ opener, authorize: async () => false, authRecheckMs: 20, authConfirmMs: 10 });
    const { id, stream } = await opened(store, streams);
    const seen = await events(store.attach(id, owner, attachRequest())!, (all) => all.some((item) => item.event === "ended"));
    expect(JSON.parse(seen.at(-1)!.data)).toEqual({ reason: "signed-out", code: null });
    expect(stream.closed).toBe(true);
  });

  test("one failed check that the next look contradicts keeps the session", async () => {
    const { opener, streams } = fakeOpener();
    let checks = 0;
    const store = new TerminalSessions({ opener, authorize: async () => ++checks !== 1, authRecheckMs: 20, authConfirmMs: 30 });
    const { id, stream } = await opened(store, streams);
    const response = store.attach(id, owner, attachRequest())!;
    await Bun.sleep(150);
    expect(checks).toBeGreaterThan(2);
    expect(stream.closed).toBe(false);
    void response.body!.cancel().catch(() => {});
  });

  test("a second window takes the session over and the first is told it moved", async () => {
    const { opener, streams } = fakeOpener();
    const store = new TerminalSessions({ opener });
    const { id, stream } = await opened(store, streams);
    const first = events(store.attach(id, owner, attachRequest())!, () => false);
    await Bun.sleep(10);
    const second = events(store.attach(id, owner, attachRequest())!, (seen) => seen.length >= 3);
    expect((await first).map((item) => item.event)).toEqual(["session", "reset", "moved"]);
    stream.lines(out("still here"));
    expect((await second)[2]).toEqual({ event: "message", data: Buffer.from("still here").toString("base64"), id: "10" });
    expect(stream.closed).toBe(false);
  });

  test("a batch sent again after a network error is typed once", async () => {
    const { opener, streams } = fakeOpener();
    const store = new TerminalSessions({ opener });
    const { id, stream } = await opened(store, streams);
    const batch = (writer: string, seq: number) => ({ data: "ls\r", batch: { writer, seq } });
    expect(store.input(id, owner, batch("a", 1))).toBe(true);
    expect(store.input(id, owner, batch("a", 1))).toBe(true);
    expect(store.input(id, owner, batch("a", 2))).toBe(true);
    // A reloaded window numbers from the start again.
    expect(store.input(id, owner, batch("b", 1))).toBe(true);
    expect(stream.written).toHaveLength(3);
  });

  test("the shell's exit is the last event, and a popup that missed it is told on return", async () => {
    const { opener, streams } = fakeOpener();
    const store = new TerminalSessions({ opener });
    const { id, stream } = await opened(store, streams);
    stream.lines(out("bye"), { exit: { code: 2, signal: null } });
    const seen = await events(store.attach(id, owner, attachRequest())!, (all) => all.some((item) => item.event === "ended"));
    expect(seen.map((item) => item.event)).toEqual(["session", "reset", "ended"]);
    expect(JSON.parse(seen[2]!.data)).toEqual({ reason: "exit", code: 2 });
    expect(store.size).toBe(0);
  });
});
