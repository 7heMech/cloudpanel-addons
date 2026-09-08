// Entry point for the Stager manager service.
//
// Served at the root of its own CloudPanel reverse-proxy site (decision 2.4),
// not under a path prefix on the panel's vhost. Bound to 127.0.0.1 so the only
// route in is that site's nginx vhost, which carries the per-site security.

import { stagerService, validateDomain, validateJobId, expandTarget } from "./service";
import type { JobView } from "./service";
import { layout, jobsView, newCloneView, jobView } from "./views";
import { guardMutation, newCsrfToken, csrfCookieHeader, SECURITY_HEADERS } from "../../../lib/app-http";
import { getNextAvailablePort, readSnapshot } from "../../../lib/snapshot-reader";

/**
 * Ports this addon has handed out that the panel snapshot cannot know about.
 *
 * The snapshot is rewritten by the root CLI on repair, so it is authoritative
 * only for instances that existed when it was written. Two windows are not
 * covered by it: a clone still in flight, whose instance does not exist yet,
 * and a clone that finished after the snapshot was taken. Both are added here.
 * A failed clone is not -- its instance was rolled back, so its port is free.
 */
function portsSinceSnapshot(jobs: JobView[], snapshotTakenAt: string): number[] {
  const taken = Date.parse(snapshotTakenAt);
  return jobs
    .filter((j) => j.port > 0 && j.state !== "failed")
    .filter((j) => {
      if (j.state === "queued" || j.state === "running") return true;
      const finished = Date.parse(j.finishedAt);
      return Number.isNaN(finished) || Number.isNaN(taken) || finished >= taken;
    })
    .map((j) => j.port);
}

/**
 * Bounds on the credential fields, because the wrapper cannot be the one to
 * enforce them.
 *
 * Every wrapper verb validates its arguments before it reads stdin, so the
 * ordinary rejection path exits with the pipe still unread. A body larger than
 * the 64 KiB pipe buffer then fails the write with EPIPE, on a stream tick
 * outside any request promise, where `Bun.serve` cannot turn it into a 500. One
 * 1 MiB password killed the process -- and since v0.7.0 that process serves
 * every addon, not just this one.
 *
 * The numbers are what the wrapper would accept anyway: 254 is the longest legal
 * email address and what `validate_email` allows, 32 is the top of
 * `validate_mfa`'s range, and 256 is generous for a password while staying four
 * orders of magnitude clear of the buffer.
 */
const MAX_EMAIL = 254;
const MAX_PASSWORD = 256;
const MAX_MFA = 32;

/** A newline in a credential would arrive at the wrapper as a shorter one. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function html(body: string, csrf: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": csrfCookieHeader(csrf),
      ...SECURITY_HEADERS,
    },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...SECURITY_HEADERS },
  });
}

// The whole request surface, exported so the one manager process can mount it.
//
// `path` is this addon's own path, with the mount prefix already stripped by the
// router: a request for /stager/api/... arrives here as /api/... .
// Taking it as an argument rather than reading req.url is what keeps every route
// below written as though this addon owned the site, which it used to.
export async function handle(req: Request, path: string): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;

  // Liveness probe for systemd. No auth implications: it reports nothing
  // about any site.
  if (path === "/health") {
    return json({ ok: true, service: "stager-manager" });
  }

  if (method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    try {
      return html(layout("Staging clones", jobsView(await stagerService.listJobs())), csrf);
    } catch (err) {
      return html(layout("Error", errorBlock(err)), csrf, 500);
    }
  }

  // The button injected into every CloudPanel site page lands here with the
  // site it was rendered on. Nothing is trusted about it: it is validated,
  // and then the wrapper looks it up in the panel's own site table.
  if (method === "GET" && path === "/new") {
    const csrf = newCsrfToken();
    try {
      const raw = url.searchParams.get("source");
      if (!raw) {
        return html(layout("New staging site", newCloneView(null, await stagerService.listSites())), csrf);
      }
      const source = validateDomain(raw.toLowerCase());
      if (!source) {
        return html(
          layout("New staging site",
            newCloneView(null, await stagerService.listSites(), "That is not a valid hostname.")),
          csrf, 400
        );
      }
      const detail = await stagerService.describe(source);
      if (!detail.ok || !detail.data) {
        return html(
          layout("New staging site",
            newCloneView(null, await stagerService.listSites(), detail.error ?? `Cannot clone ${source}.`)),
          csrf, 400
        );
      }
      return html(layout(`Clone ${source}`, newCloneView(detail.data, [])), csrf);
    } catch (err) {
      return html(layout("Error", errorBlock(err)), csrf, 500);
    }
  }

  const jobPage = path.match(/^\/jobs\/([^/]+)$/);
  if (method === "GET" && jobPage) {
    const csrf = newCsrfToken();
    const id = validateJobId(decodeURIComponent(jobPage[1]!));
    if (!id) return html(layout("Not found", `<div class="alert">No such job.</div>`), csrf, 404);
    const res = await stagerService.getJob(id);
    if (!res.ok || !res.data) {
      return html(layout("Not found", `<div class="alert">${escapeMinimal(res.error ?? "No such job.")}</div>`), csrf, 404);
    }
    return html(layout(`Clone into ${res.data.job.target}`, jobView(res.data.job, res.data.log)), csrf);
  }

  if (method === "GET" && path === "/api/sites") {
    return json({ ok: true, sites: await stagerService.listSites() });
  }

  const jobApi = path.match(/^\/api\/jobs\/([^/]+)$/);
  if (method === "GET" && jobApi) {
    const id = validateJobId(decodeURIComponent(jobApi[1]!));
    if (!id) return json({ ok: false, error: "not a valid job id" }, 400);
    const res = await stagerService.getJob(id);
    return json(res, res.ok ? 200 : 404);
  }

  if (method === "POST" && path === "/api/clones") {
    const blocked = guardMutation(req);
    if (blocked) return blocked;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, error: "body must be JSON" }, 400);
    }
    const {
      source: rawSource, target: rawTarget, tls,
      instaticEmail, instaticPassword, mfaCode,
    } = (body ?? {}) as Record<string, unknown>;

    const source = validateDomain(typeof rawSource === "string" ? rawSource.toLowerCase() : null);
    if (!source) return json({ ok: false, error: "source is not a valid hostname" }, 400);

    // The shorthand is expanded here so the wrapper only ever sees a complete
    // hostname; it must reject rather than rewrite.
    const target = validateDomain(expandTarget(typeof rawTarget === "string" ? rawTarget : "", source));
    if (!target) return json({ ok: false, error: "target is not a valid hostname" }, 400);
    if (target === source) return json({ ok: false, error: "the target is the site being cloned" }, 400);

    // The credential fields are accepted only for a source that really is an
    // Instatic site, and that is settled by asking the wrapper rather than by
    // trusting the body: `describe` refuses a reverse-proxy site whose backend
    // is not an instance this box manages. Nothing here is ever logged.
    const detail = await stagerService.describe(source);
    if (!detail.ok || !detail.data) {
      return json({ ok: false, error: detail.error ?? `cannot clone ${source}` }, 400);
    }
    let instatic: { port: number; email: string; password: string; mfaCode?: string } | undefined;
    if (detail.data.siteType === "reverse-proxy") {
      if (typeof instaticEmail !== "string" || !instaticEmail.trim()) {
        return json({ ok: false, error: "cloning an Instatic site needs the source's admin email address" }, 400);
      }
      if (instaticEmail.length > MAX_EMAIL) {
        return json({ ok: false, error: "that email address is too long" }, 400);
      }
      if (typeof instaticPassword !== "string" || !instaticPassword) {
        return json({ ok: false, error: "cloning an Instatic site needs the source's admin password" }, 400);
      }
      // Bounded, and bounded here rather than left to the wrapper, because the
      // wrapper validates its arguments before it ever reads stdin: an
      // over-long password is refused with the pipe unread, and anything past
      // the 64 KiB pipe buffer then fails the write with EPIPE on a stream tick
      // no request promise can catch. One 1 MiB field killed the process that
      // serves every addon, 20 times out of 20. The stream error is handled in
      // service.ts as well; this is the half that stops the oversized write from
      // being attempted at all.
      if (instaticPassword.length > MAX_PASSWORD) {
        return json({ ok: false, error: `the password may be at most ${MAX_PASSWORD} characters` }, 400);
      }
      // Rejected, not trimmed. The credential crosses to the wrapper as one line
      // on stdin, so a newline in it would arrive as a shorter password -- a 401
      // that spends the production account's lockout budget on a value the
      // operator never typed. A control character has no business in a password
      // field either.
      if (CONTROL_CHARS.test(instaticPassword)) {
        return json({ ok: false, error: "the password may not contain a newline or a control character" }, 400);
      }
      const mfa = typeof mfaCode === "string" ? mfaCode.trim() : "";
      if (mfa.length > MAX_MFA) {
        return json({ ok: false, error: "that authentication code is too long" }, 400);
      }
      // Allocated here because the app is the side that can read the panel
      // snapshot both addons share; the wrapper only re-validates the number.
      const snapshot = readSnapshot();
      instatic = {
        port: getNextAvailablePort(
          snapshot,
          portsSinceSnapshot(await stagerService.listJobs(), snapshot.updatedAt)
        ),
        email: instaticEmail.trim().toLowerCase(),
        password: instaticPassword,
        ...(mfa ? { mfaCode: mfa } : {}),
      };
    } else if (instaticEmail !== undefined || instaticPassword !== undefined || mfaCode !== undefined) {
      return json({ ok: false, error: `${source} is not an Instatic site, so it takes no credentials` }, 400);
    }

    const res = await stagerService.startClone(source, target, tls === true, instatic);
    return json(res, res.ok ? 200 : 400);
  }

  return json({ ok: false, error: "not found" }, 404);
}

function escapeMinimal(s: string): string {
  return s.replace(/[<>&]/g, "");
}

function errorBlock(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `<div class="alert">${escapeMinimal(msg)}</div>`;
}
