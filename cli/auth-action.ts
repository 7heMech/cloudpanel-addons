// Root-only action used by the unprivileged manager to validate a CloudPanel
// session file. The CLI entrypoint is the only production caller; the optional
// directory/owner arguments exist solely for hermetic unit tests and are never
// exposed through action argv or stdin.

import { requireRoot } from "./util";
import { SESSION_DIR } from "./paths";
import {
  MAX_SESSION_ID_LENGTH,
  parsePanelSession,
  readPanelSessionFile,
} from "../lib/sso-auth";

export const MAX_AUTH_INPUT_BYTES = MAX_SESSION_ID_LENGTH + 1;
export const MAX_AUTH_REPLY_BYTES = 32 * 1024;
const AUTH_STDIN_TIMEOUT_MS = 2_000;

const SESSION_ID_RE = /^[a-zA-Z0-9,-]+$/;

export interface AuthActionOptions {
  /** Test-only fixed-directory override; the CLI always uses SESSION_DIR. */
  sessionDir?: string;
  /** Test-only owner override; production uses readPanelSessionFile's clp UID. */
  ownerUid?: number | null;
}

function invalidReply(): string {
  return '{"valid":false}\n';
}

function decodeInput(input: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    return null;
  }
}

/**
 * Validate one bounded stdin request and return the only stdout contract the
 * manager understands. Errors deliberately collapse to the same invalid
 * marker so no filesystem path or serialized session detail is disclosed.
 */
export async function runAuthAction(
  input: Uint8Array | string,
  options: AuthActionOptions = {},
): Promise<string> {
  try {
    const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
    if (bytes.byteLength > MAX_AUTH_INPUT_BYTES) return invalidReply();
    const text = decodeInput(bytes);
    const match = text?.match(/^([a-zA-Z0-9,-]{1,128})\n$/);
    if (!match || !SESSION_ID_RE.test(match[1]!)) return invalidReply();

    const sessionDir = options.sessionDir ?? SESSION_DIR;
    const sessionPath = `${sessionDir}/sess_${match[1]}`;
    const sessionBytes = await readPanelSessionFile(sessionPath, {
      ownerUid: options.ownerUid,
      warn: () => {},
    });
    const session = sessionBytes ? parsePanelSession(sessionBytes) : null;
    if (!session) return invalidReply();

    const reply = JSON.stringify({
      valid: true,
      user: session.user,
      roles: session.roles,
      expiresAt: session.expiresAt,
    }) + "\n";
    return Buffer.byteLength(reply, "utf8") <= MAX_AUTH_REPLY_BYTES ? reply : invalidReply();
  } catch {
    return invalidReply();
  }
}

async function readBoundedStdin(): Promise<Uint8Array | null> {
  try {
    const reader = Bun.stdin.stream().getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<IteratorResult<Uint8Array>>((resolve) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        void reader.cancel();
        resolve({ done: true, value: undefined as never });
      }, AUTH_STDIN_TIMEOUT_MS);
    });
    try {
      while (true) {
        const next = await Promise.race([reader.read(), timeout]);
        if (timedOut) return null;
        if (next.done) break;
        const chunk = next.value;
        if (!(chunk instanceof Uint8Array) || total + chunk.byteLength > MAX_AUTH_INPUT_BYTES) {
          await reader.cancel();
          return null;
        }
        chunks.push(chunk);
        total += chunk.byteLength;
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      reader.releaseLock();
    }
  } catch {
    return null;
  }
}

/** CLI entrypoint for `clp-addons action auth`; it accepts no argv fields. */
export async function runAuthActionStdin(argv: string[] = []): Promise<number> {
  requireRoot("auth");
  if (argv.length !== 0) {
    process.stdout.write(invalidReply());
    return 1;
  }
  const input = await readBoundedStdin();
  process.stdout.write(await runAuthAction(input ?? new Uint8Array()));
  return 0;
}
