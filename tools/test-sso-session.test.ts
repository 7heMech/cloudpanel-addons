// CloudPanel's session files are PHP-serialized blobs written by the panel.
// The addon reads them structurally rather than deserializing them, so every
// assertion here is about a scanner that must fail closed: a session it cannot
// prove is a completed, MFA-satisfied login is not a session.
//
// The fixtures under tools/fixtures/session are real panel sessions with the
// identifying fields replaced; the mutations below are the ways a forged one
// could try to look authenticated.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authenticateRequest, MAX_SESSION_BYTES, parsePanelSession, readPanelSessionFile,
} from "../lib/sso-auth";
import { adminGate } from "../cli/index";

const repo = join(import.meta.dir, "..");

function repoSource(path: string): string {
  return readFileSync(join(repo, path), "utf8");
}

/** A fixture with its comments and line wrapping stripped back to one blob. */
function fixture(name: string): Buffer {
  return Buffer.from(
    readFileSync(join(repo, "tools/fixtures/session", `${name}.txt`), "utf8")
      .split(/\r?\n/)
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .join(""),
  );
}

function authenticated(): Buffer {
  return fixture("authenticated");
}

function withReplacement(source: Buffer, from: string, to: string): Buffer {
  return Buffer.from(source.toString("utf8").replace(from, to), "utf8");
}

const NATIVE_MFA_KEY = "s:20:\"\u0000App\\Entity\\User\u0000mfa\";";

// The token is stored as a length-prefixed string, so any mutation that changes
// its byte count has to fix the prefix or the scanner rejects it for the wrong
// reason.
function mutateToken(from: string, to: string): Buffer {
  const delta = Buffer.byteLength(to) - Buffer.byteLength(from);
  const changed = withReplacement(authenticated(), from, to);
  return delta === 0 ? changed : withReplacement(changed, "s:1253:\"", `s:${1253 + delta}:\"`);
}

function userMfaFalse(): Buffer {
  return withReplacement(authenticated(), "\u0000App\\Entity\\User\u0000mfa\";b:1;", "\u0000App\\Entity\\User\u0000mfa\";b:0;");
}

function noMfa(): Buffer {
  return withReplacement(authenticated(), 'a:2:{s:16:"mfaAuthenticated";b:1;', 'a:1:{');
}

function depthBomb(): Buffer {
  let bomb = "N;";
  for (let index = 0; index < 70; index++) bomb = `a:1:{i:0;${bomb}}`;
  return Buffer.concat([authenticated(), Buffer.from(`bomb|${bomb}`, "utf8")]);
}

const DENIED: Record<string, () => Buffer> = {
  "the pending-MFA session": () => fixture("pending-mfa"),
  "mfaAuthenticated absent": noMfa,
  "mfaAuthenticated is string 1": () => withReplacement(authenticated(), 's:16:"mfaAuthenticated";b:1;', 's:16:"mfaAuthenticated";s:1:"1";'),
  "mfaAuthenticated is explicit null": () => withReplacement(authenticated(), 's:16:"mfaAuthenticated";b:1;', 's:16:"mfaAuthenticated";N;'),
  "duplicate mfaAuthenticated marker": () => withReplacement(
    authenticated(),
    'a:2:{s:16:"mfaAuthenticated";b:1;s:14:"_security_main";',
    'a:3:{s:16:"mfaAuthenticated";b:1;s:16:"mfaAuthenticated";b:1;s:14:"_security_main";',
  ),
  "serialized user mfa is not boolean": () => mutateToken("\u0000App\\Entity\\User\u0000mfa\";b:1;", "\u0000App\\Entity\\User\u0000mfa\";s:1:\"1\";"),
  "MFA property has a fake declaring class": () => withReplacement(authenticated(), NATIVE_MFA_KEY, "s:20:\"\u0000Foo\\Entity\\User\u0000mfa\";"),
  "MFA property uses an ambiguous public name": () => mutateToken(NATIVE_MFA_KEY, 's:3:"mfa";'),
  "duplicate canonical role": () => mutateToken('a:1:{i:0;s:10:"ROLE_ADMIN";}', 'a:2:{i:0;s:10:"ROLE_ADMIN";i:1;s:10:"ROLE_ADMIN";}'),
  "non-canonical role type": () => mutateToken('a:1:{i:0;s:10:"ROLE_ADMIN";}', 'a:1:{i:0;i:1;}'),
  "literal planted in user data": () => withReplacement(authenticated(), 's:13:"redacted_user"', 's:21:"mfaAuthenticated";b:1'),
  "unknown serialization tag": () => withReplacement(authenticated(), 's:1:"c";i:1893455900;', 's:1:"c";x;'),
  "truncated serialization": () => authenticated().subarray(0, authenticated().length - 1),
  "trailing serialization data": () => Buffer.concat([authenticated(), Buffer.from("garbage", "utf8")]),
  "depth bomb": depthBomb,
  "unknown token class": () => withReplacement(
    authenticated(),
    'O:75:"Symfony\\Component\\Security\\Http\\Authenticator\\Token\\PostAuthenticationToken":2',
    'O:11:"UnknownToken":2',
  ),
};

test("the reconstructed authenticated session is accepted with its expiry and role", () => {
  const result = parsePanelSession(authenticated());
  expect(result?.user).toBe("redacted_user");
  expect(result?.expiresAt).toBe(1893457440);
  expect(result?.roles).toEqual(["ROLE_ADMIN"]);
});

for (const [label, build] of Object.entries(DENIED)) {
  test(`${label} is denied`, () => {
    expect(parsePanelSession(build())).toBeNull();
  });
}

test("an oversized session is denied", () => {
  expect(parsePanelSession(Buffer.alloc(MAX_SESSION_BYTES + 1))).toBeNull();
});

test("an MFA-disabled user without the completion marker is accepted", () => {
  const withoutMarker = withReplacement(
    userMfaFalse(),
    'a:2:{s:16:"mfaAuthenticated";b:1;s:14:"_security_main";',
    'a:1:{s:14:"_security_main";',
  );
  expect(parsePanelSession(withoutMarker)?.user).toBe("redacted_user");
});

test("an MFA-disabled user with a valid completed marker is accepted", () => {
  expect(parsePanelSession(userMfaFalse())?.user).toBe("redacted_user");
});

test("a valid non-admin session remains authenticated with its typed role", () => {
  const nonAdmin = mutateToken('a:1:{i:0;s:10:"ROLE_ADMIN";}', 'a:1:{i:0;s:10:"ROLE_USER_";}');
  expect(parsePanelSession(nonAdmin)?.roles).toEqual(["ROLE_USER_"]);
});

test("the admin gate rejects a valid non-admin and accepts only ROLE_ADMIN", () => {
  const nonAdmin = parsePanelSession(mutateToken('a:1:{i:0;s:10:"ROLE_ADMIN";}', 'a:1:{i:0;s:10:"ROLE_USER_";}'));
  const admin = parsePanelSession(authenticated());
  expect(adminGate(nonAdmin && { user: nonAdmin.user, roles: nonAdmin.roles })?.status).toBe(403);
  expect(adminGate(admin && { user: admin.user, roles: admin.roles })).toBeNull();
});

test("the scanner does not use PHP deserialization and pins the main firewall key", () => {
  expect(repoSource("lib/sso-auth.ts")).not.toInclude("unserialize");
  expect(repoSource("lib/sso-auth.ts")).toInclude('"_security_main"');
});

test("an invalid CloudPanel session redirects to login before reading a path", async () => {
  const result = await authenticateRequest(new Request("https://panel.example/addons/instatic/", {
    headers: { Cookie: "cloudpanel=bad%2Fsession" },
  }));
  expect(result.response?.status).toBe(302);
});

// Provenance is settled on the descriptor before any byte is read, so a file
// the panel did not write is refused rather than parsed and then rejected.
test("session-file provenance is checked before bounded descriptor reads", async () => {
  const dir = mkdtempSync(`${tmpdir()}/session-provenance-`);
  const sessionPath = `${dir}/sess_valid`;
  const ownerUid = typeof process.getuid === "function" ? process.getuid() : 0;
  const session = authenticated();
  try {
    writeFileSync(sessionPath, session);
    const warnings: string[] = [];
    const readable = await readPanelSessionFile(sessionPath, { ownerUid, warn: (message) => warnings.push(message) });
    expect(readable?.byteLength).toBe(session.byteLength);
    expect(await readPanelSessionFile(sessionPath, { ownerUid: ownerUid + 1 })).toBeNull();

    const linkPath = `${dir}/sess_link`;
    symlinkSync(sessionPath, linkPath);
    expect(await readPanelSessionFile(linkPath, { ownerUid })).toBeNull();

    chmodSync(dir, 0o733);
    const warned = await readPanelSessionFile(sessionPath, { ownerUid, warn: (message) => warnings.push(message) });
    expect(warned?.byteLength).toBe(session.byteLength);
    expect(warnings).toHaveLength(1);
    chmodSync(dir, 0o700);

    writeFileSync(`${dir}/sess_oversized`, Buffer.alloc(MAX_SESSION_BYTES + 1, 65));
    expect(await readPanelSessionFile(`${dir}/sess_oversized`, { ownerUid })).toBeNull();

    const fifoPath = `${dir}/sess_fifo`;
    execFileSync("mkfifo", [fifoPath]);
    expect(await readPanelSessionFile(fifoPath, { ownerUid })).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The SSO path is in-process and reads the panel's own session files; there is
// no token exchange and no external validator to be tricked into answering.
describe("the SSO path is in-process and fail-closed", () => {
  test("sessions are read through a bounded no-follow descriptor", () => {
    const source = repoSource("lib/sso-auth.ts");
    expect(source).toInclude("O_NOFOLLOW");
    expect(source).toInclude("fstatSync(fd)");
    expect(source).toInclude("readSync(fd");
  });

  test("the root auth action uses the fixed session directory", () => {
    const source = repoSource("cli/auth-action.ts");
    expect(source).toInclude("SESSION_DIR");
    expect(source).toInclude("sess_");
  });

  test("CloudPanel's own cookie name and session directory are used", () => {
    expect(repoSource("lib/sso-auth.ts")).toInclude('SESSION_COOKIE = "cloudpanel"');
    expect(repoSource("cli/paths.ts")).toInclude("/home/clp/htdocs/app/files/var/sessions");
  });

  test("there is no HMAC token exchange and no external session validator", () => {
    const source = repoSource("lib/sso-auth.ts");
    expect(source).not.toInclude("issueToken");
    expect(source).not.toInclude("verifyToken");
    expect(existsSync(join(repo, "libexec/clp-verify-session"))).toBe(false);
  });
});
