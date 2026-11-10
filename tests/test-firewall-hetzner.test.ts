import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectHetzner, desiredRules, disconnectHetzner, hetznerView, OWNER_SELECTOR, parseCloudflareRanges, readCloudflareRanges,
  rulesSignature, setHetznerRole, sshPorts, syncHetzner, type HetznerOptions, type HetznerRole,
} from "../addons/firewall/hetzner";
import { HetznerApi, hetznerServerId } from "../addons/firewall/hetzner-api";
import type { HetznerRule } from "../addons/firewall/hetzner-api";
import { FakeHetzner } from "./fixtures/hetzner-api";

const uid = process.getuid!();
const TOKEN = "hz0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SERVER = 166224552;

// CloudPanel's file on the staging box, as `clpctl cloudflare:update:ips` writes it.
const CLOUDPANEL_IPS = `allow 173.245.48.0/20;
allow 103.21.244.0/22;
allow 103.22.200.0/22;
allow 103.31.4.0/22;
allow 141.101.64.0/18;
allow 108.162.192.0/18;
allow 190.93.240.0/20;
allow 188.114.96.0/20;
allow 197.234.240.0/22;
allow 198.41.128.0/17;
allow 162.158.0.0/15;
allow 104.16.0.0/13;
allow 104.24.0.0/14;
allow 172.64.0.0/13;
allow 131.0.72.0/22;
allow 2400:cb00::/32;
allow 2606:4700::/32;
allow 2803:f800::/32;
allow 2405:b500::/32;
allow 2405:8100::/32;
allow 2a06:98c0::/29;
allow 2c0f:f248::/32;
deny all;
`;
const CLOUDFLARE_V4 = "104.16.1.1";
const CLOUDFLARE_V6 = "2606:4700::1";
const RANGES = parseCloudflareRanges(CLOUDPANEL_IPS);

const ssh = (from = ["0.0.0.0/0", "::/0"], port = "22"): HetznerRule => ({ direction: "in", protocol: "tcp", port, source_ips: from });
const anyone = (port: string): HetznerRule => ({ direction: "in", protocol: "tcp", port, source_ips: ["0.0.0.0/0", "::/0"] });

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface Box {
  dir: string;
  options: HetznerOptions;
  dns: Map<string, string[]>;
  sshdPort: number;
}

/** One CloudPanel server: its state, its Cloudflare list, its sites and DNS answers, on a fake Hetzner. */
function box(fake: FakeHetzner, serverId: number | null = SERVER, sites: string[] = ["shop.example.com", "blog.example.com"]): Box {
  const dir = mkdtempSync(join(tmpdir(), "hetzner-test-"));
  dirs.push(dir);
  mkdirSync(join(dir, "sites"));
  writeFileSync(join(dir, "ips"), CLOUDPANEL_IPS, { mode: 0o644 });
  const db = new Database(join(dir, "panel.db"));
  db.exec("CREATE TABLE site (id INTEGER PRIMARY KEY, domain_name TEXT)");
  for (const site of sites) db.query("INSERT INTO site (domain_name) VALUES (?)").run(site);
  db.close();
  const dns = new Map<string, string[]>(sites.map((site) => [site, [CLOUDFLARE_V4, CLOUDFLARE_V6]]));
  const state: Box = {
    dir, dns, sshdPort: 22,
    options: {
      paths: {
        tokenFile: join(dir, "state", "hetzner-token.json"),
        syncFile: join(dir, "state", "hetzner.json"),
        lockFile: join(dir, "locks", "hetzner.lock"),
        ranges: join(dir, "ips"),
        panelDb: join(dir, "panel.db"),
        nginxSitesDir: join(dir, "sites"),
        customDomain: join(dir, "clp_custom_domain"),
        customDomainVhost: join(dir, "custom-domain.conf"),
        rootUid: uid,
        panelUid: uid,
      },
      fetch: fake.fetchAs(serverId),
      sleep: async () => {},
      resolve: async (host) => dns.get(host) ?? [],
      run: (command) => command === "ss"
        ? { ok: true, stdout: `LISTEN 0 128 0.0.0.0:${state.sshdPort} 0.0.0.0:* users:(("sshd",pid=1003,fd=3))\nLISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=1,fd=4))\n`, stderr: "" }
        : { ok: false, stdout: "", stderr: "" },
    },
  };
  return state;
}

function customDomain(server: Box, name: string, addresses: string[]): void {
  writeFileSync(join(server.dir, "clp_custom_domain"), `${name}\n`);
  writeFileSync(join(server.dir, "custom-domain.conf"), "server {}\n");
  server.dns.set(name, addresses);
}

async function connected(fake: FakeHetzner, serverId = SERVER, sites?: string[]): Promise<Box> {
  const server = box(fake, serverId, sites);
  await connectHetzner({ token: TOKEN }, server.options);
  return server;
}

/** Turns a switch, confirming the review it gets, as the page does. */
async function turn(server: Box, role: HetznerRole, enabled: boolean) {
  const first = await setHetznerRole(role, enabled, undefined, server.options);
  if (!("review" in first)) return first;
  return setHetznerRole(role, enabled, first.review.digest, server.options);
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { return (error as Error).message; }
  throw new Error("expected a refusal");
}

describe("Cloudflare's list", () => {
  test("CloudPanel's own file parses to its 22 ranges, IPv4 first", () => {
    expect(RANGES).toHaveLength(22);
    expect(RANGES[0]).toBe("103.21.244.0/22");
    expect(RANGES.findIndex((range) => range.includes(":"))).toBe(15);
  });

  test("anything but allow lines with network ranges is refused", () => {
    expect(() => parseCloudflareRanges("")).toThrow("lists no ranges");
    expect(() => parseCloudflareRanges("deny all;\n")).toThrow("lists no ranges");
    expect(() => parseCloudflareRanges("allow 173.245.48.0/20;\n")).toThrow("no IPv6 ranges");
    expect(() => parseCloudflareRanges("allow 2400:cb00::/32;\n")).toThrow("no IPv4 ranges");
    expect(() => parseCloudflareRanges(`${CLOUDPANEL_IPS}<html>`)).toThrow("line 24 is not an allow line");
    expect(() => parseCloudflareRanges("allow 173.245.48.0/20\nallow 2400:cb00::/32;")).toThrow("line 1");
    expect(() => parseCloudflareRanges("allow 173.245.48.1/20;\nallow 2400:cb00::/32;")).toThrow("not a network address");
    expect(() => parseCloudflareRanges("allow 0.0.0.0/0;\nallow 2400:cb00::/32;")).toThrow("wider than any Cloudflare range");
    expect(() => parseCloudflareRanges("allow all;\nallow 2400:cb00::/32;")).toThrow("line 1");
  });

  test("a missing, untrusted or malformed file changes nothing and says why", async () => {
    const fake = new FakeHetzner(TOKEN);
    fake.firewall("ssh", [ssh()], [SERVER]);
    const server = await connected(fake);
    await turn(server, "web", true);
    const before = structuredClone(fake.firewalls);
    const writes = fake.writes().length;

    writeFileSync(join(server.dir, "ips"), "");
    await expect(syncHetzner("repair", server.options)).rejects.toThrow("are unusable: it lists no ranges; the Hetzner firewalls were not changed");
    rmSync(join(server.dir, "ips"));
    await expect(syncHetzner("repair", server.options)).rejects.toThrow("are missing");
    writeFileSync(join(server.dir, "ips"), CLOUDPANEL_IPS);
    chmodSync(join(server.dir, "ips"), 0o666);
    expect(() => readCloudflareRanges(server.options)).toThrow("are not in a trusted regular file");
    expect(fake.writes()).toHaveLength(writes);
    expect(fake.firewalls).toEqual(before);
  });
});

describe("rules", () => {
  test("the rules are the same on every server, however its file orders or spells the list", () => {
    const shuffled = parseCloudflareRanges(`deny all;\n${CLOUDPANEL_IPS.split("\n").reverse().join("\n")}\nallow 2606:4700:0:0::/32;\n  allow 2A06:98C0::/29 ;\n`);
    expect(desiredRules("web", shuffled)).toEqual(desiredRules("web", RANGES));
    expect(desiredRules("web", RANGES).map((rule) => rule.port)).toEqual(["80", "443"]);
    expect(desiredRules("panel", RANGES).map((rule) => rule.port)).toEqual(["8443"]);
  });

  test("the signature ignores order and spelling, and catches any change in what is allowed", () => {
    const rules = desiredRules("web", RANGES);
    const respelled = [...rules].reverse().map((rule) => ({
      ...rule, source_ips: [...rule.source_ips!].reverse().map((ip) => ip.replace("2606:4700::/32", "2606:4700:0::/32")), destination_ips: [],
    }));
    expect(rulesSignature(respelled)).toBe(rulesSignature(rules));
    const fewer = rules.map((rule) => ({ ...rule, source_ips: rule.source_ips!.slice(1) }));
    expect(rulesSignature(fewer)).not.toBe(rulesSignature(rules));
    expect(rulesSignature([...rules, ssh()])).not.toBe(rulesSignature(rules));
    expect(rulesSignature(rules.map((rule) => ({ ...rule, port: "1-65535" })))).not.toBe(rulesSignature(rules));
  });

  test("two servers in one project share one firewall per role, and neither rewrites what the other wrote", async () => {
    const fake = new FakeHetzner(TOKEN);
    fake.servers.set(2, "cp-fra-2");
    fake.firewall("ssh", [ssh()], [SERVER, 2]);
    const one = await connected(fake);
    const two = await connected(fake, 2);
    await turn(one, "web", true);
    await turn(two, "web", true);
    const owned = fake.firewalls.filter((firewall) => firewall.labels["managed-by"] === "clp-addons");
    expect(owned.map((firewall) => firewall.name)).toEqual(["clp-addons-cloudflare-web"]);
    expect(owned[0]!.applied_to.map((entry) => entry.server!.id).sort((a, b) => a - b)).toEqual([2, SERVER]);
    const writes = fake.writes().length;
    expect(await syncHetzner("repair", one.options)).toBeNull();
    expect(await syncHetzner("repair", two.options)).toBeNull();
    expect(fake.writes()).toHaveLength(writes);
  });

  test("repair puts back a rule changed in Hetzner's console, and writes nothing when nothing differs", async () => {
    const fake = new FakeHetzner(TOKEN);
    fake.firewall("ssh", [ssh()], [SERVER]);
    const server = await connected(fake);
    await turn(server, "web", true);
    const web = fake.firewalls.find((firewall) => firewall.name === "clp-addons-cloudflare-web")!;
    web.rules = [...web.rules, anyone("443")];
    expect(await syncHetzner("repair", server.options)).toBe("1 Hetzner firewall set to Cloudflare's list");
    expect(rulesSignature(web.rules)).toBe(rulesSignature(desiredRules("web", RANGES)));
    const writes = fake.writes().length;
    expect(await syncHetzner("repair", server.options)).toBeNull();
    expect(fake.writes()).toHaveLength(writes);
  });

  test("the list watcher asks Hetzner nothing until the list changes", async () => {
    const fake = new FakeHetzner(TOKEN);
    fake.firewall("ssh", [ssh()], [SERVER]);
    const server = await connected(fake);
    await turn(server, "web", true);
    const calls = fake.calls.length;
    expect(await syncHetzner("ranges", server.options)).toBeNull();
    expect(fake.calls).toHaveLength(calls);
    writeFileSync(join(server.dir, "ips"), CLOUDPANEL_IPS.replace("allow 131.0.72.0/22;\n", ""));
    expect(await syncHetzner("ranges", server.options)).toBe("1 Hetzner firewall set to Cloudflare's list");
    expect(fake.firewalls.find((firewall) => firewall.name === "clp-addons-cloudflare-web")!.rules[0]!.source_ips).not.toContain("131.0.72.0/22");
  });

  test("a server whose list is older leaves the firewall to the server with the newer one", async () => {
    const fake = new FakeHetzner(TOKEN);
    fake.servers.set(2, "cp-fra-2");
    fake.firewall("ssh", [ssh()], [SERVER, 2]);
    const fresh = await connected(fake);
    const stale = await connected(fake, 2);
    writeFileSync(join(fresh.dir, "ips"), CLOUDPANEL_IPS.replace("allow 131.0.72.0/22;\n", ""));
    const old = new Date(Date.now() - 86_400_000);
    utimesSync(join(stale.dir, "ips"), old, old);
    await turn(fresh, "web", true);
    const web = fake.firewalls.find((firewall) => firewall.name === "clp-addons-cloudflare-web")!;
    const written = JSON.stringify(web.rules);
    expect(await syncHetzner("repair", stale.options)).toBe("1 Hetzner firewall follows a newer Cloudflare list from another server");
    expect(JSON.stringify(web.rules)).toBe(written);
    expect(await syncHetzner("repair", fresh.options)).toBeNull();
  });

  test("repair deletes an owned firewall nothing uses, and never one without the label", async () => {
    const fake = new FakeHetzner(TOKEN);
    fake.firewall("clp-addons-cloudflare-panel", desiredRules("panel", RANGES), [], { "managed-by": "clp-addons", "clp-addons-role": "panel" });
    fake.firewall("someone-elses", [anyone("443")], []);
    const server = await connected(fake);
    expect(await syncHetzner("repair", server.options)).toBe("1 unused Hetzner firewall deleted");
    expect(fake.firewalls.map((firewall) => firewall.name)).toEqual(["someone-elses"]);
  });
});

describe("safeguards", () => {
  test("nothing is attached unless another firewall on this server allows the port sshd listens on", async () => {
    const fake = new FakeHetzner(TOKEN);
    const server = await connected(fake);
    expect(await refusal(setHetznerRole("web", true, undefined, server.options))).toContain("no other firewall is attached to this server to allow SSH on port 22");
    fake.firewall("office", [ssh()], [SERVER]);
    server.sshdPort = 2222;
    const message = await refusal(setHetznerRole("panel", true, undefined, server.options));
    expect(message).toContain("no other firewall on this server (office) allows SSH on port 2222");
    expect(message).toContain("clp-addons-cloudflare-panel alone would shut SSH out");
    // A firewall elsewhere in the project does not count.
    fake.firewall("ssh-2222", [ssh(["203.0.113.7/32"], "2222")], [99]);
    expect(await refusal(setHetznerRole("web", true, undefined, server.options))).toContain("port 2222");
    fake.firewalls.at(-1)!.applied_to.push({ type: "server", server: { id: SERVER } });
    expect("review" in await setHetznerRole("web", true, undefined, server.options)).toBe(true);
    expect(fake.writes()).toEqual([]);
  });

  test("sshd's port comes from ss, else from its configuration", () => {
    expect(sshPorts(() => ({ ok: true, stdout: `LISTEN 0 128 0.0.0.0:2222 0.0.0.0:* users:(("sshd",pid=9,fd=3))\nLISTEN 0 128 [::]:2222 [::]:* users:(("sshd",pid=9,fd=4))\n`, stderr: "" }))).toEqual([2222]);
    expect(sshPorts((command) => command === "ss"
      ? { ok: true, stdout: `LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("systemd",pid=1,fd=50))\n`, stderr: "" }
      : { ok: true, stdout: "port 22\nport 2200\naddressfamily any\n", stderr: "" })).toEqual([22, 2200]);
  });

  test("the panel switch needs a custom domain proxied through Cloudflare that Cloudflare can reach on 443", async () => {
    const fake = new FakeHetzner(TOKEN);
    const office = fake.firewall("office", [ssh(["203.0.113.7/32"])], [SERVER]);
    const server = await connected(fake);
    expect(await refusal(setHetznerRole("panel", true, undefined, server.options))).toContain("CloudPanel has no custom domain. Add one under Admin → Settings");
    customDomain(server, "cp.example.com", ["46.225.93.37"]);
    expect(await refusal(setHetznerRole("panel", true, undefined, server.options))).toContain("cp.example.com resolves to 46.225.93.37, which is not Cloudflare");
    server.dns.set("cp.example.com", []);
    expect(await refusal(setHetznerRole("panel", true, undefined, server.options))).toContain("cp.example.com does not resolve");
    server.dns.set("cp.example.com", [CLOUDFLARE_V4, CLOUDFLARE_V6]);
    expect(await refusal(setHetznerRole("panel", true, undefined, server.options))).toContain("no firewall on this server lets Cloudflare reach 443");
    office.rules.push(anyone("443"));
    const first = await setHetznerRole("panel", true, undefined, server.options);
    if (!("review" in first)) throw new Error("expected a review");
    expect(first.review.text).toContain("CloudPanel will answer only at https://cp.example.com");
    expect(first.review.text).toContain("SSH tunnel to 127.0.0.1:8443");
    expect(fake.writes()).toEqual([]);
  });

  test("the sites switch names every hostname that reaches this server outside Cloudflare, aliases and the panel's included", async () => {
    const fake = new FakeHetzner(TOKEN);
    fake.firewall("office", [ssh()], [SERVER]);
    const server = await connected(fake, SERVER, ["shop.example.com", "blog.example.com", "old.example.org"]);
    server.dns.set("blog.example.com", ["46.225.93.37", CLOUDFLARE_V6]);
    server.dns.set("old.example.org", []);
    writeFileSync(join(server.dir, "sites", "shop.example.com.conf"), `server {
  listen 443 ssl;
  server_name shop.example.com www.shop.example.com  Store.Example.NET 203.0.113.9 *.wild.example.com _;
  proxy_ssl_server_name on;
}
`, { mode: 0o644 });
    server.dns.set("www.shop.example.com", ["46.225.93.37"]);
    server.dns.set("store.example.net", [CLOUDFLARE_V4]);
    customDomain(server, "cp.example.com", ["46.225.93.37"]);
    const first = await setHetznerRole("web", true, undefined, server.options);
    if (!("review" in first)) throw new Error("expected a review");
    expect(first.review.text).toContain("These 3 hostnames do not resolve to Cloudflare and stop answering");
    expect(first.review.details).toEqual([
      "blog.example.com resolves to 46.225.93.37",
      "cp.example.com (CloudPanel) resolves to 46.225.93.37",
      "www.shop.example.com resolves to 46.225.93.37",
    ]);
    expect(fake.writes()).toEqual([]);
  });

  test("a firewall deleted by another server on every attempt fails the switch instead of reporting success", async () => {
    const fake = new FakeHetzner(TOKEN);
    fake.firewall("office", [ssh()], [SERVER]);
    fake.firewall("clp-addons-cloudflare-web", desiredRules("web", RANGES), [7], { "managed-by": "clp-addons", "clp-addons-role": "web" });
    fake.applyNotFound = true;
    const server = await connected(fake);
    expect(await refusal(turn(server, "web", true))).toContain("was deleted by another server each time it was attached");
  });

  test("only the review the operator saw makes the change", async () => {
    const fake = new FakeHetzner(TOKEN);
    fake.firewall("office", [ssh()], [SERVER]);
    const server = await connected(fake);
    const first = await setHetznerRole("web", true, undefined, server.options);
    if (!("review" in first)) throw new Error("expected a review");
    expect("review" in await setHetznerRole("web", true, "not-the-digest", server.options)).toBe(true);
    server.dns.set("shop.example.com", ["46.225.93.37"]);
    const changed = await setHetznerRole("web", true, first.review.digest, server.options);
    expect("review" in changed && changed.review.details).toEqual(["shop.example.com resolves to 46.225.93.37"]);
    expect(fake.writes()).toEqual([]);
  });

  test("another firewall that still lets anyone reach the port is named instead of success", async () => {
    const fake = new FakeHetzner(TOKEN);
    fake.firewall("office", [ssh(), anyone("80-443")], [SERVER]);
    const server = await connected(fake);
    const first = await setHetznerRole("web", true, undefined, server.options);
    expect("review" in first && first.review.text).toContain("80 is still open to anyone through firewall office. 443 is still open to anyone through firewall office.");
    const done = await turn(server, "web", true);
    expect("notice" in done && done.notice).toContain("clp-addons-cloudflare-web is attached, but has no effect yet: 80 is still open to anyone");
    const view = await hetznerView(server.options);
    expect(view.state === "connected" && view.roles.web.stillOpen).toHaveLength(2);
    // A source inside Cloudflare's ranges does not count.
    fake.firewalls[0]!.rules = [ssh(), { direction: "in", protocol: "tcp", port: "443", source_ips: ["104.16.0.0/16"] }];
    const quiet = await hetznerView(server.options);
    expect(quiet.state === "connected" && quiet.roles.web.stillOpen).toEqual([]);
  });

  test("turning a switch off says what closes, detaches, and deletes the firewall once nothing uses it", async () => {
    const fake = new FakeHetzner(TOKEN);
    fake.firewall("office", [ssh()], [SERVER]);
    const server = await connected(fake);
    await turn(server, "web", true);
    const off = await setHetznerRole("web", false, undefined, server.options);
    if (!("review" in off)) throw new Error("expected a review");
    expect(off.review.text).toContain("No other firewall on this server (office) allows 80 and 443, so every site stops answering");
    expect(off.review.danger).toBe(true);
    expect(await turn(server, "web", false)).toEqual({ notice: "Sites through Cloudflare only is off." });
    expect(fake.firewalls.map((firewall) => firewall.name)).toEqual(["office"]);
  });

  test("an owned firewall another server still uses is detached but kept", async () => {
    const fake = new FakeHetzner(TOKEN);
    fake.servers.set(2, "cp-fra-2");
    fake.firewall("office", [ssh(), anyone("80"), anyone("443")], [SERVER, 2]);
    const one = await connected(fake);
    const two = await connected(fake, 2);
    await turn(one, "web", true);
    await turn(two, "web", true);
    await turn(one, "web", false);
    const web = fake.firewalls.find((firewall) => firewall.name === "clp-addons-cloudflare-web")!;
    expect(web.applied_to).toEqual([{ type: "server", server: { id: 2 } }]);
  });

  test("a firewall of the same name without the label is never touched", async () => {
    const fake = new FakeHetzner(TOKEN);
    fake.firewall("office", [ssh()], [SERVER]);
    const mine = fake.firewall("clp-addons-cloudflare-web", [anyone("80")], []);
    const server = await connected(fake);
    expect(await refusal(turn(server, "web", true))).toContain("already exists in this Hetzner project without the label managed-by=clp-addons");
    expect(mine.rules).toEqual([anyone("80")]);
    expect(mine.applied_to).toEqual([]);
  });

  test("a token is removed even when Hetzner cannot be asked, with a warning", async () => {
    const fake = new FakeHetzner(TOKEN);
    const server = await connected(fake);
    const api = server.options.fetch!;
    server.options.fetch = async (url, init) => url.startsWith("https://api.hetzner.cloud/")
      ? new Response(JSON.stringify({ error: { code: "service_error", message: "try again later" } }), { status: 503 })
      : api(url, init);
    const { notice } = await disconnectHetzner(server.options);
    expect(notice).toContain("The Hetzner token is removed");
    expect(notice).toContain("could not be asked what is attached to this server");
    expect((await hetznerView(server.options)).state).toBe("disconnected");
  });

  test("a range time far ahead of this server's clock does not hold the rules", async () => {
    const fake = new FakeHetzner(TOKEN);
    const ahead = String(Math.floor(Date.now() / 1000) + 10 * 86_400);
    const web = fake.firewall("clp-addons-cloudflare-web", [anyone("80")], [SERVER],
      { "managed-by": "clp-addons", "clp-addons-role": "web", "clp-addons-ranges-at": ahead });
    const server = await connected(fake);
    expect(await syncHetzner("repair", server.options)).toBe("1 Hetzner firewall set to Cloudflare's list");
    expect(rulesSignature(web.rules)).toBe(rulesSignature(desiredRules("web", RANGES)));
  });

  test("the token cannot be removed while one of its firewalls is attached here", async () => {
    const fake = new FakeHetzner(TOKEN);
    fake.firewall("office", [ssh()], [SERVER]);
    const server = await connected(fake);
    await turn(server, "web", true);
    expect(await refusal(disconnectHetzner(server.options))).toContain("Turn both switches off first");
    await turn(server, "web", false);
    expect((await disconnectHetzner(server.options)).notice).toContain("removed");
    expect((await hetznerView(server.options)).state).toBe("disconnected");
  });
});

describe("the token", () => {
  test("is checked against this server, kept root-only, and never in a message", async () => {
    const fake = new FakeHetzner(TOKEN);
    const server = box(fake);
    expect(await refusal(connectHetzner({ token: "not a token; rm -rf /" }, server.options))).toContain("letters and digits only");
    const wrong = `${TOKEN.slice(0, -1)}X`;
    fake.echoToken = true;
    const refused = await refusal(connectHetzner({ token: wrong }, server.options));
    expect(refused).toBe("Hetzner did not accept this token");
    expect(refused).not.toContain(wrong);

    const other = new FakeHetzner(TOKEN);
    other.servers.clear();
    expect(await refusal(connectHetzner({ token: TOKEN }, { ...server.options, fetch: other.fetchAs(SERVER) })))
      .toContain(`This token's project does not have this server (id ${SERVER})`);

    expect(await connectHetzner({ token: TOKEN }, server.options)).toEqual({ notice: "Connected to the Hetzner project of cp-fra-1." });
    const file = join(server.dir, "state", "hetzner-token.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ token: TOKEN });
    const view = await hetznerView(server.options);
    expect(JSON.stringify(view)).not.toContain(TOKEN);
  });

  test("a provider message that repeats the token is redacted", async () => {
    const fake = new FakeHetzner("another-token-entirely-0123456789");
    fake.echoToken = true;
    const api = new HetznerApi(TOKEN, fake.fetchAs(SERVER));
    const message = await refusal(api.server(SERVER));
    expect(message).toContain("[redacted]");
    expect(message).not.toContain(TOKEN);
    const server = box(fake);
    mkdirSync(join(server.dir, "state"));
    writeFileSync(join(server.dir, "state", "hetzner-token.json"), JSON.stringify({ token: TOKEN }), { mode: 0o600 });
    const view = await hetznerView(server.options);
    expect(view.state).toBe("error");
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    expect(JSON.stringify(view)).toContain("[redacted]");
  });
});

describe("the metadata service", () => {
  /** This box's fetch, with the metadata service silent. */
  const silent = (server: Box) => {
    const api = server.options.fetch!;
    let probes = 0;
    server.options.fetch = async (url, init) => {
      if (url.startsWith("http://169.254.169.254/")) { probes++; throw new Error("timed out"); }
      return api(url, init);
    };
    return () => probes;
  };

  test("a moment's silence on a connected server falls back to the id kept at connect", async () => {
    const fake = new FakeHetzner(TOKEN);
    fake.firewall("office", [ssh()], [SERVER]);
    const server = await connected(fake);
    await turn(server, "web", true);
    silent(server);
    expect((await hetznerView(server.options)).state).toBe("connected");
    expect(await refusal(disconnectHetzner(server.options))).toContain("Turn both switches off first");
  });

  test("off Hetzner Cloud the page asks the metadata service once per ten minutes", async () => {
    const server = box(new FakeHetzner(TOKEN, null), null);
    const probes = silent(server);
    let now = 1_000_000;
    server.options.now = () => now;
    expect(await hetznerView(server.options)).toEqual({ state: "absent" });
    expect(await hetznerView(server.options)).toEqual({ state: "absent" });
    expect(probes()).toBe(1);
    now += 10 * 60_000 + 1;
    await hetznerView(server.options);
    expect(probes()).toBe(2);
  });
});

describe("off Hetzner Cloud", () => {
  test("the card says so, and nothing can be connected or switched", async () => {
    const fake = new FakeHetzner(TOKEN, null);
    const server = box(fake, null);
    expect(await hetznerView(server.options)).toEqual({ state: "absent" });
    expect(await refusal(connectHetzner({ token: TOKEN }, server.options))).toContain("not a Hetzner Cloud server");
    expect(await refusal(setHetznerRole("web", true, undefined, server.options))).toContain("not a Hetzner Cloud server");
    expect(await syncHetzner("repair", server.options)).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  test("the metadata service's answer must be a server id", async () => {
    expect(await hetznerServerId(async () => new Response("166224552\n"))).toBe(166224552);
    expect(await hetznerServerId(async () => new Response("<html>not found</html>", { status: 404 }))).toBeNull();
    expect(await hetznerServerId(async () => new Response("i-0abc123"))).toBeNull();
    expect(await hetznerServerId(async () => { throw new Error("EHOSTUNREACH"); })).toBeNull();
  });
});

test("owned firewalls are found by label, not by name", () => {
  expect(OWNER_SELECTOR).toBe("managed-by=clp-addons");
});
