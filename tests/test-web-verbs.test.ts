import { expect, test } from "bun:test";
import { ADDONS } from "../cli/addon-catalog";
import {
  CLOUDFLARE_IPS_ALLOWED_VERBS, DNS_ALLOWED_VERBS, DUPLEX_STREAM_VERBS, GIT_ALLOWED_VERBS, INSTATIC_ALLOWED_VERBS,
  MAINTENANCE_ALLOWED_VERBS, MANAGER_ALLOWED_VERBS, OWN_ACCOUNT_VERBS, PANEL_TWEAKS_ALLOWED_VERBS,
  PHP_RESOURCES_ALLOWED_VERBS, SECURITY_KEYS_ALLOWED_VERBS, SMTP_ALLOWED_VERBS, STAGER_ALLOWED_VERBS,
  STREAM_ALLOWED_VERBS, SYSTEM_TWEAKS_ALLOWED_VERBS, TERMINAL_ALLOWED_VERBS, WP_TOOLS_ALLOWED_VERBS,
} from "../lib/gateway-protocol";
import { SELF_SCOPED_ROUTES } from "../manager/server";
import { GIT_HOOK_PREFIX } from "../addons/git/app/hook";
import { SIGN_IN_PREFIX } from "../addons/security-keys/app/sign-in";

/**
 * Everything the web side can ask root to run, and who may ask. A change to
 * the gateway's surface shows up as a change to the snapshot, in review.
 */
const ALLOWED: Record<string, Set<string>> = {
  "cloudflare-ips": CLOUDFLARE_IPS_ALLOWED_VERBS, dns: DNS_ALLOWED_VERBS, git: GIT_ALLOWED_VERBS,
  instatic: INSTATIC_ALLOWED_VERBS, maintenance: MAINTENANCE_ALLOWED_VERBS, manager: MANAGER_ALLOWED_VERBS,
  "panel-tweaks": PANEL_TWEAKS_ALLOWED_VERBS, "php-resources": PHP_RESOURCES_ALLOWED_VERBS,
  "security-keys": SECURITY_KEYS_ALLOWED_VERBS, smtp: SMTP_ALLOWED_VERBS, stager: STAGER_ALLOWED_VERBS,
  "system-tweaks": SYSTEM_TWEAKS_ALLOWED_VERBS, terminal: TERMINAL_ALLOWED_VERBS, "wp-tools": WP_TOOLS_ALLOWED_VERBS,
};

test("the web-reachable verbs and who may call them", () => {
  const lines: string[] = [];
  for (const [addon, verbs] of Object.entries(ALLOWED).sort(([a], [b]) => a.localeCompare(b))) {
    for (const verb of [...verbs].sort()) {
      const pair = `${addon}:${verb}`;
      const who = OWN_ACCOUNT_VERBS.has(pair) ? "own-account" : ADDONS[addon]?.siteManager ? "site-manager" : "admin";
      const stream = STREAM_ALLOWED_VERBS.has(verb) ? (DUPLEX_STREAM_VERBS.has(pair) ? " duplex" : " stream") : "";
      lines.push(`${pair.padEnd(34)} ${who}${stream}`);
    }
  }
  expect(lines.join("\n")).toMatchSnapshot();
});

test("the routes that do not need an administrator", () => {
  const lines = [
    `before the gate: ${GIT_HOOK_PREFIX}`,
    `before the gate: ${SIGN_IN_PREFIX}`,
    ...Object.keys(ADDONS).filter((name) => ADDONS[name]!.siteManager).sort().map((name) => `site managers: /${name}/`),
    ...[...SELF_SCOPED_ROUTES].sort().map((route) => `any panel user: ${route}`),
  ];
  expect(lines.join("\n")).toMatchSnapshot();
});
