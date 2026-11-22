import { handle } from "./app/index";
import { pruneInstaticJobs, runInstaticAction } from "./action";
import { INSTATIC_TARGETS } from "./inject/targets";
import { ensureMailBridge, mailGateway, syncMailFirewall, withdrawMailBridge } from "./mail-bridge";
import { runInstaticMail } from "./mail";
import type { AddonDefinition } from "../../lib/addon-definition";

export const INSTATIC_ADDON: AddonDefinition = {
  name: "instatic",
  title: "Instatic CMS",
  description: "Instant static site hosting and staging on CloudPanel.",
  changed: [
    { in: "2.2.0-rc.3", note: "Instatic sites can send email through the server's Postfix, and so through SMTP Relay: in Instatic's Email settings, add an SMTP connector with host smtp-relay, port 2525 and no login. A site gets this when it is next updated or recreated." },
  ],
  requiresUnits: ["docker"],
  // ghcr.io/corebunch/instatic publishes linux/amd64 images only.
  supportedArches: ["x64"],
  targets: INSTATIC_TARGETS,
  handler: handle,
  action: runInstaticAction,
  // Site managers can create and manage every CloudPanel site. Instatic's
  // fixed-image containers and site lifecycle belong to that same role.
  siteManager: true,
  commands: { "instatic-mail": { root: true, enabledOnly: true, run: () => runInstaticMail() } },
  // The network exists once a container has been started on it.
  activate: () => { if (mailGateway()) ensureMailBridge(); },
  deactivate: () => withdrawMailBridge(),
  firewall: { label: "instatic mail", run: () => syncMailFirewall() },
  // A creation job killed part-way stays `running` for ever, and `running` is
  // what blocks a retry for that hostname.
  repair: {
    label: "instatic",
    run: () => {
      // Not through the verb: the verb prints JSON for the manager, and repair
      // speaks to a person.
      const { removed, stuck } = pruneInstaticJobs();
      if (mailGateway()) ensureMailBridge();
      return removed || stuck ? `job records: ${removed} expired, ${stuck} marked failed` : null;
    },
  },
};
