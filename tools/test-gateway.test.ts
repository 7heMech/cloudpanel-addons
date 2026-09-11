import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseGatewayRequest,
  type GatewayRequest,
} from "../lib/gateway-protocol";
import { createAuthActionServer } from "../cli/auth-action";

describe("Gateway Protocol & Server", () => {
  test("parseGatewayRequest parses structured JSON requests", () => {
    const authReq = parseGatewayRequest('{"kind":"auth","sessionId":"abc123"}\n');
    expect(authReq).toEqual({ kind: "auth", sessionId: "abc123" });

    const actionReq = parseGatewayRequest(
      '{"kind":"action","addon":"stager","verb":"sites","args":["--domain","foo.com"]}\n'
    );
    expect(actionReq).toEqual({
      kind: "action",
      addon: "stager",
      verb: "sites",
      args: ["--domain", "foo.com"],
      input: undefined,
      timeoutMs: undefined,
    });
  });

  test("parseGatewayRequest falls back to legacy raw session IDs", () => {
    const legacy = parseGatewayRequest("6utuq9lrth7e3q1e7bftvr07kc\n");
    expect(legacy).toEqual({ kind: "auth", sessionId: "6utuq9lrth7e3q1e7bftvr07kc" });
  });

  test("parseGatewayRequest rejects malformed input", () => {
    expect(parseGatewayRequest("")).toBeNull();
    expect(parseGatewayRequest("   \n")).toBeNull();
    expect(parseGatewayRequest('{"kind":"action","addon":"evil"}\n')).toBeNull();
    expect(parseGatewayRequest("!@#$%^&*()\n")).toBeNull();
  });

  test("createAuthActionServer handles invalid requests safely over unix socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clp-gateway-test-"));
    const sockPath = join(dir, "gateway.sock");

    try {
      const server = createAuthActionServer();
      await new Promise<void>((resolve) => server.listen(sockPath, resolve));

      // 1. Send invalid action request
      let reply = "";
      await new Promise<void>((resolve) => {
        Bun.connect({
          unix: sockPath,
          socket: {
            open(conn) {
              conn.write('{"kind":"action","addon":"unknown","verb":"test"}\n');
            },
            data(_conn, chunk) {
              reply += Buffer.from(chunk).toString("utf8");
            },
            close() {
              resolve();
            },
          },
        });
      });

      const parsed = JSON.parse(reply.trim());
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("unknown addon");

      await new Promise<void>((resolve) => server.close(() => resolve()));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
