// The push-to-deploy route: the one request this project answers that a
// CloudPanel session does not open.
//
// It returns a Response only when the root gateway recognised the token in the
// URL. Everything else -- a stranger, a wrong token, a rotated one, a site with
// no webhook -- returns null, and the caller in cli/index.ts lets the request
// fall through to the session gate, which answers it with the same redirect any
// other path under /addons gives a stranger. So there is no oracle here: the
// URL says nothing about which sites have a webhook.
//
// This half is transport and nothing more. It hands the bytes the repository
// sent to the action, which is where the token can be read and therefore where
// the delivery can be understood; reading the payload here would mean acting on
// something nobody had authenticated yet.

import { BodyError, jsonResponse, readBoundedText, safeDecodePathSegment } from "../../../lib/app-http";
import { ADDONS_BASE_PATH, mountPath } from "../../../lib/mount";
import { MAX_HOOK_BODY_BYTES, WEBHOOK_TOKEN_RE } from "../action";
import { gitService, validateDomain } from "./service";

/**
 * The route as the manager sees it: `internalPath` has taken the `/addons`
 * mount off the front by the time a request is dispatched.
 */
export const GIT_HOOK_PREFIX = `${mountPath("git").slice(ADDONS_BASE_PATH.length)}/hook/`;

/** The same route as the URL a repository is given. */
export function gitHookPath(domain: string, token: string): string {
  return `${ADDONS_BASE_PATH}${GIT_HOOK_PREFIX}${encodeURIComponent(domain)}/${token}`;
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
  } catch (error) {
    // A payload past the bound is delivered without it: the token decides, and
    // the body is only read for the ref, so an unreadable one deploys the
    // configured branch the way a bare `curl -X POST` does. Anything else is a
    // real fault.
    if (!(error instanceof BodyError)) throw error;
  }

  const result = await gitService.hook(domain, {
    token,
    event: req.headers.get("x-github-event") ?? "",
    body,
  });
  if (!result.ok || !result.data) return null;
  return jsonResponse({ ok: true, ...result.data });
}
