import { getDomain } from "tldts";
import { autoSslRequests, updateAutoSsl, type AutoSslRequest } from "../../lib/auto-ssl";
import { writeRootJson } from "../../lib/root-json";
import type { PanelSite, SitePlan } from "./model";
import { provisionReadiness, type FleetPlan } from "./reconcile";

export const SSL_RETRY_DELAYS = [5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 0];
export interface SslOptions {
  file: string; lock: string; uid: number;
  clpctl: string;
  sites: () => PanelSite[];
  run?: (command: string, args: string[]) => Promise<boolean>;
  enabled: () => boolean;
  now?: () => number;
}
export function attachSsl(plans: SitePlan[], sites: PanelSite[], requests: Record<string, AutoSslRequest>): void {
  for (const p of plans) {
    const request = requests[p.domain];
    if (request && request.siteId === sites.find((s) => s.domain === p.domain)?.id) p.ssl = { requested: true, attempts: request.attempts, state: request.state, nextAttemptAt: request.nextAttemptAt };
  }
}
async function issue(command: string, args: string[]): Promise<boolean> {
  const process = Bun.spawn([command, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 120_000 });
  return await process.exited === 0;
}
export async function retryCertificates(plan: FleetPlan, options: SslOptions): Promise<void> {
  const now = options.now?.() ?? Date.now();
  await updateAutoSsl(async (requests) => {
    const sites = options.sites();
    for (const p of plan.sites) {
      const r = requests[p.domain], site = sites.find((s) => s.domain === p.domain);
      if (!site || !r || r.siteId !== site.id) continue;
      if (!site.placeholder) { r.state = "Certificate already installed; no replacement"; continue; }
      if (r.attempts >= SSL_RETRY_DELAYS.length) { r.state = "Retry limit reached; review DNS and retry explicitly"; continue; }
      const ready = provisionReadiness(p);
      if (!ready.ready) { r.state = ready.reason; continue; }
      const desired = plan.work.get(p.domain)?.desired.records ?? [];
      const names = [p.domain, ...(getDomain(p.domain) === p.domain ? [`www.${p.domain}`] : [])];
      if (names.some((name) => !desired.some((rec) => rec.name === name && ["A", "AAAA", "CNAME"].includes(rec.type)))) {
        r.state = "CloudPanel's CLI also requests www for an apex domain; its DNS must be managed before retrying"; continue;
      }
      if (now < r.nextAttemptAt) continue;
      if (!options.enabled()) return;
      const current = options.sites().find((s) => s.id === r.siteId && s.domain === p.domain);
      if (!current?.placeholder) { r.state = "Certificate already installed; no replacement"; continue; }
      r.attempts++;
      r.state = "Installing certificate";
      r.nextAttemptAt = SSL_RETRY_DELAYS[r.attempts - 1] ? now + SSL_RETRY_DELAYS[r.attempts - 1]! : 0;
      writeRootJson(options.file, requests, options.uid);
      const ok = await (options.run ?? issue)(options.clpctl, ["lets-encrypt:install:certificate", `--domainName=${p.domain}`, "--subjectAlternativeName="]);
      const after = options.sites().find((s) => s.id === r.siteId);
      r.state = ok && after && !after.placeholder ? "Certificate installed" : r.attempts >= SSL_RETRY_DELAYS.length ? "Retry limit reached; review DNS and retry explicitly" : "Certificate attempt failed; retry scheduled";
    }
  }, options.file, options.lock, options.uid);
}
export { autoSslRequests };
