import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeSmtpAction, postfixMaps, type SmtpActionOptions, type SmtpState } from "../addons/smtp/action";
import { emptySmtpPolicy, parseRule, senderGrants, type SmtpSubmissionSite } from "../addons/smtp/config";
import { MAX_MESSAGE_BYTES, prepareSubmission, readBoundedSubmission } from "../addons/smtp/submit";
import { dashboardView } from "../addons/smtp/app/views";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const site: SmtpSubmissionSite = {
  domain: "example.com", user: "example", uid: 1234,
  rule: { sender: "noreply@{site}", domains: [] },
};

const submit = (rule: SmtpSubmissionSite["rule"], headers: string) => {
  const result = prepareSubmission(Buffer.from(`To: user@recipient.test\n${headers}\n\nHi`), { ...site, rule });
  return { sender: result.sender, text: Buffer.from(result.message).toString("utf8") };
};

test("a fixed From replaces the app's and keeps a foreign address reachable", () => {
  const raw = Buffer.from("To: user@recipient.test\r\nFrom: Visitor <visitor@cool.com>\r\nSubject: Reset\r\nReturn-Path: forged@cool.com\r\n\r\nHello", "utf8");
  const result = prepareSubmission(raw, site);
  const output = Buffer.from(result.message).toString("utf8");
  expect(result.sender).toBe("noreply@example.com");
  expect(output).toContain("From: Visitor <noreply@example.com>\r\nReply-To: visitor@cool.com\r\n");
  expect(output).not.toContain("forged@cool.com");
  expect(output.endsWith("\r\n\r\nHello")).toBe(true);
  const unparsable = submit(site.rule, "From: wordpress@example.com (WordPress)");
  expect(unparsable.sender).toBe("noreply@example.com");
  expect(unparsable.text).not.toContain("(WordPress)");
  expect(unparsable.text).not.toContain("Reply-To");
  expect(submit(site.rule, "From: wordpress@example.com").text).not.toContain("Reply-To");
  expect(submit(site.rule, "From: a@cool.com\nReply-To: desk@cool.com").text.match(/Reply-To/g)).toHaveLength(1);
});

test("{from.local} keeps the app's name on the template's domain", () => {
  const rule = parseRule({ sender: "{from.local}@{site}" });
  const wordpress = submit(rule, "From: WordPress <wordpress@example.com>");
  expect(wordpress.sender).toBe("wordpress@example.com");
  expect(wordpress.text).toContain("From: WordPress <wordpress@example.com>\n");
  expect(wordpress.text).not.toContain("Reply-To");
  expect(submit(rule, "From: orders@cool.com").sender).toBe("orders@example.com");
  expect(submit(rule, "Subject: none").sender).toBe("noreply@example.com");
  expect(submit(parseRule({ sender: "{from.local}@mail.{site}" }), `From: ${"a".repeat(240)}@example.com`).sender).toBe("noreply@mail.example.com");
});

test("{from.domain} keeps only the site's own and granted domains", () => {
  const rule = parseRule({ sender: "{from.local}@{from.domain}", domains: ["news.example.com"] });
  for (const sender of ["wordpress@example.com", "edition@news.example.com"]) {
    expect(submit(rule, `From: ${sender}`).sender).toBe(sender);
  }
  const foreign = submit(rule, "From: noreply@othersite.test");
  expect(foreign.sender).toBe("noreply@example.com");
  expect(foreign.text).toContain("Reply-To: noreply@othersite.test");
  expect(() => submit(rule, "From: a@example.com\nFrom: b@example.com")).toThrow("multiple From");
});

test("folded From is read and ignored Sender fields cannot change it", () => {
  const rule = parseRule({ sender: "{from.local}@{from.domain}" });
  const result = submit(rule, "From: Example\n <wordpress@example.com>\nSender: forged@cool.com\n x: bogus");
  expect(result.sender).toBe("wordpress@example.com");
  expect(result.text).not.toContain("forged@cool.com");
});

test("From templates accept only the three tokens in their own halves", () => {
  for (const sender of ["noreply@{domain}", "{from.domain}@example.com", "noreply@mail.{from.domain}", "{from.local}", "a@b@{site}"]) {
    expect(() => parseRule({ sender })).toThrow();
  }
  expect(parseRule({ sender: "NoReply@{site}", domains: ["other.test"] })).toEqual(site.rule);
});

test("Postfix envelope grants follow what the template can produce", () => {
  const grants = (sender: string, domains: string[] = []) => senderGrants({ domain: "example.com", rule: parseRule({ sender, domains }) });
  expect(grants("noreply@{site}")).toEqual(["noreply@example.com"]);
  expect(grants("{from.local}@{site}")).toEqual(["@example.com"]);
  expect(grants("{from.local}@{from.domain}", ["news.example.com"])).toEqual(["@example.com", "@news.example.com"]);
  expect(grants("noreply@{from.domain}", ["news.example.com"])).toEqual(["noreply@example.com", "noreply@news.example.com"]);
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

test("domain relay map selects an override before the shared credential", () => {
  const policy = emptySmtpPolicy();
  policy.relay = { host: "mail.example.com", port: 587, username: "shared@example.com", password: "secret-one" };
  policy.relayOverrides["cool.com"] = { host: "smtp.cool.com", port: 587, username: "noreply@cool.com", password: "secret-two" };
  const maps = postfixMaps(policy);
  expect(maps.credentials.indexOf("noreply@cool.com:secret-two")).toBeLessThan(maps.credentials.indexOf("shared@example.com:secret-one"));
  expect(maps.routes).toContain("[smtp.cool.com]:587");
  expect(maps.credentials).not.toContain("* shared");
  expect(maps.tls).toContain("/^\\[mail\\.example\\.com\\]:587$/ secure match=nexthop");
  expect(maps.tls).toContain("/^\\[smtp\\.cool\\.com\\]:587$/ secure match=nexthop");
});

test("regexp credential maps keep dollar signs literal in SMTP passwords", () => {
  const policy = emptySmtpPolicy();
  policy.relay = { host: "mail.example.com", port: 587, username: "relay@example.com", password: "pa$1ss" };
  expect(postfixMaps(policy).credentials).toContain("relay@example.com:pa$$1ss");
});

test("configured relay applies to Postfix and site pool, then deactivates cleanly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clp-smtp-"));
  dirs.push(dir);
  const poolDir = join(dir, "php", "8.2", "fpm", "pool.d");
  const postfixDir = join(dir, "postfix");
  mkdirSync(poolDir, { recursive: true });
  mkdirSync(postfixDir);
  const pool = join(poolDir, "example.com.conf");
  writeFileSync(pool, "[example.com]\nuser = example\n", { mode: 0o644 });
  chmodSync(pool, 0o644);
  const settings = new Map<string, string>();
  settings.set("relayhost", "");
  settings.set("smtp_tls_CApath", "/etc/ssl/certs");
  settings.set("smtp_tls_policy_maps", "hash:/etc/postfix/operator-tls");
  const commands: string[] = [];
  const run: NonNullable<SmtpActionOptions["run"]> = (command, args) => {
    commands.push(`${command} ${args.join(" ")}`);
    if (command === "postconf" && args[0] === "-d") {
      return { ok: true, stdout: "local_login_sender_maps = static:*", stderr: "" };
    }
    if (command === "postconf" && args[0] === "-n") {
      return { ok: true, stdout: [...settings].map(([key, value]) => `${key} = ${value}`).join("\n"), stderr: "" };
    }
    if (command === "postconf" && args[0] === "-e") {
      const text = args[1]!; const equal = text.indexOf("="); settings.set(text.slice(0, equal), text.slice(equal + 1));
    }
    if (command === "postconf" && args[0] === "-X") settings.delete(args[1]!);
    if (command === "postmap") writeFileSync(`${args[0]!.slice(5)}.db`, "indexed");
    return { ok: true, stdout: "", stderr: "" };
  };
  const options: SmtpActionOptions = {
    processUid: 0,
    paths: {
      phpRoot: join(dir, "php"), postfixDir,
      stateFile: join(dir, "state.json"), originalFile: join(dir, "original.json"),
      submissionFile: join(dir, "submission.json"), lockFile: join(dir, "smtp.lock"),
      rootUid: process.getuid?.() ?? 0,
    },
    sites: [{ domain: "example.com", user: "example", phpVersion: "8.2", uid: 1234 }],
    run,
  };
  const body = { relay: { host: "mail.example.com", port: 587, username: "relay@example.com", password: "secret" } };
  await expect(executeSmtpAction(["save-setup"], { ...options, input: JSON.stringify({ ...body, rule: { sender: "noreply@{domain}" } }) })).rejects.toThrow("{from.local}, {from.domain} and {site}");
  expect(existsSync(join(dir, "smtp.lock"))).toBe(false);
  expect((await executeSmtpAction(["list"], options) as SmtpState).configured).toBe(false);
  const submissionPath = join(dir, "submission.json");
  writeFileSync(submissionPath, "prior submission file\n");
  chmodSync(submissionPath, 0o644);
  writeFileSync(pool, readFileSync(pool, "utf8") + "php_admin_value[sendmail_path] = /other/sendmail\n");
  await expect(executeSmtpAction(["save-setup"], { ...options, input: JSON.stringify({ ...body, rule: site.rule }) })).rejects.toThrow("already configures sendmail_path");
  expect((await executeSmtpAction(["list"], options) as SmtpState).configured).toBe(false);
  for (const path of ["clp-addons-sasl", "clp-addons-relays", "clp-addons-local-senders", "clp-addons-local-senders.db", "clp-addons-tls-policy"]) {
    expect(existsSync(join(postfixDir, path))).toBe(false);
  }
  expect(readFileSync(submissionPath, "utf8")).toBe("prior submission file\n");
  expect(settings.get("smtp_tls_policy_maps")).toBe("hash:/etc/postfix/operator-tls");
  writeFileSync(pool, readFileSync(pool, "utf8").replace("php_admin_value[sendmail_path] = /other/sendmail\n", ""));
  settings.set("transport_maps", "hash:/etc/postfix/transport");
  await expect(executeSmtpAction(["save-setup"], { ...options, input: JSON.stringify({ ...body, rule: site.rule }) })).rejects.toThrow("transport_maps");
  expect(existsSync(join(dir, "original.json"))).toBe(false);
  expect(existsSync(join(postfixDir, "clp-addons-sasl"))).toBe(false);
  settings.delete("transport_maps");
  await executeSmtpAction(["save-setup"], { ...options, input: JSON.stringify({ ...body, rule: site.rule }) });
  expect(readFileSync(pool, "utf8")).toContain("smtp-submit -t -i");
  expect(readFileSync(join(dir, "submission.json"), "utf8")).toContain("noreply@{site}");
  expect(settings.get("local_login_sender_maps")).toContain("clp-addons-local-senders");
  expect(readFileSync(join(postfixDir, "clp-addons-local-senders"), "utf8")).toContain("clp *\n");
  expect(settings.get("smtp_tls_security_level")).toBe("secure");
  expect(settings.get("smtp_tls_policy_maps")).toBe(`regexp:${join(postfixDir, "clp-addons-tls-policy")}, hash:/etc/postfix/operator-tls`);
  for (const [key, value] of [
    ["transport_maps", "hash:/etc/postfix/transport"],
    ["sender_dependent_default_transport_maps", "hash:/etc/postfix/sender-transport"],
    ["default_transport", "smtp:[other.example.com]:587"],
    ["relay_transport", "relay:[other.example.com]:587"],
  ] as const) {
    settings.set(key, value);
    await expect(executeSmtpAction(["reconcile"], options)).rejects.toThrow(key);
    settings.delete(key);
  }
  settings.set("transport_maps", "hash:/etc/postfix/transport");
  await expect(executeSmtpAction(["save-default"], { ...options, input: JSON.stringify({ rule: site.rule }) })).rejects.toThrow("Postfix transport_maps can override");
  settings.delete("transport_maps");
  settings.set("default_transport", "smtp:");
  settings.set("relay_transport", "relay:");
  await executeSmtpAction(["reconcile"], options);
  settings.delete("default_transport");
  settings.delete("relay_transport");
  settings.set("smtp_tls_per_site", "hash:/etc/postfix/old-tls");
  await executeSmtpAction(["save-default"], { ...options, input: JSON.stringify({ rule: site.rule }) });
  expect(settings.get("smtp_tls_policy_maps")?.startsWith(`regexp:${join(postfixDir, "clp-addons-tls-policy")}`)).toBe(true);
  settings.delete("smtp_tls_per_site");
  const originalPath = join(dir, "original.json");
  const priorBackup = JSON.parse(readFileSync(originalPath, "utf8"));
  delete priorBackup.values.smtp_tls_policy_maps;
  writeFileSync(originalPath, JSON.stringify(priorBackup));
  settings.set("smtp_tls_policy_maps", "hash:/etc/postfix/operator-tls");
  await executeSmtpAction(["save-default"], { ...options, input: JSON.stringify({ rule: site.rule }) });
  expect(JSON.parse(readFileSync(originalPath, "utf8")).values.smtp_tls_policy_maps).toBe("hash:/etc/postfix/operator-tls");
  expect(settings.get("smtp_tls_policy_maps")).toBe(`regexp:${join(postfixDir, "clp-addons-tls-policy")}, hash:/etc/postfix/operator-tls`);
  expect(readFileSync(join(postfixDir, "clp-addons-tls-policy"), "utf8")).toContain("secure match=nexthop");
  const credentialsPath = join(postfixDir, "clp-addons-sasl");
  const credentialsBefore = readFileSync(credentialsPath);
  chmodSync(credentialsPath, 0o640);
  let failPostfixCheck = true;
  const failingRun: NonNullable<SmtpActionOptions["run"]> = (command, args) => {
    if (command === "postfix" && args[0] === "check" && failPostfixCheck) {
      failPostfixCheck = false;
      return { ok: false, stdout: "", stderr: "test failure" };
    }
    return run(command, args);
  };
  const domainRelayInput = JSON.stringify({ domain: "cool.com", relay: {
    host: "smtp.cool.com", port: 587, username: "cool@cool.com", password: "other-secret",
  } });
  await expect(executeSmtpAction(["save-domain-relay"], { ...options, run: failingRun, input: domainRelayInput })).rejects.toThrow("test failure");
  expect(readFileSync(credentialsPath)).toEqual(credentialsBefore);
  expect(statSync(credentialsPath).mode & 0o777).toBe(0o640);
  await executeSmtpAction(["save-domain-relay"], { ...options, input: JSON.stringify({ domain: "cool.com", relay: {
    host: "smtp.cool.com", port: 587, username: "cool@cool.com", password: "other-secret",
  } }) });
  expect(readFileSync(join(postfixDir, "clp-addons-tls-policy"), "utf8")).toContain("smtp\\.cool\\.com");
  expect(settings.get("smtp_tls_policy_maps")).toBe(`regexp:${join(postfixDir, "clp-addons-tls-policy")}, hash:/etc/postfix/operator-tls`);
  expect(commands.some((item) => item.includes("php-fpm8.2 -t"))).toBe(true);
  const publicState = await executeSmtpAction(["list"], options);
  const html = dashboardView(publicState as SmtpState);
  expect(JSON.stringify(publicState)).not.toContain("secret");
  expect(html).not.toContain("secret");
  expect(html).toContain('data-label="From"');
  writeFileSync(pool, readFileSync(pool, "utf8") + "php_admin_value[sendmail_path] = /other/sendmail\n");
  await expect(executeSmtpAction(["save-default"], { ...options, input: JSON.stringify({
    rule: { sender: "{from.local}@{site}", domains: [] },
  }) })).rejects.toThrow("already configures sendmail_path");
  expect((await executeSmtpAction(["list"], options) as SmtpState).defaultRule.sender).toBe("noreply@{site}");
  writeFileSync(pool, readFileSync(pool, "utf8").replace("php_admin_value[sendmail_path] = /other/sendmail\n", ""));
  await executeSmtpAction(["deactivate"], options);
  expect(readFileSync(pool, "utf8")).not.toContain("smtp-submit");
  expect(existsSync(join(dir, "submission.json"))).toBe(false);
  expect(settings.get("relayhost")).toBe("");
  expect(settings.get("smtp_tls_CApath")).toBe("/etc/ssl/certs");
  expect(settings.get("smtp_tls_policy_maps")).toBe("hash:/etc/postfix/operator-tls");
  expect(existsSync(join(postfixDir, "clp-addons-tls-policy"))).toBe(false);
});

test("site table shows each site's From and its granted domains", () => {
  const policy = emptySmtpPolicy();
  const rule = parseRule({ sender: "{from.local}@{from.domain}", domains: ["news.example.com"] });
  const html = dashboardView({
    configured: false, relay: null, relayOverrides: {}, defaultRule: policy.defaultRule,
    sites: [{ domain: "example.com", user: "example", phpVersion: "8.2", rule, overridden: true, senderPreview: rule.sender }],
  });
  expect(html).toContain("<code>{from.local}@{from.domain}</code>");
  expect(html).toContain("news.example.com");
  expect(html).toContain('data-label="Actions"');
});
