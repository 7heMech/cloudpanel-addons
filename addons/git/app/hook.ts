// The push-to-deploy route: the one request this project answers that a
// CloudPanel session does not open.
//
// It returns a Response only when the root gateway recognised the token in the
// URL. Everything else -- a stranger, a wrong token, a rotated one, a site with
// no webhook -- returns null, and the caller in cli/index.ts lets the request
// fall through to the session gate, which answers it with the same redirect any
// other path under /addons gives a stranger. So there is no oracle here: the
// URL says nothing about which sites have a webhook.

import { jsonResponse, readBoundedText, safeDecodePathSegment } from "../../../lib/app-http";
import { WEBHOOK_TOKEN_RE, type GitHookPayload } from "../action";
import { gitService, validateDomain } from "./service";

/** Where the manager sees this route; `internalPath` has stripped `/addons`. */
export const GIT_HOOK_PREFIX = "/git/hook/";

/**
 * A push payload is a few kilobytes; GitHub caps its own at 25 MB. Deliveries
 * over this are answered as unverifiable rather than read into memory.
 */
const MAX_HOOK_BODY_BYTES = 128 * 1024;

/** The ref of a push, for the branch filter. Absent from a plain `curl -X POST`. */
function refFrom(body: string): string {
  if (!body.startsWith("{")) return "";
  try {
    const ref = (JSON.parse(body) as { ref?: unknown }).ref;
    return typeof ref === "string" && ref.length <= 255 ? ref : "";
  } catch {
    return "";
  }
}

export async function handleGitHook(req: Request, path: string): Promise<Response | null> {
  const segments = path.slice(GIT_HOOK_PREFIX.length).split("/");
  if (segments.length !== 2) return null;
  const domain = validateDomain(safeDecodePathSegment(segments[0]!) ?? "");
  const token = segments[1]!;
  if (!domain || !WEBHOOK_TOKEN_RE.test(token)) return null;

  // No guardMutation: a repository sends no CSRF token and its Origin is not
  // the panel. The token in the URL is the whole authentication for this route,
  // which is why it is minted here rather than chosen, and why rotating it is
  // how a leaked URL is revoked.
  let body = "";
  try {
    body = await readBoundedText(req, MAX_HOOK_BODY_BYTES);
  } catch {
    // Too large to read: the token still decides, and a signature over a body
    // this never saw cannot match, so the delivery is reported as refused.
  }
  const signature = req.headers.get("x-hub-signature-256") ?? "";
  const payload: GitHookPayload = {
    token,
    ref: refFrom(body),
    event: req.headers.get("x-github-event") ?? "",
    // The body travels only when there is a signature to check it against.
    ...(signature ? { signature, body } : {}),
  };

  const result = await gitService.hook(domain, payload);
  if (!result.ok || !result.data) return null;
  return jsonResponse({ ok: true, ...result.data });
}
