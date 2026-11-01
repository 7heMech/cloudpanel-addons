import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PENDING_TTL_MS, expectRule, firewallStatus, normalizePortRange, normalizeSource, parseUfwRules, planFirewall,
  readFirewallState, setRuleProtocol, settleState, syncFirewall, ufwPort,
  type FirewallOptions, type FirewallState, type PanelRule, type UfwRule,
} from "../addons/system-tweaks/firewall";

const ANYWHERE: PanelRule[] = [
  { id: 1, portRange: "22", source: "0.0.0.0/0" },
  { id: 2, portRange: "22", source: "::/0" },
  { id: 3, portRange: "443", source: "0.0.0.0/0" },
  { id: 4, portRange: "443", source: "::/0" },
];

/** What CloudPanel's rebuild leaves: TCP for every rule, and UDP 443 for HTTP/3. */
function panelBuilt(rules: PanelRule[]): UfwRule[] {
  return [
    ...rules.map((rule) => ({ proto: "tcp" as const, port: ufwPort(rule.portRange)!, src: normalizeSource(rule.source)!.text })),
    { proto: "udp", port: "443", src: "0.0.0.0/0" },
    { proto: "udp", port: "443", src: "::/0" },
  ];
}

test("sources and ports are compared the way ufw writes them", () => {
  expect(normalizeSource("0.0.0.0/0")).toEqual({ text: "0.0.0.0/0", v6: false });
  expect(normalizeSource("203.0.113.9/32")?.text).toBe("203.0.113.9");
  expect(normalizeSource("10.1.2.3/8")?.text).toBe("10.0.0.0/8");
  expect(normalizeSource("2001:DB8:0:0::1/128")).toEqual({ text: "2001:db8::1", v6: true });
  expect(normalizeSource("2001:db8:1:2:3:4:5:6/32")?.text).toBe("2001:db8::/32");
  expect(normalizeSource("::/0")?.text).toBe("::/0");
  for (const bad of ["", "any", "1.2.3", "1.2.3.4/33", "1.2.3.4/8/8", "::1::2", "1.2.3.4; reboot", "--dry-run"]) {
    expect(normalizeSource(bad)).toBeNull();
  }
  expect(ufwPort("22")).toBe("22");
  expect(ufwPort("8000-8100")).toBe("8000:8100");
  for (const bad of ["0", "70000", "9-1", "1:2", "22 ", "a"]) expect(ufwPort(bad)).toBeNull();
  expect(normalizePortRange(" 8000 - 8100 ")).toBe("8000-8100");
  expect(normalizePortRange("053")).toBe("53");
  expect(normalizePortRange("53,54")).toBeNull();
});

test("only plain inbound allow rules are read from ufw's files", () => {
  const rules = parseUfwRules([
    "### tuple ### allow tcp 22 0.0.0.0/0 any 0.0.0.0/0 in",
    "### tuple ### allow udp 8000:8100 0.0.0.0/0 any 203.0.113.9 in comment=6869",
    "### tuple ### allow any 443 0.0.0.0/0 any 0.0.0.0/0 in",
    "### tuple ### deny udp 53 0.0.0.0/0 any 0.0.0.0/0 in",
    "### tuple ### allow tcp 22 0.0.0.0/0 any 0.0.0.0/0 OpenSSH - in",
    "-A ufw-user-input -p tcp --dport 22 -j ACCEPT",
  ].join("\n"));
  expect(rules).toEqual([
    { proto: "tcp", port: "22", src: "0.0.0.0/0" },
    { proto: "udp", port: "8000:8100", src: "203.0.113.9" },
  ]);
});

test("a protocol chosen on the add form goes to the rules saved after it with that port range", () => {
  const now = 1_000_000;
  const rules = [...ANYWHERE, { id: 5, portRange: "53", source: "0.0.0.0/0" }, { id: 6, portRange: "53", source: "::/0" }];
  const state: FirewallState = {
    protocols: {},
    pending: [
      { portRange: "53", protocol: "udp", afterId: 4, at: now - 1000 },
      { portRange: "22", protocol: "udp", afterId: 4, at: now - 1000 },
    ],
    managed: [],
  };
  const settled = settleState(state, rules, now);
  expect(settled.protocols).toEqual({ 5: "udp", 6: "udp" });
  // Rule 22 existed before the choice, so it is not taken for the new rule.
  expect(settled.pending).toEqual([state.pending[1]!]);
  // It waits ten minutes for its rule, then is forgotten.
  expect(settleState(state, ANYWHERE, now + PENDING_TTL_MS).pending).toEqual([]);
  // A TCP choice is CloudPanel's own, and is used up by its rule all the same.
  const tcp = settleState({ ...state, pending: [{ portRange: "53", protocol: "tcp", afterId: 4, at: now }] }, rules, now);
  expect(tcp).toEqual({ protocols: {}, pending: [], managed: [] });
  // A rule that already has a protocol keeps it.
  const kept = settleState({ ...state, protocols: { 5: "both" } }, rules, now);
  expect(kept.protocols).toEqual({ 5: "both", 6: "udp" });
});

test("protocols of rules that are gone are forgotten", () => {
  const settled = settleState({ protocols: { 3: "udp", 99: "both" }, pending: [], managed: [] }, ANYWHERE, 0);
  expect(settled.protocols).toEqual({ 3: "udp" });
});

test("TCP alone asks nothing of ufw", () => {
  expect(planFirewall(ANYWHERE, {}, [], panelBuilt(ANYWHERE))).toEqual({ commands: [], managed: [] });
});

test("UDP opens UDP and closes the TCP rule CloudPanel just added; additions go first", () => {
  const rules = [...ANYWHERE, { id: 5, portRange: "51820", source: "0.0.0.0/0" }, { id: 6, portRange: "3478-3479", source: "203.0.113.0/24" }];
  const plan = planFirewall(rules, { 5: "udp", 6: "udp" }, [], panelBuilt(rules));
  expect(plan.commands).toEqual([
    ["allow", "proto", "udp", "from", "0.0.0.0/0", "to", "any", "port", "51820"],
    ["allow", "proto", "udp", "from", "203.0.113.0/24", "to", "any", "port", "3478:3479"],
    ["delete", "allow", "proto", "tcp", "from", "0.0.0.0/0", "to", "any", "port", "51820"],
    ["delete", "allow", "proto", "tcp", "from", "203.0.113.0/24", "to", "any", "port", "3478:3479"],
  ]);
  expect(plan.managed).toContainEqual({ proto: "tcp", port: "51820", src: "0.0.0.0/0" });
});

test("TCP and UDP opens UDP beside CloudPanel's TCP", () => {
  const rules = [...ANYWHERE, { id: 5, portRange: "53", source: "::/0" }];
  const plan = planFirewall(rules, { 5: "both" }, [], panelBuilt(rules));
  expect(plan.commands).toEqual([["allow", "proto", "udp", "from", "::/0", "to", "any", "port", "53"]]);
  expect(plan.managed).toEqual([{ proto: "udp", port: "53", src: "::/0" }]);
});

test("a rule whose TCP another rule for the same port and source still wants keeps it", () => {
  const rules = [...ANYWHERE, { id: 5, portRange: "53", source: "0.0.0.0/0" }, { id: 6, portRange: "53", source: "0.0.0.0/0" }];
  const plan = planFirewall(rules, { 5: "udp" }, [], panelBuilt(rules));
  expect(plan.commands).toEqual([["allow", "proto", "udp", "from", "0.0.0.0/0", "to", "any", "port", "53"]]);
});

test("UDP 443 stays CloudPanel's own when a 443 rule goes back to TCP", () => {
  const managed: UfwRule[] = [{ proto: "udp", port: "443", src: "0.0.0.0/0" }, { proto: "tcp", port: "443", src: "0.0.0.0/0" }];
  const present = panelBuilt(ANYWHERE).filter((rule) => !(rule.proto === "tcp" && rule.port === "443" && rule.src === "0.0.0.0/0"));
  const plan = planFirewall(ANYWHERE, {}, managed, present);
  expect(plan.commands).toEqual([["allow", "proto", "tcp", "from", "0.0.0.0/0", "to", "any", "port", "443"]]);
});

test("switching off puts back CloudPanel's own rules and leaves the operator's alone", () => {
  const rules = [...ANYWHERE, { id: 5, portRange: "51820", source: "0.0.0.0/0" }, { id: 6, portRange: "53", source: "0.0.0.0/0" }];
  const applied = planFirewall(rules, { 5: "udp", 6: "both" }, [], panelBuilt(rules));
  const operator: UfwRule = { proto: "udp", port: "60000:61000", src: "0.0.0.0/0" };
  const present = [
    ...panelBuilt(rules).filter((rule) => !(rule.proto === "tcp" && rule.port === "51820")),
    { proto: "udp" as const, port: "51820", src: "0.0.0.0/0" },
    { proto: "udp" as const, port: "53", src: "0.0.0.0/0" },
    operator,
  ];
  const off = planFirewall(rules, {}, applied.managed, present);
  expect(off.commands).toEqual([
    ["allow", "proto", "tcp", "from", "0.0.0.0/0", "to", "any", "port", "51820"],
    ["delete", "allow", "proto", "udp", "from", "0.0.0.0/0", "to", "any", "port", "51820"],
    ["delete", "allow", "proto", "udp", "from", "0.0.0.0/0", "to", "any", "port", "53"],
  ]);
  expect(off.managed).toEqual([]);
  // A rule deleted in the panel takes nothing back with it.
  expect(planFirewall(ANYWHERE, {}, applied.managed, panelBuilt(ANYWHERE)).commands).toEqual([]);
});

// --- On disk, with a ufw that keeps its rules in the fixture's files ---------

function box() {
  const dir = mkdtempSync(join(tmpdir(), "clp-firewall-"));
  mkdirSync(join(dir, "ufw"));
  const panelDb = join(dir, "db.sq3");
  const db = new Database(panelDb, { create: true });
  db.exec("CREATE TABLE firewall_rule (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, port_range VARCHAR(255) NOT NULL, source VARCHAR(255) NOT NULL, description VARCHAR(255) DEFAULT NULL);");
  db.close();
  const tuples: UfwRule[] = [];
  const calls: string[] = [];
  const paths = {
    stateFile: join(dir, "state", "firewall.json"), lockFile: join(dir, "firewall.lock"), panelDb,
    userRules: join(dir, "ufw", "user.rules"), user6Rules: join(dir, "ufw", "user6.rules"), rootUid: process.getuid!(),
  };
  const write = () => {
    for (const [file, v6] of [[paths.userRules, false], [paths.user6Rules, true]] as const) {
      writeFileSync(file, tuples.filter((rule) => rule.src.includes(":") === v6)
        .map((rule) => `### tuple ### allow ${rule.proto} ${rule.port} ${v6 ? "::/0" : "0.0.0.0/0"} any ${rule.src} in\n`).join(""));
    }
  };
  const same = (a: UfwRule, b: UfwRule) => a.proto === b.proto && a.port === b.port && a.src === b.src;
  let clock = 0;
  const options: FirewallOptions = {
    paths,
    now: () => clock,
    sleep: (ms) => { clock += ms; },
    ufw: (args) => {
      calls.push(args.join(" "));
      const del = args[0] === "delete";
      const [, , proto, , src, , , , port] = del ? args.slice(1) : args;
      const rule = { proto: proto as "tcp" | "udp", port: port!, src: src! };
      const at = tuples.findIndex((item) => same(item, rule));
      if (del && at >= 0) tuples.splice(at, 1);
      if (!del && at < 0) tuples.push(rule);
      write();
      return { ok: true, stdout: "", stderr: "" };
    },
  };
  const addRule = (portRange: string, source: string) => {
    const db = new Database(panelDb);
    db.query("INSERT INTO firewall_rule (created_at, updated_at, port_range, source) VALUES ('now', 'now', ?, ?)").run(portRange, source);
    db.close();
  };
  const deleteRule = (id: number) => {
    const db = new Database(panelDb);
    db.query("DELETE FROM firewall_rule WHERE id = ?").run(id);
    db.close();
  };
  /** CloudPanel's own rebuild: `ufw reset`, then every row as TCP, then UDP 443. */
  const rebuild = () => {
    tuples.length = 0;
    const db = new Database(panelDb);
    const rows = db.query("SELECT id, port_range AS portRange, source FROM firewall_rule").all() as PanelRule[];
    db.close();
    tuples.push(...panelBuilt(rows));
    write();
  };
  return { dir, paths, options, tuples, calls, addRule, deleteRule, rebuild, has: (rule: UfwRule) => tuples.some((item) => same(item, rule)) };
}

test("the add form, CloudPanel's rebuilds and switching off, end to end", () => {
  const b = box();
  b.addRule("22", "0.0.0.0/0");
  b.addRule("22", "::/0");
  b.rebuild();
  expect(syncFirewall("apply", b.options)).toBeNull();

  // The add form names the protocol, then CloudPanel saves the rule and rebuilds.
  expectRule({ portRange: "51820", protocol: "udp" }, b.options);
  b.addRule("51820", "0.0.0.0/0");
  b.rebuild();
  expect(b.has({ proto: "tcp", port: "51820", src: "0.0.0.0/0" })).toBe(true);
  expect(syncFirewall("apply", b.options)).toBe("2 ufw rules changed");
  expect(b.has({ proto: "udp", port: "51820", src: "0.0.0.0/0" })).toBe(true);
  expect(b.has({ proto: "tcp", port: "51820", src: "0.0.0.0/0" })).toBe(false);
  expect(readFirewallState(b.paths)).toMatchObject({ protocols: { 3: "udp" }, pending: [] });
  expect(firewallStatus(b.options)).toEqual({ available: true, protocols: { 3: "udp" }, udpPorts: ["51820"] });

  // Another rule's change rebuilds ufw from CloudPanel's table; the UDP rule comes back.
  b.addRule("80", "0.0.0.0/0");
  b.rebuild();
  syncFirewall("apply", b.options);
  expect(b.has({ proto: "udp", port: "51820", src: "0.0.0.0/0" })).toBe(true);
  expect(b.has({ proto: "tcp", port: "51820", src: "0.0.0.0/0" })).toBe(false);
  expect(b.has({ proto: "tcp", port: "80", src: "0.0.0.0/0" })).toBe(true);
  b.calls.length = 0;
  expect(syncFirewall("apply", b.options)).toBeNull();
  expect(b.calls).toEqual([]);

  // The edit form makes it TCP and UDP.
  setRuleProtocol({ id: 3, protocol: "both" }, b.options);
  b.rebuild();
  syncFirewall("apply", b.options);
  expect(b.has({ proto: "udp", port: "51820", src: "0.0.0.0/0" })).toBe(true);
  expect(b.has({ proto: "tcp", port: "51820", src: "0.0.0.0/0" })).toBe(true);

  // Switching System Tweaks off leaves exactly CloudPanel's own rules, and keeps the choice.
  syncFirewall("withdraw", b.options);
  const own = [...b.tuples];
  b.rebuild();
  expect(new Set(own.map((rule) => JSON.stringify(rule)))).toEqual(new Set(b.tuples.map((rule) => JSON.stringify(rule))));
  expect(readFirewallState(b.paths).protocols).toEqual({ 3: "both" });
  // The watcher the withdrawal itself woke applies nothing while System Tweaks is off.
  expect(syncFirewall("apply", b.options)).toBeNull();
  expect(b.has({ proto: "udp", port: "51820", src: "0.0.0.0/0" })).toBe(false);
  // Switching it on again puts the protocol back.
  expect(syncFirewall("restore", b.options)).toBe("1 ufw rule changed");
  expect(b.has({ proto: "udp", port: "51820", src: "0.0.0.0/0" })).toBe(true);
  expect(readFirewallState(b.paths).withdrawn).toBeUndefined();

  // Deleting the rule in the panel forgets its protocol.
  b.deleteRule(3);
  b.rebuild();
  syncFirewall("apply", b.options);
  expect(readFirewallState(b.paths).protocols).toEqual({});
  expect(b.has({ proto: "udp", port: "51820", src: "0.0.0.0/0" })).toBe(false);
});

test("the forms' requests are checked before anything is stored", () => {
  const b = box();
  b.addRule("22", "0.0.0.0/0");
  expect(() => setRuleProtocol({ id: 2, protocol: "udp" }, b.options)).toThrow("there is no such firewall rule");
  expect(() => setRuleProtocol({ id: 1, protocol: "icmp" }, b.options)).toThrow("protocol must be tcp, udp or both");
  expect(() => setRuleProtocol({ id: "1", protocol: "udp" }, b.options)).toThrow("id must be");
  expect(() => expectRule({ portRange: "1:2", protocol: "udp" }, b.options)).toThrow("portRange must be");
  expect(() => expectRule({ portRange: "53; ufw disable", protocol: "udp" }, b.options)).toThrow("portRange must be");
  setRuleProtocol({ id: 1, protocol: "udp" }, b.options);
  setRuleProtocol({ id: 1, protocol: "tcp" }, b.options);
  expect(readFirewallState(b.paths).protocols).toEqual({});
  // A second choice for the same port range replaces the first.
  expectRule({ portRange: "53", protocol: "udp" }, b.options);
  expectRule({ portRange: " 53 ", protocol: "both" }, b.options);
  expect(readFirewallState(b.paths).pending).toEqual([{ portRange: "53", protocol: "both", afterId: 1, at: 0 }]);
  expect(readFileSync(b.paths.stateFile, "utf8")).toContain('"version": 1');
});

test("a box without ufw is left alone", () => {
  const b = box();
  const options = { ...b.options, paths: { ...b.paths, userRules: join(b.dir, "none"), user6Rules: join(b.dir, "none6") } };
  expect(syncFirewall("apply", options)).toBeNull();
  expect(firewallStatus(options)).toEqual({ available: false, protocols: {}, udpPorts: [] });
});

test("the firewall watcher runs System Tweaks when ufw's rule files change", async () => {
  const { ADDONS, addonFirewall } = await import("../cli/addon-catalog");
  const { firewallUnits } = await import("../cli/provision");
  expect(addonFirewall(Object.values(ADDONS)).map((spec) => spec.name)).toEqual(["system-tweaks"]);
  const units = firewallUnits();
  expect(units.path).toContain("PathChanged=/etc/ufw/user.rules\nPathChanged=/etc/ufw/user6.rules\nUnit=clp-addons-firewall.service");
  expect(units.service).toMatch(/ExecStart=\/\S+ sync-firewall\n/);
  expect(units.service).toContain("StartLimitIntervalSec=0");
});
