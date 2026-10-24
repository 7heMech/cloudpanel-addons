import { afterEach, expect, test } from "bun:test";
import { handle } from "../addons/cloudflare-ips/app";
import { cloudflareService, type CloudflareState } from "../addons/cloudflare-ips/app/service";

const originalProtection = cloudflareService.setProtection;
afterEach(() => { cloudflareService.setProtection = originalProtection; });

function request(body: unknown, authorized = true): Request {
  const csrf = "a".repeat(64);
  return new Request("https://panel.example.com/addons/cloudflare-ips/api/protection", {
    method: "POST",
    headers: {
      Host: "panel.example.com", Origin: "https://panel.example.com", "Content-Type": "application/json",
      ...(authorized ? { Cookie: `clp_addons_csrf=${csrf}`, "X-CLP-Addons-CSRF": csrf } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("bypass protection requires CSRF and an explicit boolean before reaching root", async () => {
  const calls: boolean[] = [];
  cloudflareService.setProtection = async (enabled) => { calls.push(enabled); return { ok: false, error: "unexpected" }; };
  expect((await handle(request({ enabled: true }, false), "/api/protection")).status).toBe(403);
  for (const body of [{}, { enabled: "false" }, { enabled: 0 }]) {
    expect((await handle(request(body), "/api/protection")).status).toBe(400);
  }
  expect(calls).toEqual([]);
});

test("bypass protection replies acknowledge the applied state without requiring site inventory", async () => {
  const calls: boolean[] = [];
  const state: CloudflareState = {
    sites: [{ domain: "open.example.com", type: "PHP", enabled: false, excludedFromAutomatic: false }],
    autoEnableNewSites: false,
    protection: { wanted: true, configured: true, available: true, problem: "" },
  };
  cloudflareService.setProtection = async (enabled) => { calls.push(enabled); return { ok: true, data: { protection: state.protection } }; };
  const response = await handle(request({ enabled: true }), "/api/protection");
  expect(response.status).toBe(200);
  const reply = await response.json() as { data: { protection: CloudflareState["protection"] }; html?: string };
  expect(calls).toEqual([true]);
  expect(reply.data).toEqual({ protection: state.protection });
  expect(reply.html).toBeUndefined();
});
