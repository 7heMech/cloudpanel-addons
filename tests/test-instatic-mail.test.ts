import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instaticSiteAt, smtpSession, type Envelope } from "../addons/instatic/mail";
import { ensureMailBridge, mailUnits, withdrawMailBridge } from "../addons/instatic/mail-bridge";
import { DEFAULT_INSTATIC_ACTION_PATHS } from "../addons/instatic/action";
import { deliverAsSite } from "../addons/smtp/submit";
import type { CommandResult } from "../lib/command";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "clp-instatic-mail-"));
  dirs.push(dir);
  return dir;
}

const site = { domain: "blog.example.com", user: "example-blog", uid: 1234 };

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield Buffer.from(part);
}

async function converse(input: string[], deliver = (_: Envelope) => ({ code: 0, said: "" }), who: typeof site | string = site) {
  const replies: string[] = [];
  const envelopes: Envelope[] = [];
  await smtpSession(chunks(...input), (text) => { replies.push(text); }, who, (envelope) => {
    envelopes.push(envelope);
    return deliver(envelope);
  }, 200);
  return { lines: replies.join("").split("\r\n").filter(Boolean), envelopes };
}

test("a mail library's session reaches delivery with the envelope and an unstuffed body", async () => {
  const { lines, envelopes } = await converse([
    "EHLO instatic\r\nMAIL FROM:<Hello@Example.com> SIZE=120 BODY=8BITMIME\r\n",
    "RCPT TO:<a@recipient.test>\r\nRCPT TO:<b@recipient.test>\r\nDATA\r\n",
    "From: Blog <hello@example.com>\r\nSubject: Hi\r\n\r\n..leading dot\r\nline\r\n.\r\n",
    "QUIT\r\n",
  ]);
  expect(lines[0]).toStartWith("220 ");
  expect(lines).toContain("250 8BITMIME");
  expect(lines.filter((line) => line.startsWith("250 2.1"))).toHaveLength(3);
  expect(lines).toContain("354 End data with <CR><LF>.<CR><LF>");
  expect(lines).toContain("250 2.0.0 Ok: queued");
  expect(lines.at(-1)).toBe("221 2.0.0 Bye");
  expect(envelopes).toHaveLength(1);
  expect(envelopes[0]!.mailFrom).toBe("hello@example.com");
  expect(envelopes[0]!.recipients).toEqual(["a@recipient.test", "b@recipient.test"]);
  expect(Buffer.from(envelopes[0]!.message).toString()).toBe("From: Blog <hello@example.com>\r\nSubject: Hi\r\n\r\n.leading dot\r\nline\r\n");
});

test("an address that is no Instatic container is refused at the greeting", async () => {
  const { lines, envelopes } = await converse(["EHLO x\r\n"], undefined, "172.30.0.9 is not an Instatic container");
  expect(lines).toEqual(["554 5.7.1 172.30.0.9 is not an Instatic container"]);
  expect(envelopes).toHaveLength(0);
});

test("sendmail's refusals map to temporary and permanent SMTP replies", async () => {
  const session = ["HELO x\r\nMAIL FROM:<>\r\nRCPT TO:<a@r.test>\r\nDATA\r\nSubject: x\r\n\r\nbody\r\n.\r\nQUIT\r\n"];
  const later = await converse(session, () => ({ code: 75, said: "sendmail: queue file write error\n" }));
  expect(later.lines).toContain("451 4.3.0 sendmail: queue file write error");
  expect(later.envelopes[0]!.mailFrom).toBe("");
  const never = await converse(session, () => ({ code: 77, said: "sendmail: fatal: not allowed\x1b[0m" }));
  expect(never.lines).toContain("554 5.7.1 sendmail: fatal: not allowed[0m");
});

test("commands out of order, bad addresses and oversized mail are refused without delivering", async () => {
  const { lines, envelopes } = await converse([
    "MAIL FROM:<a@example.com>\r\nEHLO x\r\nRCPT TO:<a@r.test>\r\nMAIL FROM:<not an address>\r\n",
    "MAIL FROM:<a@example.com> SIZE=999999999\r\nMAIL FROM:<a@example.com>\r\nDATA\r\nRCPT TO:<-oQ/tmp@x>\r\nVRFY a\r\nQUIT\r\n",
  ]);
  expect(lines.slice(1)).toEqual([
    "503 5.5.1 Send EHLO first", "250-clp-instatic", "250-SIZE 26214400", "250 8BITMIME",
    "503 5.5.1 Need MAIL first", "553 5.1.7 Bad sender address", "552 5.3.4 Message too big", "250 2.1.0 Ok",
    "503 5.5.1 Need RCPT first", "553 5.1.3 Bad recipient address", "502 5.5.2 Command not recognized", "221 2.0.0 Bye",
  ]);
  expect(envelopes).toHaveLength(0);
});

test("a silent client is closed after the idle wait", async () => {
  async function* stalled(): AsyncGenerator<Uint8Array> {
    yield Buffer.from("EHLO x\r\n");
    await new Promise(() => {});
  }
  const replies: string[] = [];
  await smtpSession(stalled(), (text) => { replies.push(text); }, site, () => ({ code: 0, said: "" }), 50);
  expect(replies.join("")).toEndWith("421 4.4.2 Idle too long, closing\r\n");
});

test("only a container on the mail network with an instance record is a site", () => {
  const dataBaseDir = scratch();
  const paths = { ...DEFAULT_INSTATIC_ACTION_PATHS, dataBaseDir, panelDb: join(dataBaseDir, "missing.db") };
  const run = (_: string, args: string[]): CommandResult => args[0] === "network"
    ? { ok: true, stdout: JSON.stringify({ abc: { Name: "instatic-blog.example.com", IPv4Address: "172.30.0.2/16" }, def: { Name: "other", IPv4Address: "172.30.0.3/16" } }), stderr: "" }
    : { ok: true, stdout: "1234:1234 instatic\n", stderr: "" };
  expect(instaticSiteAt("", run, paths)).toContain("is not on the clp-instatic network");
  expect(instaticSiteAt("172.30.0.3", run, paths)).toBe("172.30.0.3 is not an Instatic container");
  expect(instaticSiteAt("172.30.0.2", run, paths)).toBe("172.30.0.2 is not an Instatic container");
  mkdirSync(join(dataBaseDir, "blog.example.com"));
  writeFileSync(join(dataBaseDir, "blog.example.com", "meta.json"), "{}");
  // With no panel database there is no site user to compare the container's account with.
  expect(instaticSiteAt("172.30.0.2", run, paths)).toContain("no CloudPanel site user for blog.example.com");
});

function stubs(dir: string): { runuser: string; sendmail: string; log: string } {
  const log = join(dir, "log");
  const runuser = join(dir, "runuser");
  const sendmail = join(dir, "sendmail");
  writeFileSync(runuser, `#!/bin/sh\necho "runuser $1 $2" >> "${log}"\nshift 3\nexec "$@"\n`);
  writeFileSync(sendmail, `#!/bin/sh\necho "sendmail $*" >> "${log}"\ncat > "${dir}/message"\nexit "\${EXIT:-0}"\n`);
  chmodSync(runuser, 0o755);
  chmodSync(sendmail, 0o755);
  return { runuser, sendmail, log };
}

test("delivery runs sendmail as the site with its rule's From and LF line endings", () => {
  const dir = scratch();
  const { runuser, sendmail, log } = stubs(dir);
  const ruleDir = join(dir, "rules");
  mkdirSync(ruleDir);
  writeFileSync(join(ruleDir, "1234.json"), JSON.stringify({ version: 1, site: "blog.example.com", sender: "noreply@{site}", allowed: ["blog.example.com"] }), { mode: 0o640 });
  const options = { ruleDir, rootUid: process.getuid!(), runuser, sendmailPath: sendmail };
  const message = Buffer.from("To: a@r.test\r\nFrom: Blog <hello@elsewhere.test>\r\n\r\nHi\r\n");
  const result = deliverAsSite({ user: "example-blog", uid: 1234, mailFrom: "hello@elsewhere.test", recipients: ["a@r.test"], message }, options);
  expect(result.code).toBe(0);
  expect(readFileSync(log, "utf8")).toBe("runuser -u example-blog\nsendmail -i -f noreply@blog.example.com -- a@r.test\n");
  expect(readFileSync(join(dir, "message"), "utf8")).toBe("From: Blog <noreply@blog.example.com>\nReply-To: Blog <hello@elsewhere.test>\nTo: a@r.test\n\nHi\n");
});

test("with no From rule, an envelope sender outside the site's domains is dropped", () => {
  const dir = scratch();
  const { runuser, sendmail, log } = stubs(dir);
  const ruleDir = join(dir, "rules");
  mkdirSync(ruleDir);
  writeFileSync(join(ruleDir, "1234.json"), JSON.stringify({ version: 1, site: "blog.example.com", sender: null, allowed: ["blog.example.com"] }), { mode: 0o640 });
  const options = { ruleDir, rootUid: process.getuid!(), runuser, sendmailPath: sendmail };
  const message = Buffer.from("From: x@elsewhere.test\n\nHi\n");
  deliverAsSite({ user: "example-blog", uid: 1234, mailFrom: "x@elsewhere.test", recipients: ["a@r.test"], message }, options);
  deliverAsSite({ user: "example-blog", uid: 1234, mailFrom: "x@blog.example.com", recipients: ["a@r.test"], message }, options);
  // No rule at all: SMTP Relay is off, and Postfix takes any sender.
  deliverAsSite({ user: "example-blog", uid: 99, mailFrom: "x@elsewhere.test", recipients: ["a@r.test"], message }, options);
  expect(readFileSync(log, "utf8").split("\n").filter((line) => line.startsWith("sendmail"))).toEqual([
    "sendmail -i -- a@r.test", "sendmail -i -f x@blog.example.com -- a@r.test", "sendmail -i -f x@elsewhere.test -- a@r.test",
  ]);
});

function fakeDocker(gateway: string | null) {
  const calls: string[] = [];
  let network = gateway;
  const run = (command: string, args: string[]): CommandResult => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "docker" && args[1] === "inspect") return network ? { ok: true, stdout: `${network} \n`, stderr: "" } : { ok: false, stdout: "", stderr: "no such network" };
    if (command === "docker" && args[1] === "create") { network = "172.30.0.1"; return { ok: true, stdout: "id\n", stderr: "" }; }
    if (command === "ufw" && args[0] === "status") return { ok: true, stdout: "Status: active\n", stderr: "" };
    if (command === "ufw" && args[0] === "allow") return { ok: true, stdout: "Rule added\n", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  };
  return { run, calls, setGateway: (value: string) => { network = value; } };
}

test("the bridge creates the network, listens on its gateway and lets it through ufw", () => {
  const systemdDir = scratch();
  const docker = fakeDocker(null);
  expect(ensureMailBridge({ run: docker.run, systemdDir })).toBe("172.30.0.1");
  expect(readFileSync(join(systemdDir, "clp-addons-instatic-mail.socket"), "utf8")).toBe(mailUnits("172.30.0.1").socket);
  expect(readFileSync(join(systemdDir, "clp-addons-instatic-mail.socket"), "utf8")).toContain("ListenStream=172.30.0.1:2525\n");
  expect(docker.calls).toContain("docker network create --driver bridge --label clp-addon=instatic --opt com.docker.network.bridge.name=clp-instatic clp-instatic");
  expect(docker.calls).toContain("systemctl enable --now clp-addons-instatic-mail.socket");
  expect(docker.calls).toContain("ufw allow in on clp-instatic to 172.30.0.1 port 2525 proto tcp comment clp-addons instatic mail");

  // Unchanged: no reload; a new gateway moves the listener and the rule.
  docker.calls.length = 0;
  ensureMailBridge({ run: docker.run, systemdDir });
  expect(docker.calls).not.toContain("systemctl daemon-reload");
  docker.setGateway("172.31.0.1");
  docker.calls.length = 0;
  ensureMailBridge({ run: docker.run, systemdDir });
  expect(docker.calls).toContain("ufw delete allow in on clp-instatic to 172.30.0.1 port 2525 proto tcp");
  expect(docker.calls).toContain("systemctl restart clp-addons-instatic-mail.socket");

  docker.calls.length = 0;
  withdrawMailBridge({ run: docker.run, systemdDir });
  expect(docker.calls).toContain("systemctl disable --now clp-addons-instatic-mail.socket");
  expect(docker.calls).toContain("ufw delete allow in on clp-instatic to 172.31.0.1 port 2525 proto tcp");
});
