import { lstatSync, readFileSync } from "node:fs";
import { CONFIG_DIR } from "../../cli/paths";
import { permittedSender, senderFor, smtpAddress, type SmtpSubmissionPolicy, type SmtpSubmissionSite } from "./config";

export const SUBMISSION_POLICY_PATH = `${CONFIG_DIR}/smtp-submission.json`;
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

function trustedPolicy(path: string): SmtpSubmissionPolicy {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    throw new Error("SMTP sender policy is not a trusted root-owned file");
  }
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || (value as SmtpSubmissionPolicy).version !== 1 ||
      !Array.isArray((value as SmtpSubmissionPolicy).sites)) throw new Error("SMTP sender policy is malformed");
  return value as SmtpSubmissionPolicy;
}

function senderFromHeader(value: string): string {
  const unfolded = value.replace(/\r?\n[ \t]+/g, " ").trim();
  const bracketed = unfolded.match(/<([^<>]+)>$/);
  const address = bracketed ? bracketed[1] : unfolded;
  if (!address || address.includes(",") || /[\r\n]/.test(address)) throw new Error("message has an invalid From address");
  return smtpAddress(address);
}

/** Rewrites one message before it crosses the trusted local sendmail boundary. */
export function prepareSubmission(message: Uint8Array, site: SmtpSubmissionSite): { message: Uint8Array; sender: string } {
  if (message.byteLength > MAX_MESSAGE_BYTES) throw new Error("message exceeds the 25 MiB submission limit");
  const input = Buffer.from(message);
  const lfBoundary = input.indexOf("\n\n");
  const crlfBoundary = input.indexOf("\r\n\r\n");
  const useCrlf = crlfBoundary >= 0 && (lfBoundary < 0 || crlfBoundary < lfBoundary);
  const boundary = useCrlf ? crlfBoundary : lfBoundary;
  if (boundary < 0 || boundary > MAX_HEADER_BYTES) throw new Error("message has no bounded header section");
  const separatorLength = useCrlf ? 4 : 2;
  const newline = useCrlf ? "\r\n" : "\n";
  const headers = input.subarray(0, boundary).toString("utf8").split(/\r?\n/);
  const kept: string[] = [];
  let fromRaw: string | null = null;
  let lastWasFrom = false;
  let lastWasIgnored = false;
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
    if (name === "from") {
      if (fromRaw !== null) throw new Error("message has multiple From headers");
      fromRaw = line.slice(colon + 1);
    } else if (name !== "sender" && name !== "return-path") {
      kept.push(line);
    }
  }
  const from = fromRaw === null ? null : senderFromHeader(fromRaw);
  const configured = senderFor(site.rule.sender, site.domain);
  const sender = site.rule.mode === "force" ? configured : (from ?? configured);
  if (site.rule.mode === "allow" && !permittedSender(site, sender)) {
    throw new Error(`sender ${sender} is not allowed for ${site.domain}`);
  }
  kept.unshift(`From: ${sender}`);
  const head = Buffer.from(kept.join(newline) + newline + newline, "utf8");
  return { message: Buffer.concat([head, input.subarray(boundary + separatorLength)]), sender };
}

/** Invoked as the PHP-FPM pool's sendmail_path, never through the root gateway. */
export async function runSmtpSubmit(
  argv: string[],
  options: { policyPath?: string; sendmailPath?: string; uid?: number; input?: Uint8Array } = {},
): Promise<number> {
  try {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!;
      if (arg === "-t" || arg === "-i" || arg === "-oi") continue;
      if (arg === "-f") { i++; if (!argv[i]) throw new Error("-f needs an address"); continue; }
      if (arg.startsWith("-f") && arg.length > 2) continue;
      throw new Error("unsupported sendmail option");
    }
    const uid = options.uid ?? process.getuid?.();
    if (uid === undefined) throw new Error("cannot identify the sending site");
    const policy = trustedPolicy(options.policyPath ?? SUBMISSION_POLICY_PATH);
    const matches = policy.sites.filter((site) => site.uid === uid);
    if (matches.length !== 1) throw new Error("the sending Unix account has no unique CloudPanel site");
    const input = options.input ?? new Uint8Array(await Bun.stdin.arrayBuffer());
    const prepared = prepareSubmission(input, matches[0]!);
    const result = Bun.spawnSync([options.sendmailPath ?? "/usr/sbin/sendmail", "-t", "-i", "-f", prepared.sender], {
      stdin: prepared.message, stdout: "pipe", stderr: "pipe", maxBuffer: 64 * 1024,
    });
    if (!result.success) throw new Error(Buffer.from(result.stderr).toString("utf8").trim() || "Postfix did not accept the message");
    return 0;
  } catch (error) {
    process.stderr.write(`[smtp] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
