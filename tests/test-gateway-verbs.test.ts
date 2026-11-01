import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ADDONS as CATALOG } from "../cli/addon-catalog";
import { callGatewayAction, gatewayCaller, streamGatewayAction } from "../lib/gateway-client";
import { ADDON_VERBS, type GatewayAddon, webVerb } from "../lib/gateway-protocol";

/**
 * Each addon declares its verbs once, in its own `verbs.ts`, and the gateway's
 * allowlist and the action's verb type are read from that. What is left to
 * drift is the action's dispatcher: a declared verb it never handles, or one
 * it handles that nobody declared.
 *
 * So the verbs each action dispatches on are read off its source -- the verbs
 * its `switch` cases, the verbs it compares `argv[0]` or `verb` with, verb
 * lists it checks against, and any argument table keyed by verb -- and they
 * must be exactly the declared ones.
 */
const SOURCES: Partial<Record<GatewayAddon, string[]>> = {
  manager: ["cli/manager-action.ts"],
  "wp-tools": ["addons/wp-tools/action.ts", "addons/wp-tools/mainwp.ts"],
};

function dispatchedVerbs(addon: GatewayAddon): string[] {
  const verbs = new Set<string>();
  for (const file of SOURCES[addon] ?? [`addons/${addon}/action.ts`]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    for (const table of source.matchAll(/const ARGUMENTS[^=]*= \{([^}]*)\}/g)) {
      for (const match of table[1]!.matchAll(/"([a-z][a-z-]*)":/g)) verbs.add(match[1]!);
    }
    for (const match of source.matchAll(/case "([a-z][a-z-]*)":/g)) verbs.add(match[1]!);
    for (const match of source.matchAll(/(?:argv\[0\]|verb|rawVerb) [!=]== "([a-z][a-z-]*)"/g)) verbs.add(match[1]!);
  }
  return [...verbs].sort();
}

describe("each action dispatches exactly the verbs it declares", () => {
  test("every addon in the catalog declares its verbs", () => {
    expect(Object.keys(ADDON_VERBS).filter((name) => name !== "manager").sort()).toEqual(Object.keys(CATALOG).sort());
  });

  for (const addon of Object.keys(ADDON_VERBS) as GatewayAddon[]) {
    test(addon, () => {
      expect(dispatchedVerbs(addon)).toEqual(Object.keys(ADDON_VERBS[addon]).sort());
    });
  }

  test("a root-only verb says why", () => {
    for (const verbs of Object.values(ADDON_VERBS)) {
      for (const declared of Object.values(verbs) as { web: unknown; why?: string }[]) {
        if (declared.web === false) expect(declared.why?.length).toBeGreaterThan(10);
      }
    }
  });

  test("promote is reachable, which it was not when the route shipped", () => {
    expect(webVerb("stager", "promote")).not.toBeNull();
  });

  // `hook` is the one verb an unauthenticated request reaches, through the
  // push-to-deploy route: the manager cannot read the token itself, so a verb
  // missing here would refuse every delivery as `invalid verb`.
  test("the push-to-deploy verbs are reachable", () => {
    expect(webVerb("git", "hook")?.web).toBe("pre-gate");
    for (const verb of ["webhook-enable", "webhook-disable"]) expect(webVerb("git", verb), verb).not.toBeNull();
  });

  test("names off the wire match only declared verbs", () => {
    expect(webVerb("constructor", "list")).toBeNull();
    expect(webVerb("stager", "constructor")).toBeNull();
    expect(webVerb("stager", "run")).toBeNull();
    expect(webVerb("stager", "__proto__")).toBeNull();
  });
});

// The manager holds a route that lets a non-administrator through to the verbs
// declared for them; a refusal never reaches the socket.
describe("the manager refuses a verb its caller may not ask for", () => {
  const options = { socketPath: "/nonexistent/clp-addons-test.sock", timeout: 1_000 };
  // Run as root with no socket, an allowed call would otherwise start the installed binary.
  const testBin = process.env.CLP_ADDONS_ACTION_TEST_BIN;
  beforeAll(() => { process.env.CLP_ADDONS_ACTION_TEST_BIN = "/nonexistent/clp-addons-test-bin"; });
  afterAll(() => {
    if (testBin === undefined) delete process.env.CLP_ADDONS_ACTION_TEST_BIN;
    else process.env.CLP_ADDONS_ACTION_TEST_BIN = testBin;
  });
  const refused = (addon: string, verb: string) => ({ ok: false, error: `${addon} ${verb} is not available to this session` });

  test.each([
    [null, "git", "sites"],
    [null, "security-keys", "users"],
    [["ROLE_USER"], "dns", "list"],
    [["ROLE_USER"], "wp-tools", "new-site"],
    [["ROLE_SITE_MANAGER"], "wp-tools", "sites"],
    [["ROLE_SITE_MANAGER"], "manager", "update"],
  ] as const)("%p may not ask for %s %s", async (roles, addon, verb) => {
    const result = await gatewayCaller.run({ roles }, () => callGatewayAction(addon, verb, [], undefined, options));
    expect(result).toEqual(refused(addon, verb));
  });

  test.each([
    [null, "git", "hook"],
    [null, "security-keys", "sign-in"],
    [["ROLE_USER"], "dns", "provision"],
    [["ROLE_USER"], "security-keys", "keys"],
    [["ROLE_SITE_MANAGER"], "wp-tools", "new-site"],
    [["ROLE_SITE_MANAGER"], "instatic", "create"],
    [["ROLE_ADMIN"], "manager", "update"],
  ] as const)("%p may ask for %s %s", async (roles, addon, verb) => {
    const result = await gatewayCaller.run({ roles }, () => callGatewayAction(addon, verb, [], undefined, options));
    expect(result).not.toEqual(refused(addon, verb));
  });

  test("a stream is refused the same way", async () => {
    const closed = await gatewayCaller.run({ roles: ["ROLE_USER"] }, () => new Promise<string | undefined>((resolve) => {
      streamGatewayAction({ addon: "stager", verb: "watch-job", args: [], ...options, onClose: resolve });
    }));
    expect(closed).toBe("stager watch-job is not available to this session");
  });
});
