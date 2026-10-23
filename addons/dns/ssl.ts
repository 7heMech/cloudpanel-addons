/**
 * Automatic SSL for a site whose DNS was not ready when it was created.
 *
 * Panel Tweaks' completion page asks for a certificate in the browser. When
 * DNS is not ready yet -- a zone still waiting for its nameservers, say -- the
 * request is kept here and retried as root through CloudPanel's own CLI once
 * DNS is in place, a few times and then no more. Only a site still on the
 * self-signed certificate CloudPanel created it with is ever retried, so a
 * real certificate is never replaced.
 */
import type { PanelSite, SitePlan } from "./engine";
import { readiness } from "./engine";

export interface SslRequest {
  siteId: number;
  requestedAt: number;
  attempts: number;
  nextAttemptAt: number;
  state: string;
  done: boolean;
}

export const MAX_ATTEMPTS = 5;
/** Waits after attempt 1, 2, 3 and 4; the first waits for the browser's own try. */
const DELAYS = [5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
const FIRST_DELAY = 2 * 60_000;
const NEW_SITE_WINDOW = 15 * 60_000;
const KEEP_FINISHED = 7 * 24 * 60 * 60_000;

/** Records a request for a site created moments ago that still has its placeholder certificate. */
export function requestSsl(requests: Record<string, SslRequest>, site: PanelSite, now: number): boolean {
  if (!site.selfSigned || now - site.createdAt > NEW_SITE_WINDOW || site.createdAt > now + 60_000) return false;
  if (requests[site.domain]?.siteId === site.id) return true;
  requests[site.domain] = {
    siteId: site.id, requestedAt: now, attempts: 0, nextAttemptAt: now + FIRST_DELAY,
    state: "Waiting for the page that created the site", done: false,
  };
  return true;
}

export type Issue = (domain: string, alternativeNames: string[]) => Promise<boolean>;

/**
 * Retries every request whose site is ready. `sites` is read again after each
 * attempt, so a certificate installed by any means ends the request.
 */
export async function retryCertificates(
  requests: Record<string, SslRequest>,
  plans: SitePlan[],
  sites: () => PanelSite[],
  issue: Issue,
  now: number,
  /** Saves the attempt count before the CLI runs, so a crash mid-attempt still counts. */
  save: () => void,
): Promise<void> {
  for (const [domain, request] of Object.entries(requests)) {
    const site = sites().find((candidate) => candidate.domain === domain);
    const plan = plans.find((candidate) => candidate.domain === domain);
    // A site that is gone, or that DNS no longer enforces, is no longer DNS's to finish.
    if (!site || site.id !== request.siteId || plan?.mode !== "enforce" || (request.done && now - request.requestedAt > KEEP_FINISHED)) {
      delete requests[domain];
      continue;
    }
    if (request.done) continue;
    if (!site.selfSigned) {
      Object.assign(request, { done: true, state: "A certificate is installed" });
      continue;
    }
    const ready = readiness(plan);
    if (!ready.ready) {
      request.state = `Waiting for DNS: ${ready.reason}`;
      continue;
    }
    if (now < request.nextAttemptAt) continue;
    // An attempt is counted before it runs, so one cut short still counts.
    if (request.attempts >= MAX_ATTEMPTS) {
      Object.assign(request, { done: true, state: `No certificate after ${MAX_ATTEMPTS} attempts; request one in the site's SSL/TLS tab` });
      continue;
    }
    request.attempts++;
    request.nextAttemptAt = now + (DELAYS[request.attempts - 1] ?? 0);
    request.state = `Requesting a certificate, attempt ${request.attempts} of ${MAX_ATTEMPTS}`;
    save();
    const installed = await issue(domain, plan!.certificateNames.filter((name) => name !== domain)) && !sites().find((s) => s.id === site.id)?.selfSigned;
    if (installed) Object.assign(request, { done: true, state: "Certificate installed" });
    else if (request.attempts >= MAX_ATTEMPTS) Object.assign(request, { done: true, state: `No certificate after ${MAX_ATTEMPTS} attempts; request one in the site's SSL/TLS tab` });
    else request.state = `Attempt ${request.attempts} of ${MAX_ATTEMPTS} failed; trying again later`;
  }
}

/** CloudPanel's own CLI, as root, with a deadline. */
export function clpctlIssue(clpctl: string): Issue {
  return async (domain, alternativeNames) => {
    const process = Bun.spawn(
      [clpctl, "lets-encrypt:install:certificate", `--domainName=${domain}`, `--subjectAlternativeName=${alternativeNames.join(",")}`],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 180_000, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" } },
    );
    return await process.exited === 0;
  };
}
