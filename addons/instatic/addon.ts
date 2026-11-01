import { handle } from "./app/index";
import { pruneInstaticJobs, runInstaticAction } from "./action";
import { INSTATIC_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const INSTATIC_ADDON: AddonDefinition = {
  name: "instatic",
  title: "Instatic CMS",
  description: "Instant static site hosting and staging on CloudPanel.",
  changed: { in: "2.0.0-rc.1", note: "A slimmer dashboard that shows sites being created, and updates that roll back on failure." },
  requiresUnits: ["docker"],
  targets: INSTATIC_TARGETS,
  handler: handle,
  action: runInstaticAction,
  // Site managers can create and manage every CloudPanel site. Instatic's
  // fixed-image containers and site lifecycle belong to that same role.
  siteManager: true,
  // A creation job killed part-way stays `running` for ever, and `running` is
  // what blocks a retry for that hostname.
  repair: {
    label: "instatic job records",
    run: () => {
      // Called directly rather than through the verb: the verb prints its
      // result as JSON for the manager, and repair speaks to a person.
      const { removed, stuck } = pruneInstaticJobs();
      return removed || stuck ? `${removed} expired, ${stuck} marked failed` : null;
    },
  },
};
