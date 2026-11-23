import { handle } from "./app/index";
import { pruneInstaticJobs, runInstaticAction } from "./action";
import { INSTATIC_TARGETS } from "./inject/targets";
import { ensureMailBridge, mailGateway, syncMailFirewall, withdrawMailBridge } from "./mail-bridge";
import { runInstaticMail } from "./mail";
import type { AddonDefinition } from "../../lib/addon-definition";
import { errorMessage } from "../../lib/errors";
import { log } from "../../lib/log";

/** Once a container has made the network. A failure leaves sites running and is reported, as on a container start. */
function keepMailBridge(): void {
  try {
    if (mailGateway()) ensureMailBridge();
  } catch (error) {
    log.warn(`Instatic mail cannot reach the server: ${errorMessage(error)}`);
  }
}

export const INSTATIC_ADDON: AddonDefinition = {
  name: "instatic",
  title: "Instatic CMS",
  description: "Instant static site hosting and staging on CloudPanel.",
  changed: [
    { in: "2.2.0-rc.3", note: "Instatic sites send email through the server's Postfix, and so through SMTP Relay. A site whose Instatic has email and no mail setup of its own gets an SMTP connector for it, sending as noreply@ its domain, when it is next created, updated or recreated." },
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
  activate: () => { keepMailBridge(); },
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
      keepMailBridge();
      return removed || stuck ? `job records: ${removed} expired, ${stuck} marked failed` : null;
    },
  },
};
