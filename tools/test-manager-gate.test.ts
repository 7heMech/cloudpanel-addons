// The manager's request gate. What is pinned here is an ordering, not a route:
// authentication runs before any route, the liveness probe included.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");

/**
 * Drive `handleRequest` in a subprocess with the session gate replaced, where
 * `auth` is what that gate reports. Everything past it records being reached.
 */
function probe(auth: { user: string; roles: string[] } | null): Array<Record<string, unknown>> {
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
  callGatewayAction: async () => { reached.push("gateway"); return { ok: false, error: "no gateway in this test" }; },
}));
mock.module("./lib/mount.ts", () => ({
  ADDONS_BASE_PATH: "/addons",
  mountPath: (addon) => "/addons/" + addon,
  splitMount: () => { reached.push("addon-dispatch"); return null; },
}));

const { handleRequest } = await import("./cli/index.ts");

const out = [];
for (const path of ["/addons/health", "/addons/", "/addons/stager/", "/addons/api/update"]) {
  reached.length = 0;
  const res = await handleRequest(new Request("https://panel.example" + path), {});
  let body = null;
  try { body = JSON.parse(await res.text()); } catch (e) { /* the page is HTML */ }
  out.push({ path, status: res.status, location: res.headers.get("location"), body, reached: [...reached] });
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

const { handleRequest } = await import("./cli/index.ts");

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
