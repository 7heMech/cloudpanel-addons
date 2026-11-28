// The Worker on clp.7he.dev: the install script's address, the daily update
// check every server makes, the opt-in usage it can carry, the deletion of that
// usage, the private /stats dashboard, and the landing page from dist/site. See
// docs/decisions/releases.md.
//
// Self-contained on purpose: wrangler bundles this file, so it imports nothing
// from the addons, and the Workers runtime types are declared below instead of
// pulled in as a dependency. worker/main.ts hands it the allowlist `bun run
// site` writes.

interface Cache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface D1 {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
}

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** Analytics Engine: one point per check, indexed by the day's address hash. */
  USAGE: { writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void };
  /** Holds each UTC day's random hashing key, which expires after two days. */
  SECRETS: KV;
  /** Opt-in rows per install ID and day, and the daily roll-up. */
  DB: D1;
  /** Optional: lifts GitHub's unauthenticated rate limit for the release list. */
  GITHUB_TOKEN?: string;
  /** Optional JSON: `{ "hold": ["2.3.0"], "stage": { "2.3.0": 25 }, "urgent": ["2.2.1"] }`. */
  RELEASE_POLICY?: string;
  /** For /stats and the roll-up: the account and a token with Account Analytics: Read. */
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;
  /** For /stats: the Access team domain (`<team>.cloudflareaccess.com`) and the application's AUD tag. */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

interface Context {
  waitUntil(promise: Promise<unknown>): void;
}

/** The names a report may carry: catalog addons and their counted actions. */
export interface Allowlist {
  addons: string[];
  actions: Record<string, string[]>;
}

export interface Deps {
  cache: Cache;
  fetch: typeof fetch;
  allowlist: Allowlist;
  now?: () => Date;
}

export const REPO = "7heMech/cloudpanel-addons";
export const INSTALL_URL = `https://github.com/${REPO}/releases/latest/download/install.sh`;
export const DATASET = "clp_addons_usage";
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=100`;
const RELEASES_TTL_S = 300;
const RELEASES_STALE_S = 86_400;
const UPSTREAM_TIMEOUT_MS = 5000;
export const MAX_BODY_BYTES = 8192;
export const MAX_ACTION_COUNT = 10_000;
const SECRET_TTL_S = 2 * 86_400;
/** Opt-in rows are kept this long; the daily roll-up keeps their totals. */
export const REPORT_RETENTION_DAYS = 90;
const STATS_DAYS = 30;

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]{1,32})?$/;
const TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const CLOUDPANEL_RE = /^[0-9A-Za-z.-]{1,32}$/;
const ID_RE = /^[0-9a-f]{32}$/;
export const ARCHES = ["x64", "arm64"];

const text = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const utcDay = (date: Date) => date.toISOString().slice(0, 10);
/** Keys come off the wire; a null prototype keeps `__proto__` an ordinary key. */
const nullObject = <T>() => Object.create(null) as Record<string, T>;

// ---- The contract lib/update-check.ts holds the other side of ----

export interface UsageReport {
  id: string;
  cloudpanel: string | null;
  addons: string[];
  activity: Record<string, Record<string, number>>;
}

export interface CheckRequest {
  version: string;
  channel: "stable" | "prerelease";
  arch: string;
  usage?: UsageReport;
}

export interface CheckAnswer {
  latest: string;
  update: boolean;
  urgent: boolean;
  usage: "saved" | "refused" | "none";
}

/**
 * The required fields must be right or the whole request is refused. Names the
 * allowlist does not know are dropped rather than refused: a pre-release cut
 * from dev can know an addon or action this Worker, deployed from main, does
 * not yet. A malformed `usage` is dropped and answered "refused".
 */
export function parseCheck(value: unknown, allow: Allowlist): { check: CheckRequest; usageMalformed: boolean } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const { version, channel, arch } = body;
  if (typeof version !== "string" || !VERSION_RE.test(version)) return null;
  if (channel !== "stable" && channel !== "prerelease") return null;
  if (typeof arch !== "string" || !ARCHES.includes(arch)) return null;
  const check: CheckRequest = { version, channel, arch };
  if (body.usage === undefined) return { check, usageMalformed: false };
  const usage = parseUsage(body.usage, allow);
  if (usage) check.usage = usage;
  return { check, usageMalformed: !usage };
}

export function parseUsage(value: unknown, allow: Allowlist): UsageReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.id !== "string" || !ID_RE.test(body.id)) return null;
  if (body.cloudpanel !== null && (typeof body.cloudpanel !== "string" || !CLOUDPANEL_RE.test(body.cloudpanel))) return null;
  if (!Array.isArray(body.addons) || body.addons.length > 64) return null;
  if (!body.activity || typeof body.activity !== "object" || Array.isArray(body.activity)) return null;
  const addons = [...new Set(body.addons.filter((name): name is string => typeof name === "string" && allow.addons.includes(name)))].sort();
  const activity = nullObject<Record<string, number>>();
  for (const [addon, verbs] of Object.entries(body.activity as Record<string, unknown>)) {
    if (!Object.hasOwn(allow.actions, addon) || !verbs || typeof verbs !== "object" || Array.isArray(verbs)) continue;
    for (const [verb, count] of Object.entries(verbs as Record<string, unknown>)) {
      if (!allow.actions[addon]!.includes(verb) || typeof count !== "number" || !Number.isInteger(count) || count <= 0) continue;
      (activity[addon] ??= nullObject<number>())[verb] = Math.min(count, MAX_ACTION_COUNT);
    }
  }
  return { id: body.id, cloudpanel: body.cloudpanel, addons, activity };
}

/** The body's bytes, or null once they pass `limit`, which stops reading it. */
export async function readCapped(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

async function readJson(request: Request): Promise<{ value: unknown } | Response> {
  if (request.method !== "POST") return text(405, "POST only\n", { Allow: "POST" });
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY_BYTES) return text(413, "too large\n");
  const bytes = await readCapped(request, MAX_BODY_BYTES).catch(() => new Uint8Array());
  if (!bytes) return text(413, "too large\n");
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return text(400, "bad request\n");
  }
}

// ---- Releases and what a server is told ----

export interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
}

/** Just what the check reads, so a GitHub change cannot leak through. */
export function trimReleases(data: unknown): Release[] | null {
  if (!Array.isArray(data)) return null;
  const releases: Release[] = [];
  for (const entry of data as Record<string, unknown>[]) {
    if (!entry || typeof entry.tag_name !== "string") continue;
    releases.push({ tag_name: entry.tag_name, draft: entry.draft === true, prerelease: entry.prerelease === true });
  }
  return releases;
}

function precedence(value: string): { core: number[]; pre: string[] } {
  const version = value.replace(/^v/, "").split("+")[0] ?? "";
  const hyphen = version.indexOf("-");
  const core = (hyphen < 0 ? version : version.slice(0, hyphen)).split(".").map((n) => parseInt(n, 10) || 0);
  return { core, pre: hyphen < 0 ? [] : version.slice(hyphen + 1).split(".") };
}

/** The same order as lib/semver.ts: 2.0.0-rc.1 < 2.0.0-rc.2 < 2.0.0. */
export function compareSemver(a: string, b: string): number {
  const pa = precedence(a);
  const pb = precedence(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (!pa.pre.length || !pb.pre.length) return pb.pre.length - pa.pre.length;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const numeric = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (numeric[0] && numeric[1]) return Number(x) - Number(y);
    if (numeric[0] !== numeric[1]) return numeric[0] ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export interface ReleasePolicy {
  /** Versions no server is offered. */
  hold?: string[];
  /** Versions offered to this percentage of servers, by the day's hash. */
  stage?: Record<string, number>;
  /** Versions a server below them is told are urgent. */
  urgent?: string[];
}

export function readPolicy(raw: string | undefined): ReleasePolicy {
  try {
    const value = JSON.parse(raw ?? "{}") as ReleasePolicy;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

/** `bucket` is 0–99, from the day's hash, so a staged release reaches a stable share of servers each day. */
export function decide(releases: Release[], check: CheckRequest, policy: ReleasePolicy, bucket: number): Omit<CheckAnswer, "usage"> {
  const bare = (tag: string) => tag.replace(/^v/, "");
  const offered = releases.filter((release) => {
    const version = bare(release.tag_name);
    if (release.draft || !TAG_RE.test(release.tag_name)) return false;
    if (check.channel === "stable" && (release.prerelease || version.includes("-"))) return false;
    if (policy.hold?.includes(version)) return false;
    const share = policy.stage?.[version];
    return typeof share !== "number" || bucket < share;
  }).map((release) => bare(release.tag_name)).sort((a, b) => compareSemver(b, a));
  const newest = offered[0];
  const update = newest !== undefined && compareSemver(newest, check.version) > 0;
  const latest = update ? newest! : check.version;
  const urgent = update && (policy.urgent ?? []).some((version) =>
    compareSemver(version, check.version) > 0 && compareSemver(version, latest) <= 0);
  return { latest, update, urgent };
}

async function releaseList(env: Env, ctx: Context, deps: Deps): Promise<Release[] | null> {
  const key = new Request("https://clp.7he.dev/__releases");
  const cached = await deps.cache.match(key);
  const age = cached ? Number(cached.headers.get("X-Cached-At") ?? 0) : 0;
  if (cached && Date.now() - age < RELEASES_TTL_S * 1000) return trimReleases(await cached.json());
  try {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "clp-addons-worker" };
    if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
    const upstream = await deps.fetch(RELEASES_URL, { headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    const list = upstream.ok ? trimReleases(await upstream.json()) : null;
    if (!list) throw new Error(`GitHub answered ${upstream.status}`);
    const toStore = new Response(JSON.stringify(list), {
      headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${RELEASES_STALE_S}`, "X-Cached-At": String(Date.now()) },
    });
    ctx.waitUntil(deps.cache.put(key, toStore));
    return list;
  } catch {
    // GitHub is down or rate-limiting: the last list is better than none.
    return cached ? trimReleases(await cached.json()) : null;
  }
}

// ---- Counting servers without identifying them ----

const hex = (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const keyMemo = new WeakMap<KV, Map<string, Promise<CryptoKey>>>();

/** A random key per UTC day, made by the first check of the day and expired by KV after two. */
async function dayKey(env: Env, day: string): Promise<CryptoKey> {
  let raw = await env.SECRETS.get(`hmac:${day}`);
  if (!raw) {
    raw = hex(crypto.getRandomValues(new Uint8Array(32)));
    await env.SECRETS.put(`hmac:${day}`, raw, { expirationTtl: SECRET_TTL_S });
  }
  const bytes = new Uint8Array(raw.match(/../g)!.map((pair) => parseInt(pair, 16)));
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** An IPv4 address as it is; an IPv6 one cut to its /64, which is what one server holds. */
export function addressGroup(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = ip.includes("::") && tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

export async function dailyHash(env: Env, ip: string, day: string): Promise<string> {
  let keys = keyMemo.get(env.SECRETS);
  if (!keys) keyMemo.set(env.SECRETS, keys = new Map());
  let key = keys.get(day);
  if (!key) {
    key = dayKey(env, day);
    keys.set(day, key);
    key.catch(() => keys!.delete(day));
    for (const old of keys.keys()) if (old < day) keys.delete(old);
  }
  return hex(await crypto.subtle.sign("HMAC", await key, new TextEncoder().encode(addressGroup(ip)))).slice(0, 32);
}

// ---- /check and /forget ----

interface CfMeta { country?: string; asn?: number; asOrganization?: string }

async function saveUsage(env: Env, usage: UsageReport, check: CheckRequest, hash: string, day: string, cf: CfMeta): Promise<boolean> {
  // One install ID per address a day: a sender making up IDs counts once.
  await env.DB.prepare("INSERT OR IGNORE INTO reporters (day, hash, id) VALUES (?, ?, ?)").bind(day, hash, usage.id).run();
  const owner = await env.DB.prepare("SELECT id FROM reporters WHERE day = ? AND hash = ?").bind(day, hash).first<{ id: string }>();
  if (owner?.id !== usage.id) return false;
  const before = await env.DB.prepare("SELECT activity FROM reports WHERE id = ? AND day = ?").bind(usage.id, day).first<{ activity: string }>();
  const activity = nullObject<Record<string, number>>();
  for (const [addon, verbs] of Object.entries(before ? JSON.parse(before.activity) as Record<string, Record<string, number>> : {})) {
    activity[addon] = Object.assign(nullObject<number>(), verbs);
  }
  for (const [addon, verbs] of Object.entries(usage.activity)) {
    for (const [verb, count] of Object.entries(verbs)) {
      const sum = (activity[addon] ??= nullObject<number>());
      sum[verb] = Math.min((sum[verb] ?? 0) + count, MAX_ACTION_COUNT);
    }
  }
  await env.DB.prepare(`INSERT INTO reports (id, day, version, channel, arch, cloudpanel, addons, activity, country, asn, network)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id, day) DO UPDATE SET version = excluded.version, channel = excluded.channel, arch = excluded.arch,
      cloudpanel = excluded.cloudpanel, addons = excluded.addons, activity = excluded.activity,
      country = excluded.country, asn = excluded.asn, network = excluded.network`)
    .bind(usage.id, day, check.version, check.channel, check.arch, usage.cloudpanel, JSON.stringify(usage.addons), JSON.stringify(activity),
      cf.country ?? null, cf.asn ?? null, cf.asOrganization ?? null)
    .run();
  return true;
}

async function check(request: Request, env: Env, ctx: Context, deps: Deps): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const parsed = parseCheck(body.value, deps.allowlist);
  if (!parsed) return text(400, "bad request\n");
  const releases = await releaseList(env, ctx, deps);
  if (!releases) return text(502, "releases unavailable\n");
  const { check } = parsed;
  if (!releases.some((release) => !release.draft && release.tag_name === `v${check.version}`)) return text(400, "unknown version\n");

  const day = utcDay(deps.now?.() ?? new Date());
  const hash = await dailyHash(env, request.headers.get("CF-Connecting-IP") ?? "", day);
  const cf = ((request as unknown as { cf?: CfMeta }).cf) ?? {};
  let usage: CheckAnswer["usage"] = parsed.usageMalformed ? "refused" : "none";
  if (check.usage) {
    try {
      usage = await saveUsage(env, check.usage, check, hash, day, cf) ? "saved" : "refused";
    } catch {
      usage = "refused";
    }
  }
  // Only the day's hash, never the address: the dashboard counts distinct hashes per day.
  env.USAGE.writeDataPoint({ indexes: [hash], blobs: [check.version, check.channel, check.arch, usage === "saved" ? "opt-in" : "basic"], doubles: [1] });
  const bucket = parseInt(hash.slice(0, 4), 16) % 100;
  return json({ ...decide(releases, check, readPolicy(env.RELEASE_POLICY), bucket), usage } satisfies CheckAnswer);
}

/** Knowing the ID is the credential: it was only ever on the server that sent it. */
async function forget(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const id = (body.value as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !ID_RE.test(id)) return text(400, "bad request\n");
  const [reports] = await env.DB.batch([
    env.DB.prepare("DELETE FROM reports WHERE id = ?").bind(id),
    env.DB.prepare("DELETE FROM reporters WHERE id = ?").bind(id),
  ]) as { meta: { changes: number } }[];
  return json({ deleted: reports?.meta.changes ?? 0 });
}

// ---- Statistics: Analytics Engine, the daily roll-up and /stats ----

async function analytics(env: Env, deps: Deps, sql: string): Promise<Record<string, unknown>[]> {
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) throw new Error("CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN are not set");
  const res = await deps.fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` },
    body: sql,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Analytics Engine answered ${res.status}`);
  return ((await res.json()) as { data?: Record<string, unknown>[] }).data ?? [];
}

const DIMENSIONS = { version: "blob1", channel: "blob2", arch: "blob3", tier: "blob4" } as const;

/** Distinct servers per UTC day, overall (`key` "") or split by one dimension. */
export async function serverCounts(env: Env, deps: Deps, from: string, to: string, dimension?: keyof typeof DIMENSIONS): Promise<{ day: string; key: string; servers: number }[]> {
  const column = dimension ? DIMENSIONS[dimension] : null;
  const rows = await analytics(env, deps, `SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, ${column ? `${column} AS key, ` : ""}count(DISTINCT index1) AS servers
    FROM ${DATASET}
    WHERE timestamp >= toDateTime('${from} 00:00:00') AND timestamp < toDateTime('${to} 00:00:00')
    GROUP BY day${column ? ", key" : ""} ORDER BY day FORMAT JSON`);
  return rows.map((row) => ({ day: String(row.day).slice(0, 10), key: column ? String(row.key) : "", servers: Number(row.servers) }));
}

interface ReportRow { id: string; day: string; addons: string; activity: string; country: string | null; asn: number | null; network: string | null }

const network = (row: ReportRow) => row.asn ? `AS${row.asn}${row.network ? ` ${row.network}` : ""}` : "unknown";

/** Opt-in totals for one set of rows, one row per ID. */
export function optInTotals(rows: ReportRow[]): { metric: string; key: string; value: number }[] {
  const out = new Map<string, number>();
  const add = (metric: string, key: string) => out.set(`${metric}\u0000${key}`, (out.get(`${metric}\u0000${key}`) ?? 0) + 1);
  for (const row of rows) {
    add("opt-in", "");
    for (const addon of JSON.parse(row.addons) as string[]) add("addon", addon);
    for (const addon of Object.keys(JSON.parse(row.activity) as Record<string, unknown>)) add("active", addon);
    add("country", row.country ?? "unknown");
    add("network", network(row));
  }
  return [...out].map(([key, value]) => {
    const [metric, name] = key.split("\u0000");
    return { metric: metric!, key: name!, value };
  });
}

const dayOffset = (day: string, days: number) => utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000));

/**
 * The cron: rolls the last seven finished days into `daily`, so history outlives
 * Analytics Engine's 90 days and opt-in rows' own, then prunes.
 */
export async function rollUp(env: Env, deps: Deps): Promise<void> {
  const today = utcDay(deps.now?.() ?? new Date());
  const from = dayOffset(today, -7);
  const statements: D1Statement[] = [];
  const upsert = (day: string, metric: string, key: string, value: number) =>
    statements.push(env.DB.prepare("INSERT INTO daily (day, metric, key, value) VALUES (?, ?, ?, ?) ON CONFLICT (day, metric, key) DO UPDATE SET value = excluded.value").bind(day, metric, key, value));
  try {
    for (const row of await serverCounts(env, deps, from, today)) upsert(row.day, "servers", "", row.servers);
    for (const dimension of Object.keys(DIMENSIONS) as (keyof typeof DIMENSIONS)[]) {
      for (const row of await serverCounts(env, deps, from, today, dimension)) upsert(row.day, dimension, row.key, row.servers);
    }
  } catch (error) {
    console.error("roll-up: Analytics Engine", error);
  }
  const { results } = await env.DB.prepare("SELECT id, day, addons, activity, country, asn, network FROM reports WHERE day >= ? AND day < ?").bind(from, today).all<ReportRow>();
  const byDay = new Map<string, ReportRow[]>();
  for (const row of results) byDay.set(row.day, [...byDay.get(row.day) ?? [], row]);
  for (const [day, rows] of byDay) for (const total of optInTotals(rows)) upsert(day, total.metric, total.key, total.value);
  statements.push(env.DB.prepare("DELETE FROM reports WHERE day < ?").bind(dayOffset(today, -REPORT_RETENTION_DAYS)));
  statements.push(env.DB.prepare("DELETE FROM reporters WHERE day < ?").bind(today));
  await env.DB.batch(statements);
}

// Access puts a signed JWT on every request it lets through; /stats checks it
// itself, so a route left open by mistake still shows nothing.
interface Jwk { kty: string; kid?: string; n?: string; e?: string; alg?: string }
let certs: { at: number; keys: Jwk[] } | null = null;

const b64url = (part: string) => Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

export async function accessAllowed(request: Request, env: Env, deps: Deps): Promise<boolean> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false;
  const [head, body, signature] = token.split(".");
  if (!head || !body || !signature) return false;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64url(head))) as { kid?: string; alg?: string };
    const claims = JSON.parse(new TextDecoder().decode(b64url(body))) as { aud?: string | string[]; exp?: number; iss?: string };
    if (header.alg !== "RS256") return false;
    const now = (deps.now?.() ?? new Date()).getTime();
    if (!certs || now - certs.at > 3_600_000) {
      const res = await deps.fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
      certs = { at: now, keys: ((await res.json()) as { keys: Jwk[] }).keys };
    }
    const jwk = certs.keys.find((key) => key.kid === header.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey("jwk", jwk as never, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(signature), new TextEncoder().encode(`${head}.${body}`))) return false;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    return audiences.includes(env.ACCESS_AUD) && (claims.exp ?? 0) * 1000 > now && claims.iss === `https://${env.ACCESS_TEAM_DOMAIN}`;
  } catch {
    return false;
  }
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export interface Stats {
  days: { day: string; servers: number; optIn: number }[];
  split: Record<"version" | "channel" | "arch", { key: string; servers: number }[]>;
  optInServers: number;
  addons: { addon: string; share: number }[];
  activity: { addon: string; share: number; median: number }[];
  countries: { key: string; servers: number }[];
  networks: { key: string; servers: number }[];
  errors: string[];
}

/** Analytics Engine for the last 30 days, the roll-up before that, opt-in rows for the breakdowns. */
export async function collectStats(env: Env, deps: Deps): Promise<Stats> {
  const today = utcDay(deps.now?.() ?? new Date());
  const tomorrow = dayOffset(today, 1);
  const from = dayOffset(today, -STATS_DAYS);
  const errors: string[] = [];
  const days = new Map<string, { servers: number; optIn: number }>();
  const { results: history } = await env.DB.prepare("SELECT day, metric, key, value FROM daily WHERE (metric = 'servers' OR (metric = 'tier' AND key = 'opt-in')) AND day >= ? ORDER BY day")
    .bind(dayOffset(today, -365)).all<{ day: string; metric: string; value: number }>();
  for (const row of history) {
    const entry = days.get(row.day) ?? { servers: 0, optIn: 0 };
    if (row.metric === "servers") entry.servers = row.value;
    else entry.optIn = row.value;
    days.set(row.day, entry);
  }
  const split: Stats["split"] = { version: [], channel: [], arch: [] };
  try {
    for (const row of await serverCounts(env, deps, from, tomorrow)) days.set(row.day, { ...days.get(row.day) ?? { optIn: 0 }, servers: row.servers });
    for (const row of await serverCounts(env, deps, from, tomorrow, "tier")) {
      if (row.key === "opt-in") days.set(row.day, { ...days.get(row.day) ?? { servers: 0 }, optIn: row.servers });
    }
    for (const dimension of ["version", "channel", "arch"] as const) {
      // The last finished day, so the split is not of a day half over.
      const rows = await serverCounts(env, deps, dayOffset(today, -1), today, dimension);
      split[dimension] = rows.map(({ key, servers }) => ({ key, servers })).sort((a, b) => b.servers - a.servers);
    }
  } catch (error) {
    errors.push(`Analytics Engine: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Each opted-in server's latest row, and its activity summed over the window.
  const { results: rows } = await env.DB.prepare("SELECT id, day, addons, activity, country, asn, network FROM reports WHERE day >= ? ORDER BY day").bind(from).all<ReportRow>();
  const latest = new Map<string, ReportRow>();
  const perServer = new Map<string, Map<string, number>>();
  for (const row of rows) {
    latest.set(row.id, row);
    const sums = perServer.get(row.id) ?? new Map<string, number>();
    for (const [addon, verbs] of Object.entries(JSON.parse(row.activity) as Record<string, Record<string, number>>)) {
      sums.set(addon, (sums.get(addon) ?? 0) + Object.values(verbs).reduce((a, b) => a + b, 0));
    }
    perServer.set(row.id, sums);
  }
  const optInServers = latest.size;
  const totals = optInTotals([...latest.values()]);
  const ranked = (metric: string) => totals.filter((total) => total.metric === metric)
    .map((total) => ({ key: total.key, servers: total.value })).sort((a, b) => b.servers - a.servers);
  const used = new Map<string, number[]>();
  for (const sums of perServer.values()) for (const [addon, count] of sums) used.set(addon, [...used.get(addon) ?? [], count]);
  return {
    days: [...days].map(([day, entry]) => ({ day, ...entry })).sort((a, b) => a.day.localeCompare(b.day)),
    split,
    optInServers,
    addons: ranked("addon").map(({ key, servers }) => ({ addon: key, share: optInServers ? servers / optInServers : 0 })),
    activity: [...used].map(([addon, counts]) => ({ addon, share: optInServers ? counts.length / optInServers : 0, median: median(counts) }))
      .sort((a, b) => b.share - a.share),
    countries: ranked("country"),
    networks: ranked("network").slice(0, 25),
    errors,
  };
}

const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pct = (share: number) => `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;

function shareTable(title: string, head: string[], rows: { label: string; share: number; cells: string[] }[]): string {
  if (!rows.length) return `<section><h2>${esc(title)}</h2><p class="muted">No data yet.</p></section>`;
  return `<section><h2>${esc(title)}</h2><table><thead><tr>${head.map((cell, i) => `<th${i ? ' class="num"' : ""}>${esc(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) =>
    `<tr><td>${esc(row.label)}</td>${row.cells.map((cell) => `<td class="num">${esc(cell)}</td>`).join("")}<td class="bar"><span style="width:${Math.round(row.share * 100)}%"></span></td></tr>`).join("")}</tbody></table></section>`;
}

function serversChart(days: Stats["days"]): string {
  const recent = days.slice(-90);
  if (!recent.length) return `<p class="muted">No checks counted yet.</p>`;
  const max = Math.max(...recent.map((day) => day.servers), 1);
  const w = 720, h = 180, gap = 2, bar = Math.max(2, (w - gap * recent.length) / recent.length);
  const bars = recent.map((day, i) => {
    const height = Math.max(1, (day.servers / max) * (h - 20));
    const optIn = day.servers ? ` (${pct(day.optIn / day.servers)} opted in)` : "";
    return `<rect x="${(i * (bar + gap)).toFixed(1)}" y="${(h - height).toFixed(1)}" width="${bar.toFixed(1)}" height="${height.toFixed(1)}" rx="2"><title>${day.day}: ${day.servers} servers${optIn}</title></rect>`;
  }).join("");
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Distinct servers per day, last ${recent.length} days, peak ${max}">${bars}</svg>
  <p class="axis"><span>${recent[0]!.day}</span><span>peak ${max}</span><span>${recent.at(-1)!.day}</span></p>`;
}

export function statsHtml(stats: Stats): string {
  const today = stats.days.at(-1);
  const finished = stats.days.at(-2) ?? today;
  const total = (rows: { servers: number }[]) => rows.reduce((sum, row) => sum + row.servers, 0) || 1;
  const split = (title: string, rows: { key: string; servers: number }[]) =>
    shareTable(title, [title, "Servers", ""], rows.map((row) => ({ label: row.key, share: row.servers / total(rows), cells: [String(row.servers)] })));
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Addon usage</title><style>
:root{--bg:#f7f8fa;--card:#fff;--ink:#1d2127;--muted:#5f6670;--line:#e3e6ea;--mark:#257de0;--track:#e8eef7}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--card:#191919;--ink:#e8e8e8;--muted:#a0a4aa;--line:#2c2c2c;--mark:#338ced;--track:#24303d}}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:0 0 10px}
.muted,.axis{color:var(--muted)}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:18px 0}
.tile,section{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px}.tile b{display:block;font-size:24px}
section{margin-top:14px;overflow-x:auto}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:0 14px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:5px 6px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:500}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}td.bar{width:35%}td.bar span{display:block;height:8px;border-radius:4px;background:var(--mark)}
td.bar{background:linear-gradient(var(--track),var(--track)) center/100% 8px no-repeat}
.chart{width:100%;height:auto;display:block}.chart rect{fill:var(--mark)}.axis{display:flex;justify-content:space-between;font-size:12px;margin:4px 0 0}
.error{color:#c62828}</style></head><body><main>
<h1>Addon usage</h1><p class="muted">Distinct servers per UTC day, counted by a daily hash; opt-in breakdowns cover the last ${STATS_DAYS} days, one row per install ID.</p>
${stats.errors.map((error) => `<p class="error">${esc(error)}</p>`).join("")}
<div class="tiles"><div class="tile"><b>${finished?.servers ?? 0}</b><span class="muted">servers, ${esc(finished?.day ?? "no day yet")}</span></div>
<div class="tile"><b>${finished && finished.servers ? pct(finished.optIn / finished.servers) : "–"}</b><span class="muted">opt-in rate that day</span></div>
<div class="tile"><b>${stats.optInServers}</b><span class="muted">opted-in servers, ${STATS_DAYS} days</span></div>
<div class="tile"><b>${today?.servers ?? 0}</b><span class="muted">servers so far today</span></div></div>
<section><h2>Servers per day</h2>${serversChart(stats.days)}</section>
<div class="grid">${split("Version", stats.split.version)}${split("Channel", stats.split.channel)}</div>
${split("Architecture", stats.split.arch)}
<div class="grid">${shareTable("Addons enabled", ["Addon", "Share", ""], stats.addons.map((row) => ({ label: row.addon, share: row.share, cells: [pct(row.share)] })))}
${shareTable("Activity per addon", ["Addon", "Servers using", "Median actions", ""], stats.activity.map((row) => ({ label: row.addon, share: row.share, cells: [pct(row.share), String(row.median)] })))}</div>
<div class="grid">${split("Country", stats.countries)}${split("Network", stats.networks)}</div>
</main></body></html>`;
}

async function stats(request: Request, env: Env, deps: Deps): Promise<Response> {
  if (request.method !== "GET") return text(405, "GET only\n", { Allow: "GET" });
  if (!await accessAllowed(request, env, deps)) return text(403, "Cloudflare Access required\n");
  return new Response(statsHtml(await collectStats(env, deps)), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" },
  });
}

export async function handle(request: Request, env: Env, ctx: Context, deps: Deps): Promise<Response> {
  const { pathname } = new URL(request.url);
  switch (pathname) {
    case "/install.sh":
      if (request.method !== "GET" && request.method !== "HEAD") return text(405, "GET only\n", { Allow: "GET, HEAD" });
      return new Response(null, {
        status: 302,
        headers: { Location: INSTALL_URL, "Cache-Control": "public, max-age=300" },
      });
    case "/check":
      return check(request, env, ctx, deps);
    case "/forget":
      return forget(request, env);
    case "/stats":
      return stats(request, env, deps);
    default:
      return env.ASSETS.fetch(request);
  }
}
