import type { AddonDefinition } from "../../cli/addon-catalog";
import { deactivateSmtp, executeSmtpAction, runSmtpAction, type SmtpActionOptions } from "./action";
import { handle } from "./app/index";

export const SMTP_ADDON: AddonDefinition = {
  name: "smtp",
  title: "SMTP Relay",
  description: "Relay PHP mail through Postfix with sender rules for each site.",
  requiresUnits: ["postfix"],
  targets: [],
  handler: handle,
  action: runSmtpAction,
  deactivate: deactivateSmtp,
  maintenance: {
    label: "SMTP relay",
    run: async (options) => {
      const result = await executeSmtpAction(["reconcile"], (options ?? {}) as SmtpActionOptions) as { repaired: number };
      return result.repaired > 0 ? `${result.repaired} PHP mail pool${result.repaired === 1 ? "" : "s"} restored` : null;
    },
  },
};
