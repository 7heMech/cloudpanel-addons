import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { esc, escJs, guardMutation } from "../lib/app-http";
import {
  authenticateRequest, MAX_SESSION_BYTES, parsePanelSession, readPanelSessionFile,
} from "../lib/sso-auth";

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
check("the reconstructed pending-MFA session is denied", parsePanelSession(pending) === null);

const withReplacement = (source: Buffer, from: string, to: string): Buffer =>
  Buffer.from(source.toString("utf8").replace(from, to), "utf8");
const noMfa = withReplacement(
  authenticated,
  'a:2:{s:16:"mfaAuthenticated";b:1;',
  'a:1:{',
);
const mfaString = withReplacement(authenticated, 's:16:"mfaAuthenticated";b:1;', 's:16:"mfaAuthenticated";s:1:"1";');
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
  ["literal planted in user data", plantedLiteral],
  ["unknown serialization tag", unknownTag],
  ["truncated serialization", truncated],
  ["trailing serialization data", trailing],
  ["depth bomb", depthBombSession],
  ["unknown token class", unknownToken],
] as const) {
  check(`${label} is denied`, parsePanelSession(data) === null);
}
check("an oversized session is denied", parsePanelSession(Buffer.alloc(MAX_SESSION_BYTES + 1)) === null);
check("the scanner does not use PHP deserialization", !readFileSync("lib/sso-auth.ts", "utf8").includes("unserialize"));
check("the scanner pins the main firewall key", readFileSync("lib/sso-auth.ts", "utf8").includes('"_security_main"'));

const malformedRequest = await authenticateRequest(new Request("https://panel.example/addons/instatic/", {
  headers: { Cookie: "PHPSESSID=bad%2Fsession" },
}));
check("an invalid PHPSESSID redirects to login before reading a path", malformedRequest.response?.status === 302);

console.log("== session-file provenance is checked before Bun.file ==");
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
} finally {
  rmSync(sessionDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
