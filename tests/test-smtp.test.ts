import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closedRelay, executeSmtpAction, type SmtpActionOptions, type SmtpSiteRow, type SmtpState, type SmtpTestResult } from "../addons/smtp/action";
import { envelopeGrants, siteName, submissionRule, type SmtpRewriteRule } from "../addons/smtp/config";
import { MAX_MESSAGE_BYTES, prepareSubmission, readBoundedSubmission, runSmtpSubmit } from "../addons/smtp/submit";
import { dashboardContent } from "../addons/smtp/app/views";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "clp-smtp-"));
  dirs.push(dir);
  return dir;
}

const rule = (sender: string, allowed = ["example.com"], site = "example.com"): SmtpRewriteRule =>
  ({ version: 1, site, sender, allowed });
function submit(r: SmtpRewriteRule, headers: string): { sender: string; text: string } {
  const result = prepareSubmission(Buffer.from(`To: user@recipient.test\n${headers}\n\nHi`), r);
  return { sender: result.sender, text: Buffer.from(result.message).toString("utf8") };
}

test("a fixed From keeps the display name and the original address as Reply-To", () => {
  const fixed = rule("noreply@{site}");
  const wordpress = submit(fixed, "From: WordPress <wordpress@example.com>");
  expect(wordpress.sender).toBe("noreply@example.com");
  expect(wordpress.text).toContain("From: WordPress <noreply@example.com>\nReply-To: WordPress <wordpress@example.com>\n");
  const shop = submit(fixed, "From: My Shop <orders@example.com>");
  expect(shop.text).toContain("Reply-To: My Shop <orders@example.com>");
  const visitor = submit(fixed, "From: Jane Visitor <jane@gmail.com>");
  expect(visitor.text).toContain("From: Jane Visitor <noreply@example.com>\nReply-To: Jane Visitor <jane@gmail.com>\n");
  expect(submit(fixed, "From: noreply@example.com").text).not.toContain("Reply-To");
  expect(submit(fixed, "From: a@cool.com\nReply-To: desk@cool.com").text.match(/Reply-To/g)).toHaveLength(1);
  const crlf = prepareSubmission(Buffer.from("To: u@r.test\r\nFrom: Visitor <visitor@cool.com>\r\nReturn-Path: forged@cool.com\r\n\r\nHello"), fixed);
  const output = Buffer.from(crlf.message).toString("utf8");
  expect(output).toContain("From: Visitor <noreply@example.com>\r\nReply-To: Visitor <visitor@cool.com>\r\n");
  expect(output).not.toContain("forged@cool.com");
  expect(output.endsWith("\r\n\r\nHello")).toBe(true);
});

test("{from.local} and {from.domain} keep only the site's own and granted domains", () => {
  const local = rule("{from.local}@{site}");
  expect(submit(local, "From: WordPress <wordpress@example.com>").text).toContain("From: WordPress <wordpress@example.com>\nTo:");
  expect(submit(local, "From: Jane <jane@cool.com>").sender).toBe("noreply@example.com");
  expect(submit(local, "Subject: none").sender).toBe("noreply@example.com");
  const domain = rule("{from.local}@{from.domain}", ["example.com", "news.example.com"]);
  expect(submit(domain, "From: edition@news.example.com").sender).toBe("edition@news.example.com");
  expect(submit(domain, "From: noreply@othersite.test").text).toContain("Reply-To: noreply@othersite.test");
  expect(() => submit(domain, "From: a@example.com\nFrom: b@example.com")).toThrow("multiple From");
  const folded = submit(domain, "From: Example\n <wordpress@example.com>\nSender: forged@cool.com\n x: bogus");
  expect(folded.sender).toBe("wordpress@example.com");
  expect(folded.text).not.toContain("forged@cool.com");
});

test("a www. site sends as its bare domain, as WordPress does", () => {
  expect(siteName("www.example.com", new Set(["www.example.com"]))).toBe("example.com");
  expect(siteName("www.example.com", new Set(["www.example.com", "example.com"]))).toBe("www.example.com");
  expect(siteName("www.com", new Set())).toBe("www.com");
  const www = submissionRule("www.example.com", "example.com", "{from.local}@{from.domain}", []);
  expect(www.allowed).toEqual(["example.com", "www.example.com"]);
  const wordpress = submit(www, "From: WordPress <wordpress@example.com>");
  expect(wordpress.sender).toBe("wordpress@example.com");
  expect(wordpress.text).not.toContain("Reply-To");
  expect(submit({ ...www, sender: "noreply@{site}" }, "Subject: x").sender).toBe("noreply@example.com");
});

test("an address that cannot be used still keeps its display name; an apostrophe is fine", () => {
  const fixed = rule("noreply@{site}");
  const irish = submit(fixed, "From: Pat <o'brien@gmail.com>");
  expect(irish.text).toContain("From: Pat <noreply@example.com>\nReply-To: Pat <o'brien@gmail.com>\n");
  const odd = submit(fixed, "From: Shop <shop@exa_mple.com>");
  expect(odd.text).toContain("From: Shop <noreply@example.com>\n");
  expect(odd.text).not.toContain("Reply-To");
  expect(submit(fixed, "From: wordpress@example.com (WordPress)").text).not.toContain("(WordPress)");
});

test("headers pass through byte for byte, whatever charset the app wrote them in", () => {
  const latin1 = Buffer.from("To: u@r.test\nSubject: Caf\xe9\nFrom: Jos\xe9 <j@gmail.com>\n\nbody", "latin1");
  const output = Buffer.from(prepareSubmission(latin1, rule("noreply@{site}")).message);
  expect(output.toString("latin1")).toBe("From: Jos\xe9 <noreply@example.com>\nReply-To: Jos\xe9 <j@gmail.com>\nTo: u@r.test\nSubject: Caf\xe9\n\nbody");
  expect(submit(rule("noreply@{site}"), "From: José <j@gmail.com>").text).toContain("From: José <noreply@example.com>\n");
});

test("envelope grants cover the site's domains and whatever its template can produce", () => {
  expect(envelopeGrants(rule("noreply@{site}"))).toEqual(["@example.com", "noreply@example.com"]);
  expect(envelopeGrants(rule("{from.local}@{from.domain}", ["example.com", "news.example.com"])))
    .toEqual(["@example.com", "@news.example.com"]);
  expect(envelopeGrants(rule("alerts@agency.example"))).toEqual(["@example.com", "alerts@agency.example"]);
  expect(envelopeGrants(rule("{from.local}@agency.example"))).toEqual(["@example.com", "@agency.example"]);
});

test("stdin accepts exactly 25 MiB and cancels at the first byte over the limit", async () => {
  const atLimit = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_MESSAGE_BYTES)); controller.close(); } });
  expect((await readBoundedSubmission(atLimit)).byteLength).toBe(MAX_MESSAGE_BYTES);
  let pulls = 0;
  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(pulls === 1 ? MAX_MESSAGE_BYTES : 1));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  await expect(readBoundedSubmission(oversized)).rejects.toThrow("25 MiB");
  expect(pulls).toBe(2);
  expect(cancelled).toBe(true);
});

test("the wrapper hands mail to sendmail unchanged whenever it has no rule to apply", async () => {
  const dir = scratch();
  const fake = join(dir, "sendmail");
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\ncat > "${dir}/stdin"\n`);
  chmodSync(fake, 0o755);
  const ruleDir = join(dir, "rules");
  mkdirSync(ruleDir);
  const uid = 4321;
  const message = Buffer.from("To: a@b.test\nFrom: Me <me@gmail.com>\n\nbody");
  const options = { ruleDir, rootUid: process.getuid!(), sendmailPath: fake, uid, input: message };
  const sent = () => ({ args: readFileSync(join(dir, "args"), "utf8").trim().split("\n"), stdin: readFileSync(join(dir, "stdin"), "utf8") });

  expect(await runSmtpSubmit(["-t", "-i", "-fme@gmail.com"], options)).toBe(0);
  expect(sent()).toEqual({ args: ["-t", "-i", "-fme@gmail.com"], stdin: message.toString() });

  const path = join(ruleDir, `${uid}.json`);
  writeFileSync(path, JSON.stringify(rule("noreply@{site}")));
  chmodSync(path, 0o660);
  await runSmtpSubmit(["-t", "-i"], options);
  expect(sent().stdin).toBe(message.toString());

  chmodSync(path, 0o640);
  expect(await runSmtpSubmit(["-t", "-i", "-f", "me@gmail.com"], options)).toBe(0);
  expect(sent().args).toEqual(["-t", "-i", "-f", "noreply@example.com"]);
  expect(sent().stdin).toContain("From: Me <noreply@example.com>\nReply-To: Me <me@gmail.com>\n");

  await runSmtpSubmit(["-bs"], options);
  expect(sent().args).toEqual(["-bs"]);

  // A site in no profile keeps its message, and loses only an envelope sender outside its own domains.
  writeFileSync(path, JSON.stringify({ ...rule("noreply@{site}"), sender: null }));
  await runSmtpSubmit(["-t", "-i", "-fme@gmail.com"], options);
  expect(sent()).toEqual({ args: ["-t", "-i"], stdin: message.toString() });
  await runSmtpSubmit(["-t", "-i", "-f", "Orders@Example.com"], options);
  expect(sent().args).toEqual(["-t", "-i", "-f", "Orders@Example.com"]);
  writeFileSync(path, JSON.stringify(rule("noreply@{site}")));
  const twoFroms = Buffer.from("To: a@b.test\nFrom: a@example.com\nFrom: b@example.com\n\nbody");
  await runSmtpSubmit(["-t", "-i"], { ...options, input: twoFroms });
  expect(sent()).toEqual({ args: ["-t", "-i"], stdin: twoFroms.toString() });
  writeFileSync(path, JSON.stringify({ ...rule("noreply@{site}"), sender: null }));
  await runSmtpSubmit(["-t", "-i", "-f", ""], options);
  expect(sent().args).toEqual(["-t", "-i"]);
  expect(await runSmtpSubmit(["-t", "-i"], { ...options, sendmailPath: join(dir, "missing") })).toBe(1);
});

test("relay restrictions lose only permit_mynetworks", () => {
  expect(closedRelay(null)).toBe("permit_sasl_authenticated, defer_unauth_destination");
  expect(closedRelay("permit_mynetworks permit_sasl_authenticated defer_unauth_destination")).toBe("permit_sasl_authenticated defer_unauth_destination");
  expect(closedRelay("permit_mynetworks, check_policy_service { inet:127.0.0.1:10023, timeout=10s }, reject_unauth_destination"))
    .toBe("check_policy_service { inet:127.0.0.1:10023, timeout=10s }, reject_unauth_destination");
  expect(closedRelay("permit_mynetworks")).toBe("permit_sasl_authenticated, defer_unauth_destination");
});

interface Box { options: SmtpActionOptions; settings: Map<string, string>; commands: string[]; dir: string; postfixDir: string; phpRoot: string; ruleDir: string; fpmBinDir: string; sendmailLink: string }

function box(sites: SmtpSiteRow[]): Box {
  const dir = scratch();
  const postfixDir = join(dir, "postfix");
  const phpRoot = join(dir, "php");
  const ruleDir = join(dir, "rules");
  const fpmBinDir = join(dir, "sbin");
  const sendmailLink = join(dir, "bin", "sendmail");
  mkdirSync(postfixDir);
  mkdirSync(join(dir, "bin"));
  // 7.4's PHP-FPM was removed and its conf.d left behind.
  for (const path of ["8.2/fpm/conf.d", "8.2/cli/conf.d", "8.3/cli/conf.d", "7.4/fpm/conf.d"]) mkdirSync(join(phpRoot, path), { recursive: true });
  mkdirSync(fpmBinDir);
  writeFileSync(join(fpmBinDir, "php-fpm8.2"), "");
  const settings = new Map<string, string>([
    ["mynetworks", "127.0.0.0/8"],
    ["smtp_tls_policy_maps", "hash:/etc/postfix/operator-tls"],
  ]);
  const commands: string[] = [];
  const run: NonNullable<SmtpActionOptions["run"]> = (command, args) => {
    commands.push(`${command} ${args.join(" ")}`);
    if (command === "postconf" && args[0] === "-d") return { ok: true, stdout: "local_login_sender_maps = static:*", stderr: "" };
    if (command === "postconf" && args[0] === "-xh") return { ok: true, stdout: "cp-stg", stderr: "" };
    if (command === "postconf" && args[0] === "-n") {
      return { ok: true, stdout: [...settings].map(([key, value]) => `${key} = ${value}`).join("\n"), stderr: "" };
    }
    if (command === "postconf" && args[0] === "-e") {
      const text = args[1]!;
      const equal = text.indexOf("=");
      settings.set(text.slice(0, equal), text.slice(equal + 1));
    }
    if (command === "postconf" && args[0] === "-X") settings.delete(args[1]!);
    if (command === "postmap") writeFileSync(`${args[0]!.slice(5)}.db`, "indexed");
    return { ok: true, stdout: "", stderr: "" };
  };
  const options: SmtpActionOptions = {
    processUid: 0,
    paths: {
      phpRoot, fpmBinDir, postfixDir, ruleDir, sendmailLink,
      stateFile: join(dir, "state.json"), originalFile: join(dir, "original.json"), lockFile: join(dir, "lock", "smtp.lock"),
      runuser: "/bin/true", rootUid: process.getuid!(),
    },
    sites,
    run,
  };
  return { options, settings, commands, dir, postfixDir, phpRoot, ruleDir, fpmBinDir, sendmailLink };
}

const gid = process.getgid!();
const SITES: SmtpSiteRow[] = [
  { id: 1, domain: "www.example.com", user: "example", uid: 2001, gid, type: "php", phpVersion: "8.2" },
  { id: 2, domain: "shop.test", user: "shop", uid: 2002, gid, type: "php", phpVersion: "8.3" },
  { id: 3, domain: "app.test", user: "app", uid: 2003, gid, type: "nodejs", phpVersion: null },
];
const POSTMARK = { name: "Postmark", relay: { host: "smtp.postmarkapp.com", port: 587, username: "token", password: "pa$1ss" }, sender: "{from.local}@{site}" };

async function act(b: Box, verb: string, body?: unknown): Promise<unknown> {
  return executeSmtpAction([verb], { ...b.options, input: body === undefined ? undefined : JSON.stringify(body) });
}
const file = (b: Box, name: string) => readFileSync(join(b.postfixDir, `clp-addons-${name}`), "utf8");

test("routing a site binds every login, relays by sender, closes loopback, and installs the PHP hook", async () => {
  const b = box(SITES);
  await expect(act(b, "save-profile", { ...POSTMARK, sender: "{nope}@x" })).rejects.toThrow("From may use only");
  await expect(act(b, "save-profile", { ...POSTMARK, relay: { ...POSTMARK.relay, port: 465 } })).rejects.toThrow("465");
  expect(existsSync(join(b.dir, "lock", "smtp.lock"))).toBe(false);
  const seeded = await act(b, "list") as SmtpState;
  expect(seeded.profiles.map((profile) => profile.name)).toEqual(["Don't send"]);

  await act(b, "save-profile", POSTMARK);
  expect(b.commands.filter((command) => command.startsWith("postconf -e"))).toEqual([]);
  const state = await act(b, "assign", { domains: ["www.example.com", "app.test"], profileId: "postmark" }) as SmtpState;
  expect(state.sites.find((site) => site.domain === "www.example.com")!.sender).toBe("{from.local}@example.com");

  expect(b.settings.get("smtpd_relay_restrictions")).toBe("permit_sasl_authenticated, defer_unauth_destination");
  expect(b.settings.get("local_login_sender_maps")).toBe(`hash:${join(b.postfixDir, "clp-addons-local-senders")}, regexp:${join(b.postfixDir, "clp-addons-login-fallback")}`);
  expect(b.settings.get("smtp_tls_policy_maps")).toBe(`regexp:${join(b.postfixDir, "clp-addons-tls-policy")}, hash:/etc/postfix/operator-tls`);
  expect(b.settings.has("relayhost")).toBe(false);
  expect(file(b, "transports")).toBe(
    "/@app\\.test$/ smtp:[smtp.postmarkapp.com]:587\n/@example\\.com$/ smtp:[smtp.postmarkapp.com]:587\n/@www\\.example\\.com$/ smtp:[smtp.postmarkapp.com]:587\n");
  expect(file(b, "sasl")).toContain("/@example\\.com$/ token:pa$$1ss\n");
  expect(statSync(join(b.postfixDir, "clp-addons-sasl")).mode & 0o777).toBe(0o600);
  expect(file(b, "tls-policy")).toBe("/^\\[smtp\\.postmarkapp\\.com\\]:587$/ secure match=nexthop\n");
  expect(file(b, "canonical")).toBe("example@cp-stg noreply@example.com\napp@cp-stg noreply@app.test\n");
  expect(file(b, "local-senders")).toBe("root *\npostfix *\nclp *\nexample example @example.com @www.example.com\n" +
    "shop shop @shop.test noreply@shop.test\napp app @app.test\n");
  expect(file(b, "login-fallback")).toBe("/^(.+)$/ $1\n");

  for (const sapi of ["8.2/fpm", "8.2/cli", "8.3/cli"]) {
    expect(readFileSync(join(b.phpRoot, sapi, "conf.d", "99-clp-addons-smtp.ini"), "utf8")).toContain("sendmail_path = /usr/local/bin/clp-addons smtp-submit -t -i");
  }
  expect(b.commands).toContain(`${b.fpmBinDir}/php-fpm8.2 -t`);
  expect(b.commands).toContain("systemctl try-reload-or-restart php8.2-fpm");
  expect(b.commands.some((command) => command.includes("php8.3-fpm") || command.includes("php7.4-fpm"))).toBe(false);
  expect(readdirSync(join(b.phpRoot, "7.4/fpm/conf.d"))).toEqual([]);
  expect(readdirSync(b.ruleDir).sort()).toEqual(["2001.json", "2002.json"]);
  expect(statSync(join(b.ruleDir, "2001.json")).mode & 0o777).toBe(0o640);
  expect(JSON.parse(readFileSync(join(b.ruleDir, "2001.json"), "utf8")))
    .toEqual({ version: 1, site: "example.com", sender: "{from.local}@{site}", allowed: ["example.com", "www.example.com"] });
  // shop.test is in no profile, so it keeps its From and only an envelope sender Postfix would refuse is dropped.
  expect(JSON.parse(readFileSync(join(b.ruleDir, "2002.json"), "utf8"))).toEqual({ version: 1, site: "shop.test", sender: null, allowed: ["shop.test"] });
  expect(readlinkSync(b.sendmailLink)).toBe("/usr/sbin/sendmail");

  const html = dashboardContent(await act(b, "list") as SmtpState);
  expect(html).not.toContain("pa$1ss");
  expect(html).toContain("Node.js");
  expect(html).toContain('<option value="-">Not relayed</option>');

  // A settled box reads Postfix once and writes nothing; the new-site watcher does not even read it.
  b.commands.length = 0;
  expect(await act(b, "reconcile")).toEqual({ repaired: 0, joined: 0 });
  expect(b.commands).toEqual(["postconf -n", "postconf -xh myorigin"]);
  b.commands.length = 0;
  await act(b, "sync-sites");
  expect(b.commands).toEqual([]);
  rmSync(b.sendmailLink);
  expect(await act(b, "reconcile")).toEqual({ repaired: 1, joined: 0 });
  expect(readlinkSync(b.sendmailLink)).toBe("/usr/sbin/sendmail");

  // Drift in Postfix and in the rule files counts too, and a umask cannot leave the rules unreachable.
  b.settings.delete("smtpd_relay_restrictions");
  rmSync(join(b.postfixDir, "clp-addons-transports"));
  chmodSync(b.ruleDir, 0o750);
  rmSync(join(b.ruleDir, "2002.json"));
  expect(await act(b, "reconcile")).toEqual({ repaired: 4, joined: 0 });
  expect(statSync(b.ruleDir).mode & 0o777).toBe(0o755);
  expect(b.settings.get("smtpd_relay_restrictions")).toBe("permit_sasl_authenticated, defer_unauth_destination");
});

test("a saved password goes only to the server and account it was saved for", async () => {
  const b = box(SITES);
  await act(b, "save-profile", POSTMARK);
  await act(b, "assign", { domains: ["shop.test"], profileId: "postmark" });
  const edit = (relay: Partial<typeof POSTMARK.relay>) => act(b, "save-profile", { ...POSTMARK, id: "postmark", relay: { ...POSTMARK.relay, password: "", ...relay } });
  await edit({ port: 2525 });
  expect(file(b, "sasl")).toContain(" token:pa$$1ss\n");
  await expect(edit({ host: "smtp.other.test" })).rejects.toThrow("enter the password again");
  await expect(edit({ username: "someone" })).rejects.toThrow("enter the password again");
  await edit({ host: "smtp.other.test", password: "fresh" });
  expect(file(b, "sasl")).toContain(" token:fresh\n");
});

test("a site or domain too long for an email address is left out instead of breaking every site", async () => {
  // Three 62-letter labels, then one that brings the name to `length`.
  const hostname = (length: number) => `${"a".repeat(62)}.`.repeat(3) + "b".repeat(length - 194) + ".test";
  const unmailable: SmtpSiteRow = { id: 8, domain: hostname(248), user: "long", uid: 2008, gid, type: "php", phpVersion: "8.2" };
  const tight: SmtpSiteRow = { id: 9, domain: hostname(240), user: "tight", uid: 2009, gid, type: "php", phpVersion: "8.2" };
  const b = box([...SITES, unmailable, tight]);
  await act(b, "save-profile", POSTMARK);
  const state = await act(b, "assign", { domains: ["shop.test", tight.domain], profileId: "postmark" }) as SmtpState;
  expect(state.skipped).toEqual([{ domain: unmailable.domain, reason: "its domain is not one mail can use" }]);
  await expect(act(b, "save-grants", { domain: "shop.test", domains: [unmailable.domain] })).rejects.toThrow("too long for an email address");

  // A From the profile cannot form for a site is refused on assigning, and a new site it cannot form one for stays out.
  await act(b, "save-profile", { name: "Agency", relay: { host: "smtp.gmail.com", port: 587, username: "a", password: "x" }, sender: "{site}@agency.example" });
  await expect(act(b, "assign", { domains: [tight.domain], profileId: "agency" })).rejects.toThrow("its From would be too long");
  await act(b, "set-default", { profileId: "agency" });
  const late: SmtpSiteRow = { ...tight, id: 10, domain: hostname(241), user: "late", uid: 2010 };
  b.options.sites = [...SITES, unmailable, tight, late];
  expect(await act(b, "reconcile")).toEqual({ repaired: 0, joined: 0 });
  expect((await act(b, "list") as SmtpState).sites.find((site) => site.domain === late.domain)!.profileId).toBeNull();
});

test("a site can never use a sending domain that routes through another profile", async () => {
  const b = box(SITES);
  await act(b, "save-profile", POSTMARK);
  await act(b, "save-profile", { name: "Agency", relay: { host: "smtp.gmail.com", port: 587, username: "alerts@agency.example", password: "x" }, sender: "alerts@agency.example" });
  await act(b, "assign", { domains: ["www.example.com"], profileId: "postmark" });
  await act(b, "assign", { domains: ["shop.test"], profileId: "agency" });
  await expect(act(b, "save-grants", { domain: "shop.test", domains: ["example.com"] }))
    .rejects.toThrow("shop.test can send as example.com, which www.example.com sends through the Postmark profile");
  await expect(act(b, "save-grants", { domain: "app.test", domains: ["shop.test"] })).rejects.toThrow("Agency profile");
  expect((await act(b, "list") as SmtpState).sites.every((site) => site.grants.length === 0)).toBe(true);
  expect(file(b, "transports")).toContain("/^alerts@agency\\.example$/ smtp:[smtp.gmail.com]:587\n");
});

test("a site created onto another profile's domain is blocked, and nothing else stops working", async () => {
  const b = box(SITES.slice(0, 2));
  await act(b, "save-profile", POSTMARK);
  await act(b, "save-profile", { name: "Agency", relay: { host: "smtp.gmail.com", port: 587, username: "alerts@agency.example", password: "x" }, sender: "alerts@agency.example" });
  await act(b, "assign", { domains: ["www.example.com"], profileId: "postmark" });
  await act(b, "save-grants", { domain: "www.example.com", domains: ["news.test"] });
  await act(b, "set-default", { profileId: "agency" });
  const news: SmtpSiteRow = { id: 4, domain: "news.test", user: "news", uid: 2004, gid, type: "php", phpVersion: "8.2" };
  b.options.sites = [...SITES.slice(0, 2), news];

  // It cannot join the default, and in no profile it could still send as news.test through Postmark.
  expect(await act(b, "reconcile")).toEqual({ repaired: 0, joined: 0 });
  const why = "news.test can send as news.test, which www.example.com sends through the Postmark profile";
  expect((await act(b, "list") as SmtpState).sites.find((site) => site.domain === "news.test"))
    .toMatchObject({ profileId: null, sender: null, blocked: "www.example.com sends as news.test through Postmark" });
  const html = dashboardContent(await act(b, "list") as SmtpState);
  expect(html).toContain("Blocked: www.example.com sends as news.test through Postmark");
  expect(html).toContain('<td data-label="Also sends as" class="wide-cell">news.test</td>');
  expect(file(b, "local-senders")).toContain("\nnews news\n");
  expect(JSON.parse(readFileSync(join(b.ruleDir, "2004.json"), "utf8"))).toEqual({ version: 1, site: "news.test", sender: null, allowed: [] });

  await act(b, "assign", { domains: ["shop.test"], profileId: "postmark" });
  // Refused before anything changes, so there is nothing to restore.
  expect(await act(b, "assign", { domains: ["news.test"], profileId: "agency" }).catch((error: Error) => error.message)).toBe(why);
  const state = await act(b, "assign", { domains: ["news.test"], profileId: "postmark" }) as SmtpState;
  expect(state.sites.every((site) => site.blocked === null)).toBe(true);
});

test("a site SMTP cannot bind is listed and left alone instead of stopping the rest", async () => {
  const b = box([...SITES.slice(0, 2),
    { id: 5, domain: "under_score.test", user: "under", uid: 2005, gid, type: "php", phpVersion: "8.2" },
    { id: 6, domain: "twin.test", user: "twin", uid: 2002, gid, type: "static", phpVersion: null },
    { id: 7, domain: "panel.test", user: "clp", uid: 2007, gid, type: "static", phpVersion: null }]);
  await act(b, "save-profile", POSTMARK);
  const state = await act(b, "assign", { domains: ["www.example.com"], profileId: "postmark" }) as SmtpState;
  expect(state.sites.map((site) => site.domain)).toEqual(["www.example.com"]);
  expect(state.skipped).toEqual([
    { domain: "under_score.test", reason: "its domain is not one mail can use" },
    { domain: "panel.test", reason: "its Unix user clp cannot be used" },
    { domain: "shop.test", reason: "it shares Unix UID 2002 with another site" },
    { domain: "twin.test", reason: "it shares Unix UID 2002 with another site" },
  ]);
  expect(file(b, "local-senders")).toBe("root *\npostfix *\nclp *\nexample example @example.com @www.example.com\n");
});

test("a blank password keeps the saved one, and a failed Postfix check changes nothing", async () => {
  const b = box(SITES);
  await act(b, "save-profile", POSTMARK);
  await act(b, "assign", { domains: ["shop.test"], profileId: "postmark" });
  await act(b, "save-profile", { ...POSTMARK, id: "postmark", relay: { ...POSTMARK.relay, password: "" } });
  expect(file(b, "sasl")).toContain("token:pa$$1ss");
  const before = file(b, "sasl");
  const run = b.options.run!;
  let fail = true;
  const failing: NonNullable<SmtpActionOptions["run"]> = (command, args) => {
    if (command === "postfix" && fail) { fail = false; return { ok: false, stdout: "", stderr: "test failure" }; }
    return run(command, args);
  };
  await expect(executeSmtpAction(["save-profile"], { ...b.options, run: failing,
    input: JSON.stringify({ ...POSTMARK, id: "postmark", relay: { ...POSTMARK.relay, password: "other" } }) })).rejects.toThrow("test failure");
  expect(file(b, "sasl")).toBe(before);
  b.settings.set("transport_maps", "hash:/etc/postfix/transport");
  await expect(act(b, "assign", { domains: ["app.test"], profileId: "postmark" })).rejects.toThrow("transport_maps");
});

test("new sites join the default profile, and stopping all routing restores Postfix exactly", async () => {
  const b = box(SITES.slice(0, 1));
  await act(b, "save-profile", POSTMARK);
  await act(b, "set-default", { profileId: "postmark" });
  expect((await act(b, "reconcile") as { joined: number }).joined).toBe(0);
  b.options.sites = SITES;
  expect(await act(b, "reconcile")).toEqual({ repaired: 0, joined: 2 });
  expect((await act(b, "list") as SmtpState).sites.map((site) => site.profileId)).toEqual([null, "postmark", "postmark"]);
  b.options.sites = SITES.slice(1);
  await act(b, "reconcile");
  expect(Object.keys(JSON.parse(readFileSync(join(b.dir, "state.json"), "utf8")).assignments)).toEqual(["app.test", "shop.test"]);

  await act(b, "assign", { domains: ["shop.test", "app.test"], profileId: null });
  expect(b.settings.has("smtpd_relay_restrictions")).toBe(false);
  expect(b.settings.has("local_login_sender_maps")).toBe(false);
  expect(b.settings.get("smtp_tls_policy_maps")).toBe("hash:/etc/postfix/operator-tls");
  expect(readdirSync(b.postfixDir)).toEqual([]);
  expect(existsSync(join(b.phpRoot, "8.2/fpm/conf.d/99-clp-addons-smtp.ini"))).toBe(false);
  expect(readdirSync(b.ruleDir)).toEqual([]);
  expect(readdirSync(join(b.dir, "bin"))).toEqual([]);
  expect(existsSync(join(b.dir, "original.json"))).toBe(false);
});

test("a sendmail the operator already put on the default PATH is left alone", async () => {
  const b = box(SITES);
  writeFileSync(b.sendmailLink, "#!/bin/sh\n");
  await act(b, "save-profile", POSTMARK);
  await act(b, "assign", { domains: ["app.test"], profileId: "postmark" });
  await act(b, "deactivate");
  expect(readFileSync(b.sendmailLink, "utf8")).toBe("#!/bin/sh\n");
});

test("the test mail goes through the site's own path and reports what the rewrite does", async () => {
  const b = box(SITES);
  await act(b, "save-profile", POSTMARK);
  await act(b, "assign", { domains: ["www.example.com"], profileId: "dont-send" });
  await expect(act(b, "test", { domain: "shop.test", recipient: "me@inbox.test" })).rejects.toThrow("in no profile");
  const result = await act(b, "test", { domain: "www.example.com", recipient: "me@inbox.test", from: "orders@example.com" }) as SmtpTestResult;
  expect(result).toEqual({ queued: true, discarded: true, requested: "orders@example.com", sender: "noreply@example.com",
    replyTo: "orders@example.com", recipient: "me@inbox.test" });
  expect(file(b, "transports")).toBe("/^noreply@example\\.com$/ discard:\n/@example\\.com$/ discard:\n/@www\\.example\\.com$/ discard:\n");
  const html = dashboardContent(await act(b, "list") as SmtpState);
  expect(html).toContain('<span class="hint">Discarded</span>');
  expect(html).not.toContain("noreply@<wbr>example.com");

  // Plain sendmail keeps the From the app wrote; only the envelope is the profile's.
  await act(b, "assign", { domains: ["app.test"], profileId: "postmark" });
  expect(await act(b, "test", { domain: "app.test", recipient: "me@inbox.test", from: "other@gmail.com" })).toMatchObject({
    discarded: false, requested: "other@gmail.com", sender: "other@gmail.com", replyTo: null });
});

test("the test mail runs PHP's own mail(), and is refused for a pool that bypasses the relay", async () => {
  const b = box(SITES);
  const runuser = join(b.dir, "runuser");
  writeFileSync(runuser, `#!/bin/sh\nprintf '%s\\n' "$@" > "${b.dir}/runuser-args"\n`);
  chmodSync(runuser, 0o755);
  b.options.paths!.runuser = runuser;
  await act(b, "save-profile", POSTMARK);
  await act(b, "assign", { domains: ["www.example.com"], profileId: "postmark" });
  await act(b, "test", { domain: "www.example.com", recipient: "me@inbox.test" });
  const args = readFileSync(join(b.dir, "runuser-args"), "utf8");
  expect(args.startsWith("-u\nexample\n--\n/usr/bin/php8.2\n-r\n")).toBe(true);
  expect(args).toContain("\n--\nme@inbox.test\nCloudPanel SMTP relay test for www.example.com\n");
  expect(args.trim().endsWith("\nwordpress@example.com")).toBe(true);

  mkdirSync(join(b.phpRoot, "8.2/fpm/pool.d"));
  writeFileSync(join(b.phpRoot, "8.2/fpm/pool.d/www.example.com.conf"), "[example]\nphp_admin_value[sendmail_path] = /usr/sbin/sendmail -t -i\n");
  await expect(act(b, "test", { domain: "www.example.com", recipient: "me@inbox.test" })).rejects.toThrow("sets its own sendmail_path");
});

test("deactivate withdraws everything even when the saved policy is unreadable", async () => {
  const b = box(SITES);
  await act(b, "save-profile", POSTMARK);
  await act(b, "assign", { domains: ["www.example.com"], profileId: "postmark" });
  writeFileSync(join(b.dir, "state.json"), "{not json");
  chmodSync(join(b.dir, "state.json"), 0o600);
  await expect(act(b, "list")).rejects.toThrow("malformed");
  await act(b, "deactivate");
  expect(readdirSync(b.postfixDir)).toEqual([]);
  expect(b.settings.get("smtp_tls_policy_maps")).toBe("hash:/etc/postfix/operator-tls");
  expect(existsSync(join(b.phpRoot, "8.2/cli/conf.d/99-clp-addons-smtp.ini"))).toBe(false);
  expect(readdirSync(join(b.dir, "bin"))).toEqual([]);
});
