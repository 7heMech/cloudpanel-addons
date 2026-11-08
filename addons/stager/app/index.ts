import { errorMessage } from "../../../lib/errors";
import { stagerService, expandTarget, promoteBlocked } from "./service";
import { validateJobId } from "../../../lib/job-id";
import type { JobResult, JobView } from "./service";
import { layout, fragment, jobsView, newCloneView, jobView, promoteView, siteStagingView } from "./views";
import {
  errorBlock, guardMutation, validateExactDomain, htmlResponse, jsonResponse, newCsrfToken, redirectResponse, safeDecodePathSegment, readBody,
} from "../../../lib/app-http";
import { mountPath } from "../../../lib/mount";
import { getNextAvailablePort, type SanitizedSite } from "../../../lib/snapshot-reader";
// One way only: the Instatic addon knows nothing about this one.
import { instaticService } from "../../instatic/app/service";
import { jobApiRoute } from "../../../lib/job-stream";
import { embedLandingUrl } from "../../../lib/shadow-embed";

/**
 * A clone may reserve a port while the panel-data request runs. A failed clone
 * was rolled back, so its port is free.
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
 * The action validates its arguments before it reads stdin, so an oversized
 * field would be written into an unread pipe; anything past the 64 KiB pipe
 * buffer then fails the write with EPIPE on a stream tick no request promise
 * can catch, killing the process that serves every addon.
 *
 * 254 is the longest email address (RFC 5321) and what `validateEmail` allows,
 * 32 is the top of `validateMfa`'s range, and 256 is generous for a password
 * while staying far clear of the buffer.
 */
const MAX_EMAIL = 254;
const MAX_PASSWORD = 256;
const MAX_MFA = 32;

/** A newline in a credential would arrive at the action binary as a shorter one. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** `path` has the mount prefix stripped: /addons/stager/api/... arrives as /api/... . */
export async function handle(
  req: Request,
  path: string,
  updateNotice?: { current: string; latest: string } | null,
  _server?: unknown,
): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;

  // What a job page polls while the manager restarts (JOB_WATCH_JS). It
  // reports nothing about any site.
  if (path === "/health") {
    return jsonResponse({ ok: true, service: "stager-manager" });
  }

  if (method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    // A site-scoped page belongs to the panel's site page, where the injected
    // loader pulls it in; ?embed=0 keeps the standalone page.
    const selected = url.searchParams.get("domain");
    if (selected && url.searchParams.get("embed") !== "0") {
      const target = validateExactDomain(selected);
      if (target) {
        return redirectResponse(embedLandingUrl(target, "stager"));
      }
    }
    if (selected) {
      const domain = validateExactDomain(selected);
      if (!domain) {
        return htmlResponse(layout("Invalid site", errorBlock("That is not a valid hostname."), updateNotice), { status: 400, csrf });
      }
      try {
        const [page, snapshot] = await Promise.all([
          stagerService.sitePage(domain),
          stagerService.snapshot().catch(() => null),
        ]);
        return htmlResponse(
          layout(
            `Staging — ${domain}`,
            siteStagingView(page.context.domain, page.jobs, page.clonable,
              snapshot?.ageSeconds ?? Infinity, snapshot?.snap.sites ?? [], snapshot?.snap.updatedAt ?? ""),
            updateNotice,
            page.context,
          ),
          { csrf },
        );
      } catch (err) {
        const message = errorMessage(err);
        const status = /not found/i.test(message) ? 404 : 500;
        return htmlResponse(layout("Staging", errorBlock(err), updateNotice), { status, csrf });
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
      }
      return htmlResponse(
        layout(
          "Staging clones",
          jobsView(await stagerService.listJobs(), snapshotAge, panelSites, snapshotTakenAt),
          updateNotice
        ),
        { csrf }
      );
    } catch (err) {
      return htmlResponse(layout("Error", errorBlock(err), updateNotice), { status: 500, csrf });
    }
  }

  // For the loader injected into CloudPanel's site pages.
  if (method === "GET" && path === "/fragment") {
    const csrf = newCsrfToken();
    const domain = validateExactDomain(url.searchParams.get("domain") ?? "");
    if (!domain) return jsonResponse({ ok: false, error: "that is not a valid hostname" }, 400);
    try {
      const [page, snapshot] = await Promise.all([
        stagerService.sitePage(domain),
        stagerService.snapshot().catch(() => null),
      ]);
      return jsonResponse(
        fragment(
          `Staging — ${domain}`,
          siteStagingView(page.context.domain, page.jobs, page.clonable,
            snapshot?.ageSeconds ?? Infinity, snapshot?.snap.sites ?? [], snapshot?.snap.updatedAt ?? ""),
        ),
        { csrf },
      );
    } catch (err) {
      const message = errorMessage(err);
      return jsonResponse({ ok: false, error: message }, /not found/i.test(message) ? 404 : 500);
    }
  }

  // The injected button lands here with its site, which is untrusted: the
  // action looks it up in the panel's own site table.
  if (method === "GET" && path === "/new") {
    const csrf = newCsrfToken();
    try {
      const raw = url.searchParams.get("source");
      if (!raw) {
        return htmlResponse(layout("New staging site", newCloneView(null, await stagerService.listSites()), updateNotice), { csrf });
      }
      const source = validateExactDomain(raw.toLowerCase());
      if (!source) {
        return htmlResponse(
          layout("New staging site",
            newCloneView(null, await stagerService.listSites(), "That is not a valid hostname."),
            updateNotice),
          { status: 400, csrf }
        );
      }
      // The listing applies every gate the action does, so a source it leaves
      // out is one a clone would refuse; describe says which gate.
      const sites = await stagerService.listSites();
      const summary = sites.find((site) => site.domain === source);
      if (!summary) {
        const detail = await stagerService.describe(source);
        return htmlResponse(
          layout("New staging site", newCloneView(null, sites, detail.error ?? `Cannot clone ${source}.`), updateNotice),
          { status: 400, csrf }
        );
      }
      return htmlResponse(layout(`Clone ${source}`, newCloneView(summary, []), updateNotice), { csrf });
    } catch (err) {
      return htmlResponse(layout("Error", errorBlock(err), updateNotice), { status: 500, csrf });
    }
  }

  const jobPage = path.match(/^\/jobs\/([^/]+)$/);
  if (method === "GET" && jobPage) {
    const csrf = newCsrfToken();
    const decoded = safeDecodePathSegment(jobPage[1]!);
    if (decoded === null) {
      return htmlResponse(layout("Bad request", errorBlock("That address is not a valid job link."), updateNotice), { status: 400, csrf });
    }
    const id = validateJobId(decoded);
    if (!id) return htmlResponse(layout("Not found", errorBlock("No such job."), updateNotice), { status: 404, csrf });
    const res = await stagerService.getJob(id);
    if (!res.ok || !res.data) {
      return htmlResponse(layout("Not found", errorBlock(res.error ?? "No such job."), updateNotice), { status: 404, csrf });
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
    return htmlResponse(
      layout(
        res.data.job.kind === "promote" ? `Promote onto ${res.data.job.target}` : `Clone into ${res.data.job.target}`,
        jobView(res.data.job, res.data.log, snapshotAge, panelSites, snapshotTakenAt),
        updateNotice
      ),
      { csrf }
    );
  }

  // The pair of sites comes from the clone record, not the request, so a
  // promote can only put a staging site back onto the site it was cloned from.
  if (method === "GET" && path === "/promote") {
    const csrf = newCsrfToken();
    try {
      const id = validateJobId(url.searchParams.get("job") ?? "");
      if (!id) return redirectResponse(`${mountPath("stager")}/`);
      const res = await stagerService.getJob(id);
      if (!res.ok || !res.data) {
        return htmlResponse(layout("Not found", errorBlock(res.error ?? "No such job."), updateNotice), { status: 404, csrf });
      }
      const problem = promoteBlocked(res.data.job);
      if (problem) {
        return htmlResponse(layout("Promote to live", promoteView(res.data.job, problem), updateNotice), { status: 400, csrf });
      }
      return htmlResponse(layout(`Promote ${res.data.job.target}`, promoteView(res.data.job), updateNotice), { csrf });
    } catch (err) {
      return htmlResponse(layout("Error", errorBlock(err), updateNotice), { status: 500, csrf });
    }
  }

  if (method === "GET" && path === "/api/sites") {
    return jsonResponse({ ok: true, sites: await stagerService.listSites() });
  }

  const jobApi = await jobApiRoute({
    req,
    path,
    method,
    getJob: (jobId) => stagerService.getJob(jobId),
    watchJob: (jobId, handlers) => stagerService.watchJob(jobId, handlers),
  });
  if (jobApi) return jobApi;

  if (method === "POST" && path === "/api/promotions") {
    try {
      return await postPromote(req);
    } catch (err) {
      const msg = errorMessage(err);
      console.error("[stager] promote request failed:", msg);
      return jsonResponse({ ok: false, error: msg }, 500);
    }
  }

  if (method === "POST" && path === "/api/clones") {
    try {
      return await postClone(req);
    } catch (err) {
      const msg = errorMessage(err);
      console.error("[stager] clone request failed:", msg);
      return jsonResponse({ ok: false, error: msg }, 500);
    }
  }

  return jsonResponse({ ok: false, error: "not found" }, 404);
}

async function postClone(req: Request): Promise<Response> {
  const blocked = guardMutation(req);
  if (blocked) return blocked;

  const body = await readBody(req);
  if (body instanceof Response) return body;
  const {
    source: rawSource, target: rawTarget, tls,
    instaticEmail, instaticPassword, mfaCode,
  } = body;

  const source = validateExactDomain(typeof rawSource === "string" ? rawSource.toLowerCase() : null);
  if (!source) return jsonResponse({ ok: false, error: "source is not a valid hostname" }, 400);

  const target = validateExactDomain(expandTarget(typeof rawTarget === "string" ? rawTarget : "", source));
  if (!target) return jsonResponse({ ok: false, error: "target is not a valid hostname" }, 400);
  if (target === source) return jsonResponse({ ok: false, error: "the target is the site being cloned" }, 400);

  // Whether the source is an Instatic site is settled by the action, not the
  // body; the listing applies every gate a clone does, and `describe` says
  // which one applied. Nothing here is ever logged.
  const summary = (await stagerService.listSites()).find((site) => site.domain === source);
  if (!summary) {
    const detail = await stagerService.describe(source);
    return jsonResponse({ ok: false, error: detail.error ?? `cannot clone ${source}` }, 400);
  }
  let instatic: { port: number; email: string; password: string; mfaCode?: string } | undefined;
  if (summary.siteType === "reverse-proxy") {
    if (typeof instaticEmail !== "string" || !instaticEmail.trim()) {
      return jsonResponse({ ok: false, error: "cloning an Instatic site needs the source's admin email address" }, 400);
    }
    if (instaticEmail.length > MAX_EMAIL) {
      return jsonResponse({ ok: false, error: "that email address is too long" }, 400);
    }
    if (typeof instaticPassword !== "string" || !instaticPassword) {
      return jsonResponse({ ok: false, error: "cloning an Instatic site needs the source's admin password" }, 400);
    }
    if (instaticPassword.length > MAX_PASSWORD) {
      return jsonResponse({ ok: false, error: `the password may be at most ${MAX_PASSWORD} characters` }, 400);
    }
    // Rejected, not trimmed: a newline would arrive on stdin as a shorter
    // password, a 401 that spends the production account's lockout budget.
    if (CONTROL_CHARS.test(instaticPassword)) {
      return jsonResponse({ ok: false, error: "the password may not contain a newline or a control character" }, 400);
    }
    const mfa = typeof mfaCode === "string" ? mfaCode.trim() : "";
    if (mfa.length > MAX_MFA) {
      return jsonResponse({ ok: false, error: "that authentication code is too long" }, 400);
    }
    // A proposal, not a reservation: the action re-checks it under its lock.
    // Neither list may fail quietly, or an empty result would hand out a port
    // in use.
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
    return jsonResponse({ ok: false, error: `${source} is not an Instatic site, so it takes no credentials` }, 400);
  }

  const res = await stagerService.startClone(source, target, tls === true, instatic);
  return jsonResponse(res, res.ok ? 200 : 400);
}

/**
 * The request names a clone job, not two sites: accepting two free hostnames
 * would make this a general site-to-site overwrite.
 */
async function postPromote(req: Request): Promise<Response> {
  const blocked = guardMutation(req);
  if (blocked) return blocked;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "body must be JSON" }, 400);
  }
  const {
    job: rawJob, instaticEmail, instaticPassword, mfaCode,
    liveEmail, livePassword, liveMfaCode,
  } = (body ?? {}) as Record<string, unknown>;

  const jobId = validateJobId(typeof rawJob === "string" ? rawJob : null);
  if (!jobId) return jsonResponse({ ok: false, error: "that is not a valid job id" }, 400);
  const record = await stagerService.getJob(jobId);
  if (!record.ok || !record.data) return jsonResponse({ ok: false, error: record.error ?? "no such job" }, 404);
  const clone = record.data.job;
  const problem = promoteBlocked(clone);
  if (problem) return jsonResponse({ ok: false, error: problem }, 400);

  const staging = validateExactDomain(clone.target);
  const live = validateExactDomain(clone.source);
  if (!staging || !live) return jsonResponse({ ok: false, error: "that clone record does not name two valid hostnames" }, 400);

  const isInstatic = (clone.result as JobResult | null)?.siteType === "reverse-proxy";
  let instatic:
    | { email: string; password: string; mfaCode?: string; targetEmail: string; targetPassword: string; targetMfaCode?: string }
    | undefined;
  if (isInstatic) {
    const accounts = [
      { what: "staging", email: instaticEmail, password: instaticPassword, code: mfaCode },
      { what: "live", email: liveEmail, password: livePassword, code: liveMfaCode },
    ];
    for (const account of accounts) {
      if (typeof account.email !== "string" || !account.email.trim()) {
        return jsonResponse({ ok: false, error: `promoting an Instatic site needs the ${account.what} instance's admin email address` }, 400);
      }
      if (account.email.length > MAX_EMAIL) return jsonResponse({ ok: false, error: "that email address is too long" }, 400);
      if (typeof account.password !== "string" || !account.password) {
        return jsonResponse({ ok: false, error: `promoting an Instatic site needs the ${account.what} instance's admin password` }, 400);
      }
      if (account.password.length > MAX_PASSWORD) {
        return jsonResponse({ ok: false, error: `the password may be at most ${MAX_PASSWORD} characters` }, 400);
      }
      if (CONTROL_CHARS.test(account.password)) {
        return jsonResponse({ ok: false, error: "the password may not contain a newline or a control character" }, 400);
      }
      if (account.code !== undefined && typeof account.code !== "string") {
        return jsonResponse({ ok: false, error: "that authentication code is not a string" }, 400);
      }
      if (typeof account.code === "string" && account.code.trim().length > MAX_MFA) {
        return jsonResponse({ ok: false, error: "that authentication code is too long" }, 400);
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
    return jsonResponse({ ok: false, error: `${live} is not an Instatic site, so it takes no credentials` }, 400);
  }

  const res = await stagerService.startPromote(staging, live, instatic);
  return jsonResponse(res, res.ok ? 200 : 400);
}
