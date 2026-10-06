// Root-only action used by the unprivileged manager to validate a CloudPanel
// session file, authorize against CloudPanel's database, and dispatch privileged
// addon actions through the root gateway. The CLI entrypoint is the only
// production caller; optional directory/owner/db/listen arguments exist solely
// for hermetic unit tests and are never exposed through action argv.

import net from "node:net";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dlopen, FFIType } from "bun:ffi";
import { Database } from "bun:sqlite";
import { requireRoot } from "./util";
import { CLI_BIN, PANEL_DB, SERVICE_GROUP, SERVICE_USER, SESSION_DIR } from "./paths";
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
  MAINTENANCE_ALLOWED_VERBS,
  GIT_ALLOWED_VERBS,
  CLOUDFLARE_IPS_ALLOWED_VERBS,
  SMTP_ALLOWED_VERBS,
  PHP_RESOURCES_ALLOWED_VERBS,
  PANEL_TWEAKS_ALLOWED_VERBS,
  WP_LOGIN_ALLOWED_VERBS,
  MANAGER_ALLOWED_VERBS,
  STREAM_ALLOWED_VERBS,
  DUPLEX_STREAM_VERBS,
  TERMINAL_ALLOWED_VERBS,
  DUPLEX_WORKER_MARKER,
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
  ["maintenance", MAINTENANCE_ALLOWED_VERBS],
  ["git", GIT_ALLOWED_VERBS],
  ["cloudflare-ips", CLOUDFLARE_IPS_ALLOWED_VERBS],
  ["smtp", SMTP_ALLOWED_VERBS],
  ["php-resources", PHP_RESOURCES_ALLOWED_VERBS],
  ["panel-tweaks", PANEL_TWEAKS_ALLOWED_VERBS],
  ["wp-login", WP_LOGIN_ALLOWED_VERBS],
  ["terminal", TERMINAL_ALLOWED_VERBS],
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
  /** Test-only panel info reader override. */
  getPanelInfo?: (panelDb?: string) => import("../lib/gateway-protocol").PanelSnapshot;
  /** Test-only override; production socket activation always enforces the peer check. */
  enforcePeer?: boolean;
  /** Test-only child-process override for streaming; production uses Bun.spawn. */
  spawn?: typeof Bun.spawn;
  /** Test-only; production rechecks a duplex stream's session every 15 seconds. */
  sessionRecheckMs?: number;
}

const SOL_SOCKET = 1;
const SO_PEERCRED = 17;
const PEER_CREDENTIAL_BYTES = 12;

const peerCredLibc = process.platform === "linux"
  ? dlopen("libc.so.6", {
      getsockopt: {
        args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.pointer, FFIType.pointer],
        returns: FFIType.i32,
      },
    })
  : null;

function accountId(path: string, name: string, field: number): number | null {
  try {
    const line = readFileSync(path, "utf-8").split("\n").find((entry) => entry.startsWith(`${name}:`));
    const value = Number.parseInt(line?.split(":")[field] ?? "", 10);
    return Number.isInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Check the process at the other end of a gateway connection. Socket mode and
 * group membership keep ordinary users out, but every process running as
 * clp-addons would otherwise be able to submit an allowed root action. Linux
 * exposes the peer PID/UID/GID through SO_PEERCRED; bind that credential to the
 * root-owned executable that systemd starts for the manager. A copied or
 * unrelated process under the same account therefore fails closed.
 */
export function trustedManagerPeer(socket: net.Socket): boolean {
  if (!peerCredLibc) return false;
  const fd = Number((socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd);
  if (!Number.isInteger(fd) || fd < 0) return false;
  const credentials = new Int32Array(3);
  const length = new Uint32Array([PEER_CREDENTIAL_BYTES]);
  try {
    if (peerCredLibc.symbols.getsockopt(fd, SOL_SOCKET, SO_PEERCRED, credentials, length) !== 0
      || length[0]! < PEER_CREDENTIAL_BYTES) return false;
    const [pid, uid, gid] = credentials;
    const expectedUid = accountId("/etc/passwd", SERVICE_USER, 2);
    const expectedGid = accountId("/etc/group", SERVICE_GROUP, 2);
    if (pid === undefined || uid === undefined || gid === undefined
      || expectedUid === null || expectedGid === null
      || uid !== expectedUid || gid !== expectedGid || pid <= 0) return false;

    const binary = lstatSync(CLI_BIN);
    if (!binary.isFile() || binary.uid !== 0 || (binary.mode & 0o022) !== 0 || (binary.mode & 0o111) === 0) return false;
    const procExe = readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, "");
    if (procExe !== realpathSync(CLI_BIN)) return false;
    const procStat = statSync(`/proc/${pid}/exe`);
    if (!procStat.isFile() || procStat.uid !== 0 || (procStat.mode & 0o022) !== 0 || (procStat.mode & 0o111) === 0) return false;
    return true;
  } catch {
    return false;
  }
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

/** How often a duplex stream's panel session is checked again. */
const SESSION_RECHECK_MS = 15_000;
/** How long a stream's worker has after SIGTERM before it is killed. */
const STREAM_KILL_GRACE_MS = 5_000;
/** All a duplex worker inherits; it starts nothing that needs more. */
const DUPLEX_WORKER_ENV = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  [DUPLEX_WORKER_MARKER]: "1",
};
/** How long a duplex worker may leave its stdin full before the stream is ended. */
const STALLED_INPUT_MS = 30_000;
/** How long output may keep arriving after a duplex worker has exited. */
const OUTPUT_AFTER_EXIT_MS = 1_000;

/** The panel user behind a session, when it is an active administrator's. */
async function adminSessionUser(sessionId: string, options: AuthActionOptions): Promise<string | null> {
  try {
    const reply = JSON.parse(await runAuthAction(sessionId + "\n", options)) as {
      valid?: unknown; user?: unknown; roles?: unknown;
    };
    if (reply.valid !== true || typeof reply.user !== "string") return null;
    return Array.isArray(reply.roles) && reply.roles.includes("ROLE_ADMIN") ? reply.user : null;
  } catch {
    return null;
  }
}

interface DuplexInput {
  /** The session the stream was opened with, checked again while it runs. */
  sessionId: string;
  /** Bytes that arrived before the worker did. */
  pending: Buffer[];
  /** Route every later socket byte to the worker's stdin. */
  attach: (write: (bytes: Buffer) => void) => void;
}

/**
 * Run one stream action and copy its stdout to the socket until either ends.
 *
 * A duplex stream also gets the socket's bytes on the worker's stdin, opaque
 * and in order, with the socket paused while the pipe is full. Its session is
 * checked again on a timer, and the worker is stopped when that check fails:
 * the manager is not trusted to end a shell whose operator has signed out.
 */
async function runStreamAction(
  socket: net.Socket,
  argv: string[],
  options: AuthActionOptions,
  duplex: DuplexInput | null,
): Promise<void> {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let stopping = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let recheck: ReturnType<typeof setInterval> | null = null;
  let endInput = () => {};
  const stop = () => {
    stopping = true;
    if (recheck) clearInterval(recheck);
    recheck = null;
    endInput();
    if (!proc || proc.exitCode !== null || proc.signalCode !== null || killTimer) return;
    const running = proc;
    try { running.kill("SIGTERM"); } catch {}
    killTimer = setTimeout(() => {
      try { if (running.exitCode === null && running.signalCode === null) running.kill("SIGKILL"); } catch {}
    }, STREAM_KILL_GRACE_MS);
    void running.exited.finally(() => { if (killTimer) clearTimeout(killTimer); });
  };
  socket.on("close", stop);
  socket.on("error", stop);

  try {
    proc = (options.spawn ?? Bun.spawn)(argv, duplex
      ? { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: DUPLEX_WORKER_ENV }
      : { stdin: "ignore", stdout: "pipe", stderr: "inherit", env: process.env });
    if (stopping || socket.destroyed) stop();

    if (duplex) {
      const sink = proc.stdin as import("bun").FileSink;
      let inputOpen = true;
      // The helper's EOF is what hangs its shell up, whoever ends the stream.
      endInput = () => {
        if (!inputOpen) return;
        inputOpen = false;
        try { void Promise.resolve(sink.end()).catch(() => {}); } catch {}
      };
      const write = (bytes: Buffer) => {
        if (!inputOpen) return;
        try {
          sink.write(bytes);
          const flushed = sink.flush();
          if (flushed instanceof Promise) {
            // A paused socket does not see its peer go, so a worker that never
            // reads cannot hold the stream open past this.
            socket.pause();
            const stalled = setTimeout(() => { stop(); socket.destroy(); }, STALLED_INPUT_MS);
            flushed.then(
              () => { clearTimeout(stalled); socket.resume(); },
              () => { clearTimeout(stalled); endInput(); socket.resume(); },
            );
          }
        } catch {
          endInput();
        }
      };
      for (const bytes of duplex.pending) write(bytes);
      duplex.pending.length = 0;
      duplex.attach(write);
      socket.on("end", endInput);
      const { sessionId } = duplex;
      recheck = setInterval(async () => {
        if (stopping) return;
        if (await adminSessionUser(sessionId, options)) return;
        stop();
        if (!socket.destroyed) socket.end();
      }, options.sessionRecheckMs ?? SESSION_RECHECK_MS);
    }

    if (typeof proc.stdout !== "object" || proc.stdout === null) {
      throw new Error("streaming action did not provide stdout");
    }
    const reader = proc.stdout.getReader();
    if (duplex) {
      // Something the site started can hold the pipe open after the worker
      // has gone; the stream ends with the worker, not with that.
      void proc.exited.then(() => setTimeout(() => { void reader.cancel().catch(() => {}); }, OUTPUT_AFTER_EXIT_MS));
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done || socket.destroyed) break;
      if (!socket.write(Buffer.from(value))) {
        await new Promise<void>((resolve, reject) => {
          const cleanupBackpressure = () => {
            socket.off("drain", onDrain);
            socket.off("close", onClose);
            socket.off("error", onError);
          };
          const onDrain = () => {
            cleanupBackpressure();
            resolve();
          };
          const onClose = () => {
            cleanupBackpressure();
            resolve();
          };
          const onError = (error: Error) => {
            cleanupBackpressure();
            reject(error);
          };
          socket.once("drain", onDrain);
          socket.once("close", onClose);
          socket.once("error", onError);
          if (socket.destroyed) onClose();
        });
        if (socket.destroyed) break;
      }
    }
    if (recheck) clearInterval(recheck);
    recheck = null;
    if (!socket.destroyed) socket.end();
    else stop();
  } catch (error) {
    stop();
    if (!socket.destroyed) {
      socket.end(JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }) + "\n");
    }
  }
}

/**
 * Creates a socket server for authentication, live panel information, and
 * privileged action requests. Each connection sends one line containing either
 * a session ID or a JSON request, receives one or more JSON replies, and closes.
 */
export function createAuthActionServer(options: AuthActionOptions = {}): net.Server {
  // Direct path listeners are test-only; socket activation is the production
  // path and always requests the executable-bound peer check.
  const enforcePeer = options.enforcePeer ?? Boolean(process.env.LISTEN_FDS);
  return net.createServer((socket) => {
    if (enforcePeer && !trustedManagerPeer(socket)) {
      // Bun's net implementation may keep an accepted socket alive after an
      // early `end()` when no data listener was attached. Explicitly destroy
      // after the bounded failure reply so rejected peers cannot hold gateway
      // connections open until the idle timeout.
      socket.end(JSON.stringify({ ok: false, error: "untrusted peer" }) + "\n", () => socket.destroy());
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let closed = false;
    // Set once a duplex stream has been accepted: every later byte from the
    // manager is the worker's stdin, copied and never read here.
    let forward: ((bytes: Buffer) => void) | null = null;

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
      if (forward) {
        forward(chunk);
        return;
      }
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
        const received = Buffer.concat(chunks, total);
        const lineEnd = received.indexOf(10) + 1;
        const trailing = received.subarray(lineEnd);
        const request = parseGatewayRequest(received.subarray(0, lineEnd).toString("utf8"));
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
            const fetchInfo = options.getPanelInfo ?? getLivePanelInfo;
            const info = fetchInfo(options.panelDb);
            socket.end(JSON.stringify({ ok: true, data: info }) + "\n");
          } catch (error) {
            console.error("[gateway] panel-info failed:", error);
            socket.end(
              JSON.stringify({
                ok: false,
                error: "failed to retrieve panel information",
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
          // A duplex verb is only ever a stream: this path checks no session
          // and would hand the worker the manager's own arguments and stdin.
          if (!allowed.has(request.verb) || DUPLEX_STREAM_VERBS.has(`${request.addon}:${request.verb}`)) {
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

        if (request.kind === "stream-action") {
          const allowed = ALLOWED_VERBS.get(request.addon);
          if (!allowed) {
            socket.end(JSON.stringify({ ok: false, error: "unknown addon" }) + "\n");
            return;
          }
          if (!allowed.has(request.verb) || !STREAM_ALLOWED_VERBS.has(request.verb)) {
            socket.end(JSON.stringify({ ok: false, error: "invalid verb" }) + "\n");
            return;
          }
          const duplex = DUPLEX_STREAM_VERBS.has(`${request.addon}:${request.verb}`);
          if (duplex !== (request.sessionId !== undefined)) {
            socket.end(JSON.stringify({ ok: false, error: duplex ? "a panel session is required" : "invalid verb" }) + "\n");
            return;
          }
          cleanup();
          if (!duplex) {
            await runStreamAction(socket, [CLI_BIN, "action", request.addon, request.verb, ...(request.args ?? [])], options, null);
            return;
          }
          // Held until the worker exists, then handed to it in order.
          const pending: Buffer[] = trailing.byteLength > 0 ? [trailing] : [];
          let held = trailing.byteLength;
          forward = (bytes) => {
            held += bytes.byteLength;
            if (held > MAX_GATEWAY_INPUT_BYTES) socket.destroy();
            else pending.push(bytes);
          };
          const args = request.args ?? [];
          if (args.some((arg) => arg.startsWith("--panel-user"))) {
            socket.end(JSON.stringify({ ok: false, error: "invalid arguments" }) + "\n");
            return;
          }
          const user = await adminSessionUser(request.sessionId!, options);
          if (!user) {
            socket.end(JSON.stringify({ ok: false, error: "the panel session is not an active administrator's" }) + "\n");
            return;
          }
          await runStreamAction(
            socket,
            [CLI_BIN, "action", request.addon, request.verb, ...args, `--panel-user=${user}`],
            options,
            {
              sessionId: request.sessionId!,
              pending,
              attach: (write) => { forward = write; },
            },
          );
          return;
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
  const server = createAuthActionServer({ ...options, enforcePeer: true });

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
