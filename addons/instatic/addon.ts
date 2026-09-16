import { handle } from "./app/index";
import { pruneInstaticJobs, runInstaticAction } from "./action";
import { INSTATIC_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const INSTATIC_ADDON: AddonDefinition = {
  name: "instatic",
  title: "Instatic CMS",
  description: "Instant static site hosting and staging on CloudPanel.",
  requiresUnits: ["docker"],
  targets: INSTATIC_TARGETS,
  handler: handle,
  action: runInstaticAction,
  // A creation job killed part-way stays `running` for ever, and `running` is
  // what blocks a retry for that hostname.
  maintenance: {
    label: "instatic job records",
    run: () => {
      // Called directly rather than through the verb: the verb prints its
      // result as JSON for the manager, and repair speaks to a person.
      const { removed, stuck } = pruneInstaticJobs();
      return removed || stuck ? `${removed} expired, ${stuck} marked failed` : null;
    },
  },
};
