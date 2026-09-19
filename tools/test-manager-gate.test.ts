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
function probe(
  auth: { user: string; roles: string[] } | null,
  requests: Array<{ path: string; method?: string }> = [
    { path: "/addons/health" }, { path: "/addons/" }, { path: "/addons/stager/" }, { path: "/addons/api/update" },
  ],
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
  callGatewayAction: async () => { reached.push("gateway"); return { ok: false, error: "no gateway in this test" }; },
}));
mock.module("./lib/mount.ts", () => ({
  ADDONS_BASE_PATH: "/addons",
  mountPath: (addon) => "/addons/" + addon,
  splitMount: () => { reached.push("addon-dispatch"); return null; },
}));

const { handleRequest } = await import("./cli/index.ts");

const out = [];
for (const { path, method } of ${JSON.stringify(requests)}) {
  reached.length = 0;
  const res = await handleRequest(new Request("https://panel.example" + path, { method: method || "GET" }), {});
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
// let it past, and the neighbouring wp-login routes show it is that route only.
test("a non-administrator reaches the WordPress sign-in and nothing else", () => {
  const results = probe({ user: "someone", roles: ["ROLE_USER"] }, [
    { path: "/addons/wp-login/api/sign-in", method: "POST" },
    { path: "/addons/wp-login/api/session" },
    { path: "/addons/wp-login/", method: "GET" },
    { path: "/addons/wp-login/api/remove", method: "POST" },
    { path: "/addons/wp-login/api/sign-in", method: "GET" },
    { path: "/addons/panel-tweaks/api/panel" },
    { path: "/addons/panel-tweaks/", method: "GET" },
    { path: "/addons/panel-tweaks/api/tweaks", method: "POST" },
  ]);
  const dispatched = results.filter((result) => (result.reached as string[]).includes("addon-dispatch"));
  expect(dispatched.map((result) => `${result.method} ${result.path}`)).toEqual([
    "POST /addons/wp-login/api/sign-in",
    "GET /addons/wp-login/api/session",
    "GET /addons/panel-tweaks/api/panel",
  ]);
  for (const result of results) {
    // Nothing else the manager does runs for this session, dispatched or not.
    expect(result.reached).not.toContain("update-check");
    expect(result.status).toBe(403);
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
