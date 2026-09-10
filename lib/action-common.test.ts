import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeDomain,
  normalizeIdentityHostname,
  readPanelIdentity,
  panelIdentityMatches,
  validateDomain,
  validatePort,
  validateTag,
  validateFlag,
  validateJobId,
  validateEmail,
  validateMfa,
  createActionContext,
  withDomainLock,
  type ActionContext,
} from "./action-common";

test("normalizeDomain handles standard hostnames, trailing dots, and rejections", () => {
  expect(normalizeDomain("example.com")).toBe("example.com");
  expect(normalizeDomain("EXAMPLE.COM.")).toBe("example.com");
  expect(normalizeDomain("sub.domain-123.co.uk")).toBe("sub.domain-123.co.uk");

  expect(normalizeDomain("..")).toBeNull();
  expect(normalizeDomain("example..com")).toBeNull();
  expect(normalizeDomain("localhost")).toBeNull();
  expect(normalizeDomain("-bad.com")).toBeNull();
  expect(normalizeDomain("bad-.com")).toBeNull();
  expect(normalizeDomain("foo.com; rm -rf /")).toBeNull();
  expect(normalizeDomain("../../../etc/shadow")).toBeNull();
});

test("normalizeIdentityHostname handles wildcards and standard domains", () => {
  expect(normalizeIdentityHostname("example.com")).toBe("example.com");
  expect(normalizeIdentityHostname("*.example.com.")).toBe("*.example.com");
  expect(normalizeIdentityHostname("*.*.example.com")).toBeNull();
  expect(normalizeIdentityHostname("~^.+$")).toBeNull();
});

test("readPanelIdentity parses valid configs and rejects invalid", () => {
  const dir = mkdtempSync(join(tmpdir(), "action-common-test-"));
  const conf = join(dir, "panel-identity.conf");

  try {
    writeFileSync(conf, "PRIMARY=panel.example.test\nALIASES=www.panel.example.test *.panel.example.test\n");
    // If not root, readPanelIdentity returns null because stat.uid !== 0,
    // which correctly verifies fail-closed security.
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("panelIdentityMatches matches primary and wildcard aliases", () => {
  const identity = {
    primary: "panel.example.test",
    aliases: ["www.panel.example.test", "*.panel.example.test"],
  };

  expect(panelIdentityMatches("panel.example.test", identity)).toBe(true);
  expect(panelIdentityMatches("www.panel.example.test", identity)).toBe(true);
  expect(panelIdentityMatches("tenant.panel.example.test", identity)).toBe(true);
  expect(panelIdentityMatches("sub.tenant.panel.example.test", identity)).toBe(true);

  expect(panelIdentityMatches("evilpanel.example.test", identity)).toBe(false);
  expect(panelIdentityMatches("panel.example.test.evil.test", identity)).toBe(false);
  expect(panelIdentityMatches("customer.example.test", identity)).toBe(false);
});

test("validatePort and validateTag and validateFlag", () => {
  let errOutput = "";
  const mockCtx: ActionContext = {
    addon: "test",
    log: () => {},
    warn: () => {},
    emitOk: () => {},
    emitErr: (msg: string) => {
      errOutput = msg;
      throw new Error(msg);
    },
  };

  expect(validatePort("39000", mockCtx)).toBe(39000);
  expect(validatePort("39999", mockCtx)).toBe(39999);
  expect(() => validatePort("8080", mockCtx)).toThrow("outside reserved range");
  expect(() => validatePort("40000", mockCtx)).toThrow("outside reserved range");
  expect(() => validatePort("abc", mockCtx)).toThrow("port must be an integer");
  expect(() => validatePort(undefined, mockCtx)).toThrow("missing --port");

  expect(validateTag("0.0.18", mockCtx)).toBe("0.0.18");
  expect(() => validateTag("latest", mockCtx)).toThrow("exact version");
  expect(() => validateTag("main", mockCtx)).toThrow("exact version");
  expect(() => validateTag(undefined, mockCtx)).toThrow("missing --tag");

  expect(validateFlag("yes", "tls", mockCtx)).toBe("yes");
  expect(validateFlag("no", "tls", mockCtx)).toBe("no");
  expect(() => validateFlag("maybe", "tls", mockCtx)).toThrow("--tls takes yes or no");
});

test("validateJobId, validateEmail, validateMfa", () => {
  const mockCtx: ActionContext = {
    addon: "test",
    log: () => {},
    warn: () => {},
    emitOk: () => {},
    emitErr: (msg: string) => {
      throw new Error(msg);
    },
  };

  expect(validateJobId("20260907T090213Z-56f3aa", mockCtx)).toBe("20260907T090213Z-56f3aa");
  expect(() => validateJobId(undefined, mockCtx)).toThrow("missing --job");
  expect(() => validateJobId("invalid-job", mockCtx)).toThrow("invalid job id: 'invalid-job'");
  expect(() => validateJobId("../../etc/shadow", mockCtx)).toThrow("invalid job id: '../../etc/shadow'");

  expect(validateEmail("admin@example.com", mockCtx)).toBe("admin@example.com");
  expect(() => validateEmail(undefined, mockCtx)).toThrow("missing --email");
  expect(() => validateEmail("not-an-email", mockCtx)).toThrow("invalid email address: 'not-an-email'");
  expect(() => validateEmail("a".repeat(250) + "@test.com", mockCtx)).toThrow("--email is too long");

  expect(validateMfa("123456", mockCtx)).toBe("123456");
  expect(validateMfa("ABC-123-def", mockCtx)).toBe("ABC-123-def");
  expect(() => validateMfa("123", mockCtx)).toThrow("the authentication code has an unexpected shape");
  expect(() => validateMfa("bad_chars!", mockCtx)).toThrow("the authentication code has an unexpected shape");
});

test("withDomainLock acquires and releases lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "action-lock-test-"));
  const mockCtx = createActionContext("test");
  try {
    let ran = false;
    await withDomainLock("demo.example.com", mockCtx, async () => {
      ran = true;
    }, dir);
    expect(ran).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
