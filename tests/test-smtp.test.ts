import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeSmtpAction, postfixMaps, type SmtpActionOptions, type SmtpState } from "../addons/smtp/action";
import { emptySmtpPolicy, parseRule, type SmtpSubmissionSite } from "../addons/smtp/config";
import { prepareSubmission } from "../addons/smtp/submit";
import { dashboardView } from "../addons/smtp/app/views";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const site: SmtpSubmissionSite = {
  domain: "example.com", user: "example", uid: 1234,
  rule: { mode: "force", sender: "noreply@{domain}", domains: [], addresses: [] },
};

test("forced sender replaces a foreign From and sets the envelope identity", () => {
  const raw = Buffer.from("To: user@recipient.test\r\nFrom: noreply@cool.com\r\nSubject: Reset\r\nReturn-Path: forged@cool.com\r\n\r\nHello", "utf8");
  const result = prepareSubmission(raw, site);
  const output = Buffer.from(result.message).toString("utf8");
  expect(result.sender).toBe("noreply@example.com");
  expect(output).toContain("From: noreply@example.com\r\n");
  expect(output).not.toContain("cool.com");
  expect(output.endsWith("\r\n\r\nHello")).toBe(true);
});

test("allow-listed mode preserves own and approved domains but refuses another site", () => {
  const allowed = { ...site, rule: parseRule({ mode: "allow", sender: "noreply@{domain}", domains: ["news.example.com"], addresses: ["billing@partner.test"] }) };
  for (const sender of ["wordpress@example.com", "edition@news.example.com", "billing@partner.test"]) {
    const result = prepareSubmission(Buffer.from(`To: test@recipient.test\nFrom: ${sender}\n\nHi`), allowed);
    expect(result.sender).toBe(sender);
  }
  expect(() => prepareSubmission(Buffer.from("To: test@recipient.test\nFrom: noreply@cool.com\n\nHi"), allowed)).toThrow("not allowed");
  expect(() => prepareSubmission(Buffer.from("From: a@example.com\nFrom: b@example.com\nTo: test@recipient.test\n\nHi"), allowed)).toThrow("multiple From");
});

test("folded From is checked and ignored Sender fields cannot change it", () => {
  const allowed = { ...site, rule: { ...site.rule, mode: "allow" as const } };
  const result = prepareSubmission(Buffer.from("To: test@recipient.test\nFrom: Example\n <wordpress@example.com>\nSender: forged@cool.com\n x: bogus\n\nHi"), allowed);
  expect(result.sender).toBe("wordpress@example.com");
  expect(Buffer.from(result.message).toString()).not.toContain("forged@cool.com");
});

test("domain relay map selects an override before the shared credential", () => {
  const policy = emptySmtpPolicy();
  policy.relay = { host: "mail.example.com", port: 587, username: "shared@example.com", password: "secret-one" };
  policy.relayOverrides["cool.com"] = { host: "smtp.cool.com", port: 587, username: "noreply@cool.com", password: "secret-two" };
  const maps = postfixMaps(policy);
  expect(maps.credentials.indexOf("noreply@cool.com:secret-two")).toBeLessThan(maps.credentials.indexOf("shared@example.com:secret-one"));
  expect(maps.routes).toContain("[smtp.cool.com]:587");
  expect(maps.credentials).not.toContain("* shared");
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
  await executeSmtpAction(["save-relay"], { ...options, input: JSON.stringify(body) });
  expect(readFileSync(pool, "utf8")).toContain("smtp-submit -t -i");
  expect(readFileSync(join(dir, "submission.json"), "utf8")).toContain("noreply@{domain}");
  expect(settings.get("local_login_sender_maps")).toContain("clp-addons-local-senders");
  expect(commands.some((item) => item.includes("php-fpm8.2 -t"))).toBe(true);
  const publicState = await executeSmtpAction(["list"], options);
  const html = dashboardView(publicState as SmtpState);
  expect(JSON.stringify(publicState)).not.toContain("secret");
  expect(html).not.toContain("secret");
  writeFileSync(pool, readFileSync(pool, "utf8") + "php_admin_value[sendmail_path] = /other/sendmail\n");
  await expect(executeSmtpAction(["save-default"], { ...options, input: JSON.stringify({
    rule: { mode: "allow", sender: "noreply@{domain}", domains: [], addresses: [] },
  }) })).rejects.toThrow("already configures sendmail_path");
  expect((await executeSmtpAction(["list"], options) as SmtpState).defaultRule.mode).toBe("force");
  writeFileSync(pool, readFileSync(pool, "utf8").replace("php_admin_value[sendmail_path] = /other/sendmail\n", ""));
  await executeSmtpAction(["deactivate"], options);
  expect(readFileSync(pool, "utf8")).not.toContain("smtp-submit");
  expect(existsSync(join(dir, "submission.json"))).toBe(false);
  expect(settings.has("relayhost")).toBe(false);
});
