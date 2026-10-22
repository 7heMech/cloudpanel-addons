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
      spyOn(instaticService, "listInstances").mockResolvedValue(instances);
      spyOn(instaticService, "snapshot").mockResolvedValue({ snap: { updatedAt: "now", sites: [], allocatedPorts: [], portRange: { min: 39000, max: 39999 } }, ageSeconds: 2 });
      spyOn(tags, "listAvailableTags").mockResolvedValue(available);
      const method = verb === "update" ? "updateInstance" : verb === "delete" ? "deleteInstance" : "lifecycle";
      spyOn(instaticService, method).mockResolvedValue({ ok: true, data: { domain: instances[0]!.domain } } as never);
      const path = `/api/instances/pages.example.com/${verb}`;
      const response = await instaticHandle(request(path, "POST", verb === "update" ? { tag: "0.0.19" } : undefined), path);
      const body = await response.json() as { html: string; data: { domain: string } };
      expect(response.status).toBe(200);
      expect(body.html).toBe(instaticView(instances, 2, [], available, "now"));
      expect(body.data.domain).toBe("pages.example.com");
      const page = await (await instaticHandle(request("/"), "/")).text();
      expect(page).toContain(body.html);
    });
  }

  test("failure retains rollback details and skips rendering; CSRF still guards actions", async () => {
    const read = spyOn(instaticService, "listInstances");
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
