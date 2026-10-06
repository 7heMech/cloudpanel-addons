/**
 * The manager's terminals: one gateway stream each, held in memory, with the
 * last 256 KiB of output kept so a reloaded popup can pick up where it was.
 *
 * Every line from the stream is written by the site user's own process, so it
 * is parsed as hostile: it must be one of the few messages the helper sends,
 * exactly, or the session ends. Nothing in it is interpreted beyond that, and
 * the bytes it carries reach only the browser's terminal emulator.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Server } from "bun";
import { policyHeaders } from "../../../lib/app-http";
import { streamGatewayAction } from "../../../lib/gateway-client";
import { SITE_USER_RE } from "../../../lib/site-accounts";
import { stillAuthorized } from "../../../lib/sso-auth";
import { MAX_TERMINAL_SIZE } from "../action";

export const RING_BYTES = 256 * 1024;
/** How long a session waits for its popup to come back before it ends. */
export const DETACHED_GRACE_MS = 60_000;
/** How long a popup that said it was closing has to come back, as on a reload. */
export const CLOSING_GRACE_MS = 5_000;
const START_TIMEOUT_MS = 20_000;
const KEEPALIVE_MS = 15_000;
const AUTH_RECHECK_MS = 15_000;
/** The helper's output is coalesced to 32 KiB, which is under 44 KiB as base64. */
const MAX_LINE_BYTES = 64 * 1024;
/** Login noise tolerated before the helper says it is ready. */
const MAX_PRELUDE_BYTES = 64 * 1024;
/** Input is sent in pieces that stay under the helper's line limit however they escape. */
const INPUT_PIECE = 8 * 1024;
/** A popup this far behind is dropped; it reconnects and replays from the ring. */
const MAX_CLIENT_BACKLOG = 2 * 1024 * 1024;

export type EndReason = "exit" | "closed" | "detached" | "signed-out" | "protocol" | "disconnected";

export interface Owner {
  user: string;
  /** SHA-256 of the CloudPanel session cookie, so a session is tied to one sign-in. */
  cookie: string;
}

export function ownerOf(user: string, sessionId: string): Owner {
  return { user, cookie: createHash("sha256").update(sessionId).digest("hex") };
}

export interface OpenRequest {
  domain: string;
  cols: number;
  rows: number;
  /** The CloudPanel session id, which the gateway checks itself. */
  sessionId: string;
}

export interface TerminalStream {
  write(line: string): void;
  close(): void;
}

export type StreamOpener = (
  request: OpenRequest,
  handlers: { onLine(line: string): void; onClose(error?: string): void },
) => TerminalStream;

export const gatewayOpener: StreamOpener = (request, handlers) =>
  streamGatewayAction({
    addon: "terminal",
    verb: "session",
    args: [`--domain=${request.domain}`, `--cols=${request.cols}`, `--rows=${request.rows}`],
    sessionId: request.sessionId,
    maxLineBytes: MAX_LINE_BYTES,
    onLine: handlers.onLine,
    onClose: handlers.onClose,
  });

export type HelperMessage =
  | { kind: "ready"; user: string; dir: string }
  | { kind: "output"; bytes: Buffer }
  | { kind: "exit"; code: number | null; signal: string | null }
  | { kind: "refused"; error: string };

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PRINTABLE_RE = /^[^\u0000-\u001f\u007f]*$/;

function exactKeys(value: object, keys: string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

/** One line from the stream as a message, or null when it is not exactly one. */
export function parseHelperLine(line: string): HelperMessage | null {
  if (line.length > MAX_LINE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (exactKeys(message, ["o"]) && typeof message.o === "string" && BASE64_RE.test(message.o)) {
    return { kind: "output", bytes: Buffer.from(message.o, "base64") };
  }
  if (exactKeys(message, ["ready"]) && message.ready && typeof message.ready === "object") {
    const ready = message.ready as Record<string, unknown>;
    if (exactKeys(ready, ["user", "dir"]) && typeof ready.user === "string" && SITE_USER_RE.test(ready.user)
      && typeof ready.dir === "string" && ready.dir.length <= 4096 && PRINTABLE_RE.test(ready.dir)) {
      return { kind: "ready", user: ready.user, dir: ready.dir };
    }
    return null;
  }
  if (exactKeys(message, ["exit"]) && message.exit && typeof message.exit === "object") {
    const exit = message.exit as Record<string, unknown>;
    const code = exit.code;
    const signal = exit.signal;
    if (exactKeys(exit, ["code", "signal"])
      && (code === null || (Number.isInteger(code) && (code as number) >= 0 && (code as number) <= 255))
      && (signal === null || (typeof signal === "string" && /^SIG[A-Z0-9]{1,10}$/.test(signal)))) {
      return { kind: "exit", code: code as number | null, signal: signal as string | null };
    }
    return null;
  }
  // The root worker's refusal, written before anything ran as the site user.
  if (exactKeys(message, ["ok", "error"]) && message.ok === false && typeof message.error === "string") {
    return { kind: "refused", error: message.error.slice(0, 500) };
  }
  return null;
}

interface Client {
  send(chunk: string): boolean;
  close(): void;
}

interface Session {
  id: string;
  owner: Owner;
  domain: string;
  user: string;
  state: "starting" | "open" | "ended";
  stream: TerminalStream | null;
  ring: Buffer;
  /** Bytes of output ever received; the ring holds the last of them. */
  offset: number;
  client: Client | null;
  endTimer: ReturnType<typeof setTimeout> | null;
  endAt: number;
  ended: { reason: EndReason; code: number | null } | null;
}

export type OpenResult = { ok: true; id: string; user: string } | { ok: false; error: string };

export interface SessionStoreOptions {
  opener?: StreamOpener;
  authorize?: (req: Request) => Promise<boolean | "unavailable">;
  detachedGraceMs?: number;
  closingGraceMs?: number;
  authRecheckMs?: number;
}

function event(name: string | null, data: string, id?: number): string {
  return `${name ? `event: ${name}\n` : ""}${id !== undefined ? `id: ${id}\n` : ""}data: ${data}\n\n`;
}

function sameOwner(a: Owner, b: Owner): boolean {
  return a.user === b.user && a.cookie === b.cookie;
}

/** Splits text into pieces without separating a surrogate pair. */
function pieces(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + INPUT_PIECE);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    out.push(text.slice(start, end));
    start = end;
  }
  return out;
}

export class TerminalSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly opener: StreamOpener;
  private readonly authorize: (req: Request) => Promise<boolean | "unavailable">;
  private readonly detachedGraceMs: number;
  private readonly closingGraceMs: number;
  private readonly authRecheckMs: number;

  constructor(options: SessionStoreOptions = {}) {
    this.opener = options.opener ?? gatewayOpener;
    this.authorize = options.authorize ?? stillAuthorized;
    this.detachedGraceMs = options.detachedGraceMs ?? DETACHED_GRACE_MS;
    this.closingGraceMs = options.closingGraceMs ?? CLOSING_GRACE_MS;
    this.authRecheckMs = options.authRecheckMs ?? AUTH_RECHECK_MS;
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Start a shell and resolve once it is running, or with why it is not. */
  open(owner: Owner, request: OpenRequest): Promise<OpenResult> {
    const session: Session = {
      id: randomBytes(16).toString("base64url"),
      owner,
      domain: request.domain,
      user: "",
      state: "starting",
      stream: null,
      ring: Buffer.alloc(0),
      offset: 0,
      client: null,
      endTimer: null,
      endAt: Infinity,
      ended: null,
    };
    return new Promise<OpenResult>((resolve) => {
      let settled = false;
      let prelude = 0;
      const settle = (result: OpenResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        if (!result.ok) {
          this.sessions.delete(session.id);
          session.state = "ended";
          session.stream?.close();
        }
        resolve(result);
      };
      const startTimer = setTimeout(() => settle({ ok: false, error: "the terminal did not start in time" }), START_TIMEOUT_MS);

      this.sessions.set(session.id, session);
      session.stream = this.opener(
        { ...request, cols: Math.min(request.cols, MAX_TERMINAL_SIZE), rows: Math.min(request.rows, MAX_TERMINAL_SIZE) },
        {
          onLine: (line) => {
            if (session.state === "ended") return;
            const message = parseHelperLine(line);
            if (session.state === "starting") {
              if (message?.kind === "refused") return settle({ ok: false, error: message.error });
              if (message?.kind !== "ready") {
                prelude += line.length + 1;
                if (prelude > MAX_PRELUDE_BYTES) settle({ ok: false, error: "the terminal sent something unexpected" });
                return;
              }
              session.state = "open";
              session.user = message.user;
              this.scheduleEnd(session, this.detachedGraceMs, "detached");
              return settle({ ok: true, id: session.id, user: session.user });
            }
            if (message?.kind === "output") return this.output(session, message.bytes);
            if (message?.kind === "exit") return this.end(session, "exit", message.code);
            this.end(session, "protocol");
          },
          onClose: (error) => {
            if (session.state === "starting") {
              return settle({ ok: false, error: error ?? "the terminal closed before it started" });
            }
            this.end(session, "disconnected");
          },
        },
      );
    });
  }

  private output(session: Session, bytes: Buffer): void {
    if (bytes.byteLength === 0) return;
    session.offset += bytes.byteLength;
    const joined = Buffer.concat([session.ring, bytes]);
    session.ring = joined.byteLength > RING_BYTES ? joined.subarray(joined.byteLength - RING_BYTES) : joined;
    session.client?.send(event(null, bytes.toString("base64"), session.offset));
  }

  /** Ends the session at the earliest deadline asked for so far; attaching cancels it. */
  private scheduleEnd(session: Session, ms: number, reason: EndReason): void {
    const at = Date.now() + ms;
    if (session.endTimer && session.endAt <= at) return;
    if (session.endTimer) clearTimeout(session.endTimer);
    session.endAt = at;
    session.endTimer = setTimeout(() => {
      if (session.ended) this.sessions.delete(session.id);
      else this.end(session, reason);
    }, ms);
  }

  private cancelEnd(session: Session): void {
    if (session.endTimer) clearTimeout(session.endTimer);
    session.endTimer = null;
    session.endAt = Infinity;
  }

  private end(session: Session, reason: EndReason, code: number | null = null): void {
    if (session.state === "ended") return;
    session.state = "ended";
    session.ended = { reason, code };
    this.cancelEnd(session);
    const stream = session.stream;
    session.stream = null;
    try { stream?.close(); } catch {}
    const client = session.client;
    if (client) {
      session.client = null;
      client.send(event("ended", JSON.stringify(session.ended)));
      client.close();
      this.sessions.delete(session.id);
    } else {
      // Kept for a popup on its way back, so it can show how the shell ended.
      this.scheduleEnd(session, this.detachedGraceMs, reason);
    }
  }

  private find(id: string, owner: Owner): Session | null {
    const session = this.sessions.get(id);
    return session && session.state !== "starting" && sameOwner(session.owner, owner) ? session : null;
  }

  /** Server-sent events for one popup, or null when the session is not this owner's. */
  attach(id: string, owner: Owner, req: Request, server?: Server<unknown> | null): Response | null {
    const session = this.find(id, owner);
    if (!session) return null;
    if (server && typeof server.timeout === "function") {
      try { server.timeout(req, 0); } catch {}
    }
    const lastEventId = req.headers.get("last-event-id");
    let client: Client | null = null;
    let keepalive: ReturnType<typeof setInterval> | null = null;
    let recheck: ReturnType<typeof setInterval> | null = null;
    const stopTimers = () => {
      if (keepalive) clearInterval(keepalive);
      if (recheck) clearInterval(recheck);
      keepalive = null;
      recheck = null;
    };
    const detach = () => {
      stopTimers();
      if (client && session.client === client) {
        session.client = null;
        if (session.state === "open") this.scheduleEnd(session, this.detachedGraceMs, "detached");
      }
    };

    const body = new ReadableStream<string>({
      start: (controller) => {
        let open = true;
        client = {
          send: (chunk) => {
            if (!open) return false;
            try {
              controller.enqueue(chunk);
              if ((controller.desiredSize ?? 0) < -MAX_CLIENT_BACKLOG) {
                client!.close();
                return false;
              }
              return true;
            } catch {
              open = false;
              detach();
              return false;
            }
          },
          close: () => {
            if (!open) return;
            open = false;
            detach();
            try { controller.close(); } catch {}
          },
        };
        // One popup per session: a second one takes over from the first.
        session.client?.close();
        this.cancelEnd(session);
        client.send(event("session", JSON.stringify({ domain: session.domain, user: session.user })));
        const start = session.offset - session.ring.byteLength;
        const from = lastEventId !== null && /^\d{1,15}$/.test(lastEventId) ? Number(lastEventId) : -1;
        if (from >= start && from <= session.offset) {
          if (from < session.offset) client.send(event(null, session.ring.subarray(from - start).toString("base64"), session.offset));
        } else {
          client.send(event("reset", session.ring.toString("base64"), session.offset));
        }
        if (session.state === "ended") {
          client.send(event("ended", JSON.stringify(session.ended)));
          this.sessions.delete(session.id);
          this.cancelEnd(session);
          open = false;
          try { controller.close(); } catch {}
          return;
        }
        session.client = client;
        keepalive = setInterval(() => { client?.send(": keepalive\n\n"); }, KEEPALIVE_MS);
        recheck = setInterval(async () => {
          if (session.client !== client) return;
          if (await this.authorize(req) === false) this.end(session, "signed-out");
        }, this.authRecheckMs);
      },
      cancel: () => {
        detach();
      },
    }, { highWaterMark: 64 * 1024, size: (chunk) => chunk?.length ?? 0 });

    return new Response(body, {
      status: 200,
      headers: policyHeaders("text/event-stream", {
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      }),
    });
  }

  /** Keystrokes and size changes for one session; false when it is not this owner's. */
  input(id: string, owner: Owner, input: { data?: string; size?: [number, number] }): boolean {
    const session = this.find(id, owner);
    if (!session || session.state !== "open" || !session.stream) return session !== null;
    if (input.size) session.stream.write(JSON.stringify({ r: input.size }));
    if (input.data) for (const piece of pieces(input.data)) session.stream.write(JSON.stringify({ i: piece }));
    return true;
  }

  /** The popup is going away; end the session unless it comes straight back. */
  close(id: string, owner: Owner): boolean {
    const session = this.find(id, owner);
    if (!session) return false;
    if (session.state === "open") this.scheduleEnd(session, this.closingGraceMs, "closed");
    return true;
  }
}
