import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { withFileLock } from "../lib/file-lock";
import { join } from "node:path";
import { parseCloudflareRanges, type CloudRole } from "../addons/firewall/cloud-firewall";
import {
  connectNetcup, disconnectNetcup, isPublicAddress, netcupOpenRules, netcupRules, netcupSetupState, netcupSignature, netcupView, pollNetcup,
  setNetcupRole, syncNetcup, type NetcupOptions,
} from "../addons/firewall/netcup";
import { NetcupAuth, type NetcupRule } from "../addons/firewall/netcup-api";
import { netcupActions } from "../addons/firewall/setup";
import { FakeNetcup } from "./fixtures/netcup-api";

const uid = process.getuid!();
const SERVER = 512345;
const ADDRESS = "203.0.113.24";
const V6_ONLY = "2a03:4000:2:95a:147b:36ff:fea4:2563";

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
const RANGES = parseCloudflareRanges(CLOUDPANEL_IPS);
const ssh = (port = "22"): NetcupRule => ({ direction: "INGRESS", protocol: "TCP", action: "ACCEPT", sources: [], destinationPorts: port });

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface Box { dir: string; options: NetcupOptions; now: { at: number } }

function box(fake: FakeNetcup, address: string | string[] = ADDRESS, vendor = "netcup\n"): Box {
  const dir = mkdtempSync(join(tmpdir(), "netcup-test-"));
  dirs.push(dir);
  mkdirSync(join(dir, "sites"));
  writeFileSync(join(dir, "ips"), CLOUDPANEL_IPS, { mode: 0o644 });
  writeFileSync(join(dir, "sys_vendor"), vendor);
  const db = new Database(join(dir, "panel.db"));
  db.exec("CREATE TABLE site (id INTEGER PRIMARY KEY, domain_name TEXT)");
  db.query("INSERT INTO site (domain_name) VALUES (?)").run("shop.example.com");
  db.exec("CREATE TABLE firewall_rule (id INTEGER PRIMARY KEY, port_range TEXT, source TEXT)");
  for (const port of ["22", "80", "443", "8443"]) {
    for (const source of ["0.0.0.0/0", "::/0"]) db.query("INSERT INTO firewall_rule (port_range, source) VALUES (?, ?)").run(port, source);
  }
  db.close();
  const now = { at: Date.now() };
  return {
    dir, now,
    options: {
      paths: {
        tokenFile: join(dir, "state", "netcup-token.json"),
        deviceFile: join(dir, "state", "netcup-device.json"),
        syncFile: join(dir, "state", "netcup.json"),
        lockFile: join(dir, "locks", "netcup.lock"),
        tokenLockFile: join(dir, "locks", "netcup-token.lock"),
        ranges: join(dir, "ips"),
        panelDb: join(dir, "panel.db"),
        nginxSitesDir: join(dir, "sites"),
        customDomain: join(dir, "clp_custom_domain"),
        customDomainVhost: join(dir, "custom-domain.conf"),
        protocolsFile: join(dir, "state", "protocols.json"),
        terminalConfig: join(dir, "terminal.conf"),
        vendor: join(dir, "sys_vendor"),
        rootUid: uid,
        panelUid: uid,
      },
      fetch: fake.fetch,
      sleep: async () => {},
      now: () => now.at,
      addresses: () => [address].flat(),
      macs: () => [],
      resolve: async (host) => host === "shop.example.com" ? ["104.16.1.1", "2606:4700::1"] : [],
      run: (command) => command === "ss"
        ? { ok: true, stdout: `LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1003,fd=3))\n`, stderr: "" }
        : { ok: false, stdout: "", stderr: "" },
    },
  };
}

async function connected(fake: FakeNetcup, address: string | string[] = ADDRESS): Promise<Box> {
  const server = box(fake, address);
  await connectNetcup(server.options);
  fake.granted = true;
  const done = await pollNetcup(server.options);
  if (!("notice" in done)) throw new Error("expected the sign-in to finish");
  return server;
}

async function turn(server: Box, role: CloudRole, enabled: boolean) {
  const first = await setNetcupRole(role, enabled, undefined, server.options);
  if (!("review" in first)) return first;
  return setNetcupRole(role, enabled, first.review.digest, server.options, first.review.typed);
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { return (error as Error).message; }
  throw new Error("expected a refusal");
}

describe("signing in", () => {
  test("the device sign-in shows netcup's code and link, waits, then keeps only the refresh token, root-only", async () => {
    const fake = new FakeNetcup();
    const server = box(fake);
    const started = await connectNetcup(server.options);
    expect(started).toEqual({ userCode: "BQMU-KITQ", verificationUri: "https://www.servercontrolpanel.de/realms/scp/device?user_code=BQMU-KITQ", interval: 5, expiresIn: 600 });
    expect(JSON.stringify(started)).not.toContain("device-code");
    expect(await pollNetcup(server.options)).toEqual({ pending: true, interval: 5 });
    fake.granted = true;
    expect(await pollNetcup(server.options)).toEqual({ notice: "Connected to netcup; this server is cp-nue-1 there." });
    const tokenFile = join(server.dir, "state", "netcup-token.json");
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(tokenFile, "utf8"))).toEqual({ refreshToken: fake.refreshToken });
    expect(existsSync(join(server.dir, "state", "netcup-device.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(server.dir, "state", "netcup.json"), "utf8")))
      .toEqual({ userId: 4711, serverId: SERVER, mac: "aa:bb:cc:00:00:01", serverName: "cp-nue-1" });
  });

  test("each use keeps the refresh token netcup rotated to, and a refused one asks to connect again", async () => {
    const fake = new FakeNetcup();
    const server = await connected(fake);
    const first = fake.refreshToken;
    expect((await netcupView(server.options)).state).toBe("connected");
    expect(fake.refreshToken).not.toBe(first);
    expect(JSON.parse(readFileSync(join(server.dir, "state", "netcup-token.json"), "utf8")).refreshToken).toBe(fake.refreshToken);
    fake.revokeAll();
    const view = await netcupView(server.options);
    expect(view).toEqual({ state: "error", connected: true, error: "netcup no longer accepts the saved sign-in; connect again." });
  });

  test("a poll netcup fails to answer keeps the sign-in waiting; invalid_grant ends it", async () => {
    const fake = new FakeNetcup();
    const server = box(fake);
    await connectNetcup(server.options);
    fake.pollStatus = 503;
    expect(await pollNetcup(server.options)).toEqual({ pending: true, interval: 5 });
    expect(existsSync(join(server.dir, "state", "netcup-device.json"))).toBe(true);
    fake.pollStatus = null;
    fake.granted = true;
    expect(await pollNetcup(server.options)).toEqual({ notice: "Connected to netcup; this server is cp-nue-1 there." });
    await connectNetcup(server.options);
    const realFetch = fake.fetch;
    server.options.fetch = async (url, init) => url.endsWith("/token")
      ? new Response(JSON.stringify({ error: "invalid_grant", error_description: "Invalid device code" }), { status: 400 })
      : realFetch(url, init);
    expect(await refusal(pollNetcup(server.options))).toContain("connect again");
    expect(existsSync(join(server.dir, "state", "netcup-device.json"))).toBe(false);
  });

  test("access denied or an expired code ends the sign-in", async () => {
    const fake = new FakeNetcup();
    const server = box(fake);
    await connectNetcup(server.options);
    fake.denied = true;
    expect(await refusal(pollNetcup(server.options))).toContain("Access was denied in netcup");
    await connectNetcup(server.options);
    server.now.at += 601_000;
    expect(await refusal(pollNetcup(server.options))).toContain("The code expired");
    expect(existsSync(join(server.dir, "state", "netcup-token.json"))).toBe(false);
  });

  test("an account without this server's address is kept, and the card says which address it looked for", async () => {
    const fake = new FakeNetcup();
    const server = box(fake, "198.51.100.7");
    await connectNetcup(server.options);
    fake.granted = true;
    expect(await pollNetcup(server.options)).toEqual({
      notice: "Connected to netcup. No server in this netcup account has this server's address (198.51.100.7); connect the account that holds it.",
    });
    expect(await netcupView(server.options)).toEqual({
      state: "error", connected: true, error: "No server in this netcup account has this server's address (198.51.100.7); connect the account that holds it.",
    });
  });

  test("the server is matched by the exact address, not one the filter also returns", async () => {
    const fake = new FakeNetcup();
    fake.server(600001, "v2202411000000002", null, "aa:bb:cc:00:00:02", "203.0.113.245");
    const server = await connected(fake, "203.0.113.245");
    const view = await netcupView(server.options);
    expect(view.state === "connected" && [view.serverId, view.serverName]).toEqual([600001, "v2202411000000002"]);
  });

  test("an IPv6-only server is found by the prefix netcup lists for its interface", async () => {
    const fake = new FakeNetcup();
    fake.server(600002, "v2202411000000003", "cp-v6", "aa:bb:cc:00:00:03", null, { networkPrefix: "2a03:4000:2:95a::", cidr: "2a03:4000:2:95a::/64" });
    const server = await connected(fake, V6_ONLY);
    const view = await netcupView(server.options);
    expect(view.state === "connected" && [view.serverId, view.serverName]).toEqual([600002, "cp-v6"]);
    expect(fake.calls.some((call) => call.path.startsWith("/scp-core/api/v1/servers?limit=100&offset=0"))).toBe(true);
    expect(await netcupView(box(fake, V6_ONLY).options)).toEqual({ state: "disconnected", address: V6_ONLY });
  });

  test("a server is found by its interface's MAC, and a prefix given only by its length", async () => {
    const fake = new FakeNetcup();
    fake.server(600003, "v2202411000000004", "cp-mac", "aa:bb:cc:00:00:04", null, null);
    const byMac = box(fake, "2001:db8:1::5");
    byMac.options.macs = () => ["AA:BB:CC:00:00:04"];
    await connectNetcup(byMac.options);
    fake.granted = true;
    expect(await pollNetcup(byMac.options)).toEqual({ notice: "Connected to netcup; this server is cp-mac there." });
    fake.server(600004, "v2202411000000005", "cp-len", "aa:bb:cc:00:00:05", null, { networkPrefix: "2001:db8:2::", cidr: "64" });
    const byLength = await connected(fake, "2001:db8:2::9");
    const view = await netcupView(byLength.options);
    expect(view.state === "connected" && view.serverName).toBe("cp-len");
  });

  test("without an id in userinfo, the user id is the one this account's logs name under the signed-in username", async () => {
    const fake = new FakeNetcup();
    fake.userinfoId = false;
    fake.policy("ssh", [ssh()], [SERVER]);
    const server = await connected(fake);
    expect(JSON.parse(readFileSync(join(server.dir, "state", "netcup.json"), "utf8")).userId).toBe(4711);
    expect(fake.calls.some((call) => call.path === "/scp-core/api/v1/users/17")).toBe(false);
    await turn(server, "web", true);
    expect(fake.userPolicies()).toEqual(["ssh", "clp-addons-cloudflare-web"]);
  });

  test("a view while a change holds the lock leaves netcup.json to the change", async () => {
    const fake = new FakeNetcup();
    const server = await connected(fake);
    const syncFile = join(server.dir, "state", "netcup.json");
    writeFileSync(syncFile, JSON.stringify({ userId: 4711 }), { mode: 0o600 });
    await withFileLock(join(server.dir, "locks", "netcup.lock"), 0, "held", async () => {
      expect((await netcupView(server.options)).state).toBe("connected");
    });
    expect(JSON.parse(readFileSync(syncFile, "utf8"))).toEqual({ userId: 4711 });
    await netcupView(server.options);
    expect(JSON.parse(readFileSync(syncFile, "utf8")).serverId).toBe(SERVER);
  });

  test("off netcup the card is absent, and on netcup it names this server's address before a sign-in", async () => {
    const fake = new FakeNetcup();
    const elsewhere = box(fake, ADDRESS, "QEMU\n");
    expect(await netcupView(elsewhere.options)).toEqual({ state: "absent" });
    expect(netcupSetupState(elsewhere.options).cloud).toBe(false);
    const here = box(fake);
    expect(await netcupView(here.options)).toEqual({ state: "disconnected", address: ADDRESS });
    expect(fake.calls).toEqual([]);
  });

  test("disconnecting revokes the sign-in, and is refused while a Cloudflare policy is on this server", async () => {
    const fake = new FakeNetcup();
    fake.policy("ssh", [ssh()], [SERVER]);
    const server = await connected(fake);
    await turn(server, "web", true);
    expect(await refusal(disconnectNetcup(server.options))).toContain("Turn both switches off first: clp-addons-cloudflare-web");
    await turn(server, "web", false);
    const { notice } = await disconnectNetcup(server.options);
    expect(notice).toBe("The netcup sign-in is removed and revoked. clp-addons-open-web stays on this server, so those ports stay open to anyone; remove it in SCP if you no longer want that.");
    expect(fake.revoked).toEqual([fake.refreshToken!]);
    expect(existsSync(join(server.dir, "state", "netcup-token.json"))).toBe(false);
  });

  test("disconnecting is refused while netcup cannot be read, and goes ahead for an account without this server", async () => {
    const fake = new FakeNetcup();
    const server = await connected(fake);
    fake.firewallReadStatus = 503;
    expect(await refusal(disconnectNetcup(server.options))).toBe(
      "Could not ask netcup which policies this server has: netcup: Service unavailable. Try again; disconnecting now would leave a clp-addons policy on this server that no longer follows Cloudflare's list",
    );
    expect(existsSync(join(server.dir, "state", "netcup-token.json"))).toBe(true);
    const elsewhere = await connected(new FakeNetcup(), "198.51.100.7");
    const { notice } = await disconnectNetcup(elsewhere.options);
    expect(notice).toContain("(No server in this netcup account has this server's address (198.51.100.7); connect the account that holds it)");
    expect(existsSync(join(elsewhere.dir, "state", "netcup-token.json"))).toBe(false);
  });

  test("a sign-in netcup refuses is removed anyway, with a warning", async () => {
    const fake = new FakeNetcup();
    const server = await connected(fake);
    fake.revokeAll();
    const { notice } = await disconnectNetcup(server.options);
    expect(notice).toContain("netcup could not be asked which policies this server has (it refuses the saved sign-in)");
    expect(existsSync(join(server.dir, "state", "netcup-token.json"))).toBe(false);
  });
});

describe("rules", () => {
  test("one rule per port and address family, the same on every server", () => {
    const rules = netcupRules("web", RANGES);
    expect(rules.map((rule) => [rule.protocol, rule.destinationPorts ?? null, rule.sources!.length]))
      .toEqual([["TCP", "80", 15], ["TCP", "80", 7], ["TCP", "443", 15], ["TCP", "443", 7], ["ICMP", null, 0], ["ICMPv6", null, 0]]);
    expect(netcupRules("panel", RANGES).every((rule) => rule.direction === "INGRESS" && rule.action === "ACCEPT")).toBe(true);
    expect(netcupOpenRules("panel").map((rule) => rule.protocol)).toEqual(["TCP", "ICMP", "ICMPv6"]);
    const respelled = [...rules].reverse().map((rule) => ({ ...rule, sourcePorts: null, destinations: [], sources: [...rule.sources!].reverse() }));
    expect(netcupSignature(respelled)).toBe(netcupSignature(rules));
    expect(netcupSignature([...rules, ssh()])).not.toBe(netcupSignature(rules));
  });

  test("two servers in one account share one policy per role, and repair writes nothing when nothing differs", async () => {
    const fake = new FakeNetcup();
    fake.server(600001, "v2202411000000002", "cp-nue-2", "aa:bb:cc:00:00:02", "198.51.100.9");
    fake.policy("ssh", [ssh()], [SERVER, 600001]);
    const one = await connected(fake);
    const two = await connected(fake, "198.51.100.9");
    await turn(one, "web", true);
    await turn(two, "web", true);
    expect(fake.named("clp-addons-cloudflare-web")).toHaveLength(1);
    expect(fake.userPolicies(600001)).toEqual(["ssh", "clp-addons-cloudflare-web"]);
    const writes = fake.writes().length;
    expect(await syncNetcup("repair", one.options)).toBeNull();
    expect(await syncNetcup("repair", two.options)).toBeNull();
    expect(fake.writes()).toHaveLength(writes);
  });

  test("repair puts back rules changed in SCP, and the list watcher asks netcup nothing until the list changes", async () => {
    const fake = new FakeNetcup();
    fake.policy("ssh", [ssh()], [SERVER]);
    const server = await connected(fake);
    await turn(server, "web", true);
    const web = fake.named("clp-addons-cloudflare-web")[0]!;
    web.rules = [...web.rules!, ssh("443")];
    expect(await syncNetcup("repair", server.options)).toBe("1 netcup policy set to Cloudflare's list");
    expect(netcupSignature(web.rules)).toBe(netcupSignature(netcupRules("web", RANGES)));
    const calls = fake.calls.length;
    expect(await syncNetcup("ranges", server.options)).toBeNull();
    expect(fake.calls).toHaveLength(calls);
    writeFileSync(join(server.dir, "ips"), CLOUDPANEL_IPS.replace("allow 131.0.72.0/22;\n", ""));
    expect(await syncNetcup("ranges", server.options)).toBe("1 netcup policy set to Cloudflare's list");
    expect(web.rules!.flatMap((rule) => rule.sources ?? [])).not.toContain("131.0.72.0/22");
  });

  test("repair puts back an open policy's fixed rules and never touches a policy without the mark", async () => {
    const fake = new FakeNetcup();
    fake.policy("ssh", [ssh()], [SERVER]);
    const lookalike = fake.policy("clp-addons-cloudflare-panel", [ssh("8443")], [], "mine");
    const server = await connected(fake);
    await turn(server, "web", true);
    await turn(server, "web", false);
    const open = fake.named("clp-addons-open-web")[0]!;
    open.rules = [ssh("80")];
    expect(await syncNetcup("repair", server.options)).toBe("1 netcup policy open to anyone put back");
    expect(open.rules).toEqual(netcupOpenRules("web"));
    expect(lookalike.rules).toEqual([ssh("8443")]);
  });
});

describe("safeguards", () => {
  test("on a server with no inbound rules yet, the review names what closes, the UDP replies, and asks for the server's name", async () => {
    const fake = new FakeNetcup();
    const server = await connected(fake);
    const first = await setNetcupRole("web", true, undefined, server.options);
    if (!("review" in first)) throw new Error("expected a review");
    expect(first.review.text).toBe("netcup will drop every connection to ports 80 and 443 that does not come from Cloudflare. Every site resolves to Cloudflare. Port 8443 stays open to anyone through clp-addons-open-panel.");
    expect(first.review.closes).toEqual(["SSH on port 22: site users can no longer connect over SFTP"]);
    expect(first.review.warnings[0]).toStartWith("netcup tracks only TCP connections");
    expect(first.review.warnings[1]).toBe("No policy on this server has inbound rules yet, so netcup also closes every port the addon's policies do not open:");
    expect(first.review.wayBack).toBe("netcup's SCP console still gives a root shell.");
    expect(first.review.typed).toBe("cp-nue-1");
    expect(fake.writes()).toEqual([]);
    expect(await refusal(setNetcupRole("web", true, first.review.digest, server.options, "wrong"))).toBe("Type the server's name, cp-nue-1, to confirm");

    await turn(server, "web", true);
    expect(fake.userPolicies()).toEqual(["clp-addons-cloudflare-web", "clp-addons-open-panel"]);
    expect(fake.writes().filter((call) => call.method === "PUT" && call.path.endsWith("/firewall"))).toHaveLength(1);
    const view = await netcupView(server.options);
    expect(view.state === "connected" && view.roles.web).toEqual({ on: true, firewall: "clp-addons-cloudflare-web", open: null, current: true, stillOpen: [] });
    expect(view.state === "connected" && view.sshClosed).toEqual([22]);
    expect(view.state === "connected" && view.others).toEqual(["netcup Mail block"]);
    expect(netcupSetupState(server.options).seen).toEqual({ web: true, panel: false });
  });

  test("the addon's policies go after the operator's, whose order stays", async () => {
    const fake = new FakeNetcup();
    fake.policy("block-bad", [{ direction: "INGRESS", protocol: "TCP", action: "DROP", sources: ["192.0.2.0/24"] }], [SERVER]);
    fake.policy("ssh", [ssh()], [SERVER]);
    const server = await connected(fake);
    await turn(server, "web", true);
    expect(fake.userPolicies()).toEqual(["block-bad", "ssh", "clp-addons-cloudflare-web"]);
  });

  test("off puts the open policy in the Cloudflare one's place in one write", async () => {
    const fake = new FakeNetcup();
    fake.policy("ssh", [ssh()], [SERVER]);
    const server = await connected(fake);
    await turn(server, "web", true);
    const first = await setNetcupRole("web", false, undefined, server.options);
    if (!("review" in first)) throw new Error("expected a review");
    expect(first.review.text).toBe("Anyone can reach ports 80 and 443 again: clp-addons-open-web takes the place of clp-addons-cloudflare-web on this server.");
    expect(first.review.typed).toBe("");
    await setNetcupRole("web", false, first.review.digest, server.options);
    expect(fake.userPolicies()).toEqual(["ssh", "clp-addons-open-web"]);
  });

  test("another policy that still lets anyone reach the port is named instead of success", async () => {
    const fake = new FakeNetcup();
    fake.policy("web-anyone", [ssh("443"), ssh()], [SERVER]);
    const server = await connected(fake);
    const done = await turn(server, "web", true);
    expect("notice" in done && done.notice).toBe("clp-addons-cloudflare-web is on this server, but has no effect yet: 443 is still open to anyone through policy web-anyone.");
  });

  test("a refused write changes nothing on the server", async () => {
    const fake = new FakeNetcup();
    fake.policy("ssh", [ssh()], [SERVER]);
    const server = await connected(fake);
    fake.refuseFirewall = "A maximum of 500 firewall rules can be applied";
    expect(await refusal(turn(server, "web", true))).toBe(
      "Could not put clp-addons-cloudflare-web on this server: netcup: Validation error. (userPolicies: A maximum of 500 firewall rules can be applied). Nothing on this server was changed.",
    );
    expect(fake.userPolicies()).toEqual(["ssh"]);
  });

  test("a write netcup is still applying is reported as taken, within the gateway's time", async () => {
    const fake = new FakeNetcup();
    fake.policy("ssh", [ssh()], [SERVER]);
    const server = await connected(fake);
    const first = await setNetcupRole("web", true, undefined, server.options);
    if (!("review" in first)) throw new Error("expected a review");
    fake.taskState = "RUNNING";
    const started = server.now.at;
    server.options.sleep = async (ms) => { server.now.at += ms; };
    expect(await refusal(setNetcupRole("web", true, first.review.digest, server.options))).toBe(
      "Could not wait for netcup to put clp-addons-cloudflare-web on this server: netcup took the change and is still applying it. Reload the page in a minute to see what this server has.",
    );
    expect(server.now.at - started).toBeLessThanOrEqual(180_000);
    expect(fake.userPolicies()).toEqual(["ssh", "clp-addons-cloudflare-web"]);
  });

  test("a write whose task fails says so, without claiming nothing changed", async () => {
    const fake = new FakeNetcup();
    fake.policy("ssh", [ssh()], [SERVER]);
    const server = await connected(fake);
    fake.taskState = "ERROR";
    expect(await refusal(turn(server, "web", true))).toBe(
      "Could not put clp-addons-cloudflare-web on this server: netcup took the change, but its task ended in ERROR: The hypervisor did not answer. See Firewall in SCP for what this server has now.",
    );
  });

  test("the account's policies are read past the first page", async () => {
    const fake = new FakeNetcup();
    fake.policy("ssh", [ssh()], [SERVER]);
    for (let i = 0; i < 150; i++) fake.policy(`other-${i}`, []);
    const server = await connected(fake);
    await turn(server, "web", true);
    await turn(server, "web", false);
    const before = fake.policies.length;
    await turn(server, "web", true);
    expect(fake.policies).toHaveLength(before);
    expect(fake.named("clp-addons-cloudflare-web")).toHaveLength(1);
  });

  test("a policy of the addon's name without its mark refuses the switch and is never changed", async () => {
    const fake = new FakeNetcup();
    fake.policy("ssh", [ssh()], [SERVER]);
    const lookalike = fake.policy("clp-addons-cloudflare-web", [ssh("80")], []);
    const server = await connected(fake);
    expect(await refusal(turn(server, "web", true))).toContain("A policy named clp-addons-cloudflare-web already exists in this netcup account without \"Managed by clp-addons\"");
    expect(lookalike.rules).toEqual([ssh("80")]);
    expect(fake.userPolicies()).toEqual(["ssh"]);
  });

  test("with netcup's firewall off the card says so and the switches refuse", async () => {
    const fake = new FakeNetcup();
    fake.servers[0]!.firewall.active = false;
    const server = await connected(fake);
    const view = await netcupView(server.options);
    expect(view.state === "connected" && view.blocked).toBe("netcup's firewall is off for this server, so no policy has any effect. Turn it on under Firewall in SCP.");
    expect(await refusal(setNetcupRole("web", true, undefined, server.options))).toContain("Turn it on under Firewall in SCP first");
  });

  test("the panel switch needs Cloudflare to reach 443", async () => {
    const fake = new FakeNetcup();
    fake.policy("ssh", [ssh()], [SERVER]);
    const server = await connected(fake);
    writeFileSync(join(server.dir, "clp_custom_domain"), "panel.example.com\n");
    writeFileSync(join(server.dir, "custom-domain.conf"), "server {}\n");
    server.options.resolve = async () => ["104.16.1.1"];
    expect(await refusal(setNetcupRole("panel", true, undefined, server.options))).toContain("no policy on this server lets Cloudflare reach 443");
  });

  test("no message carries a token", async () => {
    const fake = new FakeNetcup();
    const server = await connected(fake);
    await turn(server, "web", true);
    const secrets = [fake.refreshToken!, "device-code-0123456789abcdefghijklmnopqrstuv"];
    for (const text of [JSON.stringify(await netcupView(server.options)), JSON.stringify(await syncNetcup("repair", server.options))]) {
      for (const secret of secrets) expect(text).not.toContain(secret);
    }
  });
});

describe("review fixes", () => {
  test("MAC beats address across all candidates, routed IPs and wide IPv6 prefixes never match", async () => {
    const fake = new FakeNetcup();
    // Server 512345 has ADDRESS (203.0.113.24) and MAC aa:bb:cc:00:00:01; our real server is 600010 by MAC.
    fake.server(600010, "v2202411000000010", "real-box", "aa:bb:cc:00:00:10", null, null);
    const byMac = box(fake, ADDRESS);
    byMac.options.macs = () => ["aa:bb:cc:00:00:10"];
    await connectNetcup(byMac.options);
    fake.granted = true;
    expect(await pollNetcup(byMac.options)).toEqual({ notice: "Connected to netcup; this server is real-box there." });

    // A failover/routed IPv4 on server B must not match when no MAC matches.
    const routedFake = new FakeNetcup();
    routedFake.servers[0]!.ipv4Type = "ROUTED_IP";
    routedFake.servers[0]!.ipv4DestinationIp = "198.51.100.2";
    const routedBox = box(routedFake, ADDRESS);
    await connectNetcup(routedBox.options);
    routedFake.granted = true;
    const routedNotice = await pollNetcup(routedBox.options);
    expect("notice" in routedNotice && routedNotice.notice).toContain("No server in this netcup account");

    // A routed IPv6 or an IPv6 prefix shorter than /64 must not match.
    const wideFake = new FakeNetcup();
    wideFake.server(600011, "v2202411000000011", "wide-v6", "aa:bb:cc:00:00:11", null, { networkPrefix: "2a03:4000:2::", cidr: "2a03:4000:2::/48" });
    wideFake.server(600012, "v2202411000000012", "routed-v6", "aa:bb:cc:00:00:12", null, {
      networkPrefix: "2a03:4000:2:95a::", cidr: "2a03:4000:2:95a::/64", type: "ROUTED_IP", destinationIp: "2a03:4000:2:95a::1",
    });
    const wideBox = box(wideFake, V6_ONLY);
    await connectNetcup(wideBox.options);
    wideFake.granted = true;
    const wideNotice = await pollNetcup(wideBox.options);
    expect("notice" in wideNotice && wideNotice.notice).toContain("No server in this netcup account");
  });

  test("unmatched account and unconfigured 404 firewall are non-fatal in repair and keep Setup quiet", async () => {
    const fake = new FakeNetcup();
    const unmatchedBox = await connected(fake, "198.51.100.7");
    const view = await netcupView(unmatchedBox.options);
    expect(view).toEqual({
      state: "error", connected: true, error: "No server in this netcup account has this server's address (198.51.100.7); connect the account that holds it.",
    });
    expect(netcupSetupState(unmatchedBox.options).seen).toEqual({ web: false, panel: false });
    expect(netcupSetupState(unmatchedBox.options).seenAt).toBe(unmatchedBox.now.at);

    unmatchedBox.now.at += 2 * 60 * 60_000;
    const note = await syncNetcup("repair", unmatchedBox.options);
    expect(note).toBe("No server in this netcup account has this server's address (198.51.100.7); connect the account that holds it");
    expect(netcupSetupState(unmatchedBox.options).seenAt).toBe(unmatchedBox.now.at);
    expect(netcupActions(netcupSetupState(unmatchedBox.options), unmatchedBox.now.at)).toEqual([]);

    // Firewall not configured in SCP (404)
    const noFwFake = new FakeNetcup();
    const noFwBox = await connected(noFwFake);
    noFwFake.firewallReadStatus = 404;
    const noFwView = await netcupView(noFwBox.options);
    expect(noFwView).toEqual({
      state: "error", connected: true, error: "netcup's firewall is not set up on cp-nue-1 yet: open Firewall for it in SCP and click Configure.",
    });
    noFwBox.now.at += 2 * 60 * 60_000;
    const noFwNote = await syncNetcup("repair", noFwBox.options);
    expect(noFwNote).toBe("netcup's firewall is not set up on cp-nue-1 yet: open Firewall for it in SCP and click Configure");
    expect(netcupSetupState(noFwBox.options).seen).toEqual({ web: false, panel: false });
    expect(netcupActions(netcupSetupState(noFwBox.options), noFwBox.now.at)).toEqual([]);
  });

  test("connect again with an account that does not hold this server keeps the old sign-in and revokes the new token", async () => {
    const fake = new FakeNetcup();
    const server = await connected(fake);
    const oldToken = fake.refreshToken!;
    const oldSync = readFileSync(join(server.dir, "state", "netcup.json"), "utf8");

    const otherFake = new FakeNetcup();
    otherFake.servers = [];
    server.options.fetch = otherFake.fetch;
    await connectNetcup(server.options);
    otherFake.granted = true;
    const message = await refusal(pollNetcup(server.options));
    expect(message).toContain("No server in this netcup account has this server's address");
    expect(otherFake.revoked).toEqual([otherFake.refreshToken!]);
    expect(fake.revoked).toEqual([]);
    expect(JSON.parse(readFileSync(join(server.dir, "state", "netcup-token.json"), "utf8"))).toEqual({ refreshToken: oldToken });
    expect(readFileSync(join(server.dir, "state", "netcup.json"), "utf8")).toBe(oldSync);
  });

  test("disabled servers and 4xx /interfaces are skipped, no-match is cached for 15 minutes, and slow scans degrade the card", async () => {
    const fake = new FakeNetcup();
    fake.servers[0]!.disabled = true;
    fake.server(600020, "v2202411000000020", "bad-iface", "aa:bb:cc:00:00:20", null, null);
    fake.interfaceStatus.set(600020, 403);
    fake.server(600021, "v2202411000000021", "good-box", "aa:bb:cc:00:00:21", ADDRESS, null);
    const server = await connected(fake);
    const view = await netcupView(server.options);
    expect(view.state === "connected" && view.serverName).toBe("good-box");
    expect(fake.calls.some((call) => call.path.startsWith(`/scp-core/api/v1/servers/${SERVER}/interfaces`))).toBe(false);

    // 401 on /interfaces is still reported as sign-in refused, not swallowed.
    const unauthFake = new FakeNetcup();
    const unauthBox = await connected(unauthFake);
    writeFileSync(join(unauthBox.dir, "state", "netcup.json"), JSON.stringify({ userId: 4711 }), { mode: 0o600 });
    unauthFake.interfaceStatus.set(SERVER, 401);
    expect(await netcupView(unauthBox.options)).toEqual({
      state: "error", connected: true, error: "netcup no longer accepts the saved sign-in; connect again.",
    });

    // Unmatched scan is cached for 15 minutes, then rescans.
    const emptyFake = new FakeNetcup();
    const emptyBox = await connected(emptyFake, "198.51.100.7");
    const serverCallsAfterConnect = emptyFake.calls.filter((call) => call.path.startsWith("/scp-core/api/v1/servers")).length;
    await netcupView(emptyBox.options);
    expect(emptyFake.calls.filter((call) => call.path.startsWith("/scp-core/api/v1/servers"))).toHaveLength(serverCallsAfterConnect);
    emptyBox.now.at += 16 * 60_000;
    await netcupView(emptyBox.options);
    expect(emptyFake.calls.filter((call) => call.path.startsWith("/scp-core/api/v1/servers")).length).toBeGreaterThan(serverCallsAfterConnect);

    // A scan that exceeds the view budget degrades the card without caching unmatchedAt.
    const slowFake = new FakeNetcup();
    for (let i = 0; i < 5; i++) slowFake.server(600030 + i, `s-${i}`, null, `aa:bb:cc:00:01:0${i}`, null, null);
    const slowBox = await connected(slowFake, "198.51.100.8");
    writeFileSync(join(slowBox.dir, "state", "netcup.json"), JSON.stringify({ userId: 4711 }), { mode: 0o600 });
    const realFetch = slowFake.fetch;
    slowBox.options.fetch = async (url, init) => {
      if (url.includes("/interfaces")) slowBox.now.at += 10_000;
      return realFetch(url, init);
    };
    const degraded = await netcupView(slowBox.options);
    expect(degraded.state === "error" && degraded.connected && degraded.error).toContain("timed out");
    expect(JSON.parse(readFileSync(join(slowBox.dir, "state", "netcup.json"), "utf8")).unmatchedAt).toBeUndefined();
  });

  test("poll revokes the new refresh token if locking or saving fails after the grant", async () => {
    const fake = new FakeNetcup();
    const server = box(fake);
    await connectNetcup(server.options);
    fake.granted = true;
    // Make tokenFile a directory so writeState fails inside the lock after findServer/findUserId succeeded.
    mkdirSync(join(server.dir, "state", "netcup-token.json"), { recursive: true });
    expect(await refusal(pollNetcup(server.options))).toBeTruthy();
    expect(fake.revoked).toEqual([fake.refreshToken!]);
  });

  test("transient task-poll errors retry until the task finishes or the deadline passes", async () => {
    const fake = new FakeNetcup();
    fake.policy("ssh", [ssh()], [SERVER]);
    const server = await connected(fake);
    fake.taskFailures = 2;
    const done = await turn(server, "web", true);
    expect("notice" in done && done.notice).toContain("only Cloudflare");

    // Persistent errors until the deadline still report running.
    const first = await setNetcupRole("web", false, undefined, server.options);
    if (!("review" in first)) throw new Error("expected a review");
    fake.taskFailures = 100;
    server.options.sleep = async (ms) => { server.now.at += ms; };
    expect(await refusal(setNetcupRole("web", false, first.review.digest, server.options))).toContain("could not be asked whether it finished");
  });

  test("userinfo id is verified with GET /users/{id} and falls back when rejected", async () => {
    const fake = new FakeNetcup();
    fake.userinfoId = 9999;
    const server = await connected(fake);
    expect(fake.calls.some((call) => call.path === "/scp-core/api/v1/users/9999")).toBe(true);
    expect(fake.calls.some((call) => call.path === "/scp-core/api/v1/users/4711")).toBe(true);
    expect(JSON.parse(readFileSync(join(server.dir, "state", "netcup.json"), "utf8")).userId).toBe(4711);
  });

  test("disconnect succeeds with a warning when netcup's firewall is off even with a Cloudflare policy attached", async () => {
    const fake = new FakeNetcup();
    fake.policy("ssh", [ssh()], [SERVER]);
    const server = await connected(fake);
    await turn(server, "web", true);
    fake.servers[0]!.firewall.active = false;
    const { notice } = await disconnectNetcup(server.options);
    expect(notice).toContain("The netcup sign-in is removed and revoked.");
    expect(notice).toContain("clp-addons-cloudflare-web stays on this server while netcup's firewall is off");
    expect(existsSync(join(server.dir, "state", "netcup-token.json"))).toBe(false);
  });

  test("setFirewall handles a reply without a task object", async () => {
    const fake = new FakeNetcup();
    fake.policy("ssh", [ssh()], [SERVER]);
    fake.setFirewallNoTask = true;
    const server = await connected(fake);
    const done = await turn(server, "web", true);
    expect("notice" in done && done.notice).toContain("only Cloudflare");
    expect(fake.userPolicies()).toEqual(["ssh", "clp-addons-cloudflare-web"]);
  });

  test("redaction hides token values without redacting token_type_hint's value", async () => {
    const fake = new FakeNetcup();
    const secret = fake.issue();
    const auth = new NetcupAuth(fake.fetch);
    await auth.revoke(secret);
    expect(auth.clean(`error with ${secret} and refresh_token`)).toBe("error with [redacted] and refresh_token");
  });

  test("guardOf respects rule destinations so rules for other servers do not count as open here", async () => {
    const fake = new FakeNetcup();
    fake.policy("other-server", [
      { direction: "INGRESS", protocol: "TCP", action: "ACCEPT", sources: [], destinations: ["198.51.100.99"], destinationPorts: "22" },
      { direction: "INGRESS", protocol: "TCP", action: "ACCEPT", sources: [], destinations: ["198.51.100.99"], destinationPorts: "443" },
    ], [SERVER]);
    const server = await connected(fake);
    const first = await setNetcupRole("web", true, undefined, server.options);
    if (!("review" in first)) throw new Error("expected a review");
    expect(first.review.warnings.join(" ")).not.toContain("443 is still open");
    const done = await turn(server, "web", true);
    expect("notice" in done && done.notice).toBe("netcup now lets only Cloudflare reach ports 80 and 443.");
    const view = await netcupView(server.options);
    expect(view.state === "connected" && view.sshClosed).toEqual([22]);

    // A rule explicitly targeting this server's IPv4 keeps IPv4 SSH open (while not covering IPv6).
    const thisFake = new FakeNetcup();
    thisFake.policy("this-ssh", [
      { direction: "INGRESS", protocol: "TCP", action: "ACCEPT", sources: [], destinations: [ADDRESS], destinationPorts: "22" },
    ], [SERVER]);
    const thisBox = await connected(thisFake);
    await turn(thisBox, "web", true);
    const thisView = await netcupView(thisBox.options);
    expect(thisView.state === "connected" && thisView.sshClosed).toEqual([]);
  });

  test("non-public IPv4 ranges are rejected by isPublicAddress", () => {
    for (const addr of ["0.0.0.1", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.1", "172.16.0.1", "192.0.0.1", "192.168.1.1", "198.18.0.1", "198.19.255.254"]) {
      expect(isPublicAddress(addr)).toBe(false);
    }
    expect(isPublicAddress(ADDRESS)).toBe(true);
    expect(isPublicAddress(V6_ONLY)).toBe(true);
    expect(isPublicAddress("fe80::1")).toBe(false);
  });

  test("permanent OAuth errors end the device poll", async () => {
    for (const code of ["invalid_client", "unauthorized_client", "invalid_request"]) {
      const fake = new FakeNetcup();
      const server = box(fake);
      await connectNetcup(server.options);
      fake.pollError = code;
      expect(await refusal(pollNetcup(server.options))).toContain(code);
      expect(existsSync(join(server.dir, "state", "netcup-device.json"))).toBe(false);
    }
  });
});
