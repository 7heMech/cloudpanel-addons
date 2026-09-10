// Entry point for the Stager manager service.
//
// The manager router strips the /addons/ prefix before dispatching here.

import { stagerService, validateDomain, validateJobId, expandTarget } from "./service";
import type { JobView } from "./service";
import { layout, jobsView, newCloneView, jobView } from "./views";
import { guardMutation, newCsrfToken, csrfCookieHeader, SECURITY_HEADERS } from "../../../lib/app-http";
import { getNextAvailablePort, readSnapshot, type SanitizedSite } from "../../../lib/snapshot-reader";
// The Stager already depends on the Instatic addon: cloning a reverse-proxy
// site means driving its action binary, and this addon refuses one whose backend is
// not an instance that addon manages. The dependency runs one way only -- the
// Instatic addon knows nothing about this one -- so importing its service here
// closes no cycle.
import { instaticService } from "../../instatic/app/service";

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
 * Bounds on the credential fields, because the action binary cannot be the one to
 * enforce them.
 *
 * Every verb of the action binary validates its arguments before it reads stdin, so the
 * ordinary rejection path exits with the pipe still unread. A body larger than
 * the 64 KiB pipe buffer then fails the write with EPIPE, on a stream tick
 * outside any request promise, where `Bun.serve` cannot turn it into a 500. One
 * 1 MiB password killed the process -- and since v0.7.0 that process serves
 * every addon, not just this one.
 *
 * The numbers are what the action binary would accept anyway: 254 is the longest legal
 * email address and what `validateEmail` allows, 32 is the top of
 * `validateMfa`'s range, and 256 is generous for a password while staying four
 * orders of magnitude clear of the buffer.
 */
const MAX_EMAIL = 254;
const MAX_PASSWORD = 256;
const MAX_MFA = 32;

/** A newline in a credential would arrive at the action binary as a shorter one. */
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
// router: a request for /addons/stager/api/... arrives here as /api/... .
// Taking it as an argument rather than reading req.url is what keeps every route
// below written as though this addon owned the site, which it used to.
export async function handle(req: Request, path: string, updateNotice?: { current: string; latest: string } | null): Promise<Response> {
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
      let panelSites: SanitizedSite[] = [];
      let snapshotAge = Infinity;
      let snapshotTakenAt = "";
      try {
        const { snap, ageSeconds } = stagerService.snapshot();
        panelSites = snap.sites;
        snapshotAge = ageSeconds;
        snapshotTakenAt = snap.updatedAt;
      } catch {
        // Snapshot missing or unreadable; render without site presence checks
      }
      return html(
        layout(
          "Staging clones",
          jobsView(await stagerService.listJobs(), snapshotAge, panelSites, snapshotTakenAt),
          updateNotice
        ),
        csrf
      );
    } catch (err) {
      return html(layout("Error", errorBlock(err), updateNotice), csrf, 500);
    }
  }

  // The button injected into every CloudPanel site page lands here with the
  // site it was rendered on. Nothing is trusted about it: it is validated,
  // and then the action binary looks it up in the panel's own site table.
  if (method === "GET" && path === "/new") {
    const csrf = newCsrfToken();
    try {
      const raw = url.searchParams.get("source");
      if (!raw) {
        return html(layout("New staging site", newCloneView(null, await stagerService.listSites()), updateNotice), csrf);
      }
      const source = validateDomain(raw.toLowerCase());
      if (!source) {
        return html(
          layout("New staging site",
            newCloneView(null, await stagerService.listSites(), "That is not a valid hostname."),
            updateNotice),
          csrf, 400
        );
      }
      const detail = await stagerService.describe(source);
      if (!detail.ok || !detail.data) {
        return html(
          layout("New staging site",
            newCloneView(null, await stagerService.listSites(), detail.error ?? `Cannot clone ${source}.`),
            updateNotice),
          csrf, 400
        );
      }
      return html(layout(`Clone ${source}`, newCloneView(detail.data, []), updateNotice), csrf);
    } catch (err) {
      return html(layout("Error", errorBlock(err), updateNotice), csrf, 500);
    }
  }

  const jobPage = path.match(/^\/jobs\/([^/]+)$/);
  if (method === "GET" && jobPage) {
    const csrf = newCsrfToken();
    const id = validateJobId(decodeURIComponent(jobPage[1]!));
    if (!id) return html(layout("Not found", `<div class="alert">No such job.</div>`, updateNotice), csrf, 404);
    const res = await stagerService.getJob(id);
    if (!res.ok || !res.data) {
      return html(layout("Not found", `<div class="alert">${Bun.escapeHTML(res.error ?? "No such job.")}</div>`, updateNotice), csrf, 404);
    }
    let panelSites: SanitizedSite[] = [];
    let snapshotAge = Infinity;
    let snapshotTakenAt = "";
    try {
      const { snap, ageSeconds } = stagerService.snapshot();
      panelSites = snap.sites;
      snapshotAge = ageSeconds;
      snapshotTakenAt = snap.updatedAt;
    } catch {}
    return html(
      layout(
        `Clone into ${res.data.job.target}`,
        jobView(res.data.job, res.data.log, snapshotAge, panelSites, snapshotTakenAt),
        updateNotice
      ),
      csrf
    );
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
    // The one mutating route, and the only one that had no try/catch while
    // every GET branch has one. `readSnapshot()` throws when the snapshot is
    // missing, `getNextAvailablePort()` throws when the range is exhausted, and
    // the two strict list calls below throw when the action
    // binary cannot answer --
    // all of which surfaced as a bare 500 with nothing said.
    try {
      return await postClone(req);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[stager] clone request failed:", msg);
      return json({ ok: false, error: msg }, 500);
    }
  }

  return json({ ok: false, error: "not found" }, 404);
}

async function postClone(req: Request): Promise<Response> {
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

  // The shorthand is expanded here so the action binary only ever sees a
  // complete hostname; it must reject rather than rewrite.
  const target = validateDomain(expandTarget(typeof rawTarget === "string" ? rawTarget : "", source));
  if (!target) return json({ ok: false, error: "target is not a valid hostname" }, 400);
  if (target === source) return json({ ok: false, error: "the target is the site being cloned" }, 400);

  // The credential fields are accepted only for a source that really is an
  // Instatic site, and that is settled by asking the action binary rather
  // than by trusting the body. Nothing here is ever logged.
  //
  // `sites` rather than `describe`, because the only question this route has is
  // what type the source is and `describe` answers it by also running `du -sm`
  // over the whole document root -- a read with a 120-second timeout that a PHP
  // clone needing no credentials has no use for. The listing applies the same
  // gates, including leaving out a reverse proxy whose backend is not an
  // instance this box manages, so a source missing from it is one the action binary
  // would refuse; `describe` is asked once after that, for the sentence saying
  // which condition applied.
  const summary = (await stagerService.listSites()).find((site) => site.domain === source);
  if (!summary) {
    const detail = await stagerService.describe(source);
    return json({ ok: false, error: detail.error ?? `cannot clone ${source}` }, 400);
  }
  let instatic: { port: number; email: string; password: string; mfaCode?: string } | undefined;
  if (summary.siteType === "reverse-proxy") {
    if (typeof instaticEmail !== "string" || !instaticEmail.trim()) {
      return json({ ok: false, error: "cloning an Instatic site needs the source's admin email address" }, 400);
    }
    if (instaticEmail.length > MAX_EMAIL) {
      return json({ ok: false, error: "that email address is too long" }, 400);
    }
    if (typeof instaticPassword !== "string" || !instaticPassword) {
      return json({ ok: false, error: "cloning an Instatic site needs the source's admin password" }, 400);
    }
    // Bounded, and bounded here rather than left to the action binary, because
    // the action binary validates its arguments before it ever reads stdin: an
    // over-long password is refused with the pipe unread, and anything past
    // the 64 KiB pipe buffer then fails the write with EPIPE on a stream tick
    // no request promise can catch. One 1 MiB field killed the process that
    // serves every addon, 20 times out of 20. The stream error is handled in
    // service.ts as well; this is the half that stops the oversized write from
    // being attempted at all.
    if (instaticPassword.length > MAX_PASSWORD) {
      return json({ ok: false, error: `the password may be at most ${MAX_PASSWORD} characters` }, 400);
    }
    // Rejected, not trimmed. The credential crosses to the action binary as one
    // line on stdin, so a newline in it would arrive as a shorter password -- a 401
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
    // snapshot both addons share; the action binary re-checks the number under
    // its own lock, so this is a proposal rather than a reservation.
    //
    // Both sources, because the snapshot is stale about both and each side was
    // only compensating for its own. `listInstances` is what the Instatic
    // addon already asks before it creates one; an instance made from its
    // dashboard inside the fifteen-minute window is invisible to the snapshot,
    // and without this both sides offered the same number and the clone died
    // on `docker run` failing to bind it. Neither list may fail quietly here:
    // an empty one reads as "nothing is using any port", which is the one
    // answer that produces a collision.
    const snapshot = readSnapshot();
    const [jobs, instances] = await Promise.all([
      stagerService.listJobsOrThrow(),
      instaticService.listInstancesOrThrow(),
    ]);
    instatic = {
      port: getNextAvailablePort(snapshot, [
        ...portsSinceSnapshot(jobs, snapshot.updatedAt),
        ...instances.map((i) => i.port),
      ]),
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

function errorBlock(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `<div class="alert">${Bun.escapeHTML(msg)}</div>`;
}
