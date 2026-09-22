import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BodyError, MAX_BODY_BYTES, SECURITY_HEADERS, bodyErrorResponse, esc, escJs, guardMutation, htmlResponse,
  jsonResponse, newCsrfToken, policyHeaders, policyResponse, readJsonObject, redirectResponse,
  safeDecodePathSegment,
} from "../lib/app-http";

function repoSource(path: string): string {
  return readFileSync(join(import.meta.dir, "..", path), "utf8");
}

describe("response policy", () => {
  test("every response carries the content type, no-store and the security headers", () => {
    for (const res of [htmlResponse("<p>hi</p>"), jsonResponse({ ok: true })]) {
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        expect(res.headers.get(name)).toBe(value);
      }
    }
    expect(htmlResponse("").headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(jsonResponse({}).headers.get("Content-Type")).toBe("application/json");
  });

  test("a caller's own header wins over the default it replaces", async () => {
    const preview = `${SECURITY_HEADERS["Content-Security-Policy"]}; frame-src 'self' blob:`;
    const res = htmlResponse("", { headers: { "Content-Security-Policy": preview } });
    expect(res.headers.get("Content-Security-Policy")).toBe(preview);
    // The rest of the policy is still applied around the override.
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const asset = policyResponse("x", "text/javascript; charset=utf-8", {
      headers: { "Cache-Control": "public, max-age=31536000, immutable" },
    });
    expect(asset.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(await asset.text()).toBe("x");
  });

  test("caller headers are merged, not spread", () => {
    // Spreading is what the addons did. A Headers instance spreads to {} and an
    // array of pairs spreads to index keys, so either one silently lost the
    // caller's headers and kept only the defaults.
    const fromHeaders = jsonResponse({}, { headers: new Headers({ "X-Test": "one" }) });
    expect(fromHeaders.headers.get("X-Test")).toBe("one");
    const fromPairs = jsonResponse({}, { headers: [["X-Test", "two"]] });
    expect(fromPairs.headers.get("X-Test")).toBe("two");
  });

  test("the CSRF cookie is sent as a pair: the panel-wide one and the legacy expiry", () => {
    const token = newCsrfToken();
    const cookies = htmlResponse("", { csrf: token }).headers.getSetCookie();
    expect(cookies.length).toBe(2);
    expect(cookies[0]).toContain(`clp_addons_csrf=${token}`);
    expect(cookies[0]).toContain("Path=/");
    expect(cookies[0]).toContain("SameSite=Strict");
    expect(cookies[0]).toContain("Secure");
    // A browser upgraded from the /addons-scoped cookie holds both and sends
    // the stale one first, so the old one has to be expired explicitly.
    expect(cookies[1]).toContain("Path=/addons");
    expect(cookies[1]).toContain("Max-Age=0");
    expect(htmlResponse("").headers.getSetCookie().length).toBe(0);
  });

  test("a redirect carries the policy and no content type", () => {
    const res = redirectResponse("/addons/maintenance/");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/addons/maintenance/");
    expect(res.headers.get("Content-Type")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("policyHeaders answers for a response this module does not build", () => {
    // The job stream builds its own response around a ReadableStream and needs
    // its own caching rules; what it must not do is skip the security headers.
    const headers = policyHeaders("text/event-stream", { "Cache-Control": "no-cache, no-transform" });
    expect(headers.get("Content-Type")).toBe("text/event-stream");
    expect(headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(headers.get("Content-Security-Policy")).toBe(SECURITY_HEADERS["Content-Security-Policy"]!);
  });

  test("guardMutation's refusals go out under the same policy", async () => {
    const res = guardMutation(new Request("http://localhost/api/x", { method: "POST" }))!;
    expect(res.status).toBe(403);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: false, error: "missing Origin header" });
  });
});

describe("bounded JSON reads", () => {
  const post = (body: string | null, headers: Record<string, string> = {}): Request =>
    new Request("http://localhost/api/x", { method: "POST", body, headers });

  test("reads a JSON object", async () => {
    expect(await readJsonObject(post(JSON.stringify({ enabled: true })))).toEqual({ enabled: true });
  });

  test("refuses a declared length over the limit before reading a byte", async () => {
    const req = post(null, { "content-length": String(MAX_BODY_BYTES + 1) });
    const error = await readJsonObject(req, MAX_BODY_BYTES).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(BodyError);
    expect((error as BodyError).status).toBe(413);
    expect((error as BodyError).message).toBe("request body is too large");
  });

  test("refuses an oversized chunked body while it is arriving", async () => {
    // No Content-Length to check, so the declared-length guard cannot help and
    // req.text() would buffer the whole thing before anyone could measure it.
    let pushed = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pushed++;
        controller.enqueue(new Uint8Array(256).fill(0x61));
        if (pushed > 200) controller.close();
      },
    });
    const req = new Request("http://localhost/api/x", {
      method: "POST",
      body: stream,
      duplex: "half",
    });
    const error = await readJsonObject(req, 1024).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(BodyError);
    expect((error as BodyError).status).toBe(413);
    // Abandoned early rather than read to the end.
    expect(pushed).toBeLessThan(200);
  });

  test("refuses a malformed Content-Length", async () => {
    const error = await readJsonObject(post("{}", { "content-length": "not-a-number" }))
      .catch((err: unknown) => err);
    expect((error as BodyError).message).toBe("malformed Content-Length");
    expect((error as BodyError).status).toBe(400);
  });

  test("refuses invalid JSON and JSON that is not an object", async () => {
    for (const [body, message] of [
      ["{", "body must be valid JSON"],
      ["", "body must be valid JSON"],
      ["42", "body must be a JSON object"],
      ['"text"', "body must be a JSON object"],
      ["[1,2]", "body must be a JSON object"],
      ["null", "body must be a JSON object"],
    ] as const) {
      const error = await readJsonObject(post(body)).catch((err: unknown) => err);
      expect((error as BodyError).message).toBe(message);
      expect((error as BodyError).status).toBe(400);
    }
  });

  test("refuses a Content-Length that is not a run of digits", async () => {
    // Number() would read every one of these as a small enough number and let
    // the body through on a claim that is not a Content-Length at all.
    // No " 12 " here: Headers trims the value before anyone reads it, so that
    // one arrives as a perfectly ordinary "12".
    for (const declared of ["0x40", "1e3", "", "+12", "1.5", "-1"]) {
      const error = await readJsonObject(post(null, { "content-length": declared })).catch((err: unknown) => err);
      expect((error as BodyError).message).toBe("malformed Content-Length");
      expect((error as BodyError).status).toBe(400);
    }
  });

  test("bodyErrorResponse answers a BodyError and rethrows anything else", async () => {
    const res = bodyErrorResponse(new BodyError("request body is too large", 413));
    expect(res.status).toBe(413);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.json()).toEqual({ ok: false, error: "request body is too large" });
    // A server fault is not a bad request and must not be reported as one.
    expect(() => bodyErrorResponse(new TypeError("boom"))).toThrow("boom");
  });
});

describe("repeated Set-Cookie", () => {
  test("a caller's cookies survive the merge and join the CSRF pair", () => {
    const headers = new Headers();
    headers.append("Set-Cookie", "a=1; Path=/");
    headers.append("Set-Cookie", "b=2; Path=/");
    headers.set("X-Thing", "kept");
    const res = jsonResponse({ ok: true }, { headers, csrf: "token" });
    const cookies = res.headers.getSetCookie();
    expect(cookies).toContain("a=1; Path=/");
    expect(cookies).toContain("b=2; Path=/");
    // Both the caller's pair and the CSRF pair, not one collapsed value.
    expect(cookies.length).toBe(4);
    expect(res.headers.get("X-Thing")).toBe("kept");
  });

  test("a redirect keeps them too and still carries the policy", () => {
    const headers: [string, string][] = [["Set-Cookie", "a=1"], ["Set-Cookie", "b=2"]];
    const res = redirectResponse("/addons/stager/", { headers });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/addons/stager/");
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Frame-Options")).toBe(SECURITY_HEADERS["X-Frame-Options"]!);
  });
});

describe("path segment decoding", () => {
  test("decodes a segment and refuses malformed encoding", () => {
    expect(safeDecodePathSegment("a%20b")).toBe("a b");
    expect(safeDecodePathSegment("example.com")).toBe("example.com");
    // decodeURIComponent throws a URIError here, which a route calling it
    // directly turned into a 500 from the socket boundary.
    expect(safeDecodePathSegment("%")).toBeNull();
    expect(safeDecodePathSegment("%zz")).toBeNull();
  });
});

describe("HTML and JavaScript escaping", () => {
  test("esc encodes HTML rather than removing characters", () => {
    expect(esc(`<tag attr="quoted">&'`)).toBe("&lt;tag attr=&quot;quoted&quot;&gt;&amp;&#x27;");
    expect(esc("<&>")).toBe("&lt;&amp;&gt;");
    // The helper this replaced deleted the characters instead of encoding them.
    expect(esc("<unsafe>&")).not.toBe("unsafe");
  });

  test("the addon error paths escape through Bun rather than by hand", () => {
    expect(repoSource("addons/instatic/app/index.ts")).toInclude("Bun.escapeHTML(msg)");
    const stager = repoSource("addons/stager/app/index.ts");
    expect(stager).toInclude("Bun.escapeHTML(");
    expect(stager).not.toInclude("escapeMinimal");
  });

  test("escJs neutralises a quote while preserving the JavaScript value", () => {
    expect(escJs('a"b')).not.toInclude('"');
    expect(new Function(`return '${escJs("a'b\n")}'`)()).toBe("a'b\n");
  });
});

describe("CSRF and origin guard", () => {
  function mutation(headers: Record<string, string>, url = "https://panel.example:8443/addons/stager/api/clones"): Request {
    return new Request(url, { method: "POST", headers: { Cookie: "clp_addons_csrf=csrf_token", "x-clp-addons-csrf": "csrf_token", ...headers } });
  }

  function csrf(cookie: string, header: string): Request {
    return new Request("https://panel.example/addons/instatic/api/instances", {
      method: "POST",
      headers: { Origin: "https://panel.example", Host: "panel.example", Cookie: cookie, "x-clp-addons-csrf": header },
    });
  }

  test("duplicate cookie names keep the first value", () => {
    expect(guardMutation(csrf("clp_addons_csrf=first; clp_addons_csrf=second", "first"))).toBeNull();
    expect(guardMutation(csrf("clp_addons_csrf=first; clp_addons_csrf=second", "second"))?.status).toBe(403);
  });

  test("an empty CSRF cookie remains invalid", () => {
    expect(guardMutation(csrf("clp_addons_csrf=", "anything"))?.status).toBe(403);
  });

  test("equals signs and percent-encoding in a cookie value survive validation", () => {
    expect(guardMutation(csrf("clp_addons_csrf=left=middle=right", "left=middle=right"))).toBeNull();
    expect(guardMutation(csrf("clp_addons_csrf=left%2Fmiddle", "left/middle"))).toBeNull();
  });

  test("both request guards parse cookies with Bun.CookieMap", () => {
    expect(repoSource("lib/app-http.ts")).toInclude("new Bun.CookieMap");
    expect(repoSource("lib/sso-auth.ts")).toInclude("new Bun.CookieMap");
  });

  test("same-origin is accepted with an explicit port and when a proxy strips it", () => {
    expect(guardMutation(mutation({ Origin: "https://panel.example:8443", Host: "panel.example:8443" }))).toBeNull();
    expect(guardMutation(mutation({ Origin: "https://panel.example:8443", Host: "panel.example" }))).toBeNull();
  });

  // The panel is on 8443 and its tenants' own sites are on 443, so a mismatched
  // port is the shape a cross-site request from a hosted site actually takes.
  test("a different origin, port or scheme is refused", () => {
    for (const origin of [
      "https://evil.example:8443",
      "https://panel.example",
      "https://panel.example:3000",
      "http://panel.example:8443",
    ]) {
      expect(guardMutation(mutation({ Origin: origin, Host: "panel.example:8443" }))?.status).toBe(403);
    }
  });

  test("a spoofed X-Forwarded-Host cannot rescue a cross-origin request", () => {
    expect(guardMutation(mutation({
      Origin: "https://evil.example:8443",
      Host: "panel.example:8443",
      "X-Forwarded-Host": "evil.example:8443",
    }))?.status).toBe(403);
  });
});
