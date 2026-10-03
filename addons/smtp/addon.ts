import type { AddonDefinition } from "../../cli/addon-catalog";
import { activateSmtp, deactivateSmtp, executeSmtpAction, runSmtpAction, type SmtpActionOptions } from "./action";
import { handle } from "./app/index";

const count = (value: number, word: string) => `${value} ${word}${value === 1 ? "" : "s"}`;

export const SMTP_ADDON: AddonDefinition = {
  name: "smtp",
  title: "SMTP Relay",
  description: "Send each site's mail through a relay profile, with Postfix keeping every site to its own domains.",
  requiresUnits: ["postfix"],
  targets: [],
  handler: handle,
  action: runSmtpAction,
  deactivate: deactivateSmtp,
  activate: activateSmtp,
  maintenance: {
    label: "SMTP relay",
    run: async (options) => {
      const result = await executeSmtpAction(["reconcile"], (options ?? {}) as SmtpActionOptions) as { repaired: number; joined: number };
      const done = [
        ...(result.joined ? [`${count(result.joined, "new site")} joined the default profile`] : []),
        ...(result.repaired ? [`${count(result.repaired, "PHP mail setting")} restored`] : []),
      ];
      return done.length ? done.join(", ") : null;
    },
  },
};
