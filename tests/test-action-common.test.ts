// The site-user and database-name schemes are shared by the manager and both
// privileged actions. Keeping these on the exported helpers prevents the
// callers from silently drifting apart.
import { describe, expect, test } from "bun:test";
import {
  availableSiteUser, dbNameFor, dbUserFor, panelSiteUserFor, siteUserFor,
} from "../cli/action-common";

const DOMAINS = [
  "demo.clp-stg.local",
  "addons.clp-stg.local",
  // Same first ten characters once punctuation is stripped. Under the schemes
  // this replaces, these two produced identical account names.
  "demo.clp-stg.local",
  "demo.clp-stg.example.com",
  "a.io",
  "UPPER.Example.COM",
];

for (const domain of DOMAINS) {
  test(`${domain} yields a valid Linux account name`, () => {
    expect(siteUserFor(domain)).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
  });
}

test("no two distinct domains share a site-user name", () => {
  const seen = new Map<string, string>();
  for (const domain of DOMAINS) {
    const name = siteUserFor(domain);
    const clash = seen.get(name);
    expect(clash === undefined || clash === domain, `${domain} collides with ${clash} as ${name}`).toBe(true);
    seen.set(name, domain);
  }
});

// The staging database and its user are named from the target domain too, and
// they land in MySQL rather than /etc/passwd: 64 characters for a schema, 32
// for a user, and no dots or hyphens, which a domain has plenty of.
for (const domain of DOMAINS) {
  test(`${domain} yields legal MySQL schema and user names`, () => {
    expect(dbNameFor(domain)).toMatch(/^[a-z][a-z0-9]{0,63}$/);
    expect(dbUserFor(domain)).toMatch(/^[a-z][a-z0-9]{0,31}$/);
  });
}

test("no two distinct domains share a database name", () => {
  const seen = new Map<string, string>();
  for (const domain of DOMAINS) {
    const name = dbNameFor(domain);
    const clash = seen.get(name);
    expect(clash === undefined || clash === domain.toLowerCase(), `${domain} collides with ${clash} as ${name}`).toBe(true);
    seen.set(name, domain.toLowerCase());
  }
});

// The site user an Instatic instance gets is the one CloudPanel's own New Site
// page would have suggested, because an operator reads it in the panel's site
// list beside sites the panel named itself.
describe("the panel-style site user", () => {
  // Measured, not guessed: these are the names CloudPanel wrote for these two
  // sites on this project's staging box.
  for (const [domain, panelWrote] of [
    ["the.staging.renaissancechurch.com", "renaissancechurch-the-staging"],
    ["there.staging.renaissancechurch.com", "renaissancechurch-there-staging"],
  ] as const) {
    test(`matches what the panel wrote for ${domain}`, () => {
      expect(panelSiteUserFor(domain)).toBe(panelWrote);
    });
  }

  test("an apex domain is just its registrable label", () => {
    expect(panelSiteUserFor("sus.com")).toBe("sus");
    expect(panelSiteUserFor("testing.com")).toBe("testing");
  });

  test("a subdomain follows the registrable label, in the order it is written", () => {
    expect(panelSiteUserFor("demo.example.com")).toBe("example-demo");
    expect(panelSiteUserFor("bdn.wpsite.example.test")).toBe("example-bdn-wpsite");
  });

  test("case and punctuation are normalised away", () => {
    expect(panelSiteUserFor("UPPER.Example.COM")).toBe("example-upper");
    expect(panelSiteUserFor("example.com.")).toBe("example");
  });

  // useradd wants a name that starts with a letter and fits in 32 characters,
  // and a domain owes neither.
  for (const domain of [
    "1st.example.com",
    "a.io",
    "a-very-long-subdomain.another-long-part.averylongregistrabledomain.com",
  ]) {
    test(`${domain} still yields a usable account name`, () => {
      expect(panelSiteUserFor(domain)).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
    });
  }
});

// CloudPanel refuses a second site on one site user -- "siteUser: This value
// already exists" -- and two domains that differ only in their TLD ask for the
// same name, so the create path has to be handed one that is free.
describe("picking a free site user", () => {
  test("uses the panel-style name when nothing holds it", () => {
    expect(availableSiteUser("example.com", () => false)).toBe("example");
  });

  test("numbers the next one when the name is taken", () => {
    expect(availableSiteUser("example.com", (user) => user === "example")).toBe("example-2");
    expect(availableSiteUser("example.com", (user) => ["example", "example-2"].includes(user)))
      .toBe("example-3");
  });

  test("a numbered name still fits an account name", () => {
    const long = "a-very-long-subdomain.another-long-part.averylongregistrabledomain.com";
    const taken = new Set([panelSiteUserFor(long)]);
    const picked = availableSiteUser(long, (user) => taken.has(user));
    expect(picked).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
    expect(taken.has(picked)).toBe(false);
  });

  test("it gives up rather than looping when everything is taken", () => {
    expect(() => availableSiteUser("example.com", () => true)).toThrow(/could not find a free site user/);
  });
});
