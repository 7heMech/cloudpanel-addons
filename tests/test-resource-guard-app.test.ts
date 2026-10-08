import { beforeEach, expect, mock, test } from "bun:test";
import { DEFAULT_GUARD_SETTINGS, type GuardState } from "../addons/resource-guard/action";

const calls: unknown[][] = [];
let available = true;
const state: GuardState = {
  settings: { ...DEFAULT_GUARD_SETTINGS }, protected: false, allocatedMiB: null,
  scratch: null, files: null, legacy: null, disks: [], warnings: [], verifiedPhp: [], lastCheck: null,
};
mock.module("../lib/gateway-client", () => ({
  callGatewayAction: async (...args: unknown[]) => {
    calls.push(args);
    return available ? { ok: true, data: state } : { ok: false, error: "disk status unavailable" };
  },
}));
const { handle } = await import("../addons/resource-guard/app/index");
beforeEach(() => { calls.length = 0; available = true; });
function mutation(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return handle(new Request(`https://panel.example:8443/addons/resource-guard${path}`, {
    method: "POST", body: JSON.stringify(body), headers: {
      Host: "panel.example:8443", Origin: "https://panel.example:8443",
      Cookie: "clp_addons_csrf=token", "X-CLP-Addons-CSRF": "token", "Content-Type": "application/json", ...headers,
    },
  }), path);
}
test("dashboard sets the panel-wide CSRF cookie and explains that protection is off", async () => {
  const response = await handle(new Request("https://panel.example:8443/addons/resource-guard/"), "/");
  expect(response.status).toBe(200);
  expect(response.headers.getSetCookie()[0]).toContain("Path=/;");
  expect(await response.text()).toContain(">Off</span>");
  expect(calls[0]).toEqual(["resource-guard", "status"]);
});
test("mutations enforce both CSRF and the exact panel origin before reaching root", async () => {
  expect((await mutation("/api/configure", DEFAULT_GUARD_SETTINGS, { "X-CLP-Addons-CSRF": "wrong" })).status).toBe(403);
  expect((await mutation("/api/clean", {}, { Origin: "https://panel.example" })).status).toBe(403);
  expect(calls).toEqual([]);
});
test("configuration and cleanup use only fixed gateway verbs", async () => {
  expect((await mutation("/api/configure", DEFAULT_GUARD_SETTINGS)).status).toBe(200);
  expect(calls[0]).toEqual(["resource-guard", "configure", [], JSON.stringify(DEFAULT_GUARD_SETTINGS)]);
  expect((await mutation("/api/clean", {})).status).toBe(200);
  expect(calls[1]).toEqual(["resource-guard", "clean", [], "{}"]);
  expect((await mutation("/api/deactivate", {})).status).toBe(404);
});
test("unavailable diagnostics remain an explicit service failure", async () => {
  available = false;
  const response = await handle(new Request("https://panel.example:8443/addons/resource-guard/api/status"), "/api/status");
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ ok: false, error: "disk status unavailable" });
});
