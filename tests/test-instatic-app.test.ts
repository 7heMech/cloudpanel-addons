import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { appRequest as request } from "./app-request";
import { handle as instaticHandle } from "../addons/instatic/app/index";
import { instaticService, type InstanceView } from "../addons/instatic/app/service";
import * as tags from "../addons/instatic/app/tags";
import { dashboardView as instaticView } from "../addons/instatic/app/views";

afterEach(() => mock.restore());

describe("Instatic dashboard replies", () => {
  const instances: InstanceView[] = [{
    domain: "pages.example.com", port: 39000, tag: "0.0.19", container: "preview", siteUser: "pages",
    createdAt: "", state: "running",
  }];
  const available = { tags: ["0.0.19"], latest: "0.0.19", source: "registry" as const };

  for (const verb of ["start", "stop", "restart", "recreate", "update", "delete"]) {
    test(`${verb} returns the same dashboard as GET`, async () => {
      spyOn(instaticService, "listInstancesOrThrow").mockResolvedValue(instances);
      spyOn(instaticService, "listJobs").mockResolvedValue([]);
      spyOn(tags, "listAvailableTags").mockResolvedValue(available);
      const method = verb === "update" ? "updateInstance" : verb === "delete" ? "deleteInstance" : "lifecycle";
      spyOn(instaticService, method).mockResolvedValue({ ok: true, data: { domain: instances[0]!.domain } } as never);
      const path = `/api/instances/pages.example.com/${verb}`;
      const response = await instaticHandle(request(path, "POST", verb === "update" ? { tag: "0.0.19" } : undefined), path);
      const body = await response.json() as { html: string; data: { domain: string } };
      expect(response.status).toBe(200);
      expect(body.html).toBe(instaticView(instances, available, []));
      expect(body.data.domain).toBe("pages.example.com");
      const page = await (await instaticHandle(request("/"), "/")).text();
      expect(page).toContain(body.html);
    });
  }

  test("a list that fails after a change leaves the page as it is rather than empty", async () => {
    spyOn(instaticService, "listInstancesOrThrow").mockRejectedValue(new Error("action unavailable"));
    spyOn(instaticService, "listJobs").mockResolvedValue([]);
    spyOn(tags, "listAvailableTags").mockResolvedValue(available);
    spyOn(instaticService, "lifecycle").mockResolvedValue({ ok: true, data: { domain: instances[0]!.domain } } as never);
    const path = "/api/instances/pages.example.com/stop";
    const body = await (await instaticHandle(request(path, "POST"), path)).json() as { ok: boolean; html?: string };
    expect(body.ok).toBe(true);
    expect(body.html).toBeUndefined();
  });

  test("failure retains rollback details and skips rendering; CSRF still guards actions", async () => {
    const read = spyOn(instaticService, "listInstancesOrThrow");
    const result = { ok: false, error: "rolled back", data: { restoredTag: "0.0.18", logs: "container failed" } };
    const change = spyOn(instaticService, "updateInstance").mockResolvedValue(result as never);
    const path = "/api/instances/pages.example.com/update";
    const response = await instaticHandle(request(path, "POST", { tag: "0.0.19" }), path);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(result);
    expect((await instaticHandle(request(path, "POST", { tag: "0.0.19" }, false), path)).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
    expect(change).toHaveBeenCalledTimes(1);
  });
});

describe("the New site page", () => {
  test("reads only the version list, so it cannot fail on a port lookup", async () => {
    const list = spyOn(instaticService, "listInstances");
    const strict = spyOn(instaticService, "listInstancesOrThrow");
    const snapshot = spyOn(instaticService, "snapshot");
    spyOn(tags, "listAvailableTags").mockResolvedValue({ tags: ["0.0.19"], latest: "0.0.19", source: "registry" });
    const response = await instaticHandle(request("/new"), "/new");
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('id="port"');
    for (const spy of [list, strict, snapshot]) expect(spy).not.toHaveBeenCalled();
  });
});

describe("an unreachable registry", () => {
  test("is asked once a minute, not once a page", async () => {
    tags.resetTagCache();
    let calls = 0;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      calls++;
      throw new Error("offline");
    }) as unknown as typeof fetch);
    spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await tags.listAvailableTags()).source).toBe("fallback");
      expect((await tags.listAvailableTags()).latest).toBeNull();
      expect(calls).toBe(1);
    } finally {
      fetchSpy.mockRestore();
      tags.resetTagCache();
    }
  });
});

describe("updates as jobs", () => {
  const instance: InstanceView = { domain: "pages.example.com", port: 39000, tag: "0.0.18", container: "c", siteUser: "pages", createdAt: "", state: "running" };
  const available = { tags: ["0.0.19", "0.0.18"], latest: "0.0.19", source: "registry" as const };
  const job = {
    id: "20261025T120000Z-ab12cd", kind: "update" as const, domain: "pages.example.com", port: 39000, tag: "0.0.19", fromTag: "0.0.18",
    tls: false, state: "running" as const, step: "waiting for health check", createdAt: "2026-10-25T12:00:00Z",
  };

  test("a running update shows on its row, which cannot be selected meanwhile", () => {
    const html = instaticView([instance], available, [job]);
    expect(html).toContain("Updating");
    expect(html).toContain("waiting for health check");
    expect(html).toMatch(/aria-label="Select pages\.example\.com" disabled/);
    expect(html).toContain('data-working');
    expect(html).not.toContain("askUpdate('pages.example.com'");
  });

  test("a rolled-back update is named on the row until another replaces it", () => {
    const html = instaticView([instance], available, [{ ...job, state: "failed", step: "" }]);
    expect(html).toContain("Update to 0.0.19 failed");
    expect(html).not.toContain("data-working");
  });

  test("a bulk update starts one job a site and names any it could not start", async () => {
    spyOn(instaticService, "listInstancesOrThrow").mockResolvedValue([instance]);
    spyOn(instaticService, "listJobs").mockResolvedValue([]);
    spyOn(tags, "listAvailableTags").mockResolvedValue(available);
    const update = spyOn(instaticService, "updateInstance").mockImplementation(async (domain) =>
      domain === "pages.example.com" ? { ok: true, data: { job: job.id } } : { ok: false, error: "no such instance" });
    const path = "/api/bulk";
    const response = await instaticHandle(request(path, "POST", { verb: "update", tag: "0.0.19", domains: ["pages.example.com", "gone.example.com"] }), path);
    const body = await response.json() as { data: { done: string[]; failed: { domain: string; error: string }[] }; html: string };
    expect(update).toHaveBeenCalledTimes(2);
    expect(body.data.done).toEqual(["pages.example.com"]);
    expect(body.data.failed).toEqual([{ domain: "gone.example.com", error: "no such instance" }]);
    expect(body.html).toContain("instatic-sites");
    expect((await instaticHandle(request(path, "POST", { verb: "delete", domains: ["pages.example.com"] }), path)).status).toBe(400);
  });
});
