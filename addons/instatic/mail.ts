/**
 * `clp-addons instatic-mail`: one SMTP connection from an Instatic container,
 * which systemd accepts on the mail network's gateway and hands over as stdin
 * and stdout. The container is known by its source address, and its message
 * goes to Postfix as its site's login. See "Email" in docs/decisions/instatic.md.
 */
import { existsSync, writeSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { runCommand, type CommandResult } from "../../lib/command";
import { errorMessage } from "../../lib/errors";
import { smtpAddress } from "../smtp/config";
import { deliverAsSite, MAX_MESSAGE_BYTES } from "../smtp/submit";
import { DEFAULT_INSTATIC_ACTION_PATHS, resolveOwner, siteUserOf, type InstaticActionPaths } from "./action";
import { MAIL_NETWORK } from "./mail-bridge";

const MAX_LINE_BYTES = 4096;
const MAX_RECIPIENTS = 100;
const IDLE_MS = 120_000;

export interface MailSite { domain: string; user: string; uid: number }

export interface Envelope { mailFrom: string; recipients: string[]; message: Uint8Array }

/** sendmail's exit code and what it said, as `deliverAsSite` returns them. */
export type Deliver = (envelope: Envelope) => { code: number; said: string } | Promise<{ code: number; said: string }>;

type Run = (command: string, args: string[]) => CommandResult;

/** The Instatic site whose container has `address` on the mail network, or why there is none. */
export function instaticSiteAt(
  address: string,
  run: Run = (command, args) => runCommand(command, args, 15_000),
  paths: InstaticActionPaths = DEFAULT_INSTATIC_ACTION_PATHS,
): MailSite | string {
  if (isIP(address) !== 4) return `${address || "an unknown address"} is not on the ${MAIL_NETWORK} network`;
  const inspected = run("docker", ["network", "inspect", MAIL_NETWORK, "--format", "{{json .Containers}}"]);
  let containers: Record<string, { Name?: unknown; IPv4Address?: unknown }> = {};
  try { containers = JSON.parse(inspected.stdout || "{}") ?? {}; } catch { /* no containers */ }
  const [id, container] = Object.entries(containers).find(([, entry]) => String(entry.IPv4Address ?? "").split("/")[0] === address) ?? [];
  const domain = /^instatic-(.+)$/.exec(String(container?.Name ?? ""))?.[1];
  if (!id || !domain || !existsSync(join(paths.dataBaseDir, domain, "meta.json"))) return `${address} is not an Instatic container`;
  const config = run("docker", ["inspect", "--format", '{{.Config.User}} {{index .Config.Labels "clp-addon"}}', id]);
  const [runsAs = "", label = ""] = config.stdout.trim().split(" ");
  let owner: string;
  try { owner = resolveOwner(domain, paths); } catch (error) { return errorMessage(error); }
  const user = siteUserOf(domain, paths);
  // The container must still run as the site's account, or the address names someone else.
  if (!config.ok || label !== "instatic" || runsAs !== owner || !user) return `${domain}'s container does not run as its site user`;
  return { domain, user, uid: Number(owner.split(":")[0]) };
}

/** Splits a byte stream into CRLF- or LF-terminated lines, each without its terminator. */
class LineReader {
  private buffer = Buffer.alloc(0);
  private readonly iterator: AsyncIterator<Uint8Array>;
  constructor(input: AsyncIterable<Uint8Array>, private readonly idleMs: number) {
    this.iterator = input[Symbol.asyncIterator]();
  }

  /** null at the end of input or after the idle wait; "too long" when no line ends within the limit. */
  async line(limit: number): Promise<Buffer | null | "too long"> {
    while (true) {
      const end = this.buffer.indexOf(0x0a);
      if (end >= 0) {
        const line = this.buffer.subarray(0, end > 0 && this.buffer[end - 1] === 0x0d ? end - 1 : end);
        this.buffer = this.buffer.subarray(end + 1);
        return line.length > limit ? "too long" : line;
      }
      if (this.buffer.length > limit) return "too long";
      let timer: Timer | undefined;
      const next = await Promise.race([
        this.iterator.next(),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), this.idleMs); }),
      ]).finally(() => clearTimeout(timer));
      if (next === null || next.done) return null;
      this.buffer = Buffer.concat([this.buffer, next.value]);
    }
  }
}

function replyFor({ code, said }: { code: number; said: string }): string {
  if (code === 0) return "250 2.0.0 Ok: queued";
  const reason = said.split("\n").map((line) => line.replace(/[^\x20-\x7e]/g, "").trim()).find(Boolean)?.slice(0, 200) ?? `sendmail exited ${code}`;
  // EX_TEMPFAIL: Postfix could not take it now.
  return code === 75 ? `451 4.3.0 ${reason}` : `554 5.7.1 ${reason}`;
}

function parsePath(argument: string, verb: "FROM" | "TO"): { address: string; params: string[] } | null {
  const match = new RegExp(`^${verb}:\\s*<([^<>]*)>((?:\\s+\\S+)*)\\s*$`, "i").exec(argument);
  if (!match) return null;
  return { address: match[1]!, params: match[2]!.trim().split(/\s+/).filter(Boolean) };
}

/**
 * One SMTP session, enough for a mail library: EHLO, MAIL, RCPT, DATA, RSET,
 * NOOP and QUIT, without TLS or a login. `site` null refuses the connection.
 */
export async function smtpSession(
  input: AsyncIterable<Uint8Array>,
  write: (text: string) => void,
  site: MailSite | string,
  deliver: Deliver,
  idleMs = IDLE_MS,
): Promise<void> {
  const say = (line: string) => write(`${line}\r\n`);
  if (typeof site === "string") {
    say(`554 5.7.1 ${site.replace(/[^\x20-\x7e]/g, "")}`);
    return;
  }
  say(`220 ${MAIL_NETWORK} ESMTP mail for ${site.domain}`);
  const reader = new LineReader(input, idleMs);
  let greeted = false;
  let mailFrom: string | null = null;
  let recipients: string[] = [];
  const reset = () => { mailFrom = null; recipients = []; };
  while (true) {
    const raw = await reader.line(MAX_LINE_BYTES);
    if (raw === null) { say("421 4.4.2 Idle too long, closing"); return; }
    if (raw === "too long") { say("500 5.5.2 Line too long"); return; }
    const line = raw.toString("latin1");
    const [, command = "", argument = ""] = /^(\S*)\s?(.*)$/.exec(line) ?? [];
    switch (command.toUpperCase()) {
      case "EHLO":
        greeted = true; reset();
        say(`250-${MAIL_NETWORK}`); say(`250-SIZE ${MAX_MESSAGE_BYTES}`); say("250 8BITMIME");
        break;
      case "HELO":
        greeted = true; reset(); say(`250 ${MAIL_NETWORK}`);
        break;
      case "MAIL": {
        if (!greeted) { say("503 5.5.1 Send EHLO first"); break; }
        if (mailFrom !== null) { say("503 5.5.1 Sender already given"); break; }
        const path = parsePath(argument, "FROM");
        if (!path) { say("501 5.5.4 Syntax: MAIL FROM:<address>"); break; }
        const size = path.params.map((param) => /^SIZE=(\d+)$/i.exec(param)?.[1]).find(Boolean);
        if (size && Number(size) > MAX_MESSAGE_BYTES) { say("552 5.3.4 Message too big"); break; }
        try { mailFrom = path.address ? smtpAddress(path.address) : ""; } catch { say("553 5.1.7 Bad sender address"); break; }
        say("250 2.1.0 Ok");
        break;
      }
      case "RCPT": {
        if (mailFrom === null) { say("503 5.5.1 Need MAIL first"); break; }
        const path = parsePath(argument, "TO");
        if (!path) { say("501 5.5.4 Syntax: RCPT TO:<address>"); break; }
        if (recipients.length >= MAX_RECIPIENTS) { say("452 4.5.3 Too many recipients"); break; }
        try { recipients.push(smtpAddress(path.address)); } catch { say("553 5.1.3 Bad recipient address"); break; }
        say("250 2.1.5 Ok");
        break;
      }
      case "DATA": {
        if (mailFrom === null || recipients.length === 0) { say("503 5.5.1 Need RCPT first"); break; }
        say("354 End data with <CR><LF>.<CR><LF>");
        const chunks: Buffer[] = [];
        let size = 0;
        while (true) {
          const data = await reader.line(MAX_MESSAGE_BYTES);
          if (data === null) { say("421 4.4.2 Idle too long, closing"); return; }
          if (data === "too long") { say("552 5.3.4 Message too big"); return; }
          if (data.length === 1 && data[0] === 0x2e) break;
          const unstuffed = data[0] === 0x2e ? data.subarray(1) : data;
          size += unstuffed.length + 2;
          if (size <= MAX_MESSAGE_BYTES) chunks.push(unstuffed, Buffer.from("\r\n"));
        }
        if (size > MAX_MESSAGE_BYTES) say("552 5.3.4 Message too big");
        else say(replyFor(await deliver({ mailFrom, recipients, message: Buffer.concat(chunks) })));
        reset();
        break;
      }
      case "RSET": reset(); say("250 2.0.0 Ok"); break;
      case "NOOP": say("250 2.0.0 Ok"); break;
      case "QUIT": say("221 2.0.0 Bye"); return;
      default: say("502 5.5.2 Command not recognized");
    }
  }
}

export async function runInstaticMail(): Promise<number> {
  const site = instaticSiteAt((process.env.REMOTE_ADDR ?? "").replace(/^::ffff:/, ""));
  if (typeof site === "string") process.stderr.write(`[instatic-mail] refused: ${site}\n`);
  await smtpSession(Bun.stdin.stream(), (text) => { writeSync(1, text); }, site, (envelope) => {
    const result = deliverAsSite({ user: (site as MailSite).user, uid: (site as MailSite).uid, ...envelope });
    process.stderr.write(`[instatic-mail] ${(site as MailSite).domain}: ${envelope.recipients.length} recipient(s), sendmail ${result.code}${result.code ? `: ${result.said}` : ""}\n`);
    return result;
  });
  return 0;
}
