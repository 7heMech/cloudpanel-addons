import { INSTATIC_TARGETS } from "../addons/instatic/inject/targets";
import { STAGER_TARGETS } from "../addons/stager/inject/targets";

export { PANEL_IDENTITY_PATH } from "./action-constants";

export { mountPath } from "../lib/mount";

export const REPO = "7heMech/cloudpanel-addons";
export const CLI_ARTIFACT = "clp-addons-linux-x64";
export const CLI_BIN = "/usr/local/bin/clp-addons";
export const LIBEXEC_DIR = "/usr/local/libexec/clp-addons";
export const GH_PRIVATE = `${LIBEXEC_DIR}/gh`;

export const SERVICE_USER = "clp-addons";
export const SERVICE_GROUP = "clp-addons";
export const PANEL_GROUP = "clp";
export const SHARED_GROUP = SERVICE_GROUP;

export const SOCKET_DIR = "/run/clp-addons";
export const SOCKET_PATH = `${SOCKET_DIR}/manager.sock`;
export const SESSION_DIR = "/home/clp/htdocs/app/files/var/sessions";

export const MANAGER_UNIT = "clp-addons.service";
export const PANEL_DB = "/home/clp/htdocs/app/data/db.sq3";
export const NGINX_SITES_DIR = "/etc/nginx/sites-enabled";
export const NGINX_PROXY_STATE_DIR = "/var/lib/clp-addons/nginx";

const PANEL_APP = "/home/clp/htdocs/app/files";
export const TEMPLATES_DIR = `${PANEL_APP}/templates`;
export const TWIG_CACHE_DIR = `${PANEL_APP}/var/cache`;

export const CONFIG_DIR = "/etc/clp-addons";
export const STATE_DIR = "/var/lib/clp-addons";
export const ARTIFACT_MANIFEST_PATH = `${STATE_DIR}/artifacts.json`;
export const TEMPLATE_STATE_DIR = `${STATE_DIR}/templates`;
export const LOCK_DIR = "/run/lock/clp-addons";
export const SYSTEMD_DIR = "/etc/systemd/system";

export const RECONCILE_SERVICE = "clp-addons-reconcile.service";
export const RECONCILE_TIMER = "clp-addons-reconcile.timer";
export const RECONCILE_PATH = "clp-addons-anchor.path";
export const ANCHOR_SERVICE = "clp-addons-anchor.service";

export interface AddonTarget {
  slug: string;
  template: string;
  anchorAfter: string;
  snippet: (addonUrl: string) => string;
  required: boolean;
}

export interface AddonSpec {
  name: string;
  title?: string;
  description?: string;
  configFile: string;
  requiresUnits?: string[];
  stateDir: string;
  targets: AddonTarget[];
}

export const ADDONS: Record<string, AddonSpec> = {
  instatic: {
    name: "instatic",
    title: "Instatic",
    description: "Instant static site hosting and staging on CloudPanel",
    configFile: `${CONFIG_DIR}/instatic.conf`,
    requiresUnits: ["docker"],
    stateDir: `${STATE_DIR}/instatic`,
    targets: INSTATIC_TARGETS,
  },
  stager: {
    name: "stager",
    title: "Stager",
    description: "Instant staging environments & site clones (WordPress, PHP, Node.js)",
    configFile: `${CONFIG_DIR}/stager.conf`,
    stateDir: `${STATE_DIR}/stager`,
    targets: STAGER_TARGETS,
  },
};

export const ADDON_NAMES = Object.keys(ADDONS);
export const LEGACY_USERS = ["instatic-app"];
export const LEGACY_UNITS = ["clp-addon-instatic.service", "clp-addon-stager.service"];

export function templateWatchPaths(): string[] {
  const paths = new Set<string>();
  for (const spec of Object.values(ADDONS)) {
    for (const target of spec.targets) paths.add(`${TEMPLATES_DIR}/${target.template}`);
  }
  return [...paths].sort();
}
