// The manager's request gate. What is pinned here is an ordering, not a route:
// authentication runs before any route, the liveness probe included.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");

/**
 * Drive `handleRequest` in a subprocess with the session gate replaced, where
 * `auth` is what that gate reports. Everything past it records being reached.
 */
function probe(
  auth: { user: string; roles: string[] } | null,
  requests: Array<{ path: string; method?: string; headers?: Record<string, string>; body?: string }> = [
    { path: "/addons/health" }, { path: "/addons/" }, { path: "/addons/stager/" }, { path: "/addons/api/update" },
  ],
  // Resolve mounts instead of recording the attempt, so a request that is let
  // past the gate reaches the addon's own handler. No addon is installed here,
  // so the real splitMount would answer null for every path.
  dispatchMounts = false,
  // What the root gateway answers, by `addon:verb`; anything else fails.
  gateway: Record<string, unknown> = {},
): Array<Record<string, unknown>> {
  const script = `
import { mock } from "bun:test";

const reached = [];
const realSso = await import("./lib/sso-auth.ts");
mock.module("./lib/sso-auth.ts", () => ({
  ...realSso,
  authenticateRequest: async () => {
    const auth = ${JSON.stringify(auth)};
    return auth
      ? { auth }
      : { auth: null, response: new Response(null, { status: 302, headers: { Location: "/login" } }) };
  },
}));
mock.module("./lib/update-check.ts", () => ({
  checkCliUpdate: async () => { reached.push("update-check"); return null; },
}));
mock.module("./lib/gateway-client.ts", () => ({
  callGatewayAction: async (addon, verb, args) => {
    reached.push("gateway");
    reached.push(["gateway", addon, verb, ...(args || [])].join(" "));
    return ${JSON.stringify(gateway)}[addon + ":" + verb] ?? { ok: false, error: "no gateway in this test" };
  },
}));
// Nothing here reaches the network: a WordPress.org search answers no plugins.
globalThis.fetch = async () => { reached.push("fetch"); return Response.json({ plugins: [] }); };
mock.module("./lib/mount.ts", () => ({
  ADDONS_BASE_PATH: "/addons",
  mountPath: (addon) => "/addons/" + addon,
  splitMount: (path) => {
    reached.push("addon-dispatch");
    if (!${JSON.stringify(dispatchMounts)}) return null;
    const match = /^\\/([^/]+)(\\/.*)?$/.exec(path);
    return match ? { addon: match[1], rest: match[2] || "/" } : null;
  },
}));

const { handleRequest } = await import("./manager/server.ts");

const out = [];
for (const { path, method, headers, body: requestBody } of ${JSON.stringify(requests)}) {
  reached.length = 0;
  const res = await handleRequest(new Request("https://panel.example" + path, { method: method || "GET", headers, body: requestBody }), {});
  let body = null;
  try { body = JSON.parse(await res.text()); } catch (e) { /* the page is HTML */ }
  out.push({ path, method: method || "GET", status: res.status, location: res.headers.get("location"), body, reached: [...reached] });
}
console.log(JSON.stringify(out));
`;
  const run = spawnSync("bun", ["-e", script], { cwd: repo, encoding: "utf-8" });
  if (run.status !== 0) throw new Error(run.stderr || "gate probe failed");
  return JSON.parse(run.stdout.trim().split("\n").at(-1)!);
}

test("no route answers before the session gate", () => {
  for (const result of probe(null)) {
    expect(result.status, `${result.path} must redirect an anonymous caller`).toBe(302);
    expect(result.location).toBe("/login");
    expect(result.body).toBeNull();
    expect(result.reached, `${result.path} ran work before authenticating`).toEqual([]);
  }
});

test("an authenticated non-administrator gets no further than the gate", () => {
  for (const result of probe({ user: "someone", roles: ["ROLE_USER"] })) {
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ ok: false, error: "administrator role required" });
    expect(result.reached).toEqual([]);
  }
});

// The one carve-out in the blanket gate. The route is not answered here --
// splitMount is mocked away -- but reaching the dispatch is what says the gate
// let it past, and the neighbouring wp-tools routes show it is that route only.
test("a non-administrator reaches only the named self-scoped routes", () => {
  const results = probe({ user: "someone", roles: ["ROLE_USER"] }, [
    { path: "/addons/wp-tools/api/sign-in", method: "POST" },
    { path: "/addons/wp-tools/api/session" },
    { path: "/addons/wp-tools/api/site-kind" },
    { path: "/addons/wp-tools/api/site-kind", method: "POST" },
    { path: "/addons/wp-tools/api/site-installed", method: "POST" },
    { path: "/addons/wp-tools/api/site-installed", method: "GET" },
    { path: "/addons/wp-tools/", method: "GET" },
    { path: "/addons/wp-tools/api/remove", method: "POST" },
    { path: "/addons/wp-tools/api/sign-in", method: "GET" },
      // Uploading a plugin, and who may choose them, stay administrators'.
    { path: "/addons/wp-tools/api/plugin-upload", method: "POST" },
    { path: "/addons/wp-tools/api/plugin-discard", method: "POST" },
    { path: "/addons/wp-tools/api/new-site-settings", method: "POST" },
    { path: "/addons/wp-tools/api/plugin-search" },
    { path: "/addons/wp-tools/api/new-site", method: "POST" },
    { path: "/addons/wp-tools/api/new-site-status" },
    { path: "/addons/panel-tweaks/api/panel" },
    { path: "/addons/dns/api/session" },
    { path: "/addons/dns/api/provision", method: "POST" },
    { path: "/addons/dns/api/site" },
    { path: "/addons/dns/api/site", method: "POST" },
    { path: "/addons/dns/" },
    { path: "/addons/dns/api/check", method: "POST" },
    { path: "/addons/dns/api/provision", method: "GET" },
    { path: "/addons/dns/api/session", method: "POST" },
    { path: "/addons/dns/api/provision-extra", method: "POST" },
    { path: "/addons/panel-tweaks/", method: "GET" },
    { path: "/addons/panel-tweaks/api/tweaks", method: "POST" },
  ]);
  const dispatched = results.filter((result) => (result.reached as string[]).includes("addon-dispatch"));
  expect(dispatched.map((result) => `${result.method} ${result.path}`)).toEqual([
    "POST /addons/wp-tools/api/sign-in",
    "GET /addons/wp-tools/api/session",
    "GET /addons/wp-tools/api/site-kind",
    "POST /addons/wp-tools/api/site-installed",
    "GET /addons/wp-tools/api/plugin-search",
    "POST /addons/wp-tools/api/new-site",
    "GET /addons/wp-tools/api/new-site-status",
    "GET /addons/panel-tweaks/api/panel",
    "GET /addons/dns/api/session",
    "POST /addons/dns/api/provision",
    "GET /addons/dns/api/site",
  ]);
  for (const result of results) {
    // Nothing else the manager does runs for this session, dispatched or not.
    expect(result.reached).not.toContain("update-check");
    expect(result.status).toBe(403);
  }
});

// The addons that declare `siteManager` are the whole mount, not a route list:
// CloudPanel does not narrow that role's site list, so the addon's own pages
// are already what it may see. Everything else stays behind the blanket gate.
test("a site manager reaches the addons that declare the role and nothing else", () => {
  const results = probe({ user: "manager", roles: ["ROLE_SITE_MANAGER"] }, [
    { path: "/addons/git/" },
    { path: "/addons/git/api/sites" },
    { path: "/addons/instatic/new" },
    { path: "/addons/instatic/api/instances", method: "POST", headers: {
      Origin: "https://panel.example", Host: "panel.example",
      Cookie: "clp_addons_csrf=gate-test", "X-CLP-Addons-CSRF": "gate-test",
    }, body: JSON.stringify({ domain: "bad", tag: "0.0.20" }) },
    { path: "/addons/instatic/api/instances/example.com/restart", method: "POST" },
    { path: "/addons/instatic/api/jobs/invalid" },
    { path: "/addons/stager/" },
    { path: "/addons/" },
    { path: "/addons/api/update", method: "POST" },
  ], true);
  const answered = results.filter((result) => result.status !== 403);
  // The addons answer for themselves, even when their data source fails or
  // their input validation refuses the request.
  expect(answered.map((result) => `${result.method} ${result.path}`)).toEqual([
    "GET /addons/git/",
    "GET /addons/git/api/sites",
    "GET /addons/instatic/new",
    "POST /addons/instatic/api/instances",
    "GET /addons/instatic/api/jobs/invalid",
  ]);
  const create = results.find((result) => result.path === "/addons/instatic/api/instances")!;
  expect(create.status).toBe(400);
  expect(create.body).toEqual({ ok: false, error: "domain is not a valid hostname" });
  const restart = results.find((result) => result.path === "/addons/instatic/api/instances/example.com/restart")!;
  expect(restart.status).toBe(403);
  expect(restart.body).toEqual({ ok: false, error: "missing Origin header" });
  for (const result of results) {
    expect(result.reached).not.toContain("update-check");
  }
});

// The plugin picker on CloudPanel's new-site form, which site managers use
// too. The gate lets a site manager through to these three routes by name and
// no further; the switch is root's, so it is the gateway's answer here.
test("a site manager reaches the plugin picker's routes, and root's switch decides", () => {
  const csrf = { Origin: "https://panel.example", Host: "panel.example", Cookie: "clp_addons_csrf=gate-test", "X-CLP-Addons-CSRF": "gate-test" };
  const requests = [
    { path: "/addons/wp-tools/api/new-site", method: "POST", headers: csrf,
      body: JSON.stringify({ domain: "new.example.com", plugins: [{ slug: "woocommerce", activate: true }] }) },
    { path: "/addons/wp-tools/api/new-site", method: "POST", headers: csrf,
      body: JSON.stringify({ domain: "new.example.com", uploads: [{ id: "0".repeat(32), activate: true }] }) },
    { path: "/addons/wp-tools/api/plugin-search?q=woo" },
    { path: "/addons/wp-tools/api/new-site-status?job=20261029T192025Z-4a8d82" },
    { path: "/addons/wp-tools/api/plugin-upload", method: "POST", headers: csrf, body: "PK" },
    { path: "/addons/wp-tools/api/plugin-discard", method: "POST", headers: csrf, body: JSON.stringify({ id: "0".repeat(32) }) },
    { path: "/addons/wp-tools/api/new-site-settings", method: "POST", headers: csrf, body: JSON.stringify({ siteManagers: true }) },
    { path: "/addons/wp-tools/" },
  ];
  const off = "an administrator has not let site managers choose plugins for new sites";
  const statuses = (gateway: Record<string, unknown>) => {
    const results = probe({ user: "manager", roles: ["ROLE_SITE_MANAGER"] }, requests, true, gateway);
    for (const result of results) expect(result.reached).not.toContain("update-check");
    return results;
  };

  const refused = statuses({
    "wp-tools:new-site": { ok: false, error: off },
    "wp-tools:new-site-access": { ok: false, error: off },
    "wp-tools:new-site-status": { ok: false, error: "no such job" },
  });
  expect(refused.map((result) => result.status)).toEqual([400, 403, 403, 404, 403, 403, 403, 403]);
  expect(refused[0]!.body).toEqual({ ok: false, error: off });
  // Root is told whose request it is; a zip is refused before root is asked.
  expect(refused[0]!.reached).toContain("gateway wp-tools new-site --domain=new.example.com --plugins=woocommerce:1 --as-user=manager");
  expect(refused[1]!.reached).not.toContain("gateway");
  expect(refused[2]!.reached).toContain("gateway wp-tools new-site-access --as-user=manager");
  expect(refused[2]!.reached).not.toContain("fetch");
  expect(refused[3]!.reached).toContain("gateway wp-tools new-site-status --job=20261029T192025Z-4a8d82 --as-user=manager");
  // Uploading, discarding, the switch itself and the addon's page stay behind the gate.
  for (const result of refused.slice(4)) {
    expect(result.body).toEqual({ ok: false, error: "administrator role required" });
    expect(result.reached).not.toContain("gateway");
  }

  const allowed = statuses({
    "wp-tools:new-site": { ok: true, data: { job: { id: "20261029T192025Z-4a8d82" } } },
    "wp-tools:new-site-access": { ok: true, data: { uploads: false } },
    "wp-tools:new-site-status": { ok: true, data: { job: { id: "20261029T192025Z-4a8d82", state: "running" } } },
  });
  expect(allowed.map((result) => result.status)).toEqual([200, 403, 200, 200, 403, 403, 403, 403]);
  expect(allowed[2]!.reached).toContain("fetch");
  expect(allowed[2]!.body).toEqual({ ok: true, data: { plugins: [] } });
});

test("an ordinary user cannot create or manage Instatic sites", () => {
  for (const result of probe({ user: "someone", roles: ["ROLE_USER"] }, [
    { path: "/addons/instatic/" },
    { path: "/addons/instatic/new" },
    { path: "/addons/instatic/api/instances", method: "POST" },
    { path: "/addons/instatic/api/instances/example.com/delete", method: "POST" },
    { path: "/addons/instatic/api/jobs/20260910T093000Z-a1b2c3/events" },
  ], true)) {
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ ok: false, error: "administrator role required" });
    expect(result.reached).toEqual([]);
  }
});

test("an addon that is not installed answers 404 to an administrator and 403 to anyone else", () => {
  // Panel Tweaks' completion script reads exactly these as "DNS is not installed".
  const session = [{ path: "/addons/dns/api/session" }];
  expect(probe({ user: "admin", roles: ["ROLE_ADMIN"] }, session)[0]!.status).toBe(404);
  expect(probe({ user: "someone", roles: ["ROLE_USER"] }, session)[0]!.status).toBe(403);
  expect(probe({ user: "manager", roles: ["ROLE_SITE_MANAGER"] }, session)[0]!.status).toBe(403);
});

test("an administrator reaches the probe and the routes behind it", () => {
  const results = probe({ user: "admin", roles: ["ROLE_ADMIN"] });
  const health = results.find((result) => result.path === "/addons/health")!;
  expect(health.status).toBe(200);
  expect(health.body).toEqual({ ok: true, service: "clp-addons" });
  // Answered before the update check: it is polled once a second on restart.
  expect(health.reached).toEqual([]);

  const index = results.find((result) => result.path === "/addons/")!;
  expect(index.status).toBe(200);
  expect(index.reached).toContain("update-check");
});

// Recorded from a CloudPanel 2.5.4-3+clp-bookworm staging box:
//   curl -sk https://<panel>:8443/notloggedin
// A refusal under /addons has to be this response and no other, or the route is
// distinguishable from any other path the panel does not serve to a stranger.
const CLOUDPANEL_REDIRECT_SHA = "af7924f0101b882e16aab40bb87254cce1c58be1218b1153bae68d6f6121de49";

test("a refusal is byte-identical to the panel's own unauthenticated redirect", async () => {
  const { redirectToLogin } = await import("../lib/sso-auth");
  const res = redirectToLogin();
  const body = await res.text();

  expect(res.status).toBe(302);
  expect(Bun.CryptoHasher.hash("sha256", body, "hex")).toBe(CLOUDPANEL_REDIRECT_SHA);
  expect(res.headers.get("location")).toBe("/login");
  expect(res.headers.get("content-type")).toBe("text/html; charset=UTF-8");
  expect(res.headers.get("cache-control")).toBe("no-cache, private");
  // The header policy is what used to give this away; the panel sends none of it.
  for (const header of ["content-security-policy", "x-frame-options", "referrer-policy", "x-content-type-options"]) {
    expect(res.headers.get(header), `${header} is not on the panel's redirect`).toBeNull();
  }
});

/**
 * The push-to-deploy route is the one thing decided ahead of the gate. What it
 * must not become is a way to ask which sites have a webhook, so every refusal
 * it can produce has to be the response the gate would have sent anyway.
 */
function hookProbe(): Array<Record<string, unknown>> {
  const script = `
import { mock } from "bun:test";

const GOOD = "G".repeat(43);
const realSso = await import("./lib/sso-auth.ts");
mock.module("./lib/sso-auth.ts", () => ({
  ...realSso,
  authenticateRequest: async () => ({ auth: null, response: realSso.redirectToLogin() }),
}));
mock.module("./lib/update-check.ts", () => ({ checkCliUpdate: async () => null }));

let calls = 0;
mock.module("./lib/gateway-client.ts", () => ({
  callGatewayAction: async (addon, verb, args, input) => {
    calls++;
    const token = JSON.parse(input ?? "{}").token;
    return token === GOOD
      ? { ok: true, data: { deployed: true, job: "20260919T120000Z-abcdef", outcome: "started a deployment" } }
      : { ok: false, error: "no delivery for this site" };
  },
  streamGatewayAction: () => ({ close() {} }),
}));

// The addon has to look installed; its config file is what the manager reads.
const realCatalog = await import("./cli/addon-catalog.ts");
mock.module("./cli/addon-catalog.ts", () => ({
  ...realCatalog,
  ADDONS: { ...realCatalog.ADDONS, git: { ...realCatalog.ADDONS.git, configFile: "./package.json" } },
}));

const { handleRequest } = await import("./manager/server.ts");

async function describe(label, req) {
  const before = calls;
  const res = await handleRequest(req, {});
  return {
    label,
    status: res.status,
    headers: [...res.headers].map(([name, value]) => name + ": " + value).sort(),
    body: await res.text(),
    gatewayCalls: calls - before,
  };
}

const base = "https://panel.example/addons/git/hook/www.example.com/";
const post = (token) => new Request(base + token, { method: "POST", body: "{}" });
const out = [
  await describe("valid", post(GOOD)),
  await describe("wrong", post("W".repeat(43))),
  await describe("malformed", post("nope")),
  await describe("get", new Request(base + GOOD)),
  await describe("stranger", new Request("https://panel.example/addons/git/", { method: "POST" })),
];
console.log(JSON.stringify(out));
`;
  const run = spawnSync("bun", ["-e", script], { cwd: repo, encoding: "utf-8" });
  if (run.status !== 0) throw new Error(run.stderr || "hook probe failed");
  return JSON.parse(run.stdout.trim().split("\n").at(-1)!);
}

test("a wrong webhook token is answered exactly as a stranger is", async () => {
  const { redirectToLogin } = await import("../lib/sso-auth");
  const gate = redirectToLogin();
  const expected = {
    status: gate.status,
    headers: [...gate.headers].map(([name, value]) => `${name}: ${value}`).sort(),
    body: await gate.text(),
  };
  const results = Object.fromEntries(hookProbe().map((result) => [result.label, result]));

  for (const label of ["wrong", "malformed", "get", "stranger"]) {
    const { status, headers, body } = results[label]!;
    expect({ status, headers, body }, `${label} is distinguishable from the gate's own refusal`).toEqual(expected);
  }
  // A token that cannot be one is refused without asking root about it, and a
  // request that is not a delivery never reaches the route at all.
  expect(results.malformed!.gatewayCalls).toBe(0);
  expect(results.stranger!.gatewayCalls).toBe(0);
  expect(results.wrong!.gatewayCalls).toBe(1);

  expect(results.valid!.status).toBe(200);
  expect(JSON.parse(String(results.valid!.body))).toEqual({
    ok: true, deployed: true, job: "20260919T120000Z-abcdef", outcome: "started a deployment",
  });
});

/**
 * Passkey sign-in is the other thing answered before the gate. It reaches root
 * only from the panel's own origin, carries the challenge in a cookie another
 * site cannot send, and is nothing at all while the addon is not installed.
 */
function signInProbe(installed: boolean): Array<Record<string, unknown>> {
  const script = `
import { mock } from "bun:test";
const realSso = await import("./lib/sso-auth.ts");
mock.module("./lib/sso-auth.ts", () => ({
  ...realSso,
  authenticateRequest: async () => ({ auth: null, response: realSso.redirectToLogin() }),
}));
mock.module("./lib/update-check.ts", () => ({ checkCliUpdate: async () => null }));
const asked = [];
mock.module("./lib/gateway-client.ts", () => ({
  callGatewayAction: async (addon, verb, args, input) => {
    asked.push(verb + " " + (input ?? ""));
    if (verb === "login-options") return { ok: true, data: { challengeId: "c".repeat(32), challenge: "xyz" } };
    return JSON.parse(input).challengeId === "c".repeat(32)
      ? { ok: true, data: { token: "f".repeat(64), user: "alice" } }
      : { ok: false, error: "the sign-in request has expired; try again" };
  },
  streamGatewayAction: () => ({ close() {} }),
}));
const realCatalog = await import("./cli/addon-catalog.ts");
mock.module("./cli/addon-catalog.ts", () => ({
  ...realCatalog,
  ADDONS: { ...realCatalog.ADDONS, "security-keys": { ...realCatalog.ADDONS["security-keys"], configFile: ${installed ? '"./package.json"' : '"./absent.conf"'} } },
}));
const { handleRequest } = await import("./manager/server.ts");
const url = "https://panel.example:8443/addons/security-keys/login/";
const post = (route, headers) => new Request(url + route, {
  method: "POST", body: JSON.stringify({ id: "k", response: {} }), headers: { host: "panel.example:8443", ...headers },
});
const out = [];
for (const [label, req] of [
  ["options", post("options", { origin: "https://panel.example:8443" })],
  ["cross-site", post("options", { origin: "https://evil.example" })],
  ["no-cookie", post("verify", { origin: "https://panel.example:8443" })],
  ["verify", post("verify", { origin: "https://panel.example:8443", cookie: "clp_addons_passkey=" + "c".repeat(32) })],
  ["get", new Request(url + "options")],
]) {
  const before = asked.length;
  const res = await handleRequest(req, {});
  out.push({ label, status: res.status, cookie: res.headers.get("set-cookie"), body: await res.text(), asked: asked.slice(before) });
}
console.log(JSON.stringify(out));
`;
  const run = spawnSync("bun", ["-e", script], { cwd: repo, encoding: "utf-8" });
  if (run.status !== 0) throw new Error(run.stderr || "sign-in probe failed");
  return JSON.parse(run.stdout.trim().split("\n").at(-1)!);
}

test("passkey sign-in is answered before the gate, from the panel's own origin only", () => {
  const results = Object.fromEntries(signInProbe(true).map((result) => [result.label, result]));
  expect(results.options).toMatchObject({ status: 200, asked: ["login-options "] });
  expect(JSON.parse(String(results.options!.body))).toEqual({ ok: true, challenge: "xyz" });
  expect(results.options!.cookie).toBe(
    `clp_addons_passkey=${"c".repeat(32)}; Path=/addons/security-keys/login; Max-Age=300; HttpOnly; Secure; SameSite=Strict`,
  );
  expect(results["cross-site"]).toMatchObject({ status: 403, asked: [] });
  expect(results["no-cookie"]).toMatchObject({ status: 400 });
  expect(JSON.parse(String(results.verify!.body))).toEqual({ ok: true, redirect: `/autologin?token=${"f".repeat(64)}` });
  expect(String(results.verify!.cookie)).toStartWith("clp_addons_passkey=; Path=/addons/security-keys/login; Max-Age=0");
  expect(results.get).toMatchObject({ status: 302, asked: [] });
});

test("passkey sign-in does not exist while the addon is not installed", () => {
  for (const result of signInProbe(false)) {
    expect(result, String(result.label)).toMatchObject({ status: 302, asked: [] });
  }
});

// The tests above drive real requests through the gate. This one is about an
// argument to Bun.serve, which no request can reach: with `development` on,
// Bun answers a handler fault with its own error page, which would put a stack
// trace in front of whoever tripped it.
test("a handler fault cannot answer with Bun's error page", () => {
  const source = readFileSync(join(repo, "manager/server.ts"), "utf8");
  expect(source.slice(source.indexOf("async function cmdServe"))).toInclude("development: false");
});

test("a slow gateway call is not cut off by Bun's idle timeout", () => {
  const source = readFileSync(join(repo, "manager/server.ts"), "utf8");
  expect(source.slice(source.indexOf("async function cmdServe"))).toInclude("idleTimeout: 0");
});

// Run by hand, serve would replace the live daemon's socket before anything
// could notice it was the wrong account, so it refuses before touching it.
test("serve refuses to start outside its systemd unit", () => {
  // Claiming a systemd invocation in the environment is not enough.
  const env = { ...process.env, INVOCATION_ID: "0123456789abcdef0123456789abcdef" };
  const result = spawnSync("bun", ["cli/index.ts", "serve"], { cwd: repo, env, encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(result.stderr).toInclude("systemctl restart clp-addons.service");
});

// A shell as a site's user is an administrator's tool: no role list, no
// self-scoped route, whatever the other addons let through.
test("no non-administrator reaches the terminal", () => {
  const paths = [
    { path: "/addons/terminal/" },
    { path: "/addons/terminal/sites/www.example.com" },
    { path: "/addons/terminal/api/sessions", method: "POST" },
    { path: "/addons/terminal/api/sessions/AAAAAAAAAAAAAAAAAAAAAA/events" },
  ];
  for (const roles of [["ROLE_USER"], ["ROLE_SITE_MANAGER"]]) {
    for (const result of probe({ user: "someone", roles }, paths, true)) {
      expect(result.status, `${roles[0]} ${result.path}`).toBe(403);
    }
  }
});
