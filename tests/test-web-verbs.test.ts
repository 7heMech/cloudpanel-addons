import { expect, test } from "bun:test";
import { ADDONS } from "../cli/addon-catalog";
import { ADDON_VERBS, webVerb } from "../lib/gateway-protocol";

/**
 * Everything the web side can ask root to run, and who may ask. A change to
 * the gateway's surface shows up as a change to the snapshot, in review.
 */
test("the web-reachable verbs and who may call them", () => {
  const lines: string[] = [];
  for (const addon of Object.keys(ADDON_VERBS).sort()) {
    for (const verb of Object.keys(ADDON_VERBS[addon as keyof typeof ADDON_VERBS]).sort()) {
      const declared = webVerb(addon, verb);
      if (!declared) continue;
      const stream = declared.stream === "duplex" ? " duplex" : declared.stream ? " stream" : "";
      lines.push(`${`${addon}:${verb}`.padEnd(34)} ${declared.web}${stream}`);
    }
  }
  expect(lines.join("\n")).toMatchSnapshot();
});

test("the routes that do not need an administrator", () => {
  const names = Object.keys(ADDONS).sort();
  const lines = [
    ...names.flatMap((name) => ADDONS[name]!.preGate ? [`before the gate: ${ADDONS[name]!.preGate!.prefix}`] : []),
    ...names.filter((name) => ADDONS[name]!.siteManager).map((name) => `site managers: /${name}/`),
    ...names.flatMap((name) => (ADDONS[name]!.selfScopedRoutes ?? []).map((route) => {
      const [method, path] = route.split(" ");
      return `any panel user: ${method} /${name}${path}`;
    })).sort(),
  ];
  expect(lines.join("\n")).toMatchSnapshot();
});
