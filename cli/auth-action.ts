// Root-only action used by the unprivileged manager to validate a CloudPanel
// session file, authorize against CloudPanel's database, and dispatch privileged
// addon actions through the root gateway. The CLI entrypoint is the only
// production caller; optional directory/owner/db/listen arguments exist solely
// for hermetic unit tests and are never exposed through action argv.

import net from "node:net";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { requireRoot } from "./util";
import { CLI_BIN, PANEL_DB, SESSION_DIR } from "./paths";
import {
  MAX_SESSION_ID_LENGTH,
  parsePanelSession,
  readPanelSessionFile,
} from "../lib/sso-auth";
import {
  parseGatewayRequest,
  MAX_GATEWAY_INPUT_BYTES,
  DEFAULT_GATEWAY_TIMEOUT_MS,
  STAGER_ALLOWED_VERBS,
  INSTATIC_ALLOWED_VERBS,
  MANAGER_ALLOWED_VERBS,
} from "../lib/gateway-protocol";
import { getLivePanelInfo } from "../lib/panel-snapshot";

export const MAX_AUTH_INPUT_BYTES = MAX_SESSION_ID_LENGTH + 1;
export const MAX_AUTH_REPLY_BYTES = 32 * 1024;
const AUTH_STDIN_TIMEOUT_MS = 2_000;

// A Map rather than an object literal: the key comes off the wire, and
// `{}["constructor"]` is truthy.
const ALLOWED_VERBS = new Map<string, Set<string>>([
  ["stager", STAGER_ALLOWED_VERBS],
  ["instatic", INSTATIC_ALLOWED_VERBS],
  ["manager", MANAGER_ALLOWED_VERBS],
]);

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
    let sessionId: string | null = null;
    const match = text?.match(/^([a-zA-Z0-9,-]{1,128})\n$/);
    if (match) {
      sessionId = match[1]!;
    } else if (text?.trim().startsWith("{")) {
      try {
        const obj = JSON.parse(text.trim());
        if (obj.kind === "auth" && typeof obj.sessionId === "string") {
          sessionId = obj.sessionId;
        }
      } catch {}
    }
    if (!sessionId || !SESSION_ID_RE.test(sessionId)) return invalidReply();

    const sessionDir = options.sessionDir ?? SESSION_DIR;
    const sessionPath = `${sessionDir}/sess_${sessionId}`;
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
 * Creates a socket server for authentication, live panel information, and
 * privileged action requests. Each connection sends one line containing either
 * a session ID or a JSON request, receives a JSON reply, and closes.
 */
export function createAuthActionServer(options: AuthActionOptions = {}): net.Server {
  return net.createServer((socket) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let closed = false;

    let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      if (!closed) {
        closed = true;
        socket.end(invalidReply());
      }
    }, 10_000);

    const cleanup = () => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
    };

    socket.on("data", async (chunk: Buffer) => {
      if (closed) return;
      if (total + chunk.byteLength > MAX_GATEWAY_INPUT_BYTES) {
        closed = true;
        cleanup();
        socket.end(invalidReply());
        return;
      }
      chunks.push(chunk);
      total += chunk.byteLength;
      if (chunk.includes(10)) {
        closed = true;
        cleanup();
        const full = Buffer.concat(chunks, total).toString("utf8");
        const request = parseGatewayRequest(full);
        if (!request) {
          socket.end(invalidReply());
          return;
        }

        if (request.kind === "auth") {
          const reply = await runAuthAction(request.sessionId + "\n", options);
          socket.end(reply);
          return;
        }

        if (request.kind === "panel-info") {
          try {
            const info = getLivePanelInfo(options.panelDb);
            socket.end(JSON.stringify({ ok: true, data: info }) + "\n");
          } catch (error) {
            socket.end(
              JSON.stringify({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }) + "\n",
            );
          }
          return;
        }

        if (request.kind === "action") {
          // "manager" is not an addon; it is this project's own provisioning,
          // reached through the same gateway because enabling an addon and
          // replacing the binary are root work requested from an unprivileged
          // web process.
          const allowed = ALLOWED_VERBS.get(request.addon);
          if (!allowed) {
            socket.end(JSON.stringify({ ok: false, error: "unknown addon" }) + "\n");
            return;
          }
          if (!allowed.has(request.verb)) {
            socket.end(JSON.stringify({ ok: false, error: "invalid verb" }) + "\n");
            return;
          }

          const actionTimeout = request.timeoutMs ?? DEFAULT_GATEWAY_TIMEOUT_MS;
          timeout = setTimeout(() => {
            try {
              socket.end(JSON.stringify({ ok: false, error: "action execution timed out" }) + "\n");
            } catch {
              // already closed
            }
          }, actionTimeout + 2_000);

          try {
            const stdin = request.input !== undefined ? new Blob([request.input]) : "ignore";
            const proc = Bun.spawn(
              [CLI_BIN, "action", request.addon, request.verb, ...(request.args ?? [])],
              {
                stdin,
                stdout: "pipe",
                stderr: "pipe",
                env: process.env,
                timeout: actionTimeout,
                maxBuffer: 16 * 1024 * 1024,
              },
            );

            const [stdout, stderr, exitCode] = await Promise.all([
              proc.stdout.text(),
              proc.stderr.text(),
              proc.exited,
            ]);
            cleanup();

            const trimmed = stdout.trim();
            if (trimmed.startsWith("{")) {
              socket.end(trimmed + "\n");
            } else {
              const err =
                stderr.trim() ||
                (exitCode !== 0
                  ? `action process exited with code ${exitCode}`
                  : "action returned non-json output");
              socket.end(JSON.stringify({ ok: false, error: err }) + "\n");
            }
          } catch (err) {
            cleanup();
            socket.end(
              JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              }) + "\n",
            );
          }
        }
      }
    });

    socket.on("error", () => {
      cleanup();
      try {
        socket.destroy();
      } catch {
        // ignore
      }
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
