import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sslCertificateSnippet, sslCompleteSnippet, sslFormSnippet, sslTargets } from "../addons/panel-tweaks/inject/ssl";

const KEY = "clp_addons_wordpress_ssl";
const DOMAIN = "blog.example.com";
const ORIGIN = "https://panel.example:8443";
const CERTIFICATES = `${ORIGIN}/site/${DOMAIN}/certificates`;
const ISSUE = `${ORIGIN}/site/${DOMAIN}/certificates/lets-encrypt/new`;
const formScript = readFileSync(`${import.meta.dir}/../addons/panel-tweaks/inject/ssl-form.client.js`, "utf8");
const completeScript = readFileSync(`${import.meta.dir}/../addons/panel-tweaks/inject/ssl-complete.client.js`, "utf8");

function storage(store: Map<string, string>, denied = false) {
  const check = () => { if (denied) throw new Error("storage denied"); };
  return {
    getItem(key: string) { check(); return store.get(key) ?? null; },
    removeItem(key: string) { check(); store.delete(key); },
    setItem(key: string, value: string) { check(); store.set(key, value); },
  };
}

function creation(denied = false) {
  const store = new Map([[KEY, "old pending creation"]]);
  const choice = { checked: true, disabled: false };
  const domain = { value: " Blog.Example.com " };
  const error = { hidden: true, textContent: "" };
  let submit = () => {};
  const form = {
    addEventListener(event: string, handler: () => void, capture: boolean) {
      expect(event).toBe("submit");
      expect(capture).toBe(true);
      submit = handler;
    },
  };
  const elements: Record<string, unknown> = {
    "new-wordpress-site-form": form, "clp-auto-ssl": choice,
    "site_new_word_press_domainName": domain, "clp-auto-ssl-error": error,
  };
  new Function("document", "sessionStorage", formScript)(
    { getElementById: (id: string) => elements[id] }, storage(store, denied),
  );
  return { store, choice, error, submit: () => submit() };
}

interface Page {
  type?: string;
  domain?: string;
  form?: { action?: string; method?: string; token?: string };
  error?: string;
  url?: string;
  status?: number;
}

/** Small document stand-ins keep the assertions focused on request behavior. */
async function completion(options: {
  pending?: string;
  pages?: Page[];
  store?: Map<string, string>;
  issueUrl?: string;
  denied?: boolean;
} = {}) {
  const store = options.store ?? new Map([[KEY, options.pending ?? JSON.stringify({ domain: DOMAIN, at: Date.now() })]]);
  const result = {
    hidden: true, className: "alert",
    getAttribute(name: string) {
      return ({ "data-domain": DOMAIN, "data-certificates-url": CERTIFICATES,
        "data-issue-url": options.issueUrl ?? ISSUE } as Record<string, string>)[name];
    },
  };
  const message = { textContent: "" };
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const pages = options.pages ?? [{ type: "1" }, { form: {} }, { type: "2" }];
  const factory = new Function("document", "sessionStorage", "fetch", "DOMParser", "FormData", "location", completeScript);
  factory(
    { getElementById: (id: string) => id === "clp-auto-ssl-result" ? result : message },
    storage(store, options.denied),
    async (url: string, requestOptions: RequestInit) => {
      calls.push({ url, options: requestOptions });
      const page = pages[calls.length - 1];
      if (!page) throw new Error("unexpected request");
      return {
        ok: (page.status ?? 200) < 400, status: page.status ?? 200,
        url: page.url ?? (requestOptions.method === "POST" ? CERTIFICATES : url),
        text: async () => JSON.stringify(page),
      };
    },
    class {
      parseFromString(raw: string) {
        const page = JSON.parse(raw) as Page;
        return {
          getElementById(id: string) {
            if (id === "clp-auto-ssl-certificate" && page.type !== undefined) return {
              getAttribute: (name: string) => name === "data-domain" ? page.domain ?? DOMAIN : page.type,
            };
            if (id === "create-lets-encrypt-certificate-form" && page.form) return {
              method: page.form.method ?? "post",
              getAttribute: () => page.form!.action ?? ISSUE,
              querySelector: () => ({ value: page.form!.token ?? "native-csrf-token" }),
            };
            return null;
          },
          querySelector: () => page.error ? { textContent: page.error } : null,
        };
      }
    },
    class extends FormData {
      constructor() {
        super();
        this.append("site_lets_encrypt_certificate[_token]", "native-csrf-token");
        this.append("domains[]", "example.com");
        this.append("domains[]", "www.example.com");
        this.append("domains[]", "");
      }
    },
    { href: `${ORIGIN}/site/new/wordpress/installed`, origin: ORIGIN },
  );
  // The injected script owns its promise chain, so let it drain before checking.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { store, result, message: message.textContent, calls };
}

test("SSL snippets are withdrawn together and the checkbox is not a Symfony field", () => {
  for (const snippet of [sslFormSnippet, sslCompleteSnippet, sslCertificateSnippet]) expect(snippet(false)).toBe("");
  const checkbox = sslFormSnippet(true).match(/<input[^>]*>/)![0];
  expect(checkbox).toContain("checked");
  expect(checkbox).not.toMatch(/\bname=/);
  expect(sslTargets(() => true).every((target) => !target.required)).toBe(true);
  for (const snippet of [sslFormSnippet(true), sslCompleteSnippet(true)]) {
    for (const script of snippet.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new Function(script[1]!)).not.toThrow();
  }
});

test("creation remembers only a checked choice and clears failed or unchecked attempts", () => {
  const form = creation();
  expect(form.store.has(KEY)).toBe(false);
  form.submit();
  expect(JSON.parse(form.store.get(KEY)!)).toEqual({ domain: DOMAIN, at: expect.any(Number) });
  form.choice.checked = false;
  form.submit();
  expect(form.store.has(KEY)).toBe(false);
  const blocked = creation(true);
  expect(blocked.choice.checked).toBe(false);
  expect(blocked.choice.disabled).toBe(true);
  expect(blocked.error.hidden).toBe(false);
  expect(() => blocked.submit()).not.toThrow();
  expect(blocked.error.hidden).toBe(false);
  expect(blocked.error.textContent).toContain("After creation");
});

test("completion submits the native CSRF form for the entered hostname and confirms installation", async () => {
  const done = await completion();
  expect(done.calls.map((call) => call.url)).toEqual([CERTIFICATES, ISSUE, ISSUE]);
  const post = done.calls[2]!.options;
  expect(post.method).toBe("POST");
  expect(post.credentials).toBe("same-origin");
  const body = post.body as FormData;
  expect(body.getAll("domains[]")).toEqual([DOMAIN]);
  expect(body.get("site_lets_encrypt_certificate[_token]")).toBe("native-csrf-token");
  expect(done.result.className).toBe("alert alert-success");
  expect(done.message).toContain("installed");
  expect(done.store.has(KEY)).toBe(false);
  const refreshed = await completion({ store: done.store });
  expect(refreshed.calls).toHaveLength(0);
});

test("missing, corrupt, stale, future, mismatched and unreadable choices cannot issue", async () => {
  const pending = ["null", "not json", ...[
    { domain: DOMAIN, at: Date.now() - 3600001 },
    { domain: DOMAIN, at: Date.now() + 100000 },
    { domain: DOMAIN, at: "not a time" },
    { domain: "other.example.com", at: Date.now() },
  ].map((value) => JSON.stringify(value))];
  for (const value of pending) expect((await completion({ pending: value })).calls).toHaveLength(0);
  expect((await completion({ denied: true })).calls).toHaveLength(0);
});

test("an installed Let's Encrypt or imported certificate is preserved", async () => {
  for (const type of ["2", "3"]) {
    const kept = await completion({ pages: [{ type }] });
    expect(kept.calls).toHaveLength(1);
    expect(kept.message).toContain("was kept");
  }
});

test("unrecognized certificate state, form, token and unsafe URLs fail before issuance", async () => {
  const scenarios: Page[][] = [
    [{}], [{ type: "1", domain: "other.example.com" }],
    [{ type: "1" }, {}], [{ type: "1" }, { form: { token: "" } }],
    [{ type: "1" }, { form: { method: "get" } }],
    [{ type: "1" }, { form: { action: "https://other.example/issue" } }],
    [{ type: "1" }, { form: { action: `${ORIGIN}/unexpected` } }],
  ];
  for (const pages of scenarios) {
    const failed = await completion({ pages });
    expect(failed.calls.some((call) => call.options.method === "POST")).toBe(false);
    expect(failed.result.className).toBe("alert alert-warning");
  }
  expect((await completion({ issueUrl: "https://other.example/issue" })).calls).toHaveLength(0);
});

test("native DNS failure, login redirect and unconfirmed installation remain separate from site success", async () => {
  for (const reply of [
    { error: "DNS points elsewhere", url: ISSUE },
    { url: `${ORIGIN}/login` },
    { type: "1" }, { type: "2", domain: "other.example.com" }, { status: 500 },
  ]) {
    const failed = await completion({ pages: [{ type: "1" }, { form: {} }, reply] });
    expect(failed.result.className).toBe("alert alert-warning");
    expect(failed.message).toContain("Your WordPress site was created");
    expect(failed.message).not.toContain("SSL certificate installed");
    expect(failed.store.has(KEY)).toBe(false);
    if (reply.error) expect(failed.message).toContain(reply.error);
  }
});
