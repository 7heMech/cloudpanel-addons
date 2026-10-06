// Client helper for communicating with the root gateway daemon over UNIX socket.
// Handles both gateway socket IPC and hermetic test runner execution.

import { existsSync } from "node:fs";
import {
  GATEWAY_SOCKET_PATH,
  DEFAULT_CLI_BIN,
  DEFAULT_GATEWAY_TIMEOUT_MS,
  MAX_GATEWAY_INPUT_BYTES,
  type ActionResult,
  type GatewayRequest,
  type PanelSnapshot,
} from "./gateway-protocol";

export type { ActionResult } from "./gateway-protocol";

export interface GatewayClientOptions {
  timeout?: number;
  maxBuffer?: number;
  socketPath?: string;
}

export interface GatewayStream { close(): void }

export interface DuplexGatewayStream extends GatewayStream {
  /** Send one line to a duplex stream's worker; ignored by every other stream. */
  write(line: string): void;
}

interface CommandFailure {
  code?: number | null;
  reason?: string;
}

function parseActionReply<T>(stdout: string): ActionResult<T> | null {
  try {
    const reply: unknown = JSON.parse(stdout.trim());
    if (reply === null || typeof reply !== "object" || Array.isArray(reply)) return null;
    if (typeof (reply as { ok?: unknown }).ok !== "boolean") return null;
    return reply as ActionResult<T>;
  } catch {
    return null;
  }
}

/**
 * Direct process spawn runner used when running as root or under hermetic tests
 * where CLP_ADDONS_ACTION_TEST_BIN is configured.
 */
async function runCommandDirect<T>(
  cmd: string,
  cmdArgs: string[],
  options: { timeout?: number; maxBuffer?: number },
  input?: string,
): Promise<ActionResult<T>> {
  const maxBuffer = options.maxBuffer ?? 8 * 1024 * 1024;
  let child: ReturnType<typeof Bun.spawn>;
  try {
    const stdin = input !== undefined ? new Blob([input]) : "ignore";
    child = Bun.spawn([cmd, ...cmdArgs], {
      stdin,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
      timeout: options.timeout,
      maxBuffer,
    });
  } catch (error) {
    const failure = error as CommandFailure;
    const why = failure.reason ?? "action process failed to start";
    return { ok: false, error: why };
  }

  const stdoutPromise =
    typeof child.stdout === "object" && child.stdout !== null
      ? new Response(child.stdout as ReadableStream).text()
      : Promise.resolve("");
  const stderrPromise =
    typeof child.stderr === "object" && child.stderr !== null
      ? new Response(child.stderr as ReadableStream).text()
      : Promise.resolve("");
  const [stdoutResult, stderrResult, exitResult] = await Promise.allSettled([
    stdoutPromise,
    stderrPromise,
    child.exited,
  ]);
  const stdout = stdoutResult.status === "fulfilled" ? stdoutResult.value : "";
  const stderr = stderrResult.status === "fulfilled" ? stderrResult.value : "";
  const exitCode = exitResult.status === "fulfilled" ? exitResult.value : undefined;
  const outputFailed = stdoutResult.status === "rejected" || stderrResult.status === "rejected";
  const terminated = child.signalCode !== null;
  const outputLimited =
    Buffer.byteLength(stdout, "utf8") > maxBuffer ||
    Buffer.byteLength(stderr, "utf8") > maxBuffer;

  const error: CommandFailure | null =
    exitCode === 0 && !outputFailed && !terminated && !outputLimited
      ? null
      : {
          code: exitCode,
          ...(outputFailed ? { reason: "action output could not be read" } : {}),
          ...(terminated ? { reason: "action process terminated" } : {}),
          ...(outputLimited ? { reason: `action output exceeded ${maxBuffer} bytes` } : {}),
        };

  if (error) {
    const normalNonzeroExit =
      error.reason === undefined &&
      error.code !== undefined &&
      error.code !== null &&
      error.code !== 0;
    const reply = normalNonzeroExit ? parseActionReply<T>(stdout) : null;
    if (reply) {
      if (stderr.trim()) console.error(`[action:${cmdArgs[2] ?? "unknown"}]`, stderr.trim());
      return reply;
    }
    const why = error.reason ?? (stderr.trim() || `action exited ${error.code ?? "abnormally"}`);
    console.error("[action] failed before a valid JSON reply:", why);
    return { ok: false, error: why };
  }

  if (stderr.trim()) console.error(`[action:${cmdArgs[2] ?? "unknown"}]`, stderr.trim());

  const reply = parseActionReply<T>(stdout);
  if (!reply) {
    console.error("[action] produced unparseable stdout:", stdout.slice(0, 500));
    return { ok: false, error: "action returned a malformed reply" };
  }
  return reply;
}

/**
 * Communicates with the root gateway daemon via UNIX domain socket.
 */
async function callGatewaySocket<T>(
  request: GatewayRequest,
  socketPath: string,
  timeoutMs: number,
): Promise<ActionResult<T>> {
  return new Promise<ActionResult<T>>((resolve) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    let socket: { end: () => void; write: (data: string) => void } | null = null;

    const finish = (reply: ActionResult<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.end();
      } catch {
        // already closed
      }
      resolve(reply);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: "gateway socket request timed out" });
    }, timeoutMs);

    const payload = JSON.stringify(request) + "\n";

    Bun.connect({
      unix: socketPath,
      socket: {
        open(connection) {
          socket = connection;
          connection.write(payload);
        },
        data(_connection, chunk) {
          if (total + chunk.byteLength > 16 * 1024 * 1024) {
            finish({ ok: false, error: "gateway response exceeded maximum buffer" });
            return;
          }
          chunks.push(chunk);
          total += chunk.byteLength;
        },
        close() {
          const bytes = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          const text = new TextDecoder().decode(bytes);
          const reply = parseActionReply<T>(text);
          if (reply) {
            finish(reply);
          } else {
            finish({
              ok: false,
              error: text.trim() || "gateway returned an invalid reply",
            });
          }
        },
        error(_socket, err) {
          finish({ ok: false, error: `gateway socket error: ${err ? err.message : "socket error"}` });
        },
        connectError(_socket, err) {
          finish({ ok: false, error: `gateway connection failed: ${err ? err.message : "connect error"}` });
        },
      },
    }).catch((err) => {
      finish({ ok: false, error: `gateway connect error: ${String(err)}` });
    });
  });
}

/**
 * Universal action caller for all manager components.
 * If running in test mode with CLP_ADDONS_ACTION_TEST_BIN or running as root without socket,
 * invokes directly. Otherwise dispatches securely through the root gateway daemon over UNIX socket.
 */
export async function callGatewayAction<T = unknown>(
  addon: "stager" | "instatic" | "cloudflare-ips" | "maintenance" | "php-resources" | "git" | "panel-tweaks" | "wp-login" | "smtp" | "terminal" | "manager",
  verb: string,
  args: string[] = [],
  input?: string,
  options: GatewayClientOptions = {},
): Promise<ActionResult<T>> {
  const socketPath = options.socketPath ?? GATEWAY_SOCKET_PATH;
  const timeoutMs = options.timeout ?? DEFAULT_GATEWAY_TIMEOUT_MS;

  // 1. Hermetic test runner override
  if (process.env.CLP_ADDONS_ACTION_TEST_BIN) {
    return runCommandDirect<T>(
      process.env.CLP_ADDONS_ACTION_TEST_BIN,
      ["action", addon, verb, ...args],
      options,
      input,
    );
  }

  // 2. Direct root execution fallback if socket is absent (e.g. offline testing as root)
  if (process.getuid?.() === 0 && !existsSync(socketPath)) {
    return runCommandDirect<T>(
      DEFAULT_CLI_BIN,
      ["action", addon, verb, ...args],
      options,
      input,
    );
  }

  // 3. Production path: Dispatch to root gateway daemon over UNIX domain socket
  const request: GatewayRequest = {
    kind: "action",
    addon,
    verb,
    args,
    input,
    timeoutMs,
  };

  const clientTimeoutMs = timeoutMs + 2_500;
  return callGatewaySocket<T>(request, socketPath, clientTimeoutMs);
}

const MAX_GATEWAY_STREAM_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_GATEWAY_OUTBOX_BYTES = 1024 * 1024;

function streamReply<T>(line: string): ActionResult<T> | null {
  return parseActionReply<T>(line);
}

/**
 * Runs one long-lived stream action until its child or gateway socket ends.
 *
 * `sessionId` makes it a duplex stream: the gateway checks that CloudPanel
 * session itself, and `write` reaches the worker's stdin. Such a stream has no
 * direct-spawn fallback, because that fallback is the check it would skip.
 */
export function streamGatewayAction<T = unknown>(options: {
  addon: "stager" | "instatic" | "git" | "panel-tweaks" | "terminal" | "manager";
  verb: string;
  args?: string[];
  sessionId?: string;
  socketPath?: string;
  timeoutMs?: number;
  /** The longest line accepted from the stream before it is closed. */
  maxLineBytes?: number;
  /** Each line as it arrived, for a stream whose lines are not action replies. */
  onLine?: (line: string) => void;
  onReply?: (reply: ActionResult<T>) => void;
  onClose: (error?: string) => void;
}): DuplexGatewayStream {
  let socket: Bun.Socket | null = null;
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let closed = false;
  let finished = false;
  let childExited = false;
  let socketEnded = false;
  let buffer = "";
  const decoder = new TextDecoder();
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const maxLineBytes = options.maxLineBytes ?? MAX_GATEWAY_STREAM_BUFFER_BYTES;
  // What the socket has not yet taken, written out again on drain.
  const outbox: Uint8Array[] = [];
  let outboxBytes = 0;
  const encoder = new TextEncoder();

  const endTransport = () => {
    try {
      if (child && !childExited && !child.killed) child.kill();
    } catch {}
    try {
      if (socket && !socketEnded) {
        socketEnded = true;
        socket.end();
      }
    } catch {}
  };

  const finish = (error?: string) => {
    if (finished) return;
    finished = true;
    closed = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    timeoutTimer = null;
    endTransport();
    options.onClose(error);
  };

  const deliver = (chunk: Uint8Array): void => {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (options.onLine) {
        options.onLine(line);
      } else {
        const reply = streamReply<T>(line);
        if (reply) options.onReply?.(reply);
      }
      if (closed) break;
    }
    if (Buffer.byteLength(buffer, "utf8") > maxLineBytes) {
      finish("gateway stream exceeded maximum buffer");
    }
  };

  const flushOutbox = () => {
    while (socket && outbox.length > 0 && !closed) {
      const next = outbox[0]!;
      const written = Math.max(0, socket.write(next));
      outboxBytes -= Math.min(written, next.byteLength);
      if (written >= next.byteLength) {
        outbox.shift();
        continue;
      }
      if (written > 0) outbox[0] = next.subarray(written);
      return;
    }
  };

  const write = (line: string) => {
    if (closed || options.sessionId === undefined) return;
    const bytes = encoder.encode(line.endsWith("\n") ? line : `${line}\n`);
    // A worker that stops reading must not grow this process without bound.
    if (outboxBytes + bytes.byteLength > MAX_GATEWAY_OUTBOX_BYTES) return finish("the stream stopped taking input");
    outbox.push(bytes);
    outboxBytes += bytes.byteLength;
    if (outbox.length === 1) flushOutbox();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    timeoutTimer = null;
    endTransport();
  };

  const stream: DuplexGatewayStream = { close, write };
  if (options.timeoutMs !== undefined) {
    timeoutTimer = setTimeout(() => finish("gateway stream request timed out"), options.timeoutMs);
  }
  const socketPath = options.socketPath ?? GATEWAY_SOCKET_PATH;
  const payload = JSON.stringify({
    kind: "stream-action",
    addon: options.addon,
    verb: options.verb,
    args: options.args,
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
  }) + "\n";

  const direct = Boolean(process.env.CLP_ADDONS_ACTION_TEST_BIN) || (process.getuid?.() === 0 && !existsSync(socketPath));
  if (direct && options.sessionId !== undefined) {
    queueMicrotask(() => finish("this stream needs the root gateway"));
    return stream;
  }
  if (direct) {
    const command = process.env.CLP_ADDONS_ACTION_TEST_BIN ?? DEFAULT_CLI_BIN;
    void (async () => {
      try {
        child = Bun.spawn([command, "action", options.addon, options.verb, ...(options.args ?? [])], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "inherit",
          env: process.env,
        });
        if (closed) {
          endTransport();
          await child.exited.then(() => { childExited = true; }, () => undefined);
          if (!finished) finish();
          return;
        }
        if (typeof child.stdout !== "object" || child.stdout === null) {
          throw new Error("streaming action did not provide stdout");
        }
        const reader = child.stdout.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done || closed) break;
          deliver(value);
          if (finished) break;
        }
        await child.exited.then(() => { childExited = true; }, () => undefined);
        if (!finished) finish();
      } catch (error) {
        finish(error instanceof Error ? error.message : String(error));
      }
    })();
    return stream;
  }

  Bun.connect({
    unix: socketPath,
    socket: {
      open(connection) {
        socket = connection;
        if (closed) {
          endTransport();
          return;
        }
        connection.write(payload);
        flushOutbox();
      },
      data(_connection, chunk) {
        if (!closed) deliver(chunk);
      },
      drain() {
        flushOutbox();
      },
      close() {
        finish();
      },
      error(_connection, error) {
        finish(`gateway socket error: ${error ? error.message : "socket error"}`);
      },
      connectError(_connection, error) {
        finish(`gateway connection failed: ${error ? error.message : "connect error"}`);
      },
    },
  }).catch((error) => {
    finish(`gateway connect error: ${String(error)}`);
  });

  return stream;
}

/**
 * Fetches current panel information through the root gateway socket, or directly
 * in a root process when the configured socket is absent. Failures are returned
 * as unsuccessful action results.
 */
export async function callGatewayPanelInfo(
  options: GatewayClientOptions = {},
): Promise<ActionResult<PanelSnapshot>> {
  const socketPath = options.socketPath ?? GATEWAY_SOCKET_PATH;
  const timeoutMs = options.timeout ?? 5_000;

  // 1. Direct root execution fallback if socket is absent (e.g. offline execution as root)
  if (process.getuid?.() === 0 && !existsSync(socketPath)) {
    try {
      const { getLivePanelInfo } = await import("./panel-snapshot");
      const info = getLivePanelInfo();
      return { ok: true, data: info };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // 2. Dispatch over UNIX domain socket to root gateway daemon
  const request: GatewayRequest = { kind: "panel-info" };
  return callGatewaySocket<PanelSnapshot>(request, socketPath, timeoutMs);
}

/**
 * Communicates with the root gateway daemon to validate a session.
 * Used by SSO authentication.
 */
export async function callGatewayAuth(
  sessionId: string,
  socketPath: string = GATEWAY_SOCKET_PATH,
  timeoutMs: number = 5_000,
): Promise<string> {
  return new Promise<string>((resolve) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    let socket: { end: () => void; write: (data: string) => void } | null = null;

    const finish = (reply: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.end();
      } catch {
        // already closed
      }
      resolve(reply);
    };

    const timer = setTimeout(() => {
      finish("");
    }, timeoutMs);

    const payload = JSON.stringify({ kind: "auth", sessionId }) + "\n";

    Bun.connect({
      unix: socketPath,
      socket: {
        open(connection) {
          socket = connection;
          connection.write(payload);
        },
        data(_connection, chunk) {
          if (total + chunk.byteLength > 64 * 1024) {
            finish("");
            return;
          }
          chunks.push(chunk);
          total += chunk.byteLength;
        },
        close() {
          const bytes = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          finish(new TextDecoder().decode(bytes));
        },
        error() {
          finish("");
        },
        connectError() {
          finish("");
        },
      },
    }).catch(() => {
      finish("");
    });
  });
}
