// Entry point for the Stager manager service.
//
// The manager router strips the /addons/ prefix before dispatching here.

import type { Server } from "bun";
import { stagerService, validateDomain, validateJobId, expandTarget } from "./service";
import type { JobResult, JobView } from "./service";
import { layout, fragment, jobsView, newCloneView, jobView, promoteListView, promoteView, siteStagingView } from "./views";
import {
  bodyErrorResponse, guardMutation, htmlResponse, jsonResponse, newCsrfToken, readJsonObject,
  redirectResponse, safeDecodePathSegment,
} from "../../../lib/app-http";
import { getNextAvailablePort, type SanitizedSite } from "../../../lib/snapshot-reader";
// The Stager already depends on the Instatic addon: cloning a reverse-proxy
// site means driving its action binary, and this addon refuses one whose backend is
// not an instance that addon manages. The dependency runs one way only -- the
// Instatic addon knows nothing about this one -- so importing its service here
// closes no cycle.
import { instaticService } from "../../instatic/app/service";
import { jobApiRoute } from "../../../lib/job-stream";
import { embedLandingUrl } from "../../../lib/shadow-embed";

/**
 * Ports this addon has handed out that a panel-data request can race with.
 *
 * The gateway responds with live panel and addon data, but a clone may reserve
 * a port while that request is running. Include active jobs and jobs completed
 * after the response timestamp. A failed clone was rolled back, so its port is
 * free.
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
 * The action binary receives them on a line-buffered stdin stream under a
 * 120-second timeout; if the payload has an unescaped newline or exceeds the pipe
 * buffer, the action binary fails after the child process has already started
 * writing over the site. Validating here catches that before the action binary is
 * invoked at all.
 *
 * Sized against RFC 5321 and what the fields actually carry: 254 is the longest
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
  return htmlResponse(body, { status, csrf });
}

function json(body: unknown, status = 200): Response {
  return jsonResponse(body, { status });
}

// A fragment is the first thing an operator who came straight from a site page
// loads from this addon, so it carries the CSRF cookie its own actions echo.
function fragmentJson(body: unknown, csrf: string, status = 200): Response {
  return jsonResponse(body, { status, csrf });
}

/**
 * The whole request surface, exported so the one manager process can mount it.
 *
 * `path` is this addon's own path, with the mount prefix already stripped by the
 * router: a request for /addons/stager/api/... arrives here as /api/... .
 * Taking it as an argument rather than reading req.url is what keeps every route
 * below written as though this addon owned the site, which it used to.
 */
export async function handle(
  req: Request,
  path: string,
  updateNotice?: { current: string; latest: string } | null,
  server?: Server<unknown> | null,
): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;

  // Liveness probe for systemd. No auth implications: it reports nothing
  // about any site.
  if (path === "/health") {
    return json({ ok: true, service: "stager-manager" });
  }

  if (method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    // A site-scoped page belongs to the panel's site page. Send a direct visit
    // there and let the injected loader pull this page into it; ?embed=0 keeps
    // the standalone page. Deciding this needs no panel state, so it happens
    // before anything is read.
    const selected = url.searchParams.get("domain");
    if (selected && url.searchParams.get("embed") !== "0") {
      const target = validateDomain(selected);
      if (target) {
        return redirectResponse(embedLandingUrl(target, "stager"));
      }
    }
    if (selected) {
      const domain = validateDomain(selected);
      if (!domain) {
        return html(layout("Invalid site", '<div class="alert">That is not a valid hostname.</div>', updateNotice), csrf, 400);
      }
      try {
        const [page, snapshot] = await Promise.all([
          stagerService.sitePage(domain),
          stagerService.snapshot().catch(() => null),
        ]);
        return html(
          layout(
            `Staging — ${domain}`,
            siteStagingView(page.context.domain, page.jobs, page.clonable,
              snapshot?.ageSeconds ?? Infinity, snapshot?.snap.sites ?? [], snapshot?.snap.updatedAt ?? ""),
            updateNotice,
            page.context,
          ),
          csrf,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = /not found/i.test(message) ? 404 : 500;
        return html(layout("Staging", errorBlock(err), updateNotice), csrf, status);
      }
    }
    try {
      let panelSites: SanitizedSite[] = [];
      let snapshotAge = Infinity;
      let snapshotTakenAt = "";
      try {
        const { snap, ageSeconds } = await stagerService.snapshot();
        panelSites = snap.sites;
        snapshotAge = ageSeconds;
        snapshotTakenAt = snap.updatedAt;
      } catch {
        // Panel inventory unavailable; render without site-presence checks
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

  // The same page as GET /?domain=, without a document around it, for the
  // loader injected into CloudPanel's site pages.
  if (method === "GET" && path === "/fragment") {
    const csrf = newCsrfToken();
    const domain = validateDomain(url.searchParams.get("domain") ?? "");
    if (!domain) return json({ ok: false, error: "that is not a valid hostname" }, 400);
    try {
      const [page, snapshot] = await Promise.all([
        stagerService.sitePage(domain),
        stagerService.snapshot().catch(() => null),
      ]);
      return fragmentJson(
        fragment(
          `Staging — ${domain}`,
          siteStagingView(page.context.domain, page.jobs, page.clonable,
            snapshot?.ageSeconds ?? Infinity, snapshot?.snap.sites ?? [], snapshot?.snap.updatedAt ?? ""),
        ),
        csrf,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json({ ok: false, error: message }, /not found/i.test(message) ? 404 : 500);
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
    const decoded = safeDecodePathSegment(jobPage[1]!);
    if (decoded === null) {
      return html(layout("Bad request", `<div class="alert">That address is not a valid job link.</div>`, updateNotice), csrf, 400);
    }
    const id = validateJobId(decoded);
    if (!id) return html(layout("Not found", `<div class="alert">No such job.</div>`, updateNotice), csrf, 404);
    const res = await stagerService.getJob(id);
    if (!res.ok || !res.data) {
      return html(layout("Not found", `<div class="alert">${Bun.escapeHTML(res.error ?? "No such job.")}</div>`, updateNotice), csrf, 404);
    }
    let panelSites: SanitizedSite[] = [];
    let snapshotAge = Infinity;
    let snapshotTakenAt = "";
    try {
      const { snap, ageSeconds } = await stagerService.snapshot();
      panelSites = snap.sites;
      snapshotAge = ageSeconds;
      snapshotTakenAt = snap.updatedAt;
    } catch {}
    return html(
      layout(
        res.data.job.kind === "promote" ? `Promote onto ${res.data.job.target}` : `Clone into ${res.data.job.target}`,
        jobView(res.data.job, res.data.log, snapshotAge, panelSites, snapshotTakenAt),
        updateNotice
      ),
      csrf
    );
  }

  // The return leg of a clone. The pair of sites comes from this addon's own
  // clone record rather than from the request, so a promote can only ever put
  // a staging site back onto the site it was cloned from.
  if (method === "GET" && path === "/promote") {
    const csrf = newCsrfToken();
    try {
      const rawJob = url.searchParams.get("job");
      if (!rawJob) {
        return html(layout("Promote to live", promoteListView(await stagerService.listJobs()), updateNotice), csrf);
      }
      const id = validateJobId(rawJob);
      if (!id) {
        return html(layout("Promote to live", promoteListView(await stagerService.listJobs()), updateNotice), csrf, 400);
      }
      const res = await stagerService.getJob(id);
      if (!res.ok || !res.data) {
        return html(layout("Not found", `<div class="alert">${Bun.escapeHTML(res.error ?? "No such job.")}</div>`, updateNotice), csrf, 404);
      }
      const problem = promoteBlocked(res.data.job);
      if (problem) {
        return html(layout("Promote to live", promoteView(res.data.job, problem), updateNotice), csrf, 400);
      }
      return html(layout(`Promote ${res.data.job.target}`, promoteView(res.data.job), updateNotice), csrf);
    } catch (err) {
      return html(layout("Error", errorBlock(err), updateNotice), csrf, 500);
    }
  }

  if (method === "GET" && path === "/api/sites") {
    return json({ ok: true, sites: await stagerService.listSites() });
  }

  const jobApi = await jobApiRoute({
    req, path, method, server, getJob: (jobId) => stagerService.getJob(jobId),
  });
  if (jobApi) return jobApi;

  if (method === "POST" && path === "/api/promotions") {
    try {
      return await postPromote(req);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[stager] promote request failed:", msg);
      return json({ ok: false, error: msg }, 500);
    }
  }

  if (method === "POST" && path === "/api/clones") {
    // The one mutating route, and the only one that had no try/catch while
    // every GET branch has one. A panel-data request or port allocation can
    // fail, and the strict list calls below throw when an action cannot answer --
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

/**
 * Validates a clone request and forwards it to the Stager action process.
 * Reverse-proxy clones receive a port selected from live panel, clone-job, and
 * Instatic instance data.
 */
async function postClone(req: Request): Promise<Response> {
  const blocked = guardMutation(req);
  if (blocked) return blocked;

  let body: Record<string, unknown>;
  try { body = await readJsonObject(req); } catch (error) { return bodyErrorResponse(error); }
  const {
    source: rawSource, target: rawTarget, tls,
    instaticEmail, instaticPassword, mfaCode,
  } = body;

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
    // Allocated here because the app combines panel data with both addons'
    // active jobs. The action binary re-checks the number under its own lock,
    // so this is a proposal rather than a reservation.
    //
    // Neither list may fail quietly here: an empty result would mean "nothing
    // is using any port" and could produce a collision.
    const [jobs, instances, { snap: snapshot }] = await Promise.all([
      stagerService.listJobsOrThrow(),
      instaticService.listInstancesOrThrow(),
      stagerService.snapshot(),
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

/** Why this clone record cannot be the basis of a promote, or "" if it can. */
function promoteBlocked(job: JobView): string {
  if (job.kind === "promote") return "That job is itself a promote; promote from the clone that created the staging site.";
  if (job.state !== "done") return `That clone is ${job.state}. Only a finished clone can be promoted.`;
  if (!job.result) return "That clone recorded no result, so there is nothing to say what it produced.";
  if (!job.source || !job.target) return "That clone record is incomplete.";
  return "";
}

/**
 * Validates a promote request and forwards it to the Stager action process.
 *
 * The request names a clone job, not two sites: `target` becomes the staging
 * copy the files come from and `source` becomes the live site they go to,
 * which is the clone read backwards. Accepting two free hostnames instead
 * would make this a general site-to-site overwrite, which is a different and
 * much sharper tool than the one being built here.
 */
async function postPromote(req: Request): Promise<Response> {
  const blocked = guardMutation(req);
  if (blocked) return blocked;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "body must be JSON" }, 400);
  }
  const {
    job: rawJob, instaticEmail, instaticPassword, mfaCode,
    liveEmail, livePassword, liveMfaCode,
  } = (body ?? {}) as Record<string, unknown>;

  const jobId = validateJobId(typeof rawJob === "string" ? rawJob : null);
  if (!jobId) return json({ ok: false, error: "that is not a valid job id" }, 400);
  const record = await stagerService.getJob(jobId);
  if (!record.ok || !record.data) return json({ ok: false, error: record.error ?? "no such job" }, 404);
  const clone = record.data.job;
  const problem = promoteBlocked(clone);
  if (problem) return json({ ok: false, error: problem }, 400);

  const staging = validateDomain(clone.target);
  const live = validateDomain(clone.source);
  if (!staging || !live) return json({ ok: false, error: "that clone record does not name two valid hostnames" }, 400);

  const isInstatic = (clone.result as JobResult | null)?.siteType === "reverse-proxy";
  let instatic:
    | { email: string; password: string; mfaCode?: string; targetEmail: string; targetPassword: string; targetMfaCode?: string }
    | undefined;
  if (isInstatic) {
    // Two accounts, and the same bounds on both as a clone puts on its one:
    // the action binary validates its arguments before it reads stdin, so an
    // oversized field would be written into a pipe nobody is reading.
    const accounts = [
      { what: "staging", email: instaticEmail, password: instaticPassword, code: mfaCode },
      { what: "live", email: liveEmail, password: livePassword, code: liveMfaCode },
    ];
    for (const account of accounts) {
      if (typeof account.email !== "string" || !account.email.trim()) {
        return json({ ok: false, error: `promoting an Instatic site needs the ${account.what} instance's admin email address` }, 400);
      }
      if (account.email.length > MAX_EMAIL) return json({ ok: false, error: "that email address is too long" }, 400);
      if (typeof account.password !== "string" || !account.password) {
        return json({ ok: false, error: `promoting an Instatic site needs the ${account.what} instance's admin password` }, 400);
      }
      if (account.password.length > MAX_PASSWORD) {
        return json({ ok: false, error: `the password may be at most ${MAX_PASSWORD} characters` }, 400);
      }
      if (CONTROL_CHARS.test(account.password)) {
        return json({ ok: false, error: "the password may not contain a newline or a control character" }, 400);
      }
      if (account.code !== undefined && typeof account.code !== "string") {
        return json({ ok: false, error: "that authentication code is not a string" }, 400);
      }
      if (typeof account.code === "string" && account.code.trim().length > MAX_MFA) {
        return json({ ok: false, error: "that authentication code is too long" }, 400);
      }
    }
    const sourceCode = typeof mfaCode === "string" ? mfaCode.trim() : "";
    const targetCode = typeof liveMfaCode === "string" ? liveMfaCode.trim() : "";
    instatic = {
      email: (instaticEmail as string).trim().toLowerCase(),
      password: instaticPassword as string,
      targetEmail: (liveEmail as string).trim().toLowerCase(),
      targetPassword: livePassword as string,
      ...(sourceCode ? { mfaCode: sourceCode } : {}),
      ...(targetCode ? { targetMfaCode: targetCode } : {}),
    };
  } else if (
    instaticEmail !== undefined || instaticPassword !== undefined || mfaCode !== undefined
    || liveEmail !== undefined || livePassword !== undefined || liveMfaCode !== undefined
  ) {
    return json({ ok: false, error: `${live} is not an Instatic site, so it takes no credentials` }, 400);
  }

  const res = await stagerService.startPromote(staging, live, instatic);
  return json(res, res.ok ? 200 : 400);
}

function errorBlock(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `<div class="alert">${Bun.escapeHTML(msg)}</div>`;
}
