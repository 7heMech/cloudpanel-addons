// Both addons allocate from the same reserved range against a snapshot the root
// CLI only rewrites every fifteen minutes, and each was compensating only for
// its own creates inside that window. An instance made from the Instatic
// dashboard was invisible to the Stager, both sides offered the same number, and
// the clone died on `docker run` failing to bind it -- reported as "failed to
// start container", with nothing naming the port.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getNextAvailablePort } from "../lib/snapshot-reader";
import type { PanelSnapshot } from "../lib/snapshot-reader";
import { portHolder } from "../addons/instatic/action";
import { instaticService } from "../addons/instatic/app/service";
import { handle } from "../addons/stager/app/index";
import { stagerService } from "../addons/stager/app/service";

const repo = join(import.meta.dir, "..");

function snap(allocated: number[]): PanelSnapshot {
  return {
    updatedAt: new Date().toISOString(),
    portRange: { min: 39000, max: 39999 },
    allocatedPorts: allocated,
    sites: [],
  };
}

describe("the next free port", () => {
  test("comes from the bottom of the range", () => {
    expect(getNextAvailablePort(snap([]), [])).toBe(39000);
  });

  test("skips a port the snapshot already knows about", () => {
    expect(getNextAvailablePort(snap([39000]), [])).toBe(39001);
  });

  // Without the caller's own ports, two creates in one window are handed the
  // same number and the second dies on docker failing to bind it.
  test("skips a port handed out since the snapshot", () => {
    expect(getNextAvailablePort(snap([39000]), [39001])).toBe(39002);
    expect(getNextAvailablePort(snap([39000, 39001]), [39002, 39003])).toBe(39004);
  });

  test("an exhausted range throws rather than returning a used port", () => {
    expect(() => getNextAvailablePort({ ...snap([]), portRange: { min: 39000, max: 39001 } }, [39000, 39001]))
      .toThrow();
  });
});

describe("the two addons allocate against each other", () => {
  type Stubbed = { target: object; name: string; original: unknown };
  const stubbed: Stubbed[] = [];
  function stub<T extends object>(target: T, name: keyof T & string, value: unknown): void {
    stubbed.push({ target, name, original: target[name] });
    (target as Record<string, unknown>)[name] = value;
  }
  afterEach(() => {
    for (const { target, name, original } of stubbed.splice(0).reverse()) (target as Record<string, unknown>)[name] = original;
  });

  /** A reverse-proxy source and an empty snapshot; returns the port each clone was handed. */
  function instaticSource(): number[] {
    const handed: number[] = [];
    stub(stagerService, "listSites", async () => [{
      domain: "app.example.com", siteType: "reverse-proxy", siteUser: "app", phpVersion: "", application: "", databases: 0,
    }]);
    stub(stagerService, "snapshot", async () => ({ snap: snap([]), ageSeconds: 0 }));
    stub(stagerService, "startClone", async (_source: string, _target: string, _tls: boolean, instatic?: { port: number }) => {
      handed.push(instatic!.port);
      return { ok: true, data: { job: "20260910T093000Z-a1b2c3" } };
    });
    // The lenient lists answer "nothing", which is what allocation must never believe.
    stub(stagerService, "listJobs", async () => []);
    stub(instaticService, "listInstances", async () => []);
    return handed;
  }

  function clone(): Promise<Response> {
    return handle(new Request("https://panel.example/addons/stager/api/clones", {
      method: "POST",
      headers: {
        Origin: "https://panel.example", Host: "panel.example", "Content-Type": "application/json",
        Cookie: "clp_addons_csrf=csrf_token", "x-clp-addons-csrf": "csrf_token",
      },
      body: JSON.stringify({ source: "app.example.com", target: "stg", instaticEmail: "admin@example.com", instaticPassword: "secret" }),
    }), "/api/clones");
  }

  test("the stager counts live Instatic instances, not only its own jobs", async () => {
    const handed = instaticSource();
    stub(stagerService, "listJobsOrThrow", async () => []);
    stub(instaticService, "listInstancesOrThrow", async () => [{
      domain: "dash.example.com", port: 39000, tag: "latest", container: "instatic-dash", siteUser: "dash", createdAt: "", state: "running",
    }]);
    const res = await clone();
    expect(res.status).toBe(200);
    expect(handed).toEqual([39001]);
  });

  for (const unreadable of ["the stager's jobs", "Instatic's instances"]) {
    test(`an unreadable list of ${unreadable} is a JSON error, not an empty list`, async () => {
      const handed = instaticSource();
      const fail = async () => { throw new Error(`could not list ${unreadable}`); };
      stub(stagerService, "listJobsOrThrow", unreadable === "the stager's jobs" ? fail : async () => []);
      stub(instaticService, "listInstancesOrThrow", unreadable === "Instatic's instances" ? fail : async () => []);
      const error = spyOn(console, "error").mockImplementation(() => {});
      try {
        const res = await clone();
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ ok: false, error: `could not list ${unreadable}` });
      } finally { error.mockRestore(); }
      expect(handed).toEqual([]);
    });
  }

  // The root action is where the allocation decision is made, under the lock.
  test("the action re-checks the port rather than only its range, and names who has it", () => {
    const dir = mkdtempSync(`${tmpdir()}/clp-ports-create-`);
    try {
      const bin = `${dir}/bin`;
      mkdirSync(bin);
      // No container exists and nothing listens: only the other instance's record holds the port.
      for (const command of ["docker", "ss"]) writeFileSync(`${bin}/${command}`, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      mkdirSync(`${dir}/data/other.test`, { recursive: true });
      writeFileSync(`${dir}/data/other.test/meta.json`, JSON.stringify({ domain: "other.test", port: 39997 }));
      const paths = {
        lockDir: `${dir}/lock`, dataBaseDir: `${dir}/data`, backupDir: `${dir}/backups`, jobsDir: `${dir}/jobs`,
        actionBinary: `${dir}/clp-addons`, panelDb: `${dir}/panel.db`,
        clpctl: `${bin}/clpctl`, panelIdentityFile: `${dir}/identity`, homeDir: `${dir}/home`,
      };
      const script = `
        import { mock } from "bun:test";
        Object.defineProperty(process, "getuid", { value: () => 0 });
        const common = await import("./lib/panel-identity.ts");
        mock.module("./lib/panel-identity.ts", () => ({ ...common, validateDomain: (value) => value }));
        const { runInstaticAction } = await import("./addons/instatic/action.ts");
        process.exit(await runInstaticAction(
          ["create", "--domain", "mine.test", "--port", "39997", "--tag", "0.0.18", "--tls", "no"],
          { paths: ${JSON.stringify(paths)} },
        ));
      `;
      const run = Bun.spawnSync([process.execPath, "-e", script], {
        cwd: repo, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      });
      expect(run.exitCode).not.toBe(0);
      expect(JSON.parse(run.stdout.toString().trim())).toEqual({
        ok: false,
        error: "port 39997 is already taken by the instance for other.test; retry, or pick a hostname whose instance can have a port of its own",
      });
      expect(existsSync(`${dir}/data/mine.test`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Driven for real: a stopped instance's record still holds its port, which is
// the case a listening-socket check alone would miss. 39997/39998 rather than
// the bottom of the range, because this runs on the box the addon targets,
// where the first ports really are bound and the socket half of the check
// would then answer for the record half.
describe("a port an instance recorded", () => {
  function probe(recorded: number, asked: number, self: string): string {
    const dir = mkdtempSync(`${tmpdir()}/clp-ports-`);
    try {
      mkdirSync(`${dir}/other.test`, { recursive: true });
      writeFileSync(`${dir}/other.test/meta.json`, JSON.stringify({ domain: "other.test", port: recorded }));
      return portHolder(asked, self, {
        lockDir: `${dir}/lock`, dataBaseDir: dir, backupDir: `${dir}/backups`, jobsDir: `${dir}/jobs`,
        actionBinary: `${dir}/clp-addons`, panelDb: `${dir}/panel.db`,
        clpctl: `${dir}/clpctl`, panelIdentityFile: `${dir}/identity`, homeDir: `${dir}/home`,
      }) ?? "FREE";
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("is taken, listening or not", () => {
    expect(probe(39997, 39997, "mine.test")).toBe("the instance for other.test");
  });

  test("leaves a free port free", () => {
    expect(probe(39997, 39998, "mine.test")).toBe("FREE");
  });

  test("is not reported as taken by someone else to the instance that holds it", () => {
    expect(probe(39997, 39997, "other.test")).toBe("FREE");
  });
});
