// wrangler's entry: the Worker with the allowlist `bun run site` writes from the
// addon catalog. Left out of `bun run typecheck`, which runs before that file exists.
import allowlist from "../dist/usage-allowlist.json" with { type: "json" };
import { type Env, handle, rollUp } from "./index";

interface Context { waitUntil(promise: Promise<unknown>): void }

const deps = () => ({ cache: (globalThis as unknown as { caches: { default: Parameters<typeof handle>[3]["cache"] } }).caches.default, fetch, allowlist });

export default {
  fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    return handle(request, env, ctx, deps());
  },
  scheduled(_event: unknown, env: Env, ctx: Context): void {
    ctx.waitUntil(rollUp(env, deps()));
  },
};
