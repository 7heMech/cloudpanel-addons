import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { NATIVE_SSL_TYPES, sslFormSnippet, sslSitesSnippet, sslTargets, sslWordPressSnippet } from "../addons/panel-tweaks/inject/ssl";

const script = readFileSync(`${import.meta.dir}/../addons/panel-tweaks/inject/ssl.client.js`, "utf8");
const ORIGIN = "https://panel.example:8443";
const DOMAIN = "blog.example.com";
const CERTIFICATES = `/site/${DOMAIN}/certificates`;
const ISSUE = `/site/${DOMAIN}/certificates/lets-encrypt/new`;

/** Enough of `document.cookie` to see what the script stores and when it expires. */
function cookieJar(initial = "") {
  let value = initial;
  return {
    get: () => (value ? `__Host-clp_addons_ssl=${value}` : ""),
    set: (raw: string) => {
      expect(raw).toMatch(/^__Host-clp_addons_ssl=[^;]*; Path=\/; Secure; SameSite=Strict; Max-Age=\d+$/);
      value = /Max-Age=0$/.test(raw) ? "" : raw.split(";")[0]!.split("=")[1]!;
    },
    domains: () => (value ? decodeURIComponent(value).split(" ") : []),
  };
}

interface Reply { url?: string; token?: boolean; error?: string }

/** What the DNS addon's routes answer; absent means the addon is not installed. */
interface Dns { provision: unknown }

function run(options: { cookie?: string; domainInput?: string; box?: boolean; boxDomain?: string; replies?: Reply[]; dns?: Dns }) {
  const jar = cookieJar(options.cookie ? encodeURIComponent(options.cookie) : "");
  let submit = () => {};
  const form = {
    querySelector: () => ({ value: options.domainInput ?? "" }),
    addEventListener: (_: string, handler: () => void) => { submit = handler; },
  };
  const choice = { checked: true, form };
  const alert = { className: "alert alert-info", textContent: "", links: [] as string[],
    append(_: string, a: { href: string }) { this.links.push(a.href); } };
  const box = {
    querySelector: () => alert,
    getAttribute: (name: string) => ({ "data-clp-auto-ssl": options.boxDomain ?? DOMAIN, "data-certificates-url": CERTIFICATES, "data-issue-url": ISSUE })[name],
  };
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const dnsCalls: Array<{ url: string; init?: RequestInit }> = [];
  const events: unknown[] = [];
  const replies = options.replies ?? [{ token: true }, { url: CERTIFICATES }];
  const document = {
    get cookie() { return `${jar.get()}; clp_addons_csrf=csrf-pair`; },
    set cookie(raw: string) { jar.set(raw); },
    getElementById: (id: string) => (id === "clp-auto-ssl" && options.domainInput !== undefined ? choice : null),
    querySelectorAll: () => (options.box ? [box] : []),
    createElement: () => ({ href: "", textContent: "" }),
  };
  const fetch = async (url: string, init: RequestInit) => {
    // The completion forgets its domain before it asks anything.
    expect(jar.domains()).not.toContain(DOMAIN);
    if (url.startsWith("/addons/dns/")) {
      dnsCalls.push({ url, init });
      if (!options.dns) return { ok: false, json: async () => ({ ok: false }) };
      return { ok: true, json: async () => url.endsWith("/session") ? { ok: true } : options.dns!.provision };
    }
    calls.push({ url, init });
    const reply = replies[calls.length - 1]!;
    return { url: `${ORIGIN}${reply.url ?? ISSUE}`, text: async () => JSON.stringify(reply) };
  };
  class DOMParser {
    parseFromString(raw: string) {
      const reply = JSON.parse(raw) as Reply;
      return {
        querySelector: (selector: string) => selector.includes("_token")
          ? (reply.token ? { form: "native form" } : null)
          : (reply.error ? { textContent: ` ${reply.error} ` } : null),
      };
    }
  }
  class NativeForm extends FormData {
    constructor(form: unknown) {
      super();
      expect(form).toBe("native form");
      this.append("site_lets_encrypt_certificate[_token]", "csrf");
      this.append("domains[]", DOMAIN);
      this.append("domains[]", `www.${DOMAIN}`);
      this.append("domains[]", "");
    }
  }
  new Function("document", "location", "fetch", "DOMParser", "FormData", "window", "CustomEvent", script)(
    document, { href: `${ORIGIN}/` }, fetch, DOMParser, NativeForm,
    { dispatchEvent: (event: unknown) => events.push(event) },
    class { constructor(_: string, public init: { detail: string }) {} },
  );
  return { jar, choice, alert, calls, dnsCalls, events, submit: () => submit(), settled: () => new Promise((r) => setTimeout(r, 20)) };
}

test("the option is withdrawn with its switch and is not a field of CloudPanel's form", () => {
  for (const snippet of [sslFormSnippet, sslSitesSnippet, sslWordPressSnippet]) expect(snippet(false)).toBe("");
  const checkbox = sslFormSnippet(true).match(/<input[^>]*>/)![0];
  expect(checkbox).toContain("checked");
  expect(checkbox).not.toMatch(/\bname=/);
  const targets = sslTargets(() => true);
  expect(targets.every((target) => !target.required)).toBe(true);
  for (const type of NATIVE_SSL_TYPES) {
    expect(targets.find((target) => target.template === `Frontend/Site/New/${type}.html.twig`)!.snippet("")).toContain('id="clp-auto-ssl"');
  }
  expect(() => new Function(script)).not.toThrow();
});

test("Sites only completes a pending site that still has the self-signed placeholder", () => {
  const twig = sslSitesSnippet(true);
  expect(twig).toContain("app.request.cookies.get('__Host-clp_addons_ssl')");
  expect(twig).toContain("site.domainName|lower in clpSslPending");
  expect(twig).toContain("constant('App\\\\Entity\\\\Certificate::TYPE_SELF_SIGNED')");
  // The script only comes with a status line.
  expect(twig.indexOf("<script>")).toBeGreaterThan(twig.indexOf("{% if loop.last %}"));
  expect(twig.indexOf("<script>")).toBeLessThan(twig.indexOf("{% endfor %}"));
  expect(sslWordPressSnippet(true)).toContain("clpSslDomain in clpSslPending");
});

test("a checked submit remembers the domain, an unchecked one or a rejected creation forgets it", () => {
  const form = run({ domainInput: " Blog.Example.com ", cookie: "other.example.com" });
  form.submit();
  expect(form.jar.domains()).toEqual(["other.example.com", DOMAIN]);
  form.choice.checked = false;
  form.submit();
  expect(form.jar.domains()).toEqual(["other.example.com"]);
  const rejected = run({ domainInput: DOMAIN, cookie: DOMAIN });
  expect(rejected.jar.domains()).toEqual([]);
});

test("without DNS, completion posts CloudPanel's own form for the created domain alone", async () => {
  // A site CloudPanel stored in mixed case is still forgotten.
  const done = run({ box: true, boxDomain: "Blog.Example.com", cookie: DOMAIN });
  await done.settled();
  expect(done.calls.map((call) => call.url)).toEqual([`${ORIGIN}${ISSUE}`, `${ORIGIN}${ISSUE}`]);
  const body = done.calls[1]!.init.body as FormData;
  expect(done.calls[1]!.init.method).toBe("POST");
  expect(body.getAll("domains[]")).toEqual(["Blog.Example.com"]);
  expect(body.get("site_lets_encrypt_certificate[_token]")).toBe("csrf");
  expect(done.alert.className).toBe("alert alert-success");
  expect(done.jar.domains()).toEqual([]);
  expect(done.events).toEqual([expect.objectContaining({ init: { detail: "Blog.Example.com" } })]);
});

test("anything but CloudPanel's redirect to the certificate list is a failure", async () => {
  const cases: Reply[][] = [[{}], [{ token: true }, { error: "DNS points elsewhere" }], [{ token: true }, { url: "/login" }]];
  for (const replies of cases) {
    const failed = run({ box: true, replies });
    await failed.settled();
    expect(failed.alert.className).toBe("alert alert-danger");
    expect(failed.alert.textContent).toContain("was not installed");
    expect(failed.alert.links).toEqual([`${ORIGIN}${CERTIFICATES}`]);
    expect(failed.events).toEqual([]);
    if (replies[1]?.error) expect(failed.alert.textContent).toContain("DNS points elsewhere");
  }
});

test("with DNS installed, its records are written first and name the certificate's domains", async () => {
  const done = run({ box: true, dns: { provision: { ok: true, data: { managed: true, ready: true, reason: "DNS is in place", certificateNames: [DOMAIN, `www.${DOMAIN}`] } } } });
  await done.settled();
  expect(done.dnsCalls.map((call) => call.url)).toEqual(["/addons/dns/api/session", "/addons/dns/api/provision"]);
  const provision = done.dnsCalls[1]!.init!;
  expect(JSON.parse(String(provision.body))).toEqual({ domain: DOMAIN, ssl: true });
  expect((provision.headers as Record<string, string>)["X-CLP-Addons-CSRF"]).toBe("csrf-pair");
  expect((done.calls[1]!.init.body as FormData).getAll("domains[]")).toEqual([DOMAIN, `www.${DOMAIN}`]);
  expect(done.alert.className).toBe("alert alert-success");
});

test("DNS that is not ready asks for no certificate and says why", async () => {
  const waiting = run({ box: true, dns: { provision: { ok: true, data: { managed: true, ready: false, reason: "Zone example.com is pending; set its nameservers", certificateNames: [] } } } });
  await waiting.settled();
  expect(waiting.calls).toEqual([]);
  expect(waiting.alert.className).toBe("alert alert-warning");
  expect(waiting.alert.textContent).toContain("Zone example.com is pending; set its nameservers.");
  expect(waiting.alert.textContent).toContain("requested automatically");
});

test("a site DNS does not manage gets the created domain alone, and a DNS failure is reported", async () => {
  const unmanaged = run({ box: true, dns: { provision: { ok: true, data: { managed: false, ready: false, reason: "No DNS profile", certificateNames: [] } } } });
  await unmanaged.settled();
  expect((unmanaged.calls[1]!.init.body as FormData).getAll("domains[]")).toEqual([DOMAIN]);
  const failed = run({ box: true, dns: { provision: { ok: false, error: "DNS is busy checking Cloudflare" } } });
  await failed.settled();
  expect(failed.calls).toEqual([]);
  expect(failed.alert.className).toBe("alert alert-danger");
  expect(failed.alert.textContent).toContain("DNS is busy checking Cloudflare");
});
