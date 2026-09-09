import { readFileSync } from "node:fs";
import { esc, escJs, guardMutation } from "../lib/app-http";
import { authenticateRequest, issueToken, verifyToken } from "../lib/sso-auth";

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

console.log("== SSO validation remains fail-closed ==");
for (const sessionId of ["", "bad/session", "../etc/passwd", "abc%2Fdef"]) {
  check(`invalid session ID is rejected: ${JSON.stringify(sessionId)}`, issueToken("admin", sessionId) === null);
}
for (const token of ["", "not-a-token", ".", "a.", ".b", "a.b.c", "eyJmb28iOiJiYXIifQ.invalid"]) {
  check(`malformed token is rejected: ${JSON.stringify(token)}`, verifyToken(token, "valid-session") === null);
}
check(
  "the fixed PHPSESSID sid binding is still present",
  readFileSync("lib/sso-auth.ts", "utf8").includes("value.sid !== sessionFingerprint(sessionId)") &&
    readFileSync("lib/sso-auth.ts", "utf8").includes("verifyToken(token, sessionId ?? undefined)"),
);

const malformedRequest = await authenticateRequest(new Request("https://panel.example/addons/instatic/", {
  headers: { Cookie: "clp_addons_token=not-a-token" },
}));
check("a malformed token without a panel session redirects to login", malformedRequest.response?.status === 302);

const invalidSessionRequest = await authenticateRequest(new Request("https://panel.example/addons/instatic/", {
  headers: { Cookie: "PHPSESSID=bad%2Fsession" },
}));
check("a percent-encoded invalid PHPSESSID redirects to login", invalidSessionRequest.response?.status === 302);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
