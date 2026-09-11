// Root-only action used by the unprivileged manager to validate a CloudPanel
// session file and authorize against CloudPanel's database. The CLI entrypoint
// is the only production caller; the optional directory/owner/db/listen arguments
// exist solely for hermetic unit tests and are never exposed through action argv.

import net from "node:net";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { requireRoot } from "./util";
import { PANEL_DB, SESSION_DIR } from "./paths";
import {
  MAX_SESSION_ID_LENGTH,
  parsePanelSession,
  readPanelSessionFile,
} from "../lib/sso-auth";

export const MAX_AUTH_INPUT_BYTES = MAX_SESSION_ID_LENGTH + 1;
export const MAX_AUTH_REPLY_BYTES = 32 * 1024;
const AUTH_STDIN_TIMEOUT_MS = 2_000;

const SESSION_ID_RE = /^[a-zA-Z0-9,-]+$/;
const ROLE_RE = /^ROLE_[A-Z0-9_]{1,120}$/;

export interface AuthActionOptions {
  /** Test-only fixed-directory override; the CLI always uses SESSION_DIR. */
  sessionDir?: string;
  /** Test-only owner override; production uses readPanelSessionFile's clp UID. */
  ownerUid?: number | null;
  /** Test-only database override; production uses PANEL_DB. */
  panelDb?: string;
  /** Test-only socket path override for daemon mode; production uses systemd FD 3. */
  listenPath?: string;
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
 * Look up a user's active role directly from CloudPanel's SQLite user table.
 * Returns the role string if the user exists, is active (status = 1), and has a valid role.
 * Returns null otherwise.
 */
export function lookupUserRole(dbPath: string, username: string): string | null {
  try {
    if (!existsSync(dbPath)) return null;
    const db = new Database(dbPath, { readonly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000;");
      const row = db.query<{ role: string | null; status: number | boolean | null }, [string]>(
        "SELECT role, status FROM user WHERE user_name = ?"
      ).get(username);
      if (!row) return null;
      const status = typeof row.status === "boolean" ? (row.status ? 1 : 0) : Number(row.status);
      if (status !== 1) return null;
      const role = typeof row.role === "string" ? row.role : null;
      if (!role || !ROLE_RE.test(role)) return null;
      return role;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Validate one bounded request:
 * 1. Read and structurally parse the CloudPanel session file to authenticate the user and expiry.
 * 2. If CloudPanel's database exists, authoritatively check user status and role from the database.
 * 3. Return the bounded JSON contract the manager understands.
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

    const dbPath = options.panelDb ?? PANEL_DB;
    let roles = session.roles;
    if (existsSync(dbPath)) {
      const dbRole = lookupUserRole(dbPath, session.user);
      if (!dbRole) return invalidReply();
      roles = [dbRole];
    }

    const reply = JSON.stringify({
      valid: true,
      user: session.user,
      roles,
      expiresAt: session.expiresAt,
    }) + "\n";
    return Buffer.byteLength(reply, "utf8") <= MAX_AUTH_REPLY_BYTES ? reply : invalidReply();
  } catch {
    return invalidReply();
  }
}

/**
 * Create a socket server that handles authentication requests.
 * Each connection sends one line containing the session ID, gets a JSON reply, and closes.
 */
export function createAuthActionServer(options: AuthActionOptions = {}): net.Server {
  return net.createServer((socket) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let closed = false;

    const timeout = setTimeout(() => {
      if (!closed) {
        closed = true;
        socket.end(invalidReply());
      }
    }, AUTH_STDIN_TIMEOUT_MS);

    socket.on("data", async (chunk: Buffer) => {
      if (closed) return;
      if (total + chunk.byteLength > MAX_AUTH_INPUT_BYTES) {
        closed = true;
        clearTimeout(timeout);
        socket.end(invalidReply());
        return;
      }
      chunks.push(chunk);
      total += chunk.byteLength;
      if (chunk.includes(10)) {
        closed = true;
        clearTimeout(timeout);
        const full = Buffer.concat(chunks, total);
        const reply = await runAuthAction(full, options);
        socket.end(reply);
      }
    });

    socket.on("error", () => {
      clearTimeout(timeout);
    });
  });
}

/**
 * Run the long-lived daemon activated by systemd.
 * When activated by systemd, systemd passes the listening socket as FD 3 (LISTEN_FDS=1).
 */
export async function runAuthActionDaemon(options: AuthActionOptions = {}): Promise<void> {
  const server = createAuthActionServer(options);

  return new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.on("close", resolve);

    const stop = () => {
      server.close();
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);

    if (options.listenPath) {
      server.listen(options.listenPath);
    } else {
      server.listen({ fd: 3 });
    }
  });
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
        if (chunk.includes(10)) break;
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
export async function runAuthActionStdin(argv: string[] = [], options: AuthActionOptions = {}): Promise<number> {
  requireRoot("auth");
  if (argv.length !== 0) {
    process.stdout.write(invalidReply());
    return 1;
  }
  if (process.env.LISTEN_FDS || options.listenPath) {
    await runAuthActionDaemon(options);
    return 0;
  }
  const input = await readBoundedStdin();
  process.stdout.write(await runAuthAction(input ?? new Uint8Array(), options));
  return 0;
}
