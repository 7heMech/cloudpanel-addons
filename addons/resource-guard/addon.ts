import type { AddonDefinition } from "../../cli/addon-catalog";
import { CLI_BIN } from "../../cli/paths";
import { failAction, runCommand } from "../../cli/action-common";
import { executeResourceGuardAction, runResourceGuardAction, type GuardOptions } from "./action";
import { handle } from "./app/index";

function lifecycle(verb: "reconcile" | "deactivate"): void {
  const result = runCommand(CLI_BIN, ["action", "resource-guard", verb]);
  if (!result.ok) failAction(`Resource Guard ${verb} failed: ${result.stderr || result.stdout}`);
}

export const RESOURCE_GUARD_ADDON: AddonDefinition = {
  name: "resource-guard",
  title: "Resource Guard",
  description: "Bound ImageMagick scratch storage, clean orphaned image files, and monitor free disk space and inodes.",
  targets: [],
  handler: handle,
  action: runResourceGuardAction,
  activate: () => lifecycle("reconcile"),
  deactivate: () => lifecycle("deactivate"),
  maintenance: {
    label: "resource guard",
    run: async (options) => {
      const result = await executeResourceGuardAction(["reconcile"], (options ?? {}) as GuardOptions);
      return result.warnings.length ? result.warnings.join("; ") : null;
    },
  },
};
