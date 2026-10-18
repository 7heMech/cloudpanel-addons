import { afterEach, expect, test } from "bun:test";
import { handle } from "../addons/wp-login/app";
import { wpLoginService } from "../addons/wp-login/app/service";
import { SECURITY_HEADERS } from "../lib/app-http";

const originalSites = wpLoginService.sites;
const originalSignIn = wpLoginService.signIn;
afterEach(() => {
  wpLoginService.sites = originalSites;
  wpLoginService.signIn = originalSignIn;
});

test("only listed HTTPS site origins may receive the WordPress page's token form", async () => {
  wpLoginService.sites = async () => ({ ok: true, data: { sites: [
    { domain: "shop.example.com", user: "shop", application: "WordPress", helper: false },
    { domain: "blog.example.com", user: "blog", application: "Generic", helper: false },
    { domain: "bad; form-action *", user: "bad", application: "WordPress", helper: false },
  ] } });
  const response = await handle(new Request("https://panel.example.com/addons/wp-login/"), "/");
  expect(response.headers.get("Content-Security-Policy")).toBe(
    SECURITY_HEADERS["Content-Security-Policy"]!.replace("form-action 'none'", "form-action https://shop.example.com https://blog.example.com"),
  );
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

test("an empty WordPress page retains the default form refusal", async () => {
  wpLoginService.sites = async () => ({ ok: true, data: { sites: [] } });
  const response = await handle(new Request("https://panel.example.com/addons/wp-login/"), "/");
  expect(response.headers.get("Content-Security-Policy")).toBe(SECURITY_HEADERS["Content-Security-Policy"]!);
});

test("basic-auth consent preserves the authenticated role and takes the IP from the request", async () => {
  const calls: unknown[] = [];
  wpLoginService.signIn = async (domain, request) => {
    calls.push({ domain, ...request });
    return { ok: true, data: { basicAuth: { ip: request.clientIp, canBypass: !request.asUser, message: "test gate" } } };
  };
  const csrf = "a".repeat(64);
  for (const roles of [["ROLE_ADMIN"], ["ROLE_USER"], ["ROLE_SITE_MANAGER"]]) {
    const req = new Request("https://panel.example.com/addons/wp-login/api/sign-in", {
      method: "POST",
      headers: { Host: "panel.example.com", Origin: "https://panel.example.com", Cookie: `clp_addons_csrf=${csrf}`, "X-CLP-Addons-CSRF": csrf, "X-Real-IP": "::ffff:203.0.113.9", "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "shop.example.com", allowBasicAuth: true, addBypass: true, clientIp: "198.51.100.1", asUser: "boss" }),
    });
    const response = await handle(req, "/api/sign-in", undefined, undefined, { user: "shopkeeper", roles });
    expect(response.status).toBe(200);
    expect(calls.at(-1)).toEqual({ domain: "shop.example.com", asUser: roles[0] === "ROLE_ADMIN" ? undefined : "shopkeeper", clientIp: "203.0.113.9", addBypass: true, allowBasicAuth: true });
  }
});
