// The Worker on clp.7he.dev: the install script's address, the release list
// the manager's update check asks first, the opt-in usage counters, and the
// landing page from dist/site. See docs/decisions/releases.md.
//
// Self-contained on purpose: wrangler bundles this file, so it imports nothing
// from the addons, and the Workers runtime types are declared below instead of
// pulled in as a dependency.

interface Cache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  USAGE: { writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void };
  /** Optional: lifts GitHub's unauthenticated rate limit for the release list. */
  GITHUB_TOKEN?: string;
}

interface Context {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Deps {
  cache: Cache;
  fetch: typeof fetch;
}

export const REPO = "7heMech/cloudpanel-addons";
export const INSTALL_URL = `https://github.com/${REPO}/releases/latest/download/install.sh`;
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const RELEASES_TTL_S = 300;
const RELEASES_STALE_S = 86_400;
const UPSTREAM_TIMEOUT_MS = 5000;
const MAX_USAGE_BYTES = 2048;
const MAX_ADDONS = 24;

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]{1,32})?$/;
const CLOUDPANEL_RE = /^[0-9A-Za-z.-]{1,32}$/;
const ARCH_RE = /^[a-z0-9_]{1,16}$/;
const ADDON_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** Every server reports once, under this name, so counts have a denominator. */
export const SERVER = "*";

const text = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });

export interface UsageReport {
  version: string;
  cloudpanel: string;
  arch: string;
  addons: string[];
}

/** Only the four fields the manager sends, each checked for shape. */
export function parseUsage(value: unknown): UsageReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const { version, cloudpanel, arch, addons } = body;
  if (typeof version !== "string" || !VERSION_RE.test(version)) return null;
  if (cloudpanel !== null && (typeof cloudpanel !== "string" || !CLOUDPANEL_RE.test(cloudpanel))) return null;
  if (typeof arch !== "string" || !ARCH_RE.test(arch)) return null;
  if (!Array.isArray(addons) || addons.length > MAX_ADDONS) return null;
  const names = new Set<string>();
  for (const name of addons) {
    if (typeof name !== "string" || !ADDON_RE.test(name) || name === SERVER) return null;
    names.add(name);
  }
  return { version, cloudpanel: cloudpanel ?? "", arch, addons: [...names] };
}

async function usage(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return text(405, "POST only\n", { Allow: "POST" });
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > MAX_USAGE_BYTES) return text(413, "too large\n");
  let report: UsageReport | null = null;
  try {
    const body = await request.text();
    if (body.length > MAX_USAGE_BYTES) return text(413, "too large\n");
    report = parseUsage(JSON.parse(body));
  } catch {
    report = null;
  }
  if (!report) return text(400, "bad report\n");
  // No address, hostname or machine id: nothing about the sender is read, and
  // Analytics Engine keeps none.
  for (const addon of [SERVER, ...report.addons]) {
    env.USAGE.writeDataPoint({
      indexes: [addon],
      blobs: [addon, report.version, report.cloudpanel, report.arch],
      doubles: [1],
    });
  }
  return new Response(null, { status: 204 });
}

interface GithubRelease {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

/** Just what the update check reads, so a GitHub change cannot leak through. */
export function trimReleases(data: unknown): { tag_name: string; draft: boolean; prerelease: boolean }[] | null {
  if (!Array.isArray(data)) return null;
  const releases: { tag_name: string; draft: boolean; prerelease: boolean }[] = [];
  for (const entry of data as GithubRelease[]) {
    if (!entry || typeof entry.tag_name !== "string") continue;
    releases.push({ tag_name: entry.tag_name, draft: entry.draft === true, prerelease: entry.prerelease === true });
  }
  return releases;
}

const jsonResponse = (body: string, maxAge: number) =>
  new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${maxAge}`,
    },
  });

async function releases(request: Request, env: Env, ctx: Context, deps: Deps): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return text(405, "GET only\n", { Allow: "GET, HEAD" });
  const key = new Request(new URL("/releases.json", request.url).toString());
  const cached = await deps.cache.match(key);
  const age = cached ? Number(cached.headers.get("X-Cached-At") ?? 0) : 0;
  const fresh = cached && Date.now() - age < RELEASES_TTL_S * 1000;
  const again = async () => jsonResponse(await (cached as Response).clone().text(), RELEASES_TTL_S);
  if (cached && fresh) return again();
  try {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "clp-addons-worker" };
    if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
    const upstream = await deps.fetch(RELEASES_URL, { headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    const list = upstream.ok ? trimReleases(await upstream.json()) : null;
    if (!list) throw new Error(`GitHub answered ${upstream.status}`);
    const body = JSON.stringify(list);
    const toStore = jsonResponse(body, RELEASES_STALE_S);
    toStore.headers.set("X-Cached-At", String(Date.now()));
    ctx.waitUntil(deps.cache.put(key, toStore));
    return jsonResponse(body, RELEASES_TTL_S);
  } catch {
    // GitHub is down or rate-limiting: the last list is better than none, and
    // the manager falls back to GitHub itself on a 5xx.
    if (cached) return again();
    return text(502, "releases unavailable\n");
  }
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
    case "/releases.json":
      return releases(request, env, ctx, deps);
    case "/usage":
      return usage(request, env);
    default:
      return env.ASSETS.fetch(request);
  }
}

export default {
  fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    const cache = (globalThis as unknown as { caches: { default: Cache } }).caches.default;
    return handle(request, env, ctx, { cache, fetch });
  },
};
