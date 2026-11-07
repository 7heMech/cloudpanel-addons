// The reply protocol of `clp-addons action <addon> <verb>`: one JSON line on
// stdout, the message on stderr for the gateway's journal.
import { errorMessage } from "./errors";

export class ActionFailure extends Error {
  readonly data?: unknown;

  constructor(message: string, data?: unknown) {
    super(message);
    this.name = "ActionFailure";
    this.data = data;
  }
}

export class ActionCommandFailure extends Error {
  constructor(readonly command: string, readonly output = "") {
    super(`command failed: ${command}`);
    this.name = "ActionCommandFailure";
  }
}

export function failAction(message: string, data?: unknown): never {
  throw new ActionFailure(message, data);
}

function stripJsonControls(value: string): string {
  // ESC and the other non-printing controls go; newline, tab and CR stay for
  // JSON.stringify to escape.
  return value
    .replaceAll("\u001b", "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === "string") return stripJsonControls(value);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = jsonSafe(item);
    return result;
  }
  return value;
}

export function emitActionOk(data: unknown): void {
  process.stdout.write(`${JSON.stringify(jsonSafe({ ok: true, data }))}\n`);
}

export function actionErrorJson(message: string, data?: unknown): string {
  const reply: Record<string, unknown> = { ok: false, error: stripJsonControls(message) };
  if (data !== undefined) reply.data = jsonSafe(data);
  return JSON.stringify(reply);
}

export function emitActionError(addon: string, message: string, data?: unknown): void {
  process.stderr.write(`[${addon}] ERROR: ${message}\n`);
  process.stdout.write(`${actionErrorJson(message, data)}\n`);
}

/**
 * Report a failed action and return its exit code: a JSON reply on stdout and
 * the message on stderr, where the gateway's journal keeps it. With `emit`
 * false, as when repair runs a verb in-process, only the stderr line.
 */
export function reportActionFailure(addon: string, error: unknown, emit = true, message = errorMessage(error)): 1 {
  if (emit) emitActionError(addon, message, error instanceof ActionFailure ? error.data : undefined);
  else process.stderr.write(`[${addon}] ERROR: ${message}\n`);
  return 1;
}

/** A verb's request body: at most `maxBytes`, and a JSON object. */
export function parseJsonRequest(raw: string, maxBytes: number): Record<string, unknown> {
  if (Buffer.byteLength(raw, "utf8") > maxBytes) failAction("the request is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    failAction("the request must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) failAction("the request must be a JSON object");
  return parsed as Record<string, unknown>;
}

/** The request body passed in, or else stdin's, as `parseJsonRequest` reads it. */
export async function readJsonRequest(input: string | undefined, maxBytes: number): Promise<Record<string, unknown>> {
  return parseJsonRequest(input ?? await Bun.stdin.text(), maxBytes);
}

/** Returned by a verb that wrote its own replies, such as a stream of job snapshots. */
export const REPLIED = Symbol("replied");

/** Run one action verb to its JSON reply and exit code. */
export async function replyToAction(addon: string, emit: boolean, run: () => unknown): Promise<number> {
  try {
    const data = await run();
    if (emit && data !== REPLIED) emitActionOk(data);
    return 0;
  } catch (error) {
    return reportActionFailure(addon, error, emit);
  }
}
