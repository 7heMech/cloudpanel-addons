import { describe, expect, test } from "bun:test";
import { CloudflareApi, quoteTxt, unquoteTxt } from "../addons/dns/cloudflare";
import { ProviderError, ProviderHttp } from "../lib/provider-http";
import { MailcowApi } from "../addons/dns/mailcow";
import { grants, parseResources, readAccess } from "../addons/dns/access";
import { PERMISSIONS } from "../addons/dns/token";
import { FakeCloudflare, FakeMailcow, MAILCOW_KEY, policy } from "./fixtures/dns-api";

const USER_TOKEN = "cf-user-token-0123456789abcdef";
const ACCOUNT_TOKEN = "cf-account-token-0123456789abcdef";

describe("provider HTTP bounds", () => {
  test("oversized replies are cancelled with or without a declared length", async () => {
    for (const declared of [false, true]) {
      let cancelled = false;
      const response = new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(declared ? 1 : 8 * 1024 * 1024 + 1)); },
        cancel() { cancelled = true; },
      }), { headers: declared ? { "Content-Length": String(8 * 1024 * 1024 + 1) } : {} });
      const api = new ProviderHttp("Test", "https://provider.test", {}, async () => response);
      await expect(api.request("/")).rejects.toThrow("too large");
      expect(cancelled).toBe(true);
    }
  });

  test("the deadline aborts both an unanswered request and a stalled reply body", async () => {
    for (const stalledBody of [false, true]) {
      let signal: AbortSignal | null | undefined;
      const api = new ProviderHttp("Test", "https://provider.test", {}, async (_url, init) => {
        signal = init.signal;
        expect(init.redirect).toBe("error");
        if (!stalledBody) {
          return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted"))));
        }
        return new Response(new ReadableStream({
          start(controller) { signal!.addEventListener("abort", () => controller.error(new Error("aborted"))); },
        }));
      }, { until: 0 }, 5);
      await expect(api.request("/")).rejects.toBeInstanceOf(ProviderError);
      expect(signal?.aborted).toBe(true);
    }
  });
});

function cloudflare(): { fake: FakeCloudflare; agency: string; church: string } {
  const fake = new FakeCloudflare();
  const agency = fake.account("Agency");
  const church = fake.account("Church");
  fake.token(USER_TOKEN, { owner: "user", accounts: [agency, church] });
  fake.token(ACCOUNT_TOKEN, { owner: "account", accounts: [church], listAccounts: false });
  return { fake, agency, church };
}

describe("Cloudflare", () => {
  test("a user token verifies, and lists every account and zone it was given", async () => {
    const { fake, agency, church } = cloudflare();
    for (let n = 0; n < 120; n++) fake.zone(`site${n}.example`, n % 2 ? agency : church);
    const api = new CloudflareApi(USER_TOKEN, fake.fetch);
    expect(await api.verify()).toEqual({ active: true, status: "active", owner: "user", accountId: null, id: fake.tokens.get(USER_TOKEN)!.id! });
    expect((await api.accounts()).map((account) => account.name).sort()).toEqual(["Agency", "Church"]);
    const zones = await api.zones();
    expect(zones).toHaveLength(120);
    // 50 is the most /zones gives per page, so 120 zones are three pages.
    expect(fake.calls.filter((call) => call.path === "/zones")).toHaveLength(3);
    expect(zones[0]!.account.name).toBeTruthy();
  });

  test("an account-owned token verifies at its account, and without Account Settings it sees no accounts but its zones", async () => {
    const { fake, church } = cloudflare();
    fake.zone("church.example", church);
    const api = new CloudflareApi(ACCOUNT_TOKEN, fake.fetch);
    expect(await api.accounts()).toEqual([]);
    expect((await api.zones()).map((zone) => zone.name)).toEqual(["church.example"]);
    expect(await api.verify()).toEqual({ active: true, status: "active", owner: "account", accountId: church, id: fake.tokens.get(ACCOUNT_TOKEN)!.id! });
    expect(fake.calls.some((call) => call.path === `/accounts/${church}/tokens/verify`)).toBe(true);
  });

  test("an unknown token is reported with Cloudflare's own reason", async () => {
    const { fake } = cloudflare();
    const api = new CloudflareApi("cf-nobody-0123456789abcdef", fake.fetch);
    await expect(api.zones()).rejects.toThrow("Authentication error (10000)");
  });

  test("a zone create the token may not make names the permission the token form shows", async () => {
    const refusal = JSON.stringify({ success: false, errors: [{ code: 0, message: 'Requires permission "com.cloudflare.api.account.zone.create" to create zones for the selected account' }] });
    const api = new CloudflareApi(USER_TOKEN, async () => new Response(refusal, { status: 403, headers: { "Content-Type": "application/json" } }));
    await expect(api.createZone("a".repeat(32), "example.com")).rejects.toThrow("the token lacks Zone: Edit for this account");
  });

  test("records are read across pages, TXT unquoted and SRV from its data", async () => {
    const { fake, agency } = cloudflare();
    const zone = fake.zone("example.com", agency);
    for (let n = 0; n < 1500; n++) fake.record("example.com", { type: "A", name: `h${n}.example.com`, content: "192.0.2.1" });
    fake.record("example.com", { type: "TXT", name: "example.com", content: '"v=spf1 " "mx ~all"' });
    fake.record("example.com", { type: "SRV", name: "_autodiscover._tcp.example.com", content: "0 443 mail.example.net", priority: 0,
      data: { priority: 0, weight: 0, port: 443, target: "mail.example.net" } });
    const records = await new CloudflareApi(USER_TOKEN, fake.fetch).records(zone.id);
    expect(records).toHaveLength(1502);
    expect(records.find((record) => record.type === "TXT")!.content).toBe("v=spf1 mx ~all");
    expect(records.find((record) => record.type === "SRV")).toMatchObject({ content: "0 443 mail.example.net", priority: 0 });
  });

  test("a listing that changes while it is read is read again, and refused if it keeps changing", async () => {
    const { fake, agency } = cloudflare();
    for (let n = 0; n < 60; n++) fake.zone(`z${n}.example`, agency);
    const inner = fake.fetch;
    let pages = 0;
    fake.fetch = async (url, init) => {
      if (new URL(url).pathname.endsWith("/zones") && ++pages === 2) fake.zone("late.example", agency);
      return inner(url, init);
    };
    expect(await new CloudflareApi(USER_TOKEN, fake.fetch).zones()).toHaveLength(61);
    fake.fetch = async (url, init) => {
      if (new URL(url).pathname.endsWith("/zones") && ++pages % 2 === 0) fake.zone(`late${pages}.example`, agency);
      return inner(url, init);
    };
    await expect(new CloudflareApi(USER_TOKEN, fake.fetch).zones()).rejects.toThrow("changed while it was being read");
  });

  test("a 429 keeps its Retry-After, and every later call waits for it without asking", async () => {
    const { fake, agency } = cloudflare();
    fake.zone("example.com", agency);
    fake.limit = { after: 0, retryAfter: "120" };
    const backoff = { until: 0 };
    const api = new CloudflareApi(USER_TOKEN, fake.fetch, backoff);
    const error = await api.zones().catch((caught) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.status).toBe(429);
    expect(backoff.until).toBeGreaterThan(Date.now() + 110_000);
    const calls = fake.calls.length;
    await expect(new CloudflareApi(USER_TOKEN, fake.fetch, backoff).zones()).rejects.toThrow("asked to wait");
    expect(fake.calls.length).toBe(calls);
  });

  test("a non-JSON reply is an error", async () => {
    const api = new CloudflareApi(USER_TOKEN, async () => new Response("<html>gateway</html>", { status: 502 }));
    await expect(api.zones()).rejects.toThrow("HTTP 502 without a JSON reply");
  });

  test("an error that repeats the token is redacted before it is kept or shown", async () => {
    const api = new CloudflareApi(USER_TOKEN, async (_url, init) => Response.json({
      success: false, errors: [{ code: 6003, message: `${"x".repeat(130)} rejected ${new Headers(init.headers).get("authorization")}` }],
    }, { status: 400 }));
    const message = await api.zones().then(() => "", (caught: Error) => caught.message);
    expect(message).toContain("[redacted]");
    expect(message).not.toContain(USER_TOKEN.slice(0, 12));
  });

  test("a refused rules or settings call names the permission the token lacks", async () => {
    const rule = { ref: "clp_dns_acme", action: "set_config", expression: "true", description: "x", enabled: true, action_parameters: { ssl: "full" } };
    const api = new CloudflareApi(USER_TOKEN, async () => Response.json({
      success: false, errors: [{ code: 10000, message: "Authentication error" }],
    }, { status: 403 }));
    await expect(api.entrypoint("a".repeat(32), "http_config_settings")).rejects.toThrow("lacks Config Rules: Edit");
    await expect(api.entrypoint("a".repeat(32), "http_request_firewall_custom")).rejects.toThrow("lacks Zone WAF: Edit");
    await expect(api.setting("a".repeat(32), "ssl")).rejects.toThrow("lacks Zone Settings: Edit");
    await expect(api.addRule("a".repeat(32), "http_config_settings", "b".repeat(32), rule)).rejects.toThrow("lacks Config Rules: Edit");
  });

  test("TXT values are written as quoted strings of at most 255 characters", () => {
    const long = "v=DKIM1;k=rsa;p=" + "A".repeat(400);
    const quoted = quoteTxt(long);
    expect(quoted.startsWith('"v=DKIM1')).toBe(true);
    expect(quoted.split('" "')).toHaveLength(2);
    expect(unquoteTxt(quoted)).toBe(long);
  });

  test("a new rule is added beside the phase's other rules rather than replacing them", async () => {
    const { fake, agency } = cloudflare();
    const zone = fake.zone("example.com", agency);
    const api = new CloudflareApi(USER_TOKEN, fake.fetch);
    const rule = { ref: "clp_dns_acme", action: "set_config", expression: "true", description: "x", enabled: true, action_parameters: { ssl: "full" } };
    expect(await api.entrypoint(zone.id, "http_config_settings")).toBeNull();
    const created = await api.createEntrypoint(zone.id, "http_config_settings", [{ ...rule, ref: "theirs" }]);
    const added = await api.addRule(zone.id, "http_config_settings", created.id, rule);
    expect(added.rules.map((entry) => entry.ref)).toEqual(["theirs", "clp_dns_acme"]);
  });
});

describe("Mailcow", () => {
  const origin = "https://mail.example.net";

  test("missing objects read as nothing, and refusals as errors with Mailcow's message", async () => {
    const fake = new FakeMailcow();
    const api = new MailcowApi(origin, MAILCOW_KEY, fake.fetch);
    expect(await api.hasDomain("example.com")).toBe(false);
    expect(await api.dkim("example.com")).toBeNull();
    await api.addDomain("example.com");
    expect(await api.hasDomain("example.com")).toBe(true);
    await expect(api.addDomain("example.com")).rejects.toThrow("domain_exists example.com");
    await expect(api.duplicateDkim("nokey.example", "example.com")).rejects.toThrow("dkim_domain_or_sel_invalid");
  });

  test("the published DKIM value is exactly the one Mailcow holds", async () => {
    const fake = new FakeMailcow();
    fake.domains.add("example.com");
    fake.key("source.example", "s2048");
    const api = new MailcowApi(origin, MAILCOW_KEY, fake.fetch);
    await api.duplicateDkim("source.example", "example.com");
    const key = await api.dkim("example.com");
    expect(key).toEqual({ selector: "s2048", txt: fake.dkim.get("source.example")!.dkim_txt });
  });

  test("a wrong key is refused, and the key is sent only as a header", async () => {
    const fake = new FakeMailcow();
    await expect(new MailcowApi(origin, "MC-wrong-key-000000000000", fake.fetch).hasDomain("example.com")).rejects.toThrow("refused the API key");
    const seen: RequestInit[] = [];
    const api = new MailcowApi(origin, MAILCOW_KEY, async (url, init) => { seen.push(init); expect(url).not.toContain(MAILCOW_KEY); return fake.fetch(url, init); });
    await api.hasDomain("example.com");
    expect(new Headers(seen[0]!.headers).get("x-api-key")).toBe(MAILCOW_KEY);
  });

  test("a refusal that repeats the key is redacted", async () => {
    const api = new MailcowApi(origin, MAILCOW_KEY, async (_url, init) => Response.json({ type: "danger", msg: ["key_invalid", new Headers(init.headers).get("x-api-key")] }));
    await expect(api.hasDomain("example.com")).rejects.toThrow("Mailcow: key_invalid [redacted]");
  });

  test("a sender list Mailcow does not report reads as unknown, not empty", async () => {
    const fake = new FakeMailcow();
    fake.mailboxes.set("relay@example.net", { sender_acl: ["@example.net"] });
    const api = new MailcowApi(origin, MAILCOW_KEY, fake.fetch);
    expect(await api.senderAcl("relay@example.net")).toEqual(["@example.net"]);
    fake.reportsAcl = false;
    expect(await api.senderAcl("relay@example.net")).toBeNull();
    await expect(api.senderAcl("nobody@example.net")).rejects.toThrow("has no mailbox");
  });
});

describe("a token's own permissions", () => {
  const ZONE = "com.cloudflare.api.account.zone.";
  const ACCOUNT = "com.cloudflare.api.account.";

  test("a user token reads its policies at /user/tokens/:id", async () => {
    const { fake, agency } = cloudflare();
    fake.tokens.get(USER_TOKEN)!.policies = [policy(["DNS Write", "API Tokens Read"], { [`${ZONE}*`]: "*" })];
    const api = new CloudflareApi(USER_TOKEN, fake.fetch);
    const verified = await api.verify();
    const list = await api.policies(verified, verified.id!);
    expect(fake.calls.at(-1)!.path).toBe(`/user/tokens/${verified.id}`);
    expect(list).toEqual([{ allow: true, permissions: ["DNS Write", "API Tokens Read"], resources: [{ account: "*", zone: "*" }] }]);
    expect(grants(list, PERMISSIONS.dns, { accountId: agency, zoneId: "f".repeat(32) })).toBe(true);
  });

  test("an account-owned token reads them at its account", async () => {
    const { fake, church } = cloudflare();
    fake.zone("church.example", church);
    fake.tokens.get(ACCOUNT_TOKEN)!.policies = [policy(["DNS Write", "Account API Tokens Read"], { [`${ACCOUNT}${church}`]: { [`${ZONE}*`]: "*" } })];
    const api = new CloudflareApi(ACCOUNT_TOKEN, fake.fetch);
    const verified = await api.verify();
    await api.policies(verified, verified.id!);
    expect(fake.calls.at(-1)!.path).toBe(`/accounts/${church}/tokens/${verified.id}`);
  });

  test("a token without API Tokens Read is refused its own details", async () => {
    const { fake } = cloudflare();
    const api = new CloudflareApi(USER_TOKEN, fake.fetch);
    const verified = await api.verify();
    await expect(api.policies(verified, verified.id!)).rejects.toMatchObject({ status: 403 });
  });

  test("resources are read flat, nested under an account, and for the user", () => {
    expect(parseResources({
      [`${ZONE}*`]: "*",
      [`${ZONE}${"1".repeat(32)}`]: "*",
      [`${ACCOUNT}${"a".repeat(32)}`]: { [`${ZONE}*`]: "*", [`${ZONE}${"2".repeat(32)}`]: "*" },
      [`${ACCOUNT}${"b".repeat(32)}`]: "*",
      "com.cloudflare.api.user.0123": "*",
      "com.cloudflare.api.something.else": "*",
    })).toEqual([
      { account: "*", zone: "*" },
      { account: "*", zone: "1".repeat(32) },
      { account: "a".repeat(32), zone: "*" },
      { account: "a".repeat(32), zone: "2".repeat(32) },
      { account: "b".repeat(32), zone: "*" },
      { account: "", zone: "", user: true },
    ]);
  });

  test("missing and partial permissions are named, a deny wins, and reach is described", () => {
    const [agency, clients] = ["a".repeat(32), "b".repeat(32)];
    const zones = [
      { id: "1".repeat(32), name: "example.com", accountId: agency },
      { id: "2".repeat(32), name: "example.org", accountId: clients },
      { id: "3".repeat(32), name: "example.net", accountId: clients },
    ];
    const access = readAccess({ owner: "user", accountId: null }, [
      { allow: true, permissions: ["DNS Write", "Zone Write", "Config Settings Write"], resources: [{ account: "*", zone: "*" }] },
      { allow: true, permissions: ["Zone Settings Write"], resources: [{ account: agency, zone: "*" }] },
      { allow: false, permissions: ["Config Settings Write"], resources: [{ account: "*", zone: "3".repeat(32) }] },
    ], { zones, accounts: [{ id: agency, name: "Agency" }, { id: clients, name: "Clients" }] });
    if (!access.readable) throw new Error("readable");
    expect(access.reach).toBe("All zones");
    expect(access.coverage.dns).toEqual({ held: "yes" });
    expect(access.coverage.zone).toEqual({ held: "yes" });
    expect(access.coverage.waf).toEqual({ held: "no" });
    expect(access.coverage.zoneSettings).toEqual({ held: "some", lacking: ["example.net", "example.org"], lackingCount: 2 });
    expect(access.coverage.configRules).toEqual({ held: "some", lacking: ["example.net"], lackingCount: 1 });
    expect(access.coverage.tokens).toEqual({ held: "yes" });
  });

  test("a token for chosen zones cannot create zones, and says which zones it reaches", () => {
    const agency = "a".repeat(32);
    const access = readAccess({ owner: "user", accountId: null }, [
      { allow: true, permissions: ["DNS Write", "Zone Write"], resources: [{ account: "*", zone: "1".repeat(32) }, { account: "*", zone: "2".repeat(32) }] },
    ], { zones: [{ id: "1".repeat(32), name: "example.com", accountId: agency }], accounts: [{ id: agency, name: "Agency" }] });
    if (!access.readable) throw new Error("readable");
    expect(access.reach).toBe("2 chosen zones");
    expect(access.coverage.dns).toEqual({ held: "yes" });
    expect(access.coverage.zone).toEqual({ held: "no" });
    const inAccount = readAccess({ owner: "account", accountId: agency }, [
      { allow: true, permissions: ["DNS Write"], resources: [{ account: agency, zone: "*" }] },
    ], { zones: [], accounts: [{ id: agency, name: "Agency" }] });
    expect(inAccount.readable && inAccount.reach).toBe("All zones in Agency");
  });
});
