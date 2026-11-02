import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UNMATCHED_GRACE_MS, firewallStatus, normalizePortRange, normalizeSource, parseUfwRules, planFirewall,
  readFirewallState, ruleKey, setRuleProtocol, settleState, syncFirewall, ufwPort,
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
  expect(ruleKey(" 8000 - 8100 ", " 203.0.113.9/32 ")).toBe("8000-8100 203.0.113.9");
  expect(ruleKey("53", "any")).toBeNull();
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

test("an entry is kept while a rule matches it, or while it waits for its first one", () => {
  const now = 1_000_000;
  const state: FirewallState = {
    protocols: { "22 0.0.0.0/0": "udp", "53 ::/0": "both", "51820 0.0.0.0/0": "udp", "60000 0.0.0.0/0": "udp" },
    unmatched: { "51820 0.0.0.0/0": now - 1000, "60000 0.0.0.0/0": now - UNMATCHED_GRACE_MS },
    managed: [],
  };
  // 22 matches; 53 matched once and its rule is gone; 51820 was just chosen; 60000 waited too long.
  expect(settleState(state, ANYWHERE, now)).toEqual({
    protocols: { "22 0.0.0.0/0": "udp", "51820 0.0.0.0/0": "udp" },
    unmatched: { "51820 0.0.0.0/0": now - 1000 },
    managed: [],
  });
  // Once its rule is saved it no longer waits, and goes with the rule.
  const saved = settleState(state, [...ANYWHERE, { id: 5, portRange: "51820", source: "0.0.0.0/0" }], now);
  expect(saved.unmatched).toEqual({});
  expect(settleState(saved, ANYWHERE, now).protocols).toEqual({ "22 0.0.0.0/0": "udp" });
});

test("TCP alone asks nothing of ufw", () => {
  expect(planFirewall(ANYWHERE, {}, [], panelBuilt(ANYWHERE))).toEqual({ commands: [], managed: [] });
});

test("UDP opens UDP and closes the TCP rule CloudPanel just added; additions go first", () => {
  const rules = [...ANYWHERE, { id: 5, portRange: "51820", source: "0.0.0.0/0" }, { id: 6, portRange: "3478-3479", source: "203.0.113.0/24" }];
  const plan = planFirewall(rules, { "51820 0.0.0.0/0": "udp", "3478-3479 203.0.113.0/24": "udp" }, [], panelBuilt(rules));
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
  const plan = planFirewall(rules, { "53 ::/0": "both" }, [], panelBuilt(rules));
  expect(plan.commands).toEqual([["allow", "proto", "udp", "from", "::/0", "to", "any", "port", "53"]]);
  expect(plan.managed).toEqual([{ proto: "udp", port: "53", src: "::/0" }]);
});

test("a protocol applies only to rules with exactly its port range and source", () => {
  const rules = [...ANYWHERE, { id: 5, portRange: "53", source: "203.0.113.9/32" }, { id: 6, portRange: "53", source: "203.0.113.10" }];
  const plan = planFirewall(rules, { "53 203.0.113.9": "udp", "51820 0.0.0.0/0": "udp", "22 203.0.113.9": "udp" }, [], panelBuilt(rules));
  expect(plan.commands).toEqual([
    ["allow", "proto", "udp", "from", "203.0.113.9", "to", "any", "port", "53"],
    ["delete", "allow", "proto", "tcp", "from", "203.0.113.9", "to", "any", "port", "53"],
  ]);
});

test("a rule reusing an id another rule had keeps CloudPanel's TCP", () => {
  const before = [...ANYWHERE, { id: 5, portRange: "51820", source: "0.0.0.0/0" }];
  const protocols = { "51820 0.0.0.0/0": "udp" } as const;
  const applied = planFirewall(before, protocols, [], panelBuilt(before));
  // CloudPanel's table rebuilt: id 5 is now SSH from one address.
  const after = [...ANYWHERE, { id: 5, portRange: "22", source: "198.51.100.7" }];
  const present = [...panelBuilt(after), { proto: "udp" as const, port: "51820", src: "0.0.0.0/0" }];
  const plan = planFirewall(after, protocols, applied.managed, present);
  expect(plan.commands).toEqual([["delete", "allow", "proto", "udp", "from", "0.0.0.0/0", "to", "any", "port", "51820"]]);
});

test("UDP 443 stays CloudPanel's own when a 443 rule goes back to TCP", () => {
  const managed: UfwRule[] = [{ proto: "udp", port: "443", src: "0.0.0.0/0" }, { proto: "tcp", port: "443", src: "0.0.0.0/0" }];
  const present = panelBuilt(ANYWHERE).filter((rule) => !(rule.proto === "tcp" && rule.port === "443" && rule.src === "0.0.0.0/0"));
  const plan = planFirewall(ANYWHERE, {}, managed, present);
  expect(plan.commands).toEqual([["allow", "proto", "tcp", "from", "0.0.0.0/0", "to", "any", "port", "443"]]);
});

test("switching off puts back CloudPanel's own rules and leaves the operator's alone", () => {
  const rules = [...ANYWHERE, { id: 5, portRange: "51820", source: "0.0.0.0/0" }, { id: 6, portRange: "53", source: "0.0.0.0/0" }];
  const applied = planFirewall(rules, { "51820 0.0.0.0/0": "udp", "53 0.0.0.0/0": "both" }, [], panelBuilt(rules));
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
  const editRule = (id: number, portRange: string, source: string) => {
    const db = new Database(panelDb);
    db.query("UPDATE firewall_rule SET port_range = ?, source = ? WHERE id = ?").run(portRange, source, id);
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
  return { dir, paths, options, tuples, calls, addRule, editRule, deleteRule, rebuild, has: (rule: UfwRule) => tuples.some((item) => same(item, rule)) };
}

test("the forms, CloudPanel's rebuilds and switching off, end to end", () => {
  const b = box();
  b.addRule("22", "0.0.0.0/0");
  b.addRule("22", "::/0");
  b.rebuild();
  expect(syncFirewall("apply", b.options)).toBeNull();

  // The add form names the protocol; a pass that runs before CloudPanel saves the rule keeps it.
  setRuleProtocol({ portRange: "51820", source: "0.0.0.0/0", protocol: "udp" }, b.options);
  expect(syncFirewall("apply", b.options)).toBeNull();
  expect(readFirewallState(b.paths).protocols).toEqual({ "51820 0.0.0.0/0": "udp" });
  b.addRule("51820", "0.0.0.0/0");
  b.rebuild();
  expect(b.has({ proto: "tcp", port: "51820", src: "0.0.0.0/0" })).toBe(true);
  expect(syncFirewall("apply", b.options)).toBe("2 ufw rules changed");
  expect(b.has({ proto: "udp", port: "51820", src: "0.0.0.0/0" })).toBe(true);
  expect(b.has({ proto: "tcp", port: "51820", src: "0.0.0.0/0" })).toBe(false);
  expect(readFirewallState(b.paths)).toMatchObject({ protocols: { "51820 0.0.0.0/0": "udp" }, unmatched: {} });
  expect(JSON.parse(readFileSync(b.paths.stateFile, "utf8"))).toMatchObject({ version: 2, protocols: { "51820 0.0.0.0/0": "udp" } });
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
  setRuleProtocol({ id: 3, portRange: "51820", source: "0.0.0.0/0", protocol: "both" }, b.options);
  b.rebuild();
  syncFirewall("apply", b.options);
  expect(b.has({ proto: "udp", port: "51820", src: "0.0.0.0/0" })).toBe(true);
  expect(b.has({ proto: "tcp", port: "51820", src: "0.0.0.0/0" })).toBe(true);

  // Switching System Tweaks off leaves exactly CloudPanel's own rules, and keeps the choice.
  syncFirewall("withdraw", b.options);
  const own = [...b.tuples];
  b.rebuild();
  expect(new Set(own.map((rule) => JSON.stringify(rule)))).toEqual(new Set(b.tuples.map((rule) => JSON.stringify(rule))));
  expect(readFirewallState(b.paths).protocols).toEqual({ "51820 0.0.0.0/0": "both" });
  // The watcher the withdrawal itself woke applies nothing while System Tweaks is off.
  expect(syncFirewall("apply", b.options)).toBeNull();
  expect(b.has({ proto: "udp", port: "51820", src: "0.0.0.0/0" })).toBe(false);
  // Switching it on again puts the protocol back.
  expect(syncFirewall("restore", b.options)).toBe("1 ufw rule changed");
  expect(b.has({ proto: "udp", port: "51820", src: "0.0.0.0/0" })).toBe(true);
  expect(readFirewallState(b.paths).withdrawn).toBeUndefined();

  // The edit form moves the rule to 51821: the protocol goes with it and the old entry is forgotten.
  setRuleProtocol({ id: 3, portRange: "51821", source: "0.0.0.0/0", protocol: "both" }, b.options);
  b.editRule(3, "51821", "0.0.0.0/0");
  b.rebuild();
  syncFirewall("apply", b.options);
  expect(readFirewallState(b.paths).protocols).toEqual({ "51821 0.0.0.0/0": "both" });
  expect(b.has({ proto: "udp", port: "51821", src: "0.0.0.0/0" })).toBe(true);
  expect(b.has({ proto: "udp", port: "51820", src: "0.0.0.0/0" })).toBe(false);

  // Deleting the rule in the panel forgets its protocol.
  b.deleteRule(3);
  b.rebuild();
  syncFirewall("apply", b.options);
  expect(readFirewallState(b.paths).protocols).toEqual({});
  expect(b.has({ proto: "udp", port: "51821", src: "0.0.0.0/0" })).toBe(false);
});

test("a choice from a form CloudPanel refused touches no other rule", () => {
  const b = box();
  b.addRule("22", "0.0.0.0/0");
  b.rebuild();
  // UDP chosen, then CloudPanel's validation stops the form: no rule is saved.
  setRuleProtocol({ portRange: "53", source: "203.0.113.9", protocol: "udp" }, b.options);
  // A rule on the same port from another source stays TCP.
  b.addRule("53", "0.0.0.0/0");
  b.rebuild();
  expect(syncFirewall("apply", b.options)).toBeNull();
  expect(b.has({ proto: "tcp", port: "53", src: "0.0.0.0/0" })).toBe(true);
  expect(b.has({ proto: "udp", port: "53", src: "0.0.0.0/0" })).toBe(false);
});

test("the forms' requests are checked before anything is stored", () => {
  const b = box();
  b.addRule("22", "0.0.0.0/0");
  b.addRule("8443", "0.0.0.0/0");
  const rule = (portRange: string, protocol: string, extra: Record<string, unknown> = {}) => ({ portRange, source: "0.0.0.0/0", protocol, ...extra });
  expect(() => setRuleProtocol(rule("22", "icmp"), b.options)).toThrow("protocol must be tcp, udp or both");
  expect(() => setRuleProtocol(rule("1:2", "udp"), b.options)).toThrow("Port Range must be");
  expect(() => setRuleProtocol(rule("53; ufw disable", "udp"), b.options)).toThrow("Port Range must be");
  expect(() => setRuleProtocol({ portRange: "53", source: "any", protocol: "udp" }, b.options)).toThrow("Source an address");
  // UDP alone on CloudPanel's own port would close the panel.
  expect(() => setRuleProtocol(rule("8443", "udp", { id: 2 }), b.options)).toThrow("CloudPanel itself is on port 8443");
  setRuleProtocol(rule("8443", "both", { id: 2 }), b.options);
  // The add form for a port range and source that already have a rule would change that rule.
  expect(() => setRuleProtocol(rule("22", "udp"), b.options)).toThrow("a rule for 22 from 0.0.0.0/0 already exists");
  expect(() => setRuleProtocol(rule("22", "udp", { id: 2 }), b.options)).toThrow("already exists");
  expect(() => setRuleProtocol(rule("22", "udp", { id: "1" }), b.options)).toThrow("already exists");
  setRuleProtocol(rule("22", "tcp"), b.options);
  setRuleProtocol(rule("22", "udp", { id: 1 }), b.options);
  setRuleProtocol(rule(" 53 ", "both"), b.options);
  expect(readFirewallState(b.paths).protocols).toEqual({ "8443 0.0.0.0/0": "both", "22 0.0.0.0/0": "udp", "53 0.0.0.0/0": "both" });
  expect(readFirewallState(b.paths).unmatched).toEqual({ "53 0.0.0.0/0": 0 });
  // TCP is CloudPanel's own, so choosing it deletes the entry.
  setRuleProtocol(rule("22", "tcp", { id: 1 }), b.options);
  setRuleProtocol(rule("53", "tcp"), b.options);
  expect(readFirewallState(b.paths)).toMatchObject({ protocols: { "8443 0.0.0.0/0": "both" }, unmatched: {} });
});

test("the id-keyed state of earlier builds reads as empty", () => {
  const b = box();
  mkdirSync(join(b.dir, "state"));
  writeFileSync(b.paths.stateFile, JSON.stringify({ version: 1, protocols: { 7: "udp" }, pending: [], managed: [] }), { mode: 0o600 });
  expect(readFirewallState(b.paths)).toEqual({ protocols: {}, unmatched: {}, managed: [] });
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
