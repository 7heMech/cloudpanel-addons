import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ADDONS as CATALOG } from "../cli/addon-catalog";
import {
  CLOUDFLARE_IPS_ALLOWED_VERBS, DNS_ALLOWED_VERBS, GIT_ALLOWED_VERBS, INSTATIC_ALLOWED_VERBS,
  MAINTENANCE_ALLOWED_VERBS, OWN_ACCOUNT_VERBS, PANEL_TWEAKS_ALLOWED_VERBS, PHP_RESOURCES_ALLOWED_VERBS,
  SECURITY_KEYS_ALLOWED_VERBS, SYSTEM_TWEAKS_ALLOWED_VERBS, SMTP_ALLOWED_VERBS, STAGER_ALLOWED_VERBS,
  TERMINAL_ALLOWED_VERBS, WP_TOOLS_ALLOWED_VERBS,
} from "../lib/gateway-protocol";

/**
 * The gateway allowlist and the verbs an addon's action implements are two
 * lists in two files that were kept in step by hand.
 *
 * That is how "Promote to live" shipped a route whose every request the gateway
 * answered with `invalid verb`. Nothing caught it: the addon's own tests drive
 * the service with the gateway mocked, the action tests run the verb directly
 * as root, and the gateway's own tests assert only that a verb it does not know
 * is refused. None of them asked whether the two lists agree.
 *
 * So each addon's verbs are read off its source -- its `*Verb` union, the verbs
 * its dispatcher compares `argv[0]` or `verb` with, and any argument table keyed
 * by verb -- and every one must be either reachable through the gateway or named
 * below as deliberately not. A
 * verb added to an action and forgotten in the allowlist fails here; one added
 * to neither list is not reachable from the web at all and fails at the parser.
 */
const ROOT_ONLY: Record<string, { verb: string; why: string }[]> = {
  stager: [
    { verb: "run", why: "the job runner, started only by the transient unit the create path launches" },
  ],
  instatic: [
    { verb: "run", why: "the job runner, as above" },
    { verb: "prune", why: "retention sweeping, run by the reconcile timer" },
    { verb: "backup", why: "run by the cron file the addon installs" },
  ],
  "cloudflare-ips": [
    { verb: "reconcile", why: "run by hand; the new-site watcher and repair run the same pass in-process" },
  ],
  maintenance: [],
  git: [
    { verb: "run", why: "the deployment runner, started only by the transient unit the deploy path launches" },
    { verb: "prune", why: "retention sweeping, run by the reconcile timer" },
  ],
  dns: [
    { verb: "reconcile", why: "the full check, run by the worker repair queues" },
    { verb: "sync-sites", why: "run by the new-site watcher" },
  ],
  smtp: [
    { verb: "reconcile", why: "run by repair and on enable" },
    { verb: "sync-sites", why: "run by the new-site watcher" },
    { verb: "deactivate", why: "run locally during disable or uninstall" },
  ],
  "security-keys": [],
  "system-tweaks": [],
  "php-resources": [
    { verb: "reconcile", why: "run in-process by the new-site watcher and repair" },
  ],
  "panel-tweaks": [
    { verb: "scan", why: "the repair timer's sweep; the page starts a measure job instead" },
    { verb: "run", why: "the measurement runner, started only by the transient unit measure launches" },
  ],
  "wp-tools": [
    { verb: "run", why: "the job runner, started only by the transient unit start launches" },
    { verb: "sync", why: "the policy pass repair queues every 15 minutes" },
    { verb: "varnish-install", why: "run by hand; the page installs through a start job" },
    { verb: "varnish-sync", why: "run by hand; the page checks through a start job" },
    { verb: "mainwp-sync", why: "run by hand; the page checks through a start job" },
    { verb: "mainwp-connect", why: "run by hand; the page connects through a start job" },
    { verb: "mainwp-cleanup", why: "run by hand; the page cleans up through a start job" },
  ],
  terminal: [],
};

type VerbSource = { union: string } | { dispatched: true } | { keysOf: string };

const ADDONS: { addon: string; allowed: Set<string>; sources: Record<string, VerbSource[]> }[] = [
  { addon: "stager", allowed: STAGER_ALLOWED_VERBS, sources: { "addons/stager/action.ts": [{ union: "StagerVerb" }] } },
  { addon: "instatic", allowed: INSTATIC_ALLOWED_VERBS, sources: { "addons/instatic/action.ts": [{ union: "InstaticVerb" }] } },
  { addon: "maintenance", allowed: MAINTENANCE_ALLOWED_VERBS, sources: { "addons/maintenance/action.ts": [{ union: "MaintenanceVerb" }] } },
  { addon: "cloudflare-ips", allowed: CLOUDFLARE_IPS_ALLOWED_VERBS, sources: { "addons/cloudflare-ips/action.ts": [{ union: "CloudflareVerb" }] } },
  { addon: "git", allowed: GIT_ALLOWED_VERBS, sources: { "addons/git/action.ts": [{ union: "GitVerb" }] } },
  { addon: "smtp", allowed: SMTP_ALLOWED_VERBS, sources: { "addons/smtp/action.ts": [{ union: "SmtpVerb" }] } },
  { addon: "dns", allowed: DNS_ALLOWED_VERBS, sources: { "addons/dns/action.ts": [{ union: "DnsVerb" }] } },
  { addon: "security-keys", allowed: SECURITY_KEYS_ALLOWED_VERBS, sources: { "addons/security-keys/action.ts": [{ union: "SecurityKeysVerb" }] } },
  { addon: "system-tweaks", allowed: SYSTEM_TWEAKS_ALLOWED_VERBS, sources: { "addons/system-tweaks/action.ts": [{ union: "SystemTweaksVerb" }] } },
  { addon: "php-resources", allowed: PHP_RESOURCES_ALLOWED_VERBS, sources: { "addons/php-resources/action.ts": [{ union: "PhpResourcesVerb" }] } },
  {
    addon: "panel-tweaks", allowed: PANEL_TWEAKS_ALLOWED_VERBS,
    sources: { "addons/panel-tweaks/action.ts": [{ union: "PanelTweaksVerb" }, { dispatched: true }] },
  },
  {
    addon: "wp-tools", allowed: WP_TOOLS_ALLOWED_VERBS,
    sources: {
      "addons/wp-tools/action.ts": [{ union: "WpToolsVerb" }, { dispatched: true }],
      "addons/wp-tools/mainwp.ts": [{ keysOf: "ARGUMENTS" }],
    },
  },
  { addon: "terminal", allowed: TERMINAL_ALLOWED_VERBS, sources: { "addons/terminal/action.ts": [{ dispatched: true }] } },
];

/** The verbs an action implements, read off each of its sources. */
function declaredVerbs(sources: Record<string, VerbSource[]>): string[] {
  const verbs = new Set<string>();
  for (const [file, kinds] of Object.entries(sources)) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    for (const kind of kinds) {
      const pattern = "union" in kind ? new RegExp(`type ${kind.union} =([^;]*);`)
        : "keysOf" in kind ? new RegExp(`const ${kind.keysOf}[^=]*= \\{([^}]*)\\}`) : null;
      const text = pattern ? pattern.exec(source)?.[1] : source;
      if (text === undefined) throw new Error(`no ${JSON.stringify(kind)} in ${file}`);
      const members = "dispatched" in kind ? /(?:argv\[0\]|verb) [!=]== "([a-z-]+)"/g
        : "keysOf" in kind ? /"([a-z-]+)":/g : /"([a-z-]+)"/g;
      for (const match of text.matchAll(members)) verbs.add(match[1]!);
    }
  }
  return [...verbs].sort();
}

describe("the gateway allowlist agrees with what each action implements", () => {
  test("every addon in the catalog is checked", () => {
    expect(ADDONS.map((entry) => entry.addon).sort()).toEqual(Object.keys(CATALOG).sort());
  });

  for (const { addon, sources, allowed } of ADDONS) {
    test(addon, () => {
      const declared = declaredVerbs(sources);
      // A union this failed to parse would pass everything below vacuously.
      expect(declared.length).toBeGreaterThan(0);

      const rootOnly = new Set(ROOT_ONLY[addon]!.map((entry) => entry.verb));
      const missing = declared.filter((verb) => !allowed.has(verb) && !rootOnly.has(verb));
      expect(missing).toEqual([]);

      // And nothing is allowed through that the action does not implement, so a
      // renamed verb leaves no reachable dead entry behind.
      const stale = [...allowed].filter((verb) => !declared.includes(verb));
      expect(stale).toEqual([]);

      // A verb cannot be both reachable and root-only.
      expect([...rootOnly].filter((verb) => allowed.has(verb))).toEqual([]);
    });
  }

  test("promote is reachable, which it was not when the route shipped", () => {
    expect(STAGER_ALLOWED_VERBS.has("promote")).toBe(true);
  });

  // `hook` is the one verb an unauthenticated request reaches, through the
  // push-to-deploy route: the manager cannot read the token itself, so a verb
  // missing here would refuse every delivery as `invalid verb`.
  test("the push-to-deploy verbs are reachable", () => {
    for (const verb of ["hook", "webhook-enable", "webhook-disable"]) {
      expect(GIT_ALLOWED_VERBS.has(verb), `${verb} is not reachable through the gateway`).toBe(true);
    }
  });

  // The action refuses --panel-user from anyone else, so a verb that acts on
  // the caller's account and is missing from the gateway's list could never run.
  test("every own-account verb is reachable", () => {
    for (const pair of OWN_ACCOUNT_VERBS) {
      const [addon, verb] = pair.split(":");
      expect(addon).toBe("security-keys");
      expect(SECURITY_KEYS_ALLOWED_VERBS.has(verb!), pair).toBe(true);
    }
  });
});
