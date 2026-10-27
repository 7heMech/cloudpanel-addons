import type { AddonDefinition } from "../../cli/addon-catalog";
import { pruneArchiveJobs, runArchiveAction } from "./action";
import { handle } from "./app/index";
import { ARCHIVE_TARGETS } from "./inject/targets";

export const ARCHIVE_ADDON: AddonDefinition = {
  name: "archive",
  title: "Archive Sites",
  description: "Back up a site and delete it, keep the archive restorable, and optionally redirect its domain.",
  added: "2.0.0-rc.5",
  targets: ARCHIVE_TARGETS,
  handler: handle,
  action: runArchiveAction,
  maintenance: {
    label: "Archive Sites jobs",
    run: () => {
      pruneArchiveJobs();
      return null;
    },
  },
};
