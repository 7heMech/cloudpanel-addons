import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseGatewayRequest,
  type GatewayRequest,
  INSTATIC_ALLOWED_VERBS,
} from "../lib/gateway-protocol";
import { callGatewayAuth, callGatewayPanelInfo } from "../lib/gateway-client";
import { createAuthActionServer } from "../cli/auth-action";

describe("Gateway Protocol & Server", () => {
  test("parseGatewayRequest parses structured JSON requests", () => {
    const authReq = parseGatewayRequest('{"kind":"auth","sessionId":"abc123"}\n');
    expect(authReq).toEqual({ kind: "auth", sessionId: "abc123" });

    const panelReq = parseGatewayRequest('{"kind":"panel-info"}\n');
    expect(panelReq).toEqual({ kind: "panel-info" });

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

  test("createAuthActionServer rejects unwhitelisted verbs at the gateway perimeter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clp-gateway-whitelist-"));
    const sockPath = join(dir, "gateway.sock");

    try {
      const server = createAuthActionServer();
      await new Promise<void>((resolve) => server.listen(sockPath, resolve));

      let reply = "";
      await new Promise<void>((resolve) => {
        Bun.connect({
          unix: sockPath,
          socket: {
            open(conn) {
              conn.write('{"kind":"action","addon":"stager","verb":"evil_verb"}\n');
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
      expect(parsed.error).toBe("invalid verb");

      await new Promise<void>((resolve) => server.close(() => resolve()));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("production gateway mode rejects a peer that is not the installed manager binary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clp-gateway-peer-"));
    const sockPath = join(dir, "gateway.sock");

    try {
      // The test runner is Bun, not /usr/local/bin/clp-addons. Enforcing the
      // production policy must therefore fail closed even though this process
      // can create and connect to the test socket.
      const server = createAuthActionServer({ enforcePeer: true });
      await new Promise<void>((resolve) => server.listen(sockPath, resolve));

      const result = await callGatewayPanelInfo({ socketPath: sockPath, timeout: 1000 });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("valid");
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("callGatewayAuth dispatches structured auth requests over socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clp-gateway-auth-"));
    const sockPath = join(dir, "gateway.sock");

    try {
      const server = createAuthActionServer();
      await new Promise<void>((resolve) => server.listen(sockPath, resolve));

      // Non-existent session returns invalid
      const raw = await callGatewayAuth("nonexistentsession", sockPath, 2000);
      expect(raw.trim()).toBe('{"valid":false}');

      await new Promise<void>((resolve) => server.close(() => resolve()));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("callGatewayPanelInfo returns real-time panel info over socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clp-gateway-panel-info-"));
    const sockPath = join(dir, "gateway.sock");
    const fakeDb = join(dir, "panel.sqlite");

    try {
      const server = createAuthActionServer({ panelDb: fakeDb });
      await new Promise<void>((resolve) => server.listen(sockPath, resolve));

      const res = await callGatewayPanelInfo({ socketPath: sockPath, timeout: 2000 });
      expect(res.ok).toBe(true);
      expect(res.data).toBeDefined();
      expect(Array.isArray(res.data?.sites)).toBe(true);
      expect(Array.isArray(res.data?.allocatedPorts)).toBe(true);
      expect(res.data?.portRange).toEqual({ min: 39000, max: 39999 });

      await new Promise<void>((resolve) => server.close(() => resolve()));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("callGatewayPanelInfo masks internal sqlite or path errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clp-gateway-panel-err-"));
    const sockPath = join(dir, "gateway.sock");

    try {
      const server = createAuthActionServer({
        getPanelInfo: () => {
          throw new Error("unable to create panel database snapshot /home/clp/data/db.sq3: disk I/O error");
        },
      });
      await new Promise<void>((resolve) => server.listen(sockPath, resolve));

      const res = await callGatewayPanelInfo({ socketPath: sockPath, timeout: 2000 });
      expect(res.ok).toBe(false);
      expect(res.error).toBe("failed to retrieve panel information");

      await new Promise<void>((resolve) => server.close(() => resolve()));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("INSTATIC_ALLOWED_VERBS excludes run and gateway rejects instatic run", async () => {
    expect(INSTATIC_ALLOWED_VERBS.has("run")).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), "clp-gateway-instatic-run-"));
    const sockPath = join(dir, "gateway.sock");

    try {
      const server = createAuthActionServer();
      await new Promise<void>((resolve) => server.listen(sockPath, resolve));

      let reply = "";
      await new Promise<void>((resolve) => {
        Bun.connect({
          unix: sockPath,
          socket: {
            open(conn) {
              conn.write('{"kind":"action","addon":"instatic","verb":"run"}\n');
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
      expect(parsed.error).toBe("invalid verb");

      await new Promise<void>((resolve) => server.close(() => resolve()));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
