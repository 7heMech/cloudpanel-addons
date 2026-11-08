import { errorMessage } from "./errors";
import { AUTH_SOCKET_PATH, CLI_BIN } from "./paths";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import {
  callerMay, webVerb, DEFAULT_GATEWAY_TIMEOUT_MS, type ActionResult,
  type GatewayAddon, type GatewayRequest, type PanelSnapshot, type StreamVerb, type WebVerb,
} from "./gateway-protocol";

export type { ActionResult } from "./gateway-protocol";

/**
 * Nothing here checks the action's JSON. A caller states the shape it expects
 * by the type it gives the result, such as its own `Promise<ActionResult<T>>`;
 * `never` makes it say so, and keeps the call free of a type argument, which
 * would stop the addon and verb being checked together.
 */
type GatewayReply = ActionResult<never>;

export interface GatewayClientOptions {
  timeout?: number;
  maxBuffer?: number;
  socketPath?: string;
  /**
   * For an `own-account` verb: the CloudPanel session the gateway checks
   * itself. Such an action has no direct-spawn fallback, because that fallback
   * is the check it would skip.
   */
  sessionId?: string;
}

export interface GatewayStream { close(): void }

interface DuplexGatewayStream extends GatewayStream {
  write(line: string): void;
}

/**
 * Whom the request being answered is for, when it is not an administrator:
 * their panel roles, or null before the manager's gate. Set by the manager
 * around such a request, and held against each verb's declared access, so a
 * route that lets a non-administrator through cannot reach a verb that is not
 * theirs. Root checks its own part regardless.
 */
export const gatewayCaller = new AsyncLocalStorage<{ roles: readonly string[] | null }>();

function refusedForCaller(addon: string, verb: string): string | null {
  const caller = gatewayCaller.getStore();
  if (!caller) return null;
  const declared = webVerb(addon, verb);
  return declared && callerMay(declared.web, caller.roles) ? null : `${addon} ${verb} is not available to this session`;
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
      } catch {}
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

export async function callGatewayAction<A extends GatewayAddon>(
  addon: A,
  verb: WebVerb<A>,
  args: string[] = [],
  input?: string,
  options: GatewayClientOptions = {},
): Promise<GatewayReply> {
  const refused = refusedForCaller(addon, verb);
  if (refused) return { ok: false, error: refused };
  const socketPath = options.socketPath ?? AUTH_SOCKET_PATH;
  const timeoutMs = options.timeout ?? DEFAULT_GATEWAY_TIMEOUT_MS;

  const direct = Boolean(process.env.CLP_ADDONS_ACTION_TEST_BIN) || (process.getuid?.() === 0 && !existsSync(socketPath));
  if (direct && options.sessionId !== undefined) return { ok: false, error: "this action needs the root gateway" };

  if (process.env.CLP_ADDONS_ACTION_TEST_BIN) {
    return runCommandDirect<never>(
      process.env.CLP_ADDONS_ACTION_TEST_BIN,
      ["action", addon, verb, ...args],
      options,
      input,
    );
  }

  if (process.getuid?.() === 0 && !existsSync(socketPath)) {
    return runCommandDirect<never>(
      CLI_BIN,
      ["action", addon, verb, ...args],
      options,
      input,
    );
  }

  const request: GatewayRequest = {
    kind: "action",
    addon,
    verb,
    args,
    input,
    timeoutMs,
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
  };

  const clientTimeoutMs = timeoutMs + 2_500;
  return callGatewaySocket<never>(request, socketPath, clientTimeoutMs);
}

const MAX_GATEWAY_STREAM_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_GATEWAY_OUTBOX_BYTES = 1024 * 1024;

function streamReply<T>(line: string): ActionResult<T> | null {
  return parseActionReply<T>(line);
}

/**
 * `sessionId` makes it a duplex stream: the gateway checks that CloudPanel
 * session itself, and `write` reaches the worker's stdin. Such a stream has no
 * direct-spawn fallback, because that fallback is the check it would skip.
 */
export function streamGatewayAction<A extends GatewayAddon>(options: {
  addon: A;
  verb: StreamVerb<A>;
  args?: string[];
  sessionId?: string;
  socketPath?: string;
  timeoutMs?: number;
  maxLineBytes?: number;
  onLine?: (line: string) => void;
  onReply?: (reply: GatewayReply) => void;
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
        const reply = streamReply<never>(line);
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
  const socketPath = options.socketPath ?? AUTH_SOCKET_PATH;
  const payload = JSON.stringify({
    kind: "stream-action",
    addon: options.addon,
    verb: options.verb,
    args: options.args,
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
  }) + "\n";

  const refused = refusedForCaller(options.addon, options.verb);
  if (refused) {
    queueMicrotask(() => finish(refused));
    return stream;
  }
  const direct = Boolean(process.env.CLP_ADDONS_ACTION_TEST_BIN) || (process.getuid?.() === 0 && !existsSync(socketPath));
  if (direct && options.sessionId !== undefined) {
    queueMicrotask(() => finish("this stream needs the root gateway"));
    return stream;
  }
  if (direct) {
    const command = process.env.CLP_ADDONS_ACTION_TEST_BIN ?? CLI_BIN;
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
        finish(errorMessage(error));
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

export async function callGatewayPanelInfo(
  options: GatewayClientOptions = {},
): Promise<ActionResult<PanelSnapshot>> {
  const socketPath = options.socketPath ?? AUTH_SOCKET_PATH;
  const timeoutMs = options.timeout ?? 5_000;

  if (process.getuid?.() === 0 && !existsSync(socketPath)) {
    try {
      const { getLivePanelInfo } = await import("./panel-snapshot");
      const info = getLivePanelInfo();
      return { ok: true, data: info };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  const request: GatewayRequest = { kind: "panel-info" };
  return callGatewaySocket<PanelSnapshot>(request, socketPath, timeoutMs);
}

export async function callGatewayAuth(
  sessionId: string,
  socketPath: string = AUTH_SOCKET_PATH,
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
      } catch {}
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
