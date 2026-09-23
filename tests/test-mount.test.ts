// One CloudPanel site serves every addon, so the path is the only thing that
// says which one a request is for. The case worth guarding is a prefix that is
// not a whole segment: a bare startsWith() sends /instatic-notes to instatic and
// hands it a sub-path of "-notes", which is a 404 from somewhere unexpected
// rather than from the router.
import { describe, expect, test } from "bun:test";
import { mountPath, splitMount } from "../lib/mount";
import { ADDON_NAMES } from "../cli/addon-catalog";

const ALL = ["cloudflare-ips", "instatic", "stager", "maintenance", "php-resources", "git", "panel-tweaks", "wp-login", "smtp"];

function hit(path: string): string {
  const match = splitMount(path, ALL);
  return match ? `${match.addon}:${match.rest}` : "none";
}

describe("a path that names an addon", () => {
  test("a bare mount is that addon's root", () => {
    expect(hit("/instatic")).toBe("instatic:/");
  });

  test("a trailing slash is still its root", () => {
    expect(hit("/instatic/")).toBe("instatic:/");
  });

  test("a sub-path keeps its leading slash", () => {
    expect(hit("/instatic/api/instances")).toBe("instatic:/api/instances");
    expect(hit("/stager/jobs/abc")).toBe("stager:/jobs/abc");
    expect(hit("/cloudflare-ips/api/sites")).toBe("cloudflare-ips:/api/sites");
    expect(hit("/stager/new")).toBe("stager:/new");
  });
});

describe("a path that does not", () => {
  test("the site root belongs to no addon", () => {
    expect(hit("/")).toBe("none");
    expect(hit("/nope")).toBe("none");
  });

  test("a name that merely shares a prefix is not the addon's mount", () => {
    expect(hit("/instatic-notes")).toBe("none");
    expect(hit("/instaticx/api")).toBe("none");
    expect(hit("/my-stager")).toBe("none");
  });
});

// Every registered addon must actually be reachable at the path the CLI
// advertises to the panel, or the injected nav points at a 404.
for (const name of ADDON_NAMES) {
  test(`${name} is reachable at ${mountPath(name)}`, () => {
    expect(hit(`${mountPath(name)}/x`)).toBe(`${name}:/x`);
  });
}
