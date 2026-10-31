import { handle } from "./app/index";
import {
  pruneWpJobs, reconcileWpNewSites, runWpToolsAction, wpPoliciesActive,
  type WpNewSiteEvent, type WpNewSitesResult, type WpToolsActionOptions,
} from "./action";
import { queueAddonPass } from "../../cli/job-store";
import { WP_TOOLS_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../cli/addon-catalog";
import { log } from "../../cli/util";

const CHECKS: Record<string, string> = { "varnish-check": "CLP Varnish Cache", "mainwp-check": "MainWP Child" };

function newSitesLine(result: WpNewSitesResult): string | null {
  for (const failure of result.failed) log.warn(`WordPress Tools: ${failure}`);
  const queued = Object.entries(result.queued).map(([task, domains]) => `${CHECKS[task]} check queued for ${(domains ?? []).join(", ")}`);
  if (queued.length) return queued.join("; ");
  const waiting = result.added.filter((domain) => result.waiting.includes(domain));
  return waiting.length ? `${waiting.join(", ")} waits for WordPress` : null;
}

const newSiteEvent = (event: WpNewSiteEvent) => async (options?: Record<string, unknown>) =>
  newSitesLine(await reconcileWpNewSites((options ?? {}) as WpToolsActionOptions, event));

export const WP_TOOLS_ADDON: AddonDefinition = {
  name: "wp-tools",
  title: "WordPress Tools",
  description: "One-click WordPress sign-in, plugins chosen while creating a site, and optional automatic installation of CLP Varnish Cache and MainWP Child.",
  changed: { in: "2.0.0-rc.1", note: "Renamed from WordPress Sign-In; installs CLP Varnish Cache and MainWP Child for you." },
  targets: WP_TOOLS_TARGETS,
  handler: handle,
  action: runWpToolsAction,
  // A new site is checked when its row is committed, on each panel write while
  // CloudPanel installs its WordPress, and when its certificate is written.
  newSites: {
    label: "WordPress Tools",
    run: newSiteEvent("sites"),
    waiting: async (options) => {
      const result = await reconcileWpNewSites((options ?? {}) as WpToolsActionOptions, "wake");
      return { waiting: result.waiting.length > 0, line: newSitesLine(result) };
    },
  },
  certificates: { label: "WordPress Tools", run: newSiteEvent("certificates") },
  maintenance: {
    label: "WordPress plugins",
    run: async (options) => {
      const actionOptions = (options ?? {}) as WpToolsActionOptions;
      // Job records expire, and one whose runner died is marked failed, so the page stops following it.
      pruneWpJobs(actionOptions);
      // Which sites exist now, so that the watcher's first wake does not take them all for new ones.
      try {
        await reconcileWpNewSites(actionOptions, "seed");
      } catch (error) {
        log.warn(`WordPress Tools new sites: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!wpPoliciesActive(actionOptions)) return null;
      return queueAddonPass({ addon: "wp-tools", verb: "sync", description: "WordPress plugin policies", runtime: 180 })
        ? "plugin policy pass queued" : null;
    },
  },
};
