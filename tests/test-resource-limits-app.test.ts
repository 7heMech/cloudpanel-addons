import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { appRequest as request } from "./app-request";
import { handle as phpHandle } from "../addons/resource-limits/app/index";
import { resourceLimitsService } from "../addons/resource-limits/app/service";
import { dashboardView as phpView } from "../addons/resource-limits/app/views";
import { PRESET_CATEGORIES } from "../addons/resource-limits/action";

afterEach(() => mock.restore());

describe("Resource Limits dashboard replies", () => {
  const state = { memory: { error: "Unavailable" }, categories: PRESET_CATEGORIES, defaultCategoryId: "standard", sites: [], failures: ["unavailable.test"] };
  for (const [path, method] of [
    ["/api/categories", "saveCategory"], ["/api/categories/delete", "deleteCategory"],
    ["/api/assign", "assign"], ["/api/default", "setDefault"],
  ] as const) {
    test(`${path} renders the returned state and preserves partial failures`, async () => {
      spyOn(resourceLimitsService, method).mockResolvedValue({ ok: true, data: state });
      const response = await phpHandle(request(path, "POST", {}), path);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, data: state, html: phpView(state) });
    });
  }

  test("refused changes carry no fragment and stay CSRF-protected", async () => {
    const change = spyOn(resourceLimitsService, "assign").mockResolvedValue({ ok: false, error: "refused" });
    const path = "/api/assign";
    const response = await phpHandle(request(path, "POST", {}), path);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "refused" });
    expect((await phpHandle(request(path, "POST", {}, false), path)).status).toBe(403);
    expect(change).toHaveBeenCalledTimes(1);
  });
});

test("the memory API saves through set-memory and repaints from a separate state request", async () => {
  const { handle } = await import("../addons/resource-limits/app");
  const { resourceLimitsService } = await import("../addons/resource-limits/app/service");
  const state = { categories: [], defaultCategoryId: null, sites: [], memory: { error: "Unavailable" } };
  const original = { setMemory: resourceLimitsService.setMemory, state: resourceLimitsService.state };
  const calls: string[] = [];
  resourceLimitsService.setMemory = async (change) => {
    calls.push(`set-memory ${JSON.stringify(change)}`);
    return change.redis ? { ok: false, error: "Redis has a password in redis.conf" } : { ok: true, data: { memory: { profile: "cache", mysql: false, redis: false, oom: true } } };
  };
  resourceLimitsService.state = async () => { calls.push("state"); return { ok: true, data: state }; };
  const request = (body: unknown) => new Request("https://panel.example.com/addons/resource-limits/api/memory", {
    method: "POST",
    headers: { Host: "panel.example.com", Origin: "https://panel.example.com", "Content-Type": "application/json",
      Cookie: `clp_addons_csrf=${"a".repeat(64)}`, "X-CLP-Addons-CSRF": "a".repeat(64) },
    body: JSON.stringify(body),
  });
  try {
    expect((await handle(request({ profile: "huge" }), "/api/memory")).status).toBe(400);
    expect(calls).toEqual([]);
    const response = await handle(request({ profile: "cache" }), "/api/memory");
    expect(response.status).toBe(200);
    expect((await response.json() as { html: string }).html).toBe(phpView(state));
    expect(calls).toEqual(['set-memory {"profile":"cache"}', "state"]);
    // A refused change answers with its error and reads no state.
    const refused = await handle(request({ redis: true }), "/api/memory");
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ ok: false, error: "Redis has a password in redis.conf" });
    expect(calls.at(-1)).toBe('set-memory {"redis":true}');
  } finally { Object.assign(resourceLimitsService, original); }
});
