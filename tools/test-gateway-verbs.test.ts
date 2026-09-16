import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CLOUDFLARE_IPS_ALLOWED_VERBS, INSTATIC_ALLOWED_VERBS, MAINTENANCE_ALLOWED_VERBS,
  STAGER_ALLOWED_VERBS,
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
 * So each addon's verbs are read off its `*Verb` union, and every one must be
 * either reachable through the gateway or named below as deliberately not. A
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
    { verb: "reconcile", why: "run by the addon's own timer, not by a request" },
  ],
  maintenance: [],
};

const ADDONS = [
  { addon: "stager", file: "addons/stager/action.ts", union: "StagerVerb", allowed: STAGER_ALLOWED_VERBS },
  { addon: "instatic", file: "addons/instatic/action.ts", union: "InstaticVerb", allowed: INSTATIC_ALLOWED_VERBS },
  { addon: "maintenance", file: "addons/maintenance/action.ts", union: "MaintenanceVerb", allowed: MAINTENANCE_ALLOWED_VERBS },
  { addon: "cloudflare-ips", file: "addons/cloudflare-ips/action.ts", union: "CloudflareVerb", allowed: CLOUDFLARE_IPS_ALLOWED_VERBS },
];

/** The string members of a `type XVerb = "a" | "b" | ...` declaration. */
function declaredVerbs(file: string, union: string): string[] {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const declaration = new RegExp(`type ${union} =([^;]*);`).exec(source);
  if (!declaration) throw new Error(`no ${union} declaration in ${file}`);
  return [...declaration[1]!.matchAll(/"([a-z-]+)"/g)].map((match) => match[1]!).sort();
}

describe("the gateway allowlist agrees with what each action implements", () => {
  for (const { addon, file, union, allowed } of ADDONS) {
    test(addon, () => {
      const declared = declaredVerbs(file, union);
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
});
