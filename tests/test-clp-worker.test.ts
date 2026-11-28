import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  accessAllowed, addressGroup, type Allowlist, collectStats, type D1, dailyHash, decide, type Deps, type Env, handle,
  INSTALL_URL, MAX_BODY_BYTES, parseCheck, readCapped, rollUp, statsHtml, trimReleases,
} from "../worker/index";
import { countedActions } from "../lib/usage-actions";
import { ADDON_NAMES } from "../addons/catalog";
import contract from "./fixtures/check-contract.json";

const allowlist: Allowlist = {
  addons: ["dns", "firewall", "git"],
  actions: { dns: ["assign", "list"], firewall: ["set"], git: ["deploy"] },
};

/** D1 over bun:sqlite, running worker/schema.sql. */
function fakeD1(): { db: D1; sqlite: Database } {
  const sqlite = new Database(":memory:");
  sqlite.exec(readFileSync(join(import.meta.dir, "../worker/schema.sql"), "utf8"));
  const statement = (sql: string, values: unknown[] = []): ReturnType<D1["prepare"]> => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (sqlite.query(sql).get(...(values as never[])) ?? null) as T | null,
    all: async <T>() => ({ results: sqlite.query(sql).all(...(values as never[])) as T[] }),
    run: async () => ({ meta: { changes: sqlite.query(sql).run(...(values as never[])).changes } }),
  });
  return { sqlite, db: { prepare: (sql) => statement(sql), batch: async (list) => Promise.all(list.map((item) => item.run())) } };
}

function fakeCache() {
  const store = new Map<string, Response>();
  return {
    store,
    match: async (request: Request) => store.get(request.url)?.clone(),
    put: async (request: Request, response: Response) => void store.set(request.url, response.clone()),
  };
}

const RELEASES = [
  { tag_name: "v2.3.0", draft: true, prerelease: false },
  { tag_name: "v2.2.0", draft: false, prerelease: false },
  { tag_name: "v2.2.0-rc.3", draft: false, prerelease: true },
  { tag_name: "v2.1.0", draft: false, prerelease: false },
];

function setup(options: { now?: string; upstream?: (url: string, init?: RequestInit) => Response | Promise<Response>; env?: Partial<Env> } = {}) {
  const points: { indexes?: string[]; blobs?: string[]; doubles?: number[] }[] = [];
  const waiting: Promise<unknown>[] = [];
  const calls: { url: string; init?: RequestInit }[] = [];
  const kv = new Map<string, { value: string; ttl?: number }>();
  const { db, sqlite } = fakeD1();
  const cache = fakeCache();
  let now = new Date(options.now ?? "2026-11-28T10:00:00Z");
  const env: Env = {
    ASSETS: { fetch: async () => new Response("page") },
    USAGE: { writeDataPoint: (point) => void points.push(point) },
    SECRETS: {
      get: async (key) => kv.get(key)?.value ?? null,
      put: async (key, value, opts) => void kv.set(key, { value, ttl: opts?.expirationTtl }),
    },
    DB: db,
    ...options.env,
  };
  const deps: Deps = {
    cache,
    allowlist,
    now: () => now,
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return options.upstream ? options.upstream(url, init) : Response.json(RELEASES);
    }) as unknown as typeof fetch,
  };
  const ctx = { waitUntil: (promise: Promise<unknown>) => void waiting.push(promise) };
  const call = async (path: string, init?: RequestInit & { ip?: string; cf?: Record<string, unknown> }) => {
    const request = new Request(`https://clp.7he.dev${path}`, { ...init, headers: { "CF-Connecting-IP": init?.ip ?? "203.0.113.7", ...init?.headers as Record<string, string> } });
    if (init?.cf) Object.defineProperty(request, "cf", { value: init.cf });
    const res = await handle(request, env, ctx, deps);
    await Promise.all(waiting);
    return res;
  };
  return { call, points, calls, cache, env, deps, kv, sqlite, setNow: (date: string) => { now = new Date(date); } };
}

const post = (body: unknown, extra: Record<string, unknown> = {}) => ({ method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), ...extra });
const ID = "0123456789abcdef0123456789abcdef";
const checkRequest = (version: string, arch: string, usage?: unknown) =>
  ({ version, channel: version.includes("-") ? "prerelease" : "stable", arch, ...(usage ? { usage } : {}) });
const usage = { id: ID, cloudpanel: "2.5.4", addons: ["dns", "firewall"], activity: { dns: { list: 3 }, firewall: { set: 1 } } };

test("/install.sh redirects to the latest release's installer", async () => {
  const { call } = setup();
  const res = await call("/install.sh");
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe(INSTALL_URL);
  expect((await call("/install.sh", { method: "POST" })).status).toBe(405);
});

test("other paths fall through to the landing page, and the weekly /usage and /releases.json are gone", async () => {
  const { call } = setup();
  expect(await (await call("/")).text()).toBe("page");
  expect(await (await call("/usage", post({}))).text()).toBe("page");
  expect(await (await call("/releases.json")).text()).toBe("page");
});

describe("/check", () => {
  test("answers the contract lib/update-check.ts is tested against (tests/fixtures/check-contract.json)", async () => {
    const releases = contract.releases.map((tag_name) => ({ tag_name, draft: false, prerelease: false }));
    const fixture = setup({ upstream: () => Response.json(releases) });
    expect(await (await fixture.call("/check", post(contract.request))).json()).toEqual(contract.answer);
    expect(await (await fixture.call("/check", post(contract.requestWithUsage))).json()).toEqual(contract.answerWithUsage);
    expect(await (await fixture.call("/forget", post(contract.forget))).json()).toEqual(contract.forgetAnswer);

    const { call, points } = setup();
    const res = await call("/check", post(checkRequest("2.1.0", "x64")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ latest: "2.2.0", update: true, urgent: false, usage: "none" });
    expect(points).toHaveLength(1);
    expect(points[0]!.blobs).toEqual(["2.1.0", "stable", "x64", "basic"]);
    expect(points[0]!.indexes![0]).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(points)).not.toContain("203.0.113.7");
  });

  test("a pre-release follows pre-releases; drafts are never offered; an up-to-date box is told so", async () => {
    const { call } = setup();
    expect(await (await call("/check", post(checkRequest("2.2.0-rc.3", "arm64")))).json()).toEqual({ latest: "2.2.0", update: true, urgent: false, usage: "none" });
    expect(await (await call("/check", post(checkRequest("2.2.0", "x64")))).json()).toEqual({ latest: "2.2.0", update: false, urgent: false, usage: "none" });
  });

  test("refuses implausible reports: unknown version, wrong arch or channel, big bodies", async () => {
    const { call, points } = setup();
    for (const body of [
      { version: "9.9.9", channel: "stable", arch: "x64" },
      { version: "2.3.0", channel: "stable", arch: "x64" },
      { version: "2.1.0", channel: "stable", arch: "riscv64" },
      { version: "2.1.0", channel: "nightly", arch: "x64" },
      { version: "v2.1.0", channel: "stable", arch: "x64" },
      [],
      "{not json",
    ]) expect((await call("/check", post(body))).status).toBe(400);
    expect((await call("/check", post({ version: "2.1.0", channel: "stable", arch: "x64", pad: "é".repeat(MAX_BODY_BYTES / 2) }))).status).toBe(413);
    expect((await call("/check")).status).toBe(405);
    expect(points).toHaveLength(0);
  });

  test("502s when no release list can be had", async () => {
    const { call } = setup({ upstream: () => new Response("rate limited", { status: 403 }) });
    expect((await call("/check", post(checkRequest("2.1.0", "x64")))).status).toBe(502);
  });

  test("the release list is cached and the GitHub token is sent only to GitHub", async () => {
    const { call, calls } = setup({ env: { GITHUB_TOKEN: "ghp_secret" } });
    await call("/check", post(checkRequest("2.1.0", "x64")));
    await call("/check", post(checkRequest("2.1.0", "x64")));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.github.com/repos/7heMech/cloudpanel-addons/releases?per_page=100");
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe("Bearer ghp_secret");
  });

  test("opt-in usage is stored per ID and day with country and network, never the address or hash", async () => {
    const { call, points, sqlite } = setup();
    const cf = { country: "DE", asn: 24940, asOrganization: "Hetzner Online GmbH" };
    const res = await call("/check", post(checkRequest("2.1.0", "x64", usage), { cf }));
    expect(((await res.json()) as { usage: string }).usage).toBe("saved");
    expect(points[0]!.blobs![3]).toBe("opt-in");
    const row = sqlite.query("SELECT * FROM reports").get() as Record<string, unknown>;
    expect(row).toEqual({
      id: ID, day: "2026-11-28", version: "2.1.0", channel: "stable", arch: "x64", cloudpanel: "2.5.4",
      addons: '["dns","firewall"]', activity: '{"dns":{"list":3},"firewall":{"set":1}}', country: "DE", asn: 24940, network: "Hetzner Online GmbH",
    });
    expect(JSON.stringify(row)).not.toContain(points[0]!.indexes![0]!);

    // A second send the same day adds its counts to the same row.
    await call("/check", post(checkRequest("2.1.0", "x64", { ...usage, activity: { dns: { list: 2 } } }), { cf }));
    expect((sqlite.query("SELECT activity FROM reports").get() as { activity: string }).activity).toBe('{"dns":{"list":5},"firewall":{"set":1}}');
    expect(sqlite.query("SELECT count(*) AS n FROM reports").get()).toEqual({ n: 1 });
  });

  test("one install ID per address a day: made-up IDs from the same /64 are refused", async () => {
    const { call, sqlite } = setup();
    expect((await (await call("/check", { ...post(checkRequest("2.1.0", "x64", usage)), ip: "2001:db8:1:2::10" })).json() as { usage: string }).usage).toBe("saved");
    const other = { ...usage, id: "f".repeat(32) };
    const res = await call("/check", { ...post(checkRequest("2.1.0", "x64", other)), ip: "2001:db8:1:2:ffff::1" });
    expect(await res.json()).toMatchObject({ update: true, usage: "refused" });
    expect(sqlite.query("SELECT id FROM reports").all()).toEqual([{ id: ID }]);
  });

  test("names off the allowlist are dropped, counts clamped, malformed usage refused but the check answered", async () => {
    const { call, sqlite } = setup();
    const noisy = { ...usage, addons: ["dns", "example.com", "dns"], activity: { dns: { list: 99_999, "rm -rf": 1 }, "site.example": { list: 1 }, git: { deploy: 1.5 } } };
    expect((await (await call("/check", post(checkRequest("2.1.0", "x64", noisy)))).json() as { usage: string }).usage).toBe("saved");
    expect(sqlite.query("SELECT addons, activity FROM reports").get()).toEqual({ addons: '["dns"]', activity: '{"dns":{"list":10000}}' });

    const { call: call2, points } = setup();
    const res = await call2("/check", post({ ...checkRequest("2.1.0", "x64"), usage: { id: "not-hex", addons: [], activity: {}, cloudpanel: null } }));
    expect(await res.json()).toMatchObject({ update: true, usage: "refused" });
    expect(points[0]!.blobs![3]).toBe("basic");
  });
});

test("/forget deletes an ID's rows", async () => {
  const { call, sqlite } = setup();
  await call("/check", post(checkRequest("2.1.0", "x64", usage)));
  const res = await call("/forget", post({ id: ID }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ deleted: 1 });
  expect(sqlite.query("SELECT count(*) AS n FROM reports").get()).toEqual({ n: 0 });
  expect(sqlite.query("SELECT count(*) AS n FROM reporters").get()).toEqual({ n: 0 });
  expect((await call("/forget", post({ id: "x" }))).status).toBe(400);
  expect((await call("/forget")).status).toBe(405);
});

describe("counting servers", () => {
  test("the daily hash is keyed by a random secret per day that KV expires after two days", async () => {
    const { env, kv } = setup();
    const a = await dailyHash(env, "203.0.113.7", "2026-11-28");
    expect(await dailyHash(env, "203.0.113.7", "2026-11-28")).toBe(a);
    expect(await dailyHash(env, "203.0.113.8", "2026-11-28")).not.toBe(a);
    const b = await dailyHash(env, "203.0.113.7", "2026-11-29");
    expect(b).not.toBe(a);
    expect([...kv.keys()].sort()).toEqual(["hmac:2026-11-28", "hmac:2026-11-29"]);
    expect(kv.get("hmac:2026-11-28")!.ttl).toBe(172_800);
    expect(kv.get("hmac:2026-11-28")!.value).toMatch(/^[0-9a-f]{64}$/);
  });

  test("IPv6 addresses are grouped to their /64", () => {
    expect(addressGroup("203.0.113.7")).toBe("203.0.113.7");
    expect(addressGroup("2001:db8:1:2::10")).toBe("2001:db8:1:2::/64");
    expect(addressGroup("2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(addressGroup("2001:db8::1")).toBe("2001:db8:0:0::/64");
  });
});

describe("release policy", () => {
  const check = { version: "2.1.0", channel: "stable" as const, arch: "x64" };
  test("hold, stage and urgent", () => {
    expect(decide(RELEASES, check, { hold: ["2.2.0"] }, 0)).toEqual({ latest: "2.1.0", update: false, urgent: false });
    expect(decide(RELEASES, check, { stage: { "2.2.0": 25 } }, 24)).toMatchObject({ latest: "2.2.0", update: true });
    expect(decide(RELEASES, check, { stage: { "2.2.0": 25 } }, 25)).toMatchObject({ latest: "2.1.0", update: false });
    expect(decide(RELEASES, check, { urgent: ["2.2.0"] }, 0)).toEqual({ latest: "2.2.0", update: true, urgent: true });
    expect(decide(RELEASES, { ...check, version: "2.2.0" }, { urgent: ["2.2.0"] }, 0).urgent).toBe(false);
  });
});

test("parseCheck and trimReleases keep only what they read", () => {
  expect(parseCheck({ version: "2.1.0", channel: "stable", arch: "x64", extra: "x" }, allowlist)).toEqual({ check: { version: "2.1.0", channel: "stable", arch: "x64" }, usageMalformed: false });
  expect(trimReleases([{ tag_name: "v1.0.0", draft: false, prerelease: false, body: "notes" }, { nope: 1 }])).toEqual([{ tag_name: "v1.0.0", draft: false, prerelease: false }]);
});

test("readCapped stops reading a body without Content-Length once it passes the cap", async () => {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      controller.enqueue(new Uint8Array(1024));
      if (pulled > 50) controller.close();
    },
  });
  const request = new Request("https://clp.7he.dev/check", { method: "POST", body: stream, duplex: "half" } as RequestInit);
  expect(await readCapped(request, 2048)).toBeNull();
  expect(pulled).toBeLessThan(10);
  expect(await readCapped(new Request("https://x", { method: "POST", body: "abc" }), 2048)).toEqual(new TextEncoder().encode("abc"));
});

test("the allowlist is the catalog's addons and lib/usage-actions.ts's actions", () => {
  const actions = countedActions();
  expect(Object.keys(actions).every((addon) => ADDON_NAMES.includes(addon))).toBe(true);
  expect(Object.values(actions).flat().every((verb) => /^[a-z][a-z0-9-]*$/.test(verb))).toBe(true);
});

describe("statistics", () => {
  const analyticsRows = (sql: string) => {
    if (sql.includes("blob4")) return [{ day: "2026-11-27 00:00:00", key: "opt-in", servers: 1 }, { day: "2026-11-27 00:00:00", key: "basic", servers: 3 }];
    if (sql.includes("blob1")) return [{ day: "2026-11-27 00:00:00", key: "2.2.0", servers: 3 }, { day: "2026-11-27 00:00:00", key: "2.1.0", servers: 1 }];
    if (sql.includes("blob2")) return [{ day: "2026-11-27 00:00:00", key: "stable", servers: 4 }];
    if (sql.includes("blob3")) return [{ day: "2026-11-27 00:00:00", key: "x64", servers: 4 }];
    return [{ day: "2026-11-27 00:00:00", servers: 4 }];
  };
  const upstream = async (url: string, init?: RequestInit) => {
    if (url.includes("analytics_engine")) return Response.json({ data: analyticsRows(String(init?.body)) });
    return Response.json(RELEASES);
  };
  const env = { CF_ACCOUNT_ID: "acct", CF_ANALYTICS_TOKEN: "tok" };

  test("the roll-up keeps Analytics Engine and opt-in totals per day, and prunes", async () => {
    const t = setup({ now: "2026-11-27T10:00:00Z", upstream, env });
    await t.call("/check", post(checkRequest("2.1.0", "x64", usage), { cf: { country: "DE", asn: 24940, asOrganization: "Hetzner" } }));
    t.sqlite.query("INSERT INTO reports (id, day, version, channel, arch, addons, activity) VALUES ('old', '2026-01-01', '2.0.0', 'stable', 'x64', '[]', '{}')").run();
    t.setNow("2026-11-28T00:20:00Z");
    await rollUp(t.env, t.deps);
    const daily = t.sqlite.query("SELECT metric, key, value FROM daily WHERE day = '2026-11-27' ORDER BY metric, key").all();
    expect(daily).toContainEqual({ metric: "servers", key: "", value: 4 });
    expect(daily).toContainEqual({ metric: "tier", key: "opt-in", value: 1 });
    expect(daily).toContainEqual({ metric: "addon", key: "dns", value: 1 });
    expect(daily).toContainEqual({ metric: "country", key: "DE", value: 1 });
    expect(daily).toContainEqual({ metric: "network", key: "AS24940 Hetzner", value: 1 });
    expect(t.sqlite.query("SELECT id FROM reports").all()).toEqual([{ id: ID }]);
    expect(t.sqlite.query("SELECT count(*) AS n FROM reporters").get()).toEqual({ n: 0 });
    const sql = t.calls.filter((c) => c.url.includes("analytics_engine")).map((c) => String(c.init?.body));
    expect(sql[0]).toContain("count(DISTINCT index1)");
    expect(sql[0]).toContain("toDateTime('2026-11-21 00:00:00')");
  });

  test("/stats needs a valid Access JWT, then shows servers, splits, opt-in rate and medians", async () => {
    const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
    const team = "team.cloudflareaccess.com";
    const b64 = (value: string | ArrayBuffer) => Buffer.from(typeof value === "string" ? value : new Uint8Array(value)).toString("base64url");
    const sign = async (claims: Record<string, unknown>) => {
      const head = b64(JSON.stringify({ alg: "RS256", kid: "k1" }));
      const body = b64(JSON.stringify(claims));
      return `${head}.${body}.${b64(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`)))}`;
    };
    const t = setup({
      now: "2026-11-28T10:00:00Z",
      env: { ...env, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: "aud1" },
      upstream: async (url, init) => url.endsWith("/cdn-cgi/access/certs") ? Response.json({ keys: [jwk] }) : upstream(url, init),
    });
    const exp = Date.parse("2026-11-28T11:00:00Z") / 1000;
    const good = await sign({ aud: ["aud1"], exp, iss: `https://${team}` });
    expect((await t.call("/stats")).status).toBe(403);
    expect((await t.call("/stats", { headers: { "Cf-Access-Jwt-Assertion": "a.b.c" } })).status).toBe(403);
    expect((await t.call("/stats", { headers: { "Cf-Access-Jwt-Assertion": await sign({ aud: ["other"], exp, iss: `https://${team}` }) } })).status).toBe(403);
    expect((await t.call("/stats", { headers: { "Cf-Access-Jwt-Assertion": await sign({ aud: ["aud1"], exp: exp - 7200, iss: `https://${team}` }) } })).status).toBe(403);
    expect(await accessAllowed(new Request("https://clp.7he.dev/stats", { headers: { "Cf-Access-Jwt-Assertion": good } }), { ...t.env, ACCESS_AUD: undefined }, t.deps)).toBe(false);

    await t.call("/check", post(checkRequest("2.1.0", "x64", usage), { cf: { country: "DE" } }));
    await t.call("/check", { ...post(checkRequest("2.1.0", "x64", { ...usage, id: "e".repeat(32), activity: { dns: { list: 7 } } })), ip: "198.51.100.1" });
    const res = await t.call("/stats", { headers: { "Cf-Access-Jwt-Assertion": good } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const stats = await collectStats(t.env, t.deps);
    expect(stats.days.find((day) => day.day === "2026-11-27")).toEqual({ day: "2026-11-27", servers: 4, optIn: 1 });
    expect(stats.split.version).toEqual([{ key: "2.2.0", servers: 3 }, { key: "2.1.0", servers: 1 }]);
    expect(stats.optInServers).toBe(2);
    expect(stats.addons).toEqual([{ addon: "dns", share: 1 }, { addon: "firewall", share: 1 }]);
    expect(stats.activity).toContainEqual({ addon: "dns", share: 1, median: 5 });
    expect(stats.activity).toContainEqual({ addon: "firewall", share: 0.5, median: 1 });
    expect(stats.countries).toContainEqual({ key: "DE", servers: 1 });
    const html = await res.text();
    expect(html).toContain("Servers per day");
    expect(html).toContain("25%");
    expect(statsHtml({ ...stats, errors: ["<x>"] })).toContain("&lt;x&gt;");
  });
});
