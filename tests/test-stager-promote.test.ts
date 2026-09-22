// Promote: the return leg of a clone.
//
// The parts exercised here are the ones that decide whether a live site keeps
// its data: the credential channel's fixed shape, the preflight refusals, the
// route's refusal to promote anything but a finished clone, and the two
// maintenance passes that put an interrupted switch back and take the retained
// document roots away again.

import { describe, expect, it, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  dropExpiredPromoteRoots, parsePromoteCredentials, recoverInterruptedPromotions,
  type StagerActionPaths,
} from "../addons/stager/action";
import { handle } from "../addons/stager/app/index";
import { stagerService, type JobView } from "../addons/stager/app/service";
import { promoteListView, promoteView } from "../addons/stager/app/views";

const repo = join(import.meta.dir, "..");

function runAction(paths: Record<string, string>, argv: string[]): { code: number; output: string } {
  // The action refuses to touch a domain without the panel's own identity file,
  // which only root can own. Stubbing the read is what lets the refusals below
  // be the real ones rather than that one.
  const script = `
    import { mock } from "bun:test";
    Object.defineProperty(process, "getuid", { value: () => 0, configurable: true });
    const realCommon = await import("./cli/action-common.ts");
    mock.module("./cli/action-common.ts", () => ({
      ...realCommon,
      readPanelIdentity: () => ({ primary: "panel.example.test", aliases: [] }),
    }));
    const { runStagerAction } = await import("./addons/stager/action.ts");
    const code = await runStagerAction(${JSON.stringify(argv)}, { paths: ${JSON.stringify(paths)} });
    process.exit(code);
  `;
  try {
    const output = execFileSync(process.execPath, ["-e", script], { cwd: repo, encoding: "utf8" });
    return { code: 0, output: output.trim() };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    return { code: failure.status ?? 1, output: (failure.stdout ?? "").trim() };
  }
}

function panelWith(dbPath: string, sites: Array<[string, string, string]>): void {
  const inserts = sites
    .map(([domain, type, user], index) =>
      `db.query("INSERT INTO site (id, domain_name, type, user, root_directory, application) VALUES (?, ?, ?, ?, ?, ?)")` +
      `.run(${index + 1}, ${JSON.stringify(domain)}, ${JSON.stringify(type)}, ${JSON.stringify(user)}, ` +
      `${JSON.stringify(`/home/${user}/htdocs/${domain}`)}, "Generic");`)
    .join("\n");
  const script = `
    import { Database } from "bun:sqlite";
    const db = new Database(${JSON.stringify(dbPath)});
    db.run("CREATE TABLE site (id INTEGER PRIMARY KEY, domain_name TEXT, type TEXT, user TEXT, root_directory TEXT, application TEXT, reverse_proxy_url TEXT, vhost_template TEXT)");
    db.run("CREATE TABLE php_settings (site_id INTEGER, php_version TEXT)");
    db.run("CREATE TABLE database (id INTEGER PRIMARY KEY, site_id INTEGER, name TEXT)");
    ${inserts}
    db.close();
  `;
  execFileSync(process.execPath, ["-e", script], { cwd: repo, encoding: "utf8" });
}

function writeJob(dir: string, fields: Record<string, string>): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [field, value] of Object.entries(fields)) {
    writeFileSync(join(dir, field), `${value}\n`, { mode: 0o600 });
  }
}

describe("the promote credential channel", () => {
  it("takes exactly four lines", () => {
    const parsed = parsePromoteCredentials("staging-pw\n123456\nlive-pw\n654321\n");
    expect(parsed).toEqual({ password: "staging-pw", mfa: "123456", targetPassword: "live-pw", targetMfa: "654321" });
  });

  it("accepts empty authentication codes but not empty passwords", () => {
    expect(parsePromoteCredentials("staging-pw\n\nlive-pw\n\n").mfa).toBe("");
    expect(() => parsePromoteCredentials("\n\nlive-pw\n\n")).toThrow(/staging instance's admin password/);
    expect(() => parsePromoteCredentials("staging-pw\n\n\n\n")).toThrow(/live instance's admin password/);
  });

  it("refuses a channel whose field count does not match, so a newline in a password cannot pass as one", () => {
    expect(() => parsePromoteCredentials("staging-pw\n123456\nlive-pw\n")).toThrow(/exactly four lines/);
    expect(() => parsePromoteCredentials("staging\npw\n123456\nlive-pw\n\n")).toThrow(/exactly four lines/);
  });
});

test("promote refuses a pair of sites it cannot safely act on", () => {
  const root = mkdtempSync(join(tmpdir(), "clp-stager-promote-"));
  const panelDb = join(root, "panel.db");
  const paths = { panelDb, lockDir: join(root, "locks"), jobsDir: join(root, "jobs"), tempDir: root };
  try {
    panelWith(panelDb, [
      ["live.example.test", "php", "live"],
      ["stg.example.test", "php", "stg"],
      ["node.example.test", "nodejs", "node"],
      ["static.example.test", "static", "stat"],
    ]);

    const same = runAction(paths, ["promote", "--source", "live.example.test", "--target", "live.example.test"]);
    expect(same.code).toBe(1);
    expect(same.output).toContain("the same site");

    const missing = runAction(paths, ["promote", "--source", "stg.example.test", "--target", "gone.example.test"]);
    expect(missing.code).toBe(1);
    expect(missing.output).toContain("no CloudPanel site for gone.example.test");

    const wrongType = runAction(paths, ["promote", "--source", "stg.example.test", "--target", "node.example.test"]);
    expect(wrongType.code).toBe(1);
    expect(wrongType.output).toContain("a promote does not change a site's type");

    const mismatch = runAction(paths, ["promote", "--source", "stg.example.test", "--target", "static.example.test"]);
    expect(mismatch.code).toBe(1);
    expect(mismatch.output).toContain("a promote does not change a site's type");

    // A PHP promote takes no Instatic credentials at all.
    const stray = runAction(paths, [
      "promote", "--source", "stg.example.test", "--target", "live.example.test", "--email", "a@example.test",
    ]);
    expect(stray.code).toBe(1);
    expect(stray.output).toContain("apply only to promoting an Instatic site");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promote refuses the flags that belong to a clone", () => {
  const root = mkdtempSync(join(tmpdir(), "clp-stager-promote-"));
  const panelDb = join(root, "panel.db");
  const paths = { panelDb, lockDir: join(root, "locks"), jobsDir: join(root, "jobs"), tempDir: root };
  try {
    panelWith(panelDb, [["live.example.test", "php", "live"], ["stg.example.test", "php", "stg"]]);
    const withPort = runAction(paths, [
      "promote", "--source", "stg.example.test", "--target", "live.example.test", "--port", "39001",
    ]);
    expect(withPort.code).toBe(1);
    expect(withPort.output).toContain("promote takes --source, --target");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an interrupted switch puts the live document root back", () => {
  const root = mkdtempSync(join(tmpdir(), "clp-stager-promote-"));
  const jobsDir = join(root, "jobs");
  const liveRoot = join(root, "htdocs", "live.example.test");
  const prevRoot = join(root, "htdocs", ".clp-stager-prev-live.example.test-20260916T090000Z-aabbcc");
  try {
    mkdirSync(prevRoot, { recursive: true });
    writeFileSync(join(prevRoot, "index.php"), "live\n");
    writeJob(join(jobsDir, "20260916T090000Z-aabbcc"), {
      kind: "promote",
      source: "stg.example.test",
      target: "live.example.test",
      state: "failed",
      swap: "moved",
      liveRoot,
      prevRoot,
      createdAt: "2026-09-16T09:00:00Z",
    });

    const paths = { jobsDir } as unknown as StagerActionPaths;
    expect(recoverInterruptedPromotions(paths)).toBe(1);
    expect(statSync(liveRoot).isDirectory()).toBe(true);
    expect(Bun.file(join(liveRoot, "index.php")).size).toBeGreaterThan(0);
    // Idempotent: a second pass has nothing left to do.
    expect(recoverInterruptedPromotions(paths)).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a completed switch is left alone, and so is a job still running", async () => {
  const root = mkdtempSync(join(tmpdir(), "clp-stager-promote-"));
  const jobsDir = join(root, "jobs");
  const liveRoot = join(root, "htdocs", "live.example.test");
  const prevRoot = join(root, "htdocs", ".clp-stager-prev-live.example.test-20260916T090000Z-aabbcc");
  try {
    mkdirSync(liveRoot, { recursive: true });
    writeFileSync(join(liveRoot, "index.php"), "promoted\n");
    mkdirSync(prevRoot, { recursive: true });
    writeJob(join(jobsDir, "20260916T090000Z-aabbcc"), {
      kind: "promote", source: "stg.example.test", target: "live.example.test",
      state: "done", swap: "done", liveRoot, prevRoot, createdAt: "2026-09-16T09:00:00Z",
    });
    writeJob(join(jobsDir, "20260916T100000Z-ddeeff"), {
      kind: "promote", source: "stg.example.test", target: "other.example.test",
      state: "running", swap: "moved", liveRoot: join(root, "htdocs", "other.example.test"),
      prevRoot, createdAt: "2026-09-16T10:00:00Z",
    });

    const paths = { jobsDir } as unknown as StagerActionPaths;
    expect(recoverInterruptedPromotions(paths)).toBe(0);
    expect(await Bun.file(join(liveRoot, "index.php")).text()).toBe("promoted\n");
    expect(statSync(prevRoot).isDirectory()).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a replaced document root goes away with the record that named it", () => {
  const root = mkdtempSync(join(tmpdir(), "clp-stager-promote-"));
  const jobsDir = join(root, "jobs");
  const expired = join(root, "htdocs", ".clp-stager-prev-live.example.test-20260801T090000Z-aabbcc");
  const recent = join(root, "htdocs", ".clp-stager-prev-live.example.test-20260916T090000Z-ddeeff");
  try {
    mkdirSync(expired, { recursive: true });
    mkdirSync(recent, { recursive: true });
    const oldJob = join(jobsDir, "20260801T090000Z-aabbcc");
    writeJob(oldJob, {
      kind: "promote", source: "stg.example.test", target: "live.example.test",
      state: "done", swap: "done", prevRoot: expired, createdAt: "2026-08-01T09:00:00Z",
    });
    const stale = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    utimesSync(oldJob, stale, stale);
    writeJob(join(jobsDir, "20260916T090000Z-ddeeff"), {
      kind: "promote", source: "stg.example.test", target: "live.example.test",
      state: "done", swap: "done", prevRoot: recent, createdAt: "2026-09-16T09:00:00Z",
    });

    const paths = { jobsDir } as unknown as StagerActionPaths;
    expect(dropExpiredPromoteRoots(paths)).toBe(1);
    expect(() => statSync(expired)).toThrow();
    expect(statSync(recent).isDirectory()).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only a path this addon put there is ever removed", () => {
  const root = mkdtempSync(join(tmpdir(), "clp-stager-promote-"));
  const jobsDir = join(root, "jobs");
  const notOurs = join(root, "htdocs", "live.example.test");
  try {
    mkdirSync(notOurs, { recursive: true });
    const dir = join(jobsDir, "20260801T090000Z-aabbcc");
    writeJob(dir, {
      kind: "promote", source: "stg.example.test", target: "live.example.test",
      state: "done", swap: "done", prevRoot: notOurs, createdAt: "2026-08-01T09:00:00Z",
    });
    const stale = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    utimesSync(dir, stale, stale);

    expect(dropExpiredPromoteRoots({ jobsDir } as unknown as StagerActionPaths)).toBe(0);
    expect(statSync(notOurs).isDirectory()).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function mockClone(overrides: Partial<JobView> = {}): JobView {
  return {
    id: "20260916T090000Z-a1b2c3",
    kind: "clone",
    source: "live.example.test",
    target: "stg.example.test",
    port: 0,
    state: "done",
    step: "",
    error: "",
    panelSite: true,
    createdAt: "2026-09-16T09:00:00Z",
    startedAt: "2026-09-16T09:00:01Z",
    finishedAt: "2026-09-16T09:05:00Z",
    result: {
      siteType: "php", siteUser: "stg", phpVersion: "8.3", vhostTemplate: "WordPress",
      vhostCarried: true, vhostCarriedBy: "template", database: null, instatic: null, notes: [],
    },
    ...overrides,
  };
}

function promoteRequest(body: Record<string, unknown>): Request {
  return new Request("https://panel.example.test:8443/addons/stager/api/promotions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://panel.example.test:8443",
      Host: "panel.example.test:8443",
      Cookie: "clp_addons_csrf=token",
      "x-clp-addons-csrf": "token",
    },
    body: JSON.stringify(body),
  });
}

describe("the promote route", () => {
  it("promotes only a finished clone, and reads it backwards", async () => {
    const started: Array<[string, string]> = [];
    const original = { getJob: stagerService.getJob, startPromote: stagerService.startPromote };
    stagerService.getJob = async () => ({ ok: true, data: { job: mockClone(), log: "" } });
    stagerService.startPromote = async (source: string, target: string) => {
      started.push([source, target]);
      return { ok: true, data: { job: "20260916T100000Z-ffeedd" } };
    };
    try {
      const res = await handle(promoteRequest({ job: "20260916T090000Z-a1b2c3" }), "/api/promotions");
      expect(res.status).toBe(200);
      // The clone ran live -> staging; the promote runs staging -> live.
      expect(started).toEqual([["stg.example.test", "live.example.test"]]);
    } finally {
      Object.assign(stagerService, original);
    }
  });

  it("refuses an unfinished clone, a promote, and a record with no result", async () => {
    const original = { getJob: stagerService.getJob, startPromote: stagerService.startPromote };
    let calls = 0;
    stagerService.startPromote = async () => { calls++; return { ok: true, data: { job: "x" } }; };
    try {
      for (const [job, expected] of [
        [mockClone({ state: "running" }), "Only a finished clone"],
        [mockClone({ kind: "promote" }), "itself a promote"],
        [mockClone({ result: null }), "recorded no result"],
      ] as Array<[JobView, string]>) {
        stagerService.getJob = async () => ({ ok: true, data: { job, log: "" } });
        const res = await handle(promoteRequest({ job: job.id }), "/api/promotions");
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toContain(expected);
      }
      expect(calls).toBe(0);
    } finally {
      Object.assign(stagerService, original);
    }
  });

  it("refuses credentials for a site that has no second application to sign in to", async () => {
    const original = { getJob: stagerService.getJob, startPromote: stagerService.startPromote };
    let calls = 0;
    stagerService.getJob = async () => ({ ok: true, data: { job: mockClone(), log: "" } });
    stagerService.startPromote = async () => { calls++; return { ok: true, data: { job: "x" } }; };
    try {
      const res = await handle(
        promoteRequest({ job: "20260916T090000Z-a1b2c3", instaticEmail: "a@example.test" }),
        "/api/promotions",
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("not an Instatic site");
      expect(calls).toBe(0);
    } finally {
      Object.assign(stagerService, original);
    }
  });

  it("requires both instances' credentials for an Instatic promote", async () => {
    const original = { getJob: stagerService.getJob, startPromote: stagerService.startPromote };
    const instaticClone = mockClone({
      result: {
        siteType: "reverse-proxy", siteUser: "stg", phpVersion: "", vhostTemplate: "Generic",
        vhostCarried: true, vhostCarriedBy: "rendered", database: null,
        instatic: { port: 39001, tag: "1.2.3", email: "admin@stg.example.test", password: "" }, notes: [],
      },
    });
    stagerService.getJob = async () => ({ ok: true, data: { job: instaticClone, log: "" } });
    let calls = 0;
    stagerService.startPromote = async () => { calls++; return { ok: true, data: { job: "x" } }; };
    try {
      const res = await handle(
        promoteRequest({
          job: instaticClone.id, instaticEmail: "a@example.test", instaticPassword: "pw",
        }),
        "/api/promotions",
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("live instance's admin email");
      expect(calls).toBe(0);

      // A newline in a password would arrive at the action binary as a shorter one.
      const newline = await handle(
        promoteRequest({
          job: instaticClone.id, instaticEmail: "a@example.test", instaticPassword: "pw\nmore",
          liveEmail: "b@example.test", livePassword: "pw",
        }),
        "/api/promotions",
      );
      expect(newline.status).toBe(400);
      expect(((await newline.json()) as { error: string }).error).toContain("control character");
      expect(calls).toBe(0);
    } finally {
      Object.assign(stagerService, original);
    }
  });

  it("refuses a mutation with no CSRF token", async () => {
    const req = new Request("https://panel.example.test:8443/addons/stager/api/promotions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://panel.example.test:8443", Host: "panel.example.test:8443" },
      body: JSON.stringify({ job: "20260916T090000Z-a1b2c3" }),
    });
    const res = await handle(req, "/api/promotions");
    expect(res.status).toBe(403);
  });
});

describe("the promote pages", () => {
  it("says the live database is not overwritten, and asks for the live hostname", () => {
    const html = promoteView(mockClone());
    expect(html).toContain("The live database is not overwritten");
    expect(html).toContain("Type live.example.test to confirm");
    expect(html).toContain("wp-content/uploads");
    // No credential fields for a site with no second application to sign in to.
    expect(html).not.toContain("promote-src-password");
  });

  it("asks for both accounts when the clone was an Instatic one", () => {
    const html = promoteView(mockClone({
      result: {
        siteType: "reverse-proxy", siteUser: "stg", phpVersion: "", vhostTemplate: "Generic",
        vhostCarried: true, vhostCarriedBy: "rendered", database: null,
        instatic: { port: 39001, tag: "1.2.3", email: "admin@stg.example.test", password: "" }, notes: [],
      },
    }));
    expect(html).toContain("promote-src-password");
    expect(html).toContain("promote-dst-password");
    expect(html).toContain("Publish it once afterwards");
  });

  it("lists only finished clones", () => {
    const html = promoteListView([
      mockClone(),
      mockClone({ id: "20260916T090000Z-b2c3d4", target: "wip.example.test", state: "running" }),
      mockClone({ id: "20260916T090000Z-c3d4e5", target: "old.example.test", kind: "promote" }),
    ]);
    expect(html).toContain("stg.example.test");
    expect(html).not.toContain("wip.example.test");
    expect(html).not.toContain("old.example.test");
  });
});
