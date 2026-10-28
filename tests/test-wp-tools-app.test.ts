import { afterEach, expect, test } from "bun:test";
import { handle } from "../addons/wp-tools/app";
import { wpToolsService } from "../addons/wp-tools/app/service";
import { emptyMainwpState, mainwpView } from "../addons/wp-tools/mainwp";
import { SECURITY_HEADERS } from "../lib/app-http";

const originalSites = wpToolsService.sites;
const originalSignIn = wpToolsService.signIn;
afterEach(() => {
  wpToolsService.sites = originalSites;
  wpToolsService.signIn = originalSignIn;
});

test("the WordPress page refuses every form, so its header does not grow with the fleet", async () => {
  wpToolsService.sites = async () => ({ ok: true, data: {
    sites: Array.from({ length: 500 }, (_, i) => ({
      domain: `site${i}.example.com`, user: `site${i}`, application: "WordPress", helper: false,
      varnishCache: false, varnishPlugin: null,
    })),
    varnish: { enabled: false, sites: {} },
    varnishError: "",
    mainwp: mainwpView(emptyMainwpState()),
    mainwpError: "",
    domainLink: { signIn: true },
    domainLinkError: "",
    jobs: { varnish: null, mainwp: null },
  } });
  const response = await handle(new Request("https://panel.example.com/addons/wp-tools/"), "/");
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Security-Policy")).toBe(SECURITY_HEADERS["Content-Security-Policy"]!);
});

test("a sign-in window lets a form go only to the site it was opened for", async () => {
  const response = await handle(new Request("https://panel.example.com/addons/wp-tools/sign-in/Shop.Example.com"), "/sign-in/Shop.Example.com");
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Security-Policy")).toBe(
    SECURITY_HEADERS["Content-Security-Policy"]!.replace("form-action 'none'", "form-action https://shop.example.com"),
  );
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.text()).toContain("Signing in to shop.example.com");
});

test("a sign-in window refuses a name that would widen its policy", async () => {
  for (const segment of ["bad%3B%20form-action%20*", "*.example.com", "%E0%A4%A"]) {
    const response = await handle(new Request(`https://panel.example.com/addons/wp-tools/sign-in/${segment}`), `/sign-in/${segment}`);
    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Security-Policy")).toBe(SECURITY_HEADERS["Content-Security-Policy"]!);
  }
});

test("basic-auth consent preserves the authenticated role and takes the IP from the request", async () => {
  const calls: unknown[] = [];
  wpToolsService.signIn = async (domain, request) => {
    calls.push({ domain, ...request });
    return { ok: true, data: { basicAuth: { ip: request.clientIp, canBypass: !request.asUser, message: "test gate" } } };
  };
  const csrf = "a".repeat(64);
  for (const roles of [["ROLE_ADMIN"], ["ROLE_USER"], ["ROLE_SITE_MANAGER"]]) {
    const req = new Request("https://panel.example.com/addons/wp-tools/api/sign-in", {
      method: "POST",
      headers: { Host: "panel.example.com", Origin: "https://panel.example.com", Cookie: `clp_addons_csrf=${csrf}`, "X-CLP-Addons-CSRF": csrf, "X-Real-IP": "::ffff:203.0.113.9", "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "shop.example.com", allowBasicAuth: true, addBypass: true, clientIp: "198.51.100.1", asUser: "boss" }),
    });
    const response = await handle(req, "/api/sign-in", undefined, undefined, { user: "shopkeeper", roles });
    expect(response.status).toBe(200);
    expect(calls.at(-1)).toEqual({ domain: "shop.example.com", asUser: roles[0] === "ROLE_ADMIN" ? undefined : "shopkeeper", clientIp: "203.0.113.9", addBypass: true, allowBasicAuth: true });
  }
});

test("checks, installs, connections and cleanup start background jobs, and only an administrator follows them", async () => {
  const originalStart = wpToolsService.startJob;
  const originalGet = wpToolsService.getJob;
  const calls: unknown[][] = [];
  wpToolsService.startJob = async (...args) => { calls.push(args); return { ok: true, data: { job: { id: "20261027T120000Z-abcdef" } as never } }; };
  wpToolsService.getJob = async () => ({ ok: true, data: { job: { id: "20261027T120000Z-abcdef", state: "running", step: "" } as never, log: "" } });
  const csrf = "a".repeat(64);
  const post = (path: string, body: unknown, roles = ["ROLE_ADMIN"]) => handle(new Request(`https://panel.example.com/addons/wp-tools${path}`, {
    method: "POST",
    headers: { Host: "panel.example.com", Origin: "https://panel.example.com", Cookie: `clp_addons_csrf=${csrf}`, "X-CLP-Addons-CSRF": csrf, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), path, undefined, undefined, { user: "admin", roles });
  try {
    expect((await post("/api/varnish-sync", {})).status).toBe(200);
    expect((await post("/api/varnish-install", { domain: "Shop.Example.com" })).status).toBe(200);
    expect((await post("/api/mainwp-sync", {})).status).toBe(200);
    expect((await post("/api/mainwp-connect", { domains: ["a.example.com", "b.example.com"], confirm: true })).status).toBe(200);
    expect((await post("/api/mainwp-cleanup", { confirm: true })).status).toBe(200);
    expect(calls).toEqual([
      ["varnish-check"], ["varnish-install", ["shop.example.com"]], ["mainwp-check"],
      ["mainwp-connect", ["a.example.com", "b.example.com"], "connect"], ["mainwp-cleanup", [], "mainwp"],
    ]);
    for (const body of [{ domains: ["a.example.com"] }, { domains: [], confirm: true }, { domains: ["bad name"], confirm: true }, { domain: "a.example.com", confirm: true }]) {
      expect((await post("/api/mainwp-connect", body)).status).toBe(400);
    }
    expect((await post("/api/mainwp-sync", {}, ["ROLE_SITE_MANAGER"])).status).toBe(404);
    expect(calls).toHaveLength(5);

    const get = (path: string, roles: string[]) => handle(new Request(`https://panel.example.com/addons/wp-tools${path}`, { headers: { Host: "panel.example.com" } }),
      path, undefined, undefined, { user: "someone", roles });
    expect((await get("/api/jobs/20261027T120000Z-abcdef", ["ROLE_ADMIN"])).status).toBe(200);
    expect((await get("/api/jobs/20261027T120000Z-abcdef", ["ROLE_SITE_MANAGER"])).status).toBe(404);
    expect((await get("/api/jobs/not-a-job", ["ROLE_ADMIN"])).status).toBe(400);
  } finally {
    wpToolsService.startJob = originalStart;
    wpToolsService.getJob = originalGet;
  }
});

test("the domain link setting is administrator-only and renders the panel's templates again", async () => {
  const originalSettings = wpToolsService.domainLinkSettings;
  const originalRender = wpToolsService.renderPanelTemplates;
  const saved: boolean[] = [];
  let renders = 0;
  let rendered = true;
  wpToolsService.domainLinkSettings = async (signIn) => { saved.push(signIn); return { ok: true, data: { domainLink: { signIn } } }; };
  wpToolsService.renderPanelTemplates = async () => { renders++; return rendered ? { ok: true } : { ok: false, error: "templates failed" }; };
  const csrf = "a".repeat(64);
  const post = (body: unknown, roles = ["ROLE_ADMIN"]) => handle(new Request("https://panel.example.com/addons/wp-tools/api/domain-link", {
    method: "POST",
    headers: { Host: "panel.example.com", Origin: "https://panel.example.com", Cookie: `clp_addons_csrf=${csrf}`, "X-CLP-Addons-CSRF": csrf, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), "/api/domain-link", undefined, undefined, { user: "admin", roles });
  try {
    expect((await post({ signIn: false })).status).toBe(200);
    expect((await post({ signIn: "no" })).status).toBe(400);
    expect((await post({ signIn: true }, ["ROLE_USER"])).status).toBe(404);
    expect(saved).toEqual([false]);
    expect(renders).toBe(1);
    // Saved, but the panel still shows the old link: say so, with what was saved.
    rendered = false;
    const failed = await post({ signIn: true });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ ok: false, error: "templates failed", data: { domainLink: { signIn: true } } });
  } finally {
    wpToolsService.domainLinkSettings = originalSettings;
    wpToolsService.renderPanelTemplates = originalRender;
  }
});
