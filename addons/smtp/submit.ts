import { lstatSync, readFileSync } from "node:fs";
import { CONFIG_DIR } from "../../cli/paths";
import { senderFor, smtpAddress, trustedFile, type SmtpRewriteRule, type SmtpSubmissionRule } from "./config";

/** One rule file per site uid, readable only by that site's group. */
export const RULE_DIR = `${CONFIG_DIR}/smtp`;
export const SENDMAIL = "/usr/sbin/sendmail";
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

export function rulePathFor(uid: number, dir = RULE_DIR): string {
  return `${dir}/${uid}.json`;
}

/** The site's rule, or null when there is none to apply: Postfix still enforces the envelope either way. */
function trustedRule(path: string, rootUid: number): SmtpSubmissionRule | null {
  try {
    if (!trustedFile(lstatSync(path), rootUid)) return null;
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<SmtpSubmissionRule>;
    if (value.version !== 1 || typeof value.site !== "string" || (value.sender !== null && typeof value.sender !== "string") ||
        !Array.isArray(value.allowed) || !value.allowed.every((domain) => typeof domain === "string")) return null;
    return { version: 1, site: value.site, sender: value.sender, allowed: value.allowed };
  } catch {
    return null;
  }
}

interface PlainSubmission { flags: string[]; senders: string[] }

/** PHP `mail()`'s arguments, the only ones the rewrite handles, split into flags and envelope senders; null for any others. */
function plainSubmission(argv: string[]): PlainSubmission | null {
  const flags: string[] = [];
  const senders: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-t" || arg === "-i" || arg === "-oi") flags.push(arg);
    else if (arg === "-f" || arg === "-r") {
      const value = argv[++i];
      if (value === undefined) return null;
      senders.push(value);
    } else if (/^-[fr]/.test(arg)) senders.push(arg.slice(2));
    else return null;
  }
  return flags.includes("-t") ? { flags, senders } : null;
}

/** Drops an envelope sender outside the site's domains, which Postfix would refuse, so the mail goes out under its login. */
function envelopeWithin({ flags, senders }: PlainSubmission, allowed: readonly string[]): string[] {
  const inside = (value: string) => value.lastIndexOf("@") > 0 && allowed.includes(value.slice(value.lastIndexOf("@") + 1).toLowerCase());
  return [...flags, ...senders.filter(inside).flatMap((value) => ["-f", value])];
}

/** The app's requested From. A display name survives an address that cannot be used. */
function requestedFrom(raw: string | null): { display: string; address: string | null } | null {
  if (raw === null) return null;
  const unfolded = raw.replace(/\r?\n[ \t]+/g, " ").trim();
  const bracketed = unfolded.match(/^([^<>]*)<([^<>]+)>$/);
  const display = bracketed ? bracketed[1]!.trim() : "";
  try {
    return { display, address: smtpAddress((bracketed ? bracketed[2]! : unfolded).trim()) };
  } catch {
    return { display, address: null };
  }
}

/** Stops reading stdin at the first chunk that crosses the submission limit. */
export async function readBoundedSubmission(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_MESSAGE_BYTES) throw new Error("message exceeds the 25 MiB submission limit");
      chunks.push(value);
    }
    return Buffer.concat(chunks, length);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Rewrites one message's From to the site's template; throws when the message cannot be read as mail. */
export function prepareSubmission(message: Uint8Array, rule: SmtpRewriteRule): { message: Uint8Array; sender: string } {
  if (message.byteLength > MAX_MESSAGE_BYTES) throw new Error("message exceeds the 25 MiB submission limit");
  const input = Buffer.from(message);
  const lfBoundary = input.indexOf("\n\n");
  const crlfBoundary = input.indexOf("\r\n\r\n");
  const useCrlf = crlfBoundary >= 0 && (lfBoundary < 0 || crlfBoundary < lfBoundary);
  const boundary = useCrlf ? crlfBoundary : lfBoundary;
  if (boundary < 0 || boundary > MAX_HEADER_BYTES) throw new Error("message has no bounded header section");
  const separatorLength = useCrlf ? 4 : 2;
  const newline = useCrlf ? "\r\n" : "\n";
  // latin1 maps every byte to one character and back, so headers in any charset come out as they went in.
  const headers = input.subarray(0, boundary).toString("latin1").split(/\r?\n/);
  const kept: string[] = [];
  let fromRaw: string | null = null;
  let lastWasFrom = false;
  let lastWasIgnored = false;
  let hasReplyTo = false;
  for (let i = 0; i < headers.length; i++) {
    const line = headers[i]!;
    if (/^[ \t]/.test(line)) {
      if (lastWasFrom) fromRaw += `${newline}${line}`;
      else if (lastWasIgnored) continue;
      else if (kept.length > 0) kept[kept.length - 1] += `${newline}${line}`;
      else throw new Error("message begins with a folded header");
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 1 || !/^[A-Za-z0-9-]+$/.test(line.slice(0, colon))) throw new Error("message has a malformed header");
    const name = line.slice(0, colon).toLowerCase();
    lastWasFrom = name === "from";
    lastWasIgnored = name === "sender" || name === "return-path";
    if (name === "reply-to") hasReplyTo = true;
    if (name === "from") {
      if (fromRaw !== null) throw new Error("message has multiple From headers");
      fromRaw = line.slice(colon + 1);
    } else if (name !== "sender" && name !== "return-path") {
      kept.push(line);
    }
  }
  const from = requestedFrom(fromRaw);
  const address = from?.address ?? null;
  const at = address ? address.lastIndexOf("@") : -1;
  const local = address ? address.slice(0, at) : "";
  const domain = address ? address.slice(at + 1) : "";
  let sender: string;
  try {
    sender = senderFor(rule.sender, rule.site, address && rule.allowed.includes(domain) ? { local, domain } : null);
  } catch {
    sender = senderFor(rule.sender, rule.site);
  }
  // Whoever the app named as the sender should still get the replies.
  if (address && address !== sender && !hasReplyTo) {
    kept.unshift(`Reply-To: ${from!.display ? `${from!.display} <${address}>` : address}`);
  }
  kept.unshift(`From: ${from?.display ? `${from.display} <${sender}>` : sender}`);
  const head = Buffer.from(kept.join(newline) + newline + newline, "latin1");
  return { message: Buffer.concat([head, input.subarray(boundary + separatorLength)]), sender };
}

function sendmail(path: string, argv: string[], stdin: Uint8Array | "inherit"): number {
  try {
    return Bun.spawnSync([path, ...argv], { stdin, stdout: "inherit", stderr: "inherit" }).exitCode ?? 1;
  } catch (error) {
    process.stderr.write(`[smtp] cannot run ${path}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** Invoked as PHP's `sendmail_path`, as the site's own Unix user. */
export async function runSmtpSubmit(
  argv: string[],
  options: { ruleDir?: string; rootUid?: number; sendmailPath?: string; uid?: number; input?: Uint8Array } = {},
): Promise<number> {
  const path = options.sendmailPath ?? SENDMAIL;
  const uid = options.uid ?? process.getuid?.();
  const plain = plainSubmission(argv);
  const rule = uid === undefined || !plain ? null : trustedRule(rulePathFor(uid, options.ruleDir), options.rootUid ?? 0);
  if (!rule) return sendmail(path, argv, options.input ?? "inherit");
  if (rule.sender === null) return sendmail(path, envelopeWithin(plain!, rule.allowed), options.input ?? "inherit");
  let input: Uint8Array;
  try {
    input = options.input ?? await readBoundedSubmission(Bun.stdin.stream());
  } catch (error) {
    process.stderr.write(`[smtp] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  let prepared: { message: Uint8Array; sender: string };
  try {
    prepared = prepareSubmission(input, rule as SmtpRewriteRule);
  } catch {
    return sendmail(path, argv, input);
  }
  return sendmail(path, ["-t", "-i", "-f", prepared.sender], prepared.message);
}
