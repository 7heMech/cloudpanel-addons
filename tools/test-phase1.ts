import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { esc, escJs, guardMutation } from "../lib/app-http";
import {
  authenticateRequest, MAX_SESSION_BYTES, parsePanelSession, readPanelSessionFile,
} from "../lib/sso-auth";
import { adminGate } from "../cli/index";
import { Database } from "bun:sqlite";
import { MAX_AUTH_INPUT_BYTES, createAuthActionServer, runAuthAction } from "../cli/auth-action";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok    ${label}`);
    passed++;
  } else {
    console.log(`  FAIL  ${label}${detail ? `: ${detail}` : ""}`);
    failed++;
  }
}

function mutationRequest(cookie: string, csrfHeader: string): Request {
  return new Request("https://panel.example/addons/instatic/api/instances", {
    method: "POST",
    headers: {
      Origin: "https://panel.example",
      Host: "panel.example",
      Cookie: cookie,
      "x-clp-addons-csrf": csrfHeader,
    },
  });
}

function responseStatus(response: Response | null): number {
  return response?.status ?? 200;
}

console.log("== Bun HTML escaping ==");
const hostile = `<tag attr="quoted">&'`;
check(
  "esc uses Bun's canonical entity spelling",
  esc(hostile) === "&lt;tag attr=&quot;quoted&quot;&gt;&amp;&#x27;",
  esc(hostile),
);
check("esc encodes HTML rather than removing characters", esc("<&>") === "&lt;&amp;&gt;");
check(
  "HTML encoding differs from the former escapeMinimal character removal",
  esc("<unsafe>&") !== "unsafe",
);
check("the Instatic error path uses Bun.escapeHTML", readFileSync("addons/instatic/app/index.ts", "utf8").includes("Bun.escapeHTML(msg)"));
const stagerSource = readFileSync("addons/stager/app/index.ts", "utf8");
check("the Stager error paths use Bun.escapeHTML", stagerSource.includes("Bun.escapeHTML(") && !stagerSource.includes("escapeMinimal"));

console.log("== escJs remains JavaScript-string escaping ==");
check("escJs still neutralises a double quote", !escJs('a"b').includes('"'));
check("escJs still preserves the JavaScript value", new Function(`return '${escJs("a'b\n")}'`)() === "a'b\n");

console.log("== Bun cookie parsing ==");
check(
  "duplicate cookie names keep the first value",
  guardMutation(mutationRequest("clp_addons_csrf=first; clp_addons_csrf=second", "first")) === null,
);
check(
  "a duplicate cookie's second value cannot satisfy CSRF",
  responseStatus(guardMutation(mutationRequest("clp_addons_csrf=first; clp_addons_csrf=second", "second"))) === 403,
);
check(
  "an empty CSRF cookie remains invalid",
  responseStatus(guardMutation(mutationRequest("clp_addons_csrf=", "anything"))) === 403,
);
check(
  "equals signs inside a cookie value are preserved",
  guardMutation(mutationRequest("clp_addons_csrf=left=middle=right", "left=middle=right")) === null,
);
check(
  "percent-encoded cookie values are decoded before validation",
  guardMutation(mutationRequest("clp_addons_csrf=left%2Fmiddle", "left/middle")) === null,
);
check(
  "both request guards use Bun.CookieMap",
  readFileSync("lib/app-http.ts", "utf8").includes("new Bun.CookieMap") &&
    readFileSync("lib/sso-auth.ts", "utf8").includes("new Bun.CookieMap"),
);
check(
  "guardMutation accepts same-origin with explicit port (e.g. 8443)",
  guardMutation(new Request("https://panel.example:8443/addons/stager/api/clones", {
    method: "POST",
    headers: {
      Origin: "https://panel.example:8443",
      Host: "panel.example:8443",
      Cookie: "clp_addons_csrf=csrf_token",
      "x-clp-addons-csrf": "csrf_token",
    },
  })) === null,
);
check(
  "guardMutation accepts same-origin when reverse proxy stripped the port in Host",
  guardMutation(new Request("https://panel.example:8443/addons/stager/api/clones", {
    method: "POST",
    headers: {
      Origin: "https://panel.example:8443",
      Host: "panel.example",
      Cookie: "clp_addons_csrf=csrf_token",
      "x-clp-addons-csrf": "csrf_token",
    },
  })) === null,
);
check(
  "guardMutation rejects cross-origin even when using the same port",
  responseStatus(guardMutation(new Request("https://panel.example:8443/addons/stager/api/clones", {
    method: "POST",
    headers: {
      Origin: "https://evil.example:8443",
      Host: "panel.example:8443",
      Cookie: "clp_addons_csrf=csrf_token",
      "x-clp-addons-csrf": "csrf_token",
    },
  }))) === 403,
);

console.log("== CloudPanel SSO validates reconstructed sessions structurally ==");
const fixture = (name: string): Buffer => Buffer.from(
  readFileSync(`tools/fixtures/session/${name}.txt`, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .join(""),
);
const authenticated = fixture("authenticated");
const pending = fixture("pending-mfa");
const authenticatedResult = parsePanelSession(authenticated);
check("the reconstructed authenticated session is accepted", authenticatedResult?.user === "redacted_user");
check("the authenticated session expiry is parsed", authenticatedResult?.expiresAt === 1893457440);
check("roles come from the token's canonical roleNames state", authenticatedResult?.roles.length === 1 && authenticatedResult.roles[0] === "ROLE_ADMIN");
check("the reconstructed pending-MFA session is denied", parsePanelSession(pending) === null);

const withReplacement = (source: Buffer, from: string, to: string): Buffer =>
  Buffer.from(source.toString("utf8").replace(from, to), "utf8");
const noMfa = withReplacement(
  authenticated,
  'a:2:{s:16:"mfaAuthenticated";b:1;',
  'a:1:{',
);
const mfaString = withReplacement(authenticated, 's:16:"mfaAuthenticated";b:1;', 's:16:"mfaAuthenticated";s:1:"1";');
const mfaNull = withReplacement(authenticated, 's:16:"mfaAuthenticated";b:1;', 's:16:"mfaAuthenticated";N;');
const userMfaFalse = withReplacement(authenticated, "\u0000App\\Entity\\User\u0000mfa\";b:1;", "\u0000App\\Entity\\User\u0000mfa\";b:0;");
const userMfaFalseNoMarker = withReplacement(
  userMfaFalse,
  'a:2:{s:16:"mfaAuthenticated";b:1;s:14:"_security_main";',
  'a:1:{s:14:"_security_main";',
);
const nativeMfaKey = "s:20:\"\u0000App\\Entity\\User\u0000mfa\";";
const fakeMfaScope = withReplacement(authenticated, nativeMfaKey, "s:20:\"\u0000Foo\\Entity\\User\u0000mfa\";");
const mutateSecurity = (from: string, to: string): Buffer => {
  const delta = Buffer.byteLength(to) - Buffer.byteLength(from);
  const changed = withReplacement(authenticated, from, to);
  return delta === 0 ? changed : withReplacement(changed, "s:1253:\"", `s:${1253 + delta}:\"`);
};
const publicMfaName = mutateSecurity(nativeMfaKey, 's:3:"mfa";');
const duplicateMfa = withReplacement(
  authenticated,
  'a:2:{s:16:"mfaAuthenticated";b:1;s:14:"_security_main";',
  'a:3:{s:16:"mfaAuthenticated";b:1;s:16:"mfaAuthenticated";b:1;s:14:"_security_main";',
);
const userMfaString = mutateSecurity("\u0000App\\Entity\\User\u0000mfa\";b:1;", "\u0000App\\Entity\\User\u0000mfa\";s:1:\"1\";");
const mutateRoleNames = (from: string, to: string): Buffer => {
  const delta = Buffer.byteLength(to) - Buffer.byteLength(from);
  const changed = withReplacement(authenticated, from, to);
  return delta === 0 ? changed : withReplacement(changed, "s:1253:\"", `s:${1253 + delta}:\"`);
};
const nonAdminRole = mutateRoleNames('a:1:{i:0;s:10:"ROLE_ADMIN";}', 'a:1:{i:0;s:10:"ROLE_USER_";}');
const duplicateRole = mutateRoleNames('a:1:{i:0;s:10:"ROLE_ADMIN";}', 'a:2:{i:0;s:10:"ROLE_ADMIN";i:1;s:10:"ROLE_ADMIN";}');
const nonCanonicalRoleType = mutateRoleNames('a:1:{i:0;s:10:"ROLE_ADMIN";}', 'a:1:{i:0;i:1;}');
const plantedLiteral = withReplacement(
  authenticated,
  's:13:"redacted_user"',
  's:21:"mfaAuthenticated";b:1',
);
const unknownTag = withReplacement(authenticated, 's:1:"c";i:1893455900;', 's:1:"c";x;');
const truncated = authenticated.subarray(0, authenticated.length - 1);
const trailing = Buffer.concat([authenticated, Buffer.from("garbage", "utf8")]);
const unknownToken = withReplacement(
  authenticated,
  'O:75:"Symfony\\Component\\Security\\Http\\Authenticator\\Token\\PostAuthenticationToken":2',
  'O:11:"UnknownToken":2',
);
let depthBomb = Buffer.from("N;", "utf8");
for (let index = 0; index < 70; index++) depthBomb = Buffer.from(`a:1:{i:0;${depthBomb.toString("utf8")}}`, "utf8");
const depthBombSession = Buffer.concat([authenticated, Buffer.from(`bomb|${depthBomb.toString("utf8")}`, "utf8")]);

for (const [label, data] of [
  ["mfaAuthenticated absent", noMfa],
  ["mfaAuthenticated is string 1", mfaString],
  ["mfaAuthenticated is explicit null", mfaNull],
  ["duplicate mfaAuthenticated marker", duplicateMfa],
  ["serialized user mfa is not boolean", userMfaString],
  ["MFA property has a fake declaring class", fakeMfaScope],
  ["MFA property uses an ambiguous public name", publicMfaName],
  ["MFA-enabled user without marker", noMfa],
  ["duplicate canonical role", duplicateRole],
  ["non-canonical role type", nonCanonicalRoleType],
  ["literal planted in user data", plantedLiteral],
  ["unknown serialization tag", unknownTag],
  ["truncated serialization", truncated],
  ["trailing serialization data", trailing],
  ["depth bomb", depthBombSession],
  ["unknown token class", unknownToken],
] as const) {
  check(`${label} is denied`, parsePanelSession(data) === null);
}
const mfaDisabledResult = parsePanelSession(userMfaFalseNoMarker);
check("MFA-disabled user without marker is accepted", mfaDisabledResult?.user === "redacted_user");
const mfaTrueWithNativeFalseResult = parsePanelSession(userMfaFalse);
check("MFA-disabled user with a valid completed marker is accepted", mfaTrueWithNativeFalseResult?.user === "redacted_user");
const nonAdminResult = parsePanelSession(nonAdminRole);
check("a valid non-admin session remains authenticated with its typed role", nonAdminResult?.roles.length === 1 && nonAdminResult.roles[0] === "ROLE_USER_");
check("admin gate rejects a valid non-admin", adminGate(nonAdminResult && { user: nonAdminResult.user, roles: nonAdminResult.roles })?.status === 403);
check("admin gate accepts only ROLE_ADMIN", adminGate(authenticatedResult && { user: authenticatedResult.user, roles: authenticatedResult.roles }) === null);
const serveSource = readFileSync("cli/index.ts", "utf8").slice(readFileSync("cli/index.ts", "utf8").indexOf("async function cmdServe"));
const adminCheck = serveSource.indexOf("adminGate(gate.auth)");
check("shared admin denial precedes update checks and handler dispatch",
  adminCheck >= 0 && adminCheck < serveSource.indexOf("checkCliUpdate") &&
    adminCheck < serveSource.indexOf("splitMount") && adminCheck < serveSource.indexOf("indexPage"));
check("an oversized session is denied", parsePanelSession(Buffer.alloc(MAX_SESSION_BYTES + 1)) === null);
check("the scanner does not use PHP deserialization", !readFileSync("lib/sso-auth.ts", "utf8").includes("unserialize"));
check("the scanner pins the main firewall key", readFileSync("lib/sso-auth.ts", "utf8").includes('"_security_main"'));

const malformedRequest = await authenticateRequest(new Request("https://panel.example/addons/instatic/", {
  headers: { Cookie: "cloudpanel=bad%2Fsession" },
}));
check("an invalid CloudPanel session redirects to login before reading a path", malformedRequest.response?.status === 302);

console.log("== root auth action contract (reconstructed file) ==");
const authDir = mkdtempSync(`${tmpdir()}/auth-action-`);
const authFile = `${authDir}/sess_live`;
const authOwnerUid = typeof process.getuid === "function" ? process.getuid() : 0;
try {
  writeFileSync(authFile, authenticated);
  const validReply = await runAuthAction("live\n", { sessionDir: authDir, ownerUid: authOwnerUid });
  const parsedReply = JSON.parse(validReply) as Record<string, unknown>;
  check("auth action emits one validated principal and expiry", parsedReply.valid === true && parsedReply.user === "redacted_user" && parsedReply.expiresAt === 1893457440 && JSON.stringify(parsedReply.roles) === '["ROLE_ADMIN"]');
  check("auth action output contains no serialized session fields", !validReply.includes("_sf2_attributes") && !validReply.includes("mfaSecret"));
  for (const [label, input] of [
    ["missing newline", "live"],
    ["extra stdin field", "live\nextra\n"],
    ["oversized stdin", "a".repeat(MAX_AUTH_INPUT_BYTES + 1)],
  ] as const) {
    check(`auth action rejects ${label}`, (await runAuthAction(input, { sessionDir: authDir, ownerUid: authOwnerUid })) === '{"valid":false}\n');
  }
  check("auth action rejects a missing session file", (await runAuthAction("missing\n", { sessionDir: authDir, ownerUid: authOwnerUid })) === '{"valid":false}\n');
  check("auth action rejects an invalid file owner", (await runAuthAction("live\n", { sessionDir: authDir, ownerUid: authOwnerUid + 1 })) === '{"valid":false}\n');

  // DB authorization check tests:
  const dbPath = `${authDir}/panel.sqlite`;
  const db = new Database(dbPath);
  db.run("CREATE TABLE user (user_name TEXT, role TEXT, status INTEGER)");
  db.query("INSERT INTO user VALUES (?, ?, ?)").run("redacted_user", "ROLE_ADMIN", 1);
  db.close();

  const dbAdminReply = JSON.parse(await runAuthAction("live\n", { sessionDir: authDir, ownerUid: authOwnerUid, panelDb: dbPath }));
  check("auth action reads role from DB when database exists", dbAdminReply.valid === true && JSON.stringify(dbAdminReply.roles) === '["ROLE_ADMIN"]');

  // Demotion in DB:
  const db2 = new Database(dbPath);
  db2.run("UPDATE user SET role = 'ROLE_SITE_MANAGER' WHERE user_name = 'redacted_user'");
  db2.close();
  const dbDemotedReply = JSON.parse(await runAuthAction("live\n", { sessionDir: authDir, ownerUid: authOwnerUid, panelDb: dbPath }));
  check("auth action honors demotion in DB immediately", dbDemotedReply.valid === true && JSON.stringify(dbDemotedReply.roles) === '["ROLE_SITE_MANAGER"]');

  // Inactive user in DB (status = 0):
  const db3 = new Database(dbPath);
  db3.run("UPDATE user SET status = 0 WHERE user_name = 'redacted_user'");
  db3.close();
  const dbInactiveReply = await runAuthAction("live\n", { sessionDir: authDir, ownerUid: authOwnerUid, panelDb: dbPath });
  check("auth action rejects inactive user in DB", dbInactiveReply === '{"valid":false}\n');

  // Deleted user from DB:
  const db4 = new Database(dbPath);
  db4.run("DELETE FROM user WHERE user_name = 'redacted_user'");
  db4.close();
  const dbDeletedReply = await runAuthAction("live\n", { sessionDir: authDir, ownerUid: authOwnerUid, panelDb: dbPath });
  check("auth action rejects user missing from DB", dbDeletedReply === '{"valid":false}\n');

  // Socket server mode test:
  const sockPath = `${authDir}/test.sock`;
  const server = createAuthActionServer({ sessionDir: authDir, ownerUid: authOwnerUid });
  await new Promise<void>((resolve) => server.listen(sockPath, resolve));
  let daemonReply = "";
  await new Promise<void>((resolve) => {
    Bun.connect({
      unix: sockPath,
      socket: {
        open(conn) {
          conn.write("live\n");
        },
        data(_conn, chunk) {
          daemonReply += Buffer.from(chunk).toString("utf8");
        },
        close() {
          resolve();
        },
      },
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const parsedDaemon = JSON.parse(daemonReply);
  check("auth action daemon answers over unix socket", parsedDaemon.valid === true && parsedDaemon.user === "redacted_user");
} finally {
  rmSync(authDir, { recursive: true, force: true });
}

console.log("== session-file provenance is checked before bounded descriptor reads ==");
const sessionDir = mkdtempSync(`${tmpdir()}/session-provenance-`);
const sessionPath = `${sessionDir}/sess_valid`;
const ownerUid = typeof process.getuid === "function" ? process.getuid() : 0;
try {
  writeFileSync(sessionPath, authenticated);
  const warnings: string[] = [];
  const readable = await readPanelSessionFile(sessionPath, { ownerUid, warn: (message) => warnings.push(message) });
  check("a panel-owned regular file is readable", readable?.byteLength === authenticated.byteLength);
  check("a wrong owner is denied", await readPanelSessionFile(sessionPath, { ownerUid: ownerUid + 1 }) === null);

  const linkPath = `${sessionDir}/sess_link`;
  symlinkSync(sessionPath, linkPath);
  check("a session symlink is denied", await readPanelSessionFile(linkPath, { ownerUid }) === null);

  chmodSync(sessionDir, 0o733);
  const warningReadable = await readPanelSessionFile(sessionPath, { ownerUid, warn: (message) => warnings.push(message) });
  check("a writable parent warns without denying a trusted file", warningReadable?.byteLength === authenticated.byteLength && warnings.length === 1);
  chmodSync(sessionDir, 0o700);

  writeFileSync(`${sessionDir}/sess_oversized`, Buffer.alloc(MAX_SESSION_BYTES + 1, 65));
  check("an oversized session file is denied before reading", await readPanelSessionFile(`${sessionDir}/sess_oversized`, { ownerUid }) === null);

  const fifoPath = `${sessionDir}/sess_fifo`;
  execFileSync("mkfifo", [fifoPath]);
  check("a FIFO is denied without blocking", await readPanelSessionFile(fifoPath, { ownerUid }) === null);
} finally {
  rmSync(sessionDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
