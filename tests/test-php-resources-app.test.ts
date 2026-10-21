import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { appRequest as request } from "./app-request";
import { handle as phpHandle } from "../addons/php-resources/app/index";
import { phpResourcesService } from "../addons/php-resources/app/service";
import { dashboardView as phpView } from "../addons/php-resources/app/views";
import { PRESET_CATEGORIES } from "../addons/php-resources/action";

afterEach(() => mock.restore());

describe("PHP Resources dashboard replies", () => {
  const state = { categories: PRESET_CATEGORIES, defaultCategoryId: "standard", sites: [], failures: ["unavailable.test"] };
  for (const [path, method] of [
    ["/api/categories", "saveCategory"], ["/api/categories/delete", "deleteCategory"],
    ["/api/assign", "assign"], ["/api/default", "setDefault"],
  ] as const) {
    test(`${path} renders the returned state and preserves partial failures`, async () => {
      spyOn(phpResourcesService, method).mockResolvedValue({ ok: true, data: state });
      const response = await phpHandle(request(path, "POST", {}), path);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, data: state, html: phpView(state) });
    });
  }

  test("refused changes carry no fragment and stay CSRF-protected", async () => {
    const change = spyOn(phpResourcesService, "assign").mockResolvedValue({ ok: false, error: "refused" });
    const path = "/api/assign";
    const response = await phpHandle(request(path, "POST", {}), path);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "refused" });
    expect((await phpHandle(request(path, "POST", {}, false), path)).status).toBe(403);
    expect(change).toHaveBeenCalledTimes(1);
  });
});
