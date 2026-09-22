// The site-user and database-name schemes are shared by the manager and both
// privileged actions. Keeping these on the exported helpers prevents the
// callers from silently drifting apart.
import { expect, test } from "bun:test";
import { dbNameFor, dbUserFor, siteUserFor } from "../cli/action-common";

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
