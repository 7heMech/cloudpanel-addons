// A site deleted in CloudPanel leaves the addon holding a job record or a
// running container for something the panel no longer serves. Both addons say
// so the same way, from the same two sources: a live panelSite answer when the
// action could supply one, and the panel snapshot otherwise.
//
// The snapshot is the awkward half. It is rewritten every fifteen minutes, so
// a site created since is absent from it for reasons that have nothing to do
// with deletion, and a snapshot old enough to be stale cannot be trusted to
// report an absence at all.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dashboardView, isInstanceMissing } from "../addons/instatic/app/views";
import type { InstanceView } from "../addons/instatic/app/service";
import { isSiteMissing, jobsView, jobView } from "../addons/stager/app/views";
import type { JobView } from "../addons/stager/app/service";

const SNAP_TIME = "2026-09-09T10:00:00Z";
const TAGS = { tags: ["0.0.18"], source: "registry" as const, latest: "0.0.18" };

const JOB: JobView = {
  id: "20260909T100000Z-112233",
  kind: "clone",
  source: "prod.example.com",
  target: "stg.example.com",
  port: 0,
  state: "done",
  step: "",
  createdAt: "2026-09-09T09:00:00Z",
  startedAt: "2026-09-09T09:00:01Z",
  finishedAt: "2026-09-09T09:05:00Z",
  error: "",
  result: {
    siteType: "php",
    siteUser: "stg-user",
    phpVersion: "",
    vhostCarried: false,
    vhostCarriedBy: "stock",
    vhostTemplate: "Generic",
    database: null,
    instatic: null,
    notes: [],
  },
};

const INSTANCE: InstanceView = {
  domain: "inst.example.com",
  port: 39001,
  tag: "0.0.18",
  container: "instatic-inst.example.com",
  siteUser: "inst_user",
  createdAt: "2026-09-09T09:00:00Z",
  state: "running",
};

const PROD_ONLY = [{ domain: "prod.example.com", user: "prod-user", type: "php" }];
const WITH_STAGING = [...PROD_ONLY, { domain: "stg.example.com", user: "stg-user", type: "php" }];
const OTHER_ONLY = [{ domain: "other.example.com", user: "other", type: "php" }];
const WITH_INSTANCE = [...OTHER_ONLY, { domain: "inst.example.com", user: "inst_user", type: "reverse-proxy" }];

describe("a stager job's staging site", () => {
  test("is missing when a newer snapshot does not list it", () => {
    expect(isSiteMissing(JOB, 120, PROD_ONLY, SNAP_TIME)).toBe(true);
  });

  test("is not missing when the snapshot lists it", () => {
    expect(isSiteMissing(JOB, 120, WITH_STAGING, SNAP_TIME)).toBe(false);
  });

  test("is not missing when the clone finished after the snapshot was taken", () => {
    expect(isSiteMissing(JOB, 120, PROD_ONLY, "2026-09-09T09:02:00Z")).toBe(false);
  });

  test("is not missing on the word of a snapshot older than an hour", () => {
    expect(isSiteMissing(JOB, 3601, PROD_ONLY, SNAP_TIME)).toBe(false);
  });

  test("is not missing while the job has not finished", () => {
    for (const state of ["running", "queued", "failed"] as const) {
      expect(isSiteMissing({ ...JOB, state }, 120, PROD_ONLY, SNAP_TIME), state).toBe(false);
    }
  });

  // A live answer from the action outranks the snapshot in both directions.
  test("follows a live panelSite answer over the snapshot", () => {
    expect(isSiteMissing({ ...JOB, panelSite: false }, 10, WITH_STAGING, SNAP_TIME)).toBe(true);
    expect(isSiteMissing({ ...JOB, panelSite: true }, 10, [], SNAP_TIME)).toBe(false);
  });
});

describe("the stager's pages", () => {
  test("badge a missing site and explain it", () => {
    const html = jobsView([JOB], 120, PROD_ONLY, SNAP_TIME);
    expect(html).toInclude("CloudPanel site deleted");
    expect(html).toInclude("deleted</span>");
  });

  test("say nothing when the site is present", () => {
    expect(jobsView([JOB], 120, WITH_STAGING, SNAP_TIME)).not.toInclude("CloudPanel site deleted");
  });

  test("drop the link to a site that is gone", () => {
    const html = jobView(JOB, "all good", 120, PROD_ONLY, SNAP_TIME);
    expect(html).toInclude("This staging site has been deleted from CloudPanel.");
    expect(html).toInclude("(deleted from CloudPanel)");
    expect(html).not.toInclude('href="https://stg.example.com"');
  });

  test("link to a site that is there", () => {
    const html = jobView(JOB, "all good", 120, WITH_STAGING, SNAP_TIME);
    expect(html).toInclude('href="https://stg.example.com"');
    expect(html).not.toInclude("This staging site has been deleted from CloudPanel.");
  });
});

describe("an instatic instance's site", () => {
  test("follows a live panelSite answer over the snapshot", () => {
    expect(isInstanceMissing({ ...INSTANCE, panelSite: false }, 10, WITH_INSTANCE, SNAP_TIME)).toBe(true);
    expect(isInstanceMissing({ ...INSTANCE, panelSite: true }, 10, OTHER_ONLY, SNAP_TIME)).toBe(false);
  });

  test("is missing when a newer snapshot does not list it", () => {
    expect(isInstanceMissing(INSTANCE, 120, OTHER_ONLY, SNAP_TIME)).toBe(true);
  });

  test("is not missing when the snapshot lists it", () => {
    expect(isInstanceMissing(INSTANCE, 120, WITH_INSTANCE, SNAP_TIME)).toBe(false);
  });

  test("is not missing when the instance was created after the snapshot", () => {
    expect(isInstanceMissing(INSTANCE, 120, OTHER_ONLY, "2026-09-09T08:55:00Z")).toBe(false);
  });

  test("is not missing on the word of a snapshot older than an hour", () => {
    expect(isInstanceMissing(INSTANCE, 3601, OTHER_ONLY, SNAP_TIME)).toBe(false);
  });
});

describe("the instatic dashboard", () => {
  test("badges a missing instance and offers the cleanup", () => {
    const html = dashboardView([{ ...INSTANCE, panelSite: false }], 120, OTHER_ONLY, TAGS, SNAP_TIME);
    expect(html).toInclude("CloudPanel site deleted. Delete here to archive and clean up the instance.");
    expect(html).toInclude("deleted</span>");
    expect(html).not.toInclude('href="https://inst.example.com"');
  });

  test("links to an instance whose site is present", () => {
    const html = dashboardView([{ ...INSTANCE, panelSite: true }], 120, OTHER_ONLY, TAGS, SNAP_TIME);
    expect(html).not.toInclude("CloudPanel site deleted");
    expect(html).toInclude('href="https://inst.example.com"');
  });
});

// The live answer only reaches a page if the action puts it in the reply.
test("both actions report panelSite in their JSON output", () => {
  const repo = join(import.meta.dir, "..");
  expect(readFileSync(join(repo, "addons/stager/action.ts"), "utf-8")).toInclude("panelSite:");
  expect(readFileSync(join(repo, "addons/instatic/action.ts"), "utf-8")).toInclude("panelSite:");
});
