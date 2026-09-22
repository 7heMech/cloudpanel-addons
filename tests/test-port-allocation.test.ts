// Both addons allocate from the same reserved range against a snapshot the root
// CLI only rewrites every fifteen minutes, and each was compensating only for
// its own creates inside that window. An instance made from the Instatic
// dashboard was invisible to the Stager, both sides offered the same number, and
// the clone died on `docker run` failing to bind it -- reported as "failed to
// start container", with nothing naming the port.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getNextAvailablePort } from "../lib/snapshot-reader";
import type { PanelSnapshot } from "../lib/snapshot-reader";
import { portHolder } from "../addons/instatic/action";

const repo = join(import.meta.dir, "..");

function source(path: string): string {
  return readFileSync(join(repo, path), "utf-8");
}

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
  test("the stager counts live Instatic instances, not only its own jobs", () => {
    const stagerIndex = source("addons/stager/app/index.ts");
    expect(stagerIndex).toInclude("instaticService.listInstancesOrThrow()");
    expect(stagerIndex).toInclude("stagerService.listJobsOrThrow()");
  });

  test("an unreadable list is an error on the allocation path, not an empty one", () => {
    expect(source("addons/stager/app/service.ts")).toMatch(/listJobsOrThrow[\s\S]*?throw new Error/);
    expect(source("addons/instatic/app/service.ts")).toMatch(/listInstancesOrThrow[\s\S]*?throw new Error/);
  });

  test("the lenient readers are still there for the dashboards", () => {
    expect(source("addons/stager/app/service.ts")).toInclude("async listJobs()");
    expect(source("addons/instatic/app/service.ts")).toInclude("async listInstances()");
  });

  test("the instatic create no longer allocates against a silent empty list", () => {
    expect(source("addons/instatic/app/service.ts")).toInclude("const existing = await this.listInstancesOrThrow()");
  });

  // The root action is where the allocation decision is made, under the lock.
  test("the action re-checks the port rather than only its range, and names who has it", () => {
    const instaticAction = source("addons/instatic/action.ts");
    const create = instaticAction.slice(instaticAction.indexOf("async function cmdCreate"));
    expect(create.slice(0, create.indexOf("\nasync function cmdUpdate"))).toInclude("portHolder(port, domain, paths)");
    expect(instaticAction).toInclude("is already taken by");
  });

  test("the clone route turns a throw into a message rather than a bare 500", () => {
    expect(source("addons/stager/app/index.ts"))
      .toMatch(/path === "\/api\/clones"[\s\S]{0,600}?try \{[\s\S]{0,200}?postClone/);
  });

  // And it no longer runs du over the whole docroot for a source that needs no
  // credentials.
  test("the route asks the cheap question first", () => {
    expect(source("addons/stager/app/index.ts"))
      .toInclude("(await stagerService.listSites()).find((site) => site.domain === source)");
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
