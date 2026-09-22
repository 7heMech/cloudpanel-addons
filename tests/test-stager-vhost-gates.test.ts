// What a clone's vhost is allowed to say. The dangerous outcome all three
// gates exist to prevent is one shape: a clone that answers for the site it
// was cloned from, where two nginx server blocks claim one server_name and the
// other one is production.
//
// nginx -t does not catch that -- a duplicate server_name is a warning and
// exits 0 -- and sites-enabled/*.conf glob order decides which block wins, so
// a staging name that sorts first takes production's traffic.
import { describe, expect, test } from "bun:test";
import { validateVhostBody, validateVhostTemplateBody, vhostShape } from "../addons/stager/action";

describe("the comparison that decides whether a vhost was hand edited", () => {
  // site.vhost_template keeps CloudPanel's placeholders and only the hostnames
  // are concrete, so two things in it are generated rather than chosen: the
  // http->https redirect block, prepended only for an apex or www hostname,
  // and the shape of the server_name line, which differs between the two.
  // Cloning example.com into stg.example.com therefore differs in both, and
  // reporting that as a hand edit would fire the note on every ordinary clone.
  const REDIRECT = [
    "server {",
    "  listen 443 ssl;",
    "  {{ssl_certificate}}",
    "  server_name www.example.com;",
    "  return 301 https://example.com$request_uri;",
    "}",
    "",
  ].join("\n");

  const MAIN = (nameLine: string, extra = "") => [
    "server {",
    "  listen 443 ssl;",
    `  ${nameLine}`,
    "  {{root}}",
    ...(extra ? [`  ${extra}`] : []),
    "  location / {",
    "    {{php_fpm_port}}",
    "  }",
    "}",
  ].join("\n");

  const apex = () => vhostShape(REDIRECT + MAIN("server_name example.com www1.example.com;"), "example.com");
  const sub = () => vhostShape(MAIN("server_name stg.example.com;"), "stg.example.com");

  test("an apex site and a subdomain clone have the same shape", () => {
    expect(apex()).toBe(sub());
  });

  test("an added directive still reads as an edit", () => {
    const edited = vhostShape(
      REDIRECT + MAIN("server_name example.com www1.example.com;", 'add_header X-Frame-Options "SAMEORIGIN";'),
      "example.com");
    expect(edited).not.toBe(apex());
  });

  test("a hand-widened server_name still reads as an edit", () => {
    expect(vhostShape(MAIN("server_name stg.example.com *.stg.example.com;"), "stg.example.com")).not.toBe(sub());
  });

  test("the redirect block is dropped, not the whole first block", () => {
    expect(apex()).toInclude("{{root}}");
    expect(apex()).toInclude("{{php_fpm_port}}");
    expect(apex()).not.toInclude("return 301");
  });
});

// CloudPanel's own validator refuses a template with no {{server_name}}, which
// covers part of it; these are the checks it does not make, run before it is
// asked.
describe("the template gate", () => {
  function gate(body: string): string {
    const result = validateVhostTemplateBody(body, "example.com", "stg.example.com");
    return result.ok ? "PASS" : `REJECT: ${result.reason}`;
  }

  const block = (...lines: string[]) => ["server {", ...lines.map((line) => `  ${line}`), "}"].join("\n");

  for (const [label, body] of [
    ["a template naming only the placeholder", block("{{server_name}}", "{{root}}")],
    ["a wildcard under the target", block("{{server_name}}", "server_name *.stg.example.com;")],
    ["a subdomain of the target", block("{{server_name}}", "server_name a.stg.example.com;")],
  ] as const) {
    test(`accepted: ${label}`, () => {
      expect(gate(body)).toBe("PASS");
    });
  }

  for (const [label, body] of [
    ["the source hostname surviving anywhere", block("{{server_name}}", "# see https://example.com/docs")],
    ["a template with no {{server_name}} the panel would refuse anyway",
      block("server_name stg.example.com *.stg.example.com;")],
    // The maksimasenov.com shape: the hand edit is the server_name line itself.
    ["a server_name outside the target", block("{{server_name}}", "server_name other.test;")],
    // stg.example.com is a subdomain of example.com, so a naive "endsWith the
    // source" test would pass this. It must be judged against the target.
    ["a sibling under the source's domain", block("{{server_name}}", "server_name evil.example.com;")],
  ] as const) {
    test(`refused: ${label}`, () => {
      expect(gate(body)).toStartWith("REJECT");
    });
  }
});

// vhost_body_ok is the template gate without the {{server_name}} requirement,
// which exists only because clpctl's vhost-template:add demands the
// placeholder. The fallback does not go through that verb, so it can carry a
// source whose server_name line is itself the hand edit.
describe("the fallback body gate", () => {
  function gate(body: string): string {
    const result = validateVhostBody(body, "example.com", "stg.example.com");
    return result.ok ? "PASS" : `REJECT: ${result.reason}`;
  }

  test("a hand-edited server_name naming the target is accepted, placeholder or not", () => {
    expect(gate("server {\n  server_name stg.example.com *.stg.example.com;\n  {{root}}\n}")).toBe("PASS");
    expect(gate("server {\n  server_name stg.example.com;\n}")).toBe("PASS");
  });

  test("a server_name outside the target is still refused", () => {
    expect(gate("server {\n  server_name other.test;\n}")).toStartWith("REJECT");
    expect(gate("server {\n  server_name evil.example.com;\n}")).toStartWith("REJECT");
  });

  test("the source hostname surviving anywhere is refused", () => {
    expect(gate("server {\n  server_name stg.example.com;\n  # see https://example.com/docs\n}"))
      .toStartWith("REJECT");
  });

  // Every one of these was ACCEPTED before the gate stopped selecting lines
  // with `grep -E '^[[:space:]]*server_name '`, which demands a literal space
  // at a line start and compares case-sensitively. Driven end to end through
  // the real compose for renaissance.bg -> stg.renaissance.bg, the first two
  // gave a clone that claims the production apex and every subdomain of it.
  const HOSTILE: [string, string][] = [
    ["a tab instead of a space, in upper case",
      "server {\n  server_name\tEXAMPLE.COM;\n  {{root}}\n}"],
    ["a tab and a wildcard over the source",
      "server {\n  server_name\t*.example.com;\n  {{root}}\n}"],
    ["a wildcard over the source, spaced normally",
      "server {\n  server_name *.example.com;\n  {{root}}\n}"],
    ["a list whose second line is hostile",
      "server {\n  server_name stg.example.com\n                victim-production.test;\n  {{root}}\n}"],
    ["a value on its own line",
      "server {\n  server_name\n    victim-production.test;\n  {{root}}\n}"],
    ["sharing a line with another directive",
      "server {\n  listen 8443; server_name victim-production.test;\n  {{root}}\n}"],
    ["several spaces before the value",
      "server {\n  server_name    victim-production.test;\n  {{root}}\n}"],
    ["a catch-all default server",
      "server {\n  server_name _;\n  {{root}}\n}"],
    ["a regular expression server_name",
      "server {\n  server_name ~^.+$;\n  {{root}}\n}"],
    ["the target in upper case beside a hostile name",
      "server {\n  server_name STG.EXAMPLE.COM VICTIM-PRODUCTION.TEST;\n  {{root}}\n}"],
    ["a second server block further down the file",
      "server {\n  server_name stg.example.com;\n  {{root}}\n}\n\nserver {\n  server_name victim-production.test;\n}"],
    // These five defeated the replacement gate too, until the host reader
    // stopped stripping comments by regex. nginx begins a comment only where #
    // begins a token, so a # inside a quoted value is an ordinary character --
    // reading it as a comment deleted the rest of a line nginx still executes.
    // Verified against nginx 1.30.4: the first of them hijacked the hidden name.
    ["a # inside a quoted value hiding a server_name",
      "server {\n  add_header X-M \" # \" ; server_name victim-production.test;\n  {{root}}\n}"],
    ["a tab-wrapped # inside a quoted value",
      "server {\n  add_header X-M \"\t#\t\" ; server_name victim-production.test;\n  {{root}}\n}"],
    ["a quoted # hiding a wildcard over the source",
      "server {\n  add_header X-M \" # \" ; server_name *.example.com;\n  {{root}}\n}"],
    ["a quoted value spanning lines with # at a line start",
      "server {\n  add_header X-A \"\n# \";  server_name victim-production.test;\n  {{root}}\n}"],
    ["a quoted value that is never closed",
      "server {\n  add_header X \"oops ; server_name victim-production.test;\n  {{root}}\n}"],
  ];

  for (const [label, body] of HOSTILE) {
    test(`refused: ${label}`, () => {
      expect(gate(body), JSON.stringify(body)).toStartWith("REJECT");
    });
  }

  // And the shapes that must still pass, because a gate that refuses
  // everything is a gate that has stopped being one. DNS is case-insensitive,
  // so the clone's own name in upper case is the clone's own name.
  const BENIGN: [string, string][] = [
    ["a tab before the clone's own name", "server {\n  server_name\tstg.example.com;\n  {{root}}\n}"],
    ["the clone's own name in upper case", "server {\n  server_name STG.EXAMPLE.COM;\n  {{root}}\n}"],
    ["a wildcard under the clone", "server {\n  server_name stg.example.com *.stg.example.com;\n  {{root}}\n}"],
    ["a value spanning two lines, both below the clone",
      "server {\n  server_name stg.example.com\n                a.stg.example.com;\n  {{root}}\n}"],
    ["sharing a line with another directive", "server {\n  listen 8443; server_name stg.example.com;\n  {{root}}\n}"],
    ["the {{server_name}} placeholder itself", "server {\n  {{server_name}}\n  {{root}}\n}"],
    ["a commented-out server_name nginx would not act on",
      "server {\n  server_name stg.example.com;\n  # server_name victim-production.test;\n  {{root}}\n}"],
    // The other half of the same rule: refusing every # would make the gate
    // useless on real configs, where a # inside a header value is ordinary.
    ["a # inside a header value is not a comment",
      "server {\n  server_name stg.example.com;\n  add_header X-M \" # \";\n  {{root}}\n}"],
    ["single quotes inside a double-quoted CSP",
      "server {\n  server_name stg.example.com;\n  add_header Content-Security-Policy \"default-src 'self'\";\n  {{root}}\n}"],
  ];

  for (const [label, body] of BENIGN) {
    test(`accepted: ${label}`, () => {
      expect(gate(body), JSON.stringify(body)).toBe("PASS");
    });
  }
});
