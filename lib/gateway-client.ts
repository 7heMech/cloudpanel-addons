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
} from "./gateway-protocol";

export type { ActionResult } from "./gateway-protocol";

export interface GatewayClientOptions {
  timeout?: number;
  maxBuffer?: number;
  socketPath?: string;
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
  addon: "stager" | "instatic" | "manager",
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
