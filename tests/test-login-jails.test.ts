import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../lib/command";
import {
  anySpelling, applyLoginJails, customDomainName, jailFiles, loginJailsStatus, parseBans, releaseLoginJails, sshLogin, unban,
  withDomainLog, withLoginLog, withoutDomainLog, withoutLoginLog, type LoginJailOptions,
} from "../addons/system-tweaks/login-jails";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const PANEL_CONF = `user clp;
http {
    real_ip_header X-Forwarded-For;
    server_tokens off;
    access_log off;

    include /home/clp/services/nginx/sites-enabled/*.conf;
}
`;

// CloudPanel's custom-domain vhost, as staging has it.
const DOMAIN_VHOST = `server {
  listen 443 ssl http2;
  server_name cp.example.com;
  root /home/clp/htdocs/app/files/public;

  #access_log /home/clp/logs/nginx/access.log;

  location / {
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_pass https://127.0.0.1:8443/;
  }
}
`;

const ok = (stdout = ""): CommandResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): CommandResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

/** A box with fail2ban installed, as CloudPanel's staging server had it: enabled at boot, failed. */
function box(service = { enabled: true, active: false, jails: [] as string[] }) {
  const dir = mkdtempSync(join(tmpdir(), "clp-login-jails-"));
  dirs.push(dir);
  const fail2banDir = join(dir, "fail2ban");
  mkdirSync(join(fail2banDir, "jail.d"), { recursive: true });
  mkdirSync(join(fail2banDir, "filter.d"));
  const panelConf = join(dir, "nginx.conf");
  writeFileSync(panelConf, PANEL_CONF);
  chmodSync(panelConf, 0o770);
  const cloudflareIps = join(dir, "cloudflare-ips");
  writeFileSync(cloudflareIps, "allow 173.245.48.0/20;\nallow 2400:cb00::/32;\nallow nonsense;\ndeny all;\n");
  const domainVhost = join(dir, "custom-domain.conf");
  writeFileSync(domainVhost, DOMAIN_VHOST, { mode: 0o644 });
  const uid = process.getuid!();
  const state = { ...service, missing: [] as string[], testFails: false, commands: [] as string[], bans: "" };
  const run = (command: string, args: string[]): CommandResult => {
    state.commands.push(`${command} ${args.join(" ")}`);
    if (command === "dpkg-query") return state.missing.includes(args.at(-1)!) ? fail("not installed") : ok("install ok installed");
    if (command === "sshd") return ok("port 22\nport 2222\npasswordauthentication yes\npermitrootlogin yes\nusepam yes\nkbdinteractiveauthentication no\n");
    if (command === "systemctl") {
      if (args[0] === "is-enabled") return ok(state.enabled ? "enabled\n" : "disabled\n");
      if (args[0] === "is-active") return ok(state.active ? "active\n" : "failed\n");
      if (args[0] === "restart" || args[0] === "reload") state.active = true;
      if (args[0] === "stop") state.active = false;
      if (args[0] === "enable") state.enabled = true;
      if (args[0] === "disable") state.enabled = false;
      return ok();
    }
    if (command === "fail2ban-client") {
      if (args[0] === "-t") return state.testFails ? fail("ERROR  No section: 'Definition'") : ok();
      if (args[0] === "status") return ok(`Status\n|- Number of jail:\t${state.jails.length}\n\`- Jail list:\t${state.jails.join(", ")}\n`);
      if (args[0] === "get") return ok(state.bans);
      return ok("1");
    }
    return ok();
  };
  const options: LoginJailOptions = {
    run, paths: { fail2banDir, panelConf, panelUid: uid, panelGid: process.getgid!(), cloudflareIps, domainVhost, domainUid: 0, rootUid: uid, rootGid: process.getgid!() },
  };
  const file = (name: string) => join(fail2banDir, name);
  const read = (name: string) => existsSync(file(name)) ? readFileSync(file(name), "utf8") : null;
  return { dir, state, options, panelConf, domainVhost, uid, read };
}

test("the login log takes the place of the one access_log off; and comes out again", () => {
  const added = withLoginLog(PANEL_CONF)!;
  expect(added).toContain("    #clp-addons:login-log access_log off;\n    # clp-addons:login-log:start\n");
  expect(added).toContain("tag=clp_addons_panel,nohostname clp_addons_login if=$clp_addons_login_failed;");
  expect(added).not.toMatch(/^\s*access_log off;/m);
  expect(withLoginLog(added)).toBe(added);
  expect(withoutLoginLog(added)).toBe(PANEL_CONF);
  expect(withLoginLog(PANEL_CONF.replace("    access_log off;\n", ""))).toBeNull();
  expect(withLoginLog(PANEL_CONF.replace("    access_log off;\n", "    access_log off;\n    access_log off;\n"))).toBeNull();
});

test("the jails ban one port each through nftables, and SSH stays off unless asked", () => {
  const input = { panelUid: 1000, domainUid: 0, proxies: ["10.0.0.0/8", "173.245.48.0/20"], sshPorts: ["22", "2222"] };
  const panelOnly = jailFiles({ panel: true, ssh: false }, input);
  expect(panelOnly.jails).toContain("[clp-addons-panel]\nenabled = true\n");
  expect(panelOnly.jails).toContain("backend = systemd[journalflags=1]\njournalmatch = SYSLOG_IDENTIFIER=clp_addons_panel _UID=1000\nport = 8443\nbanaction = nftables-multiport\n");
  expect(panelOnly.jails).toContain("ignoreip = %(known/ignoreip)s 10.0.0.0/8 173.245.48.0/20\n");
  expect(panelOnly.jails).toContain("[sshd]\nenabled = false\n");
  expect(panelOnly.defaults).toContain("[DEFAULT]\nignoreip = 127.0.0.1/8 ::1\n");
  expect(panelOnly.filter).toContain("failregex = ^%(__prefix_line)s(?:password|mfa|basic-auth) login failed from <ADDR>$");
  const both = jailFiles({ panel: true, ssh: true }, input);
  expect(both.jails).toContain("[sshd]\nenabled = true\nbackend = systemd\nbanaction = nftables-multiport\nport = 22,2222\nmaxretry = 5\nfindtime = 1h\nbantime = 1h");
  expect(jailFiles({ panel: false, ssh: false }, input)).toEqual({ defaults: null, jails: null, filter: null });
});

test("switching on starts a failed fail2ban with the jails, and switching off puts it back as it was", () => {
  const b = box();
  const applied = applyLoginJails({ panel: true, ssh: false }, null, b.options);
  expect(applied).toEqual({ before: { enabled: true, active: false }, ssh: false, changed: true });
  expect(b.read("jail.d/clp-addons.local")).toContain(`journalmatch = SYSLOG_IDENTIFIER=clp_addons_panel _UID=${b.uid}`);
  expect(b.read("jail.d/clp-addons.local")).toContain("ignoreip = %(known/ignoreip)s 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 173.245.48.0/20 2400:cb00::/32\n");
  expect(readFileSync(b.panelConf, "utf8")).toContain("# clp-addons:login-log:start");
  expect(b.state.commands).toContain("fail2ban-client -t");
  expect(b.state.commands).toContain("systemctl restart fail2ban");
  expect(b.state.active).toBe(true);

  // Nothing to do the second time.
  b.state.commands = [];
  expect(applyLoginJails({ panel: true, ssh: false }, applied.before, b.options).changed).toBe(false);
  expect(b.state.commands.filter((line) => /restart|reload/.test(line))).toEqual([]);

  expect(applyLoginJails({ panel: false, ssh: false }, applied.before, b.options)).toEqual({ before: null, ssh: false, changed: true });
  expect(b.read("jail.d/clp-addons.local")).toBeNull();
  expect(b.read("jail.d/00-clp-addons.conf")).toBeNull();
  expect(b.read("filter.d/clp-addons-panel.conf")).toBeNull();
  expect(readFileSync(b.panelConf, "utf8")).toBe(PANEL_CONF);
  expect(b.state.active).toBe(false);
  expect(b.state.enabled).toBe(true);
});

test("a fail2ban that was neither running nor enabled is stopped and disabled again", () => {
  const b = box({ enabled: false, active: false, jails: [] });
  const { before } = applyLoginJails({ panel: false, ssh: true }, null, b.options);
  expect(b.state).toMatchObject({ enabled: true, active: true });
  expect(b.read("jail.d/clp-addons.local")).not.toContain("[clp-addons-panel]");
  expect(readFileSync(b.panelConf, "utf8")).toBe(PANEL_CONF);
  releaseLoginJails(before, b.options);
  expect(b.state).toMatchObject({ enabled: false, active: false });
});

test("a root-owned panel config keeps its owner while the jail follows the panel worker UID", () => {
  const b = box();
  const panelUid = b.uid + 1;
  const options = { ...b.options, paths: { ...b.options.paths, panelUid } };
  const before = statSync(b.panelConf);
  expect(loginJailsStatus(options)).toMatchObject({ panelLog: false, problem: "" });
  const applied = applyLoginJails({ panel: true, ssh: false }, null, options);
  expect(loginJailsStatus(options)).toMatchObject({ panelLog: true, problem: "" });
  expect(statSync(b.panelConf)).toMatchObject({ uid: before.uid, gid: before.gid, mode: before.mode });
  expect(b.read("jail.d/clp-addons.local")).toContain(`journalmatch = SYSLOG_IDENTIFIER=clp_addons_panel _UID=${panelUid}`);
  applyLoginJails({ panel: false, ssh: false }, applied.before, options);
  expect(readFileSync(b.panelConf, "utf8")).toBe(PANEL_CONF);
  expect(statSync(b.panelConf)).toMatchObject({ uid: before.uid, gid: before.gid, mode: before.mode });
});

test("login logging refuses a panel config writable by an unrelated group", () => {
  const b = box();
  const gid = process.getgid!();
  const options = { ...b.options, paths: { ...b.options.paths, panelGid: gid + 1, rootGid: gid + 2 } };
  expect(loginJailsStatus(options).problem).toContain(`untrusted gid ${gid}`);
  expect(() => applyLoginJails({ panel: true, ssh: false }, null, options)).toThrow(`untrusted gid ${gid}`);
  expect(readFileSync(b.panelConf, "utf8")).toBe(PANEL_CONF);
  expect(b.state.commands).not.toContain("systemctl reload clp-nginx");
});

test("an SSH jail fail2ban already ran stays on, and a running fail2ban is reloaded rather than restarted", () => {
  const b = box({ enabled: true, active: true, jails: ["sshd"] });
  const applied = applyLoginJails({ panel: true, ssh: false }, null, b.options);
  expect(applied.ssh).toBe(true);
  expect(b.read("jail.d/clp-addons.local")).toContain("[sshd]\nenabled = true\n");
  expect(b.state.commands).toContain("systemctl reload fail2ban");
  expect(b.state.commands).not.toContain("systemctl restart fail2ban");
  // Released, the operator's own jails come back with a reload and fail2ban keeps running.
  releaseLoginJails(applied.before, b.options);
  expect(b.state.active).toBe(true);
});

test("jails fail2ban refuses are taken back out", () => {
  const b = box();
  b.state.testFails = true;
  expect(() => applyLoginJails({ panel: true, ssh: false }, null, b.options)).toThrow("fail2ban refused the jails: ERROR  No section: 'Definition'");
  expect(b.read("jail.d/clp-addons.local")).toBeNull();
  expect(b.state.commands).not.toContain("systemctl restart fail2ban");
});

test("without fail2ban nothing is written or started", () => {
  const b = box();
  b.state.missing = ["fail2ban", "python3-systemd"];
  expect(applyLoginJails({ panel: true, ssh: false }, null, b.options)).toEqual({ before: null, ssh: false, changed: false });
  expect(b.read("jail.d/clp-addons.local")).toBeNull();
  expect(readFileSync(b.panelConf, "utf8")).toBe(PANEL_CONF);
  expect(b.state.commands.some((line) => line.startsWith("systemctl"))).toBe(false);
  expect(loginJailsStatus(b.options)).toMatchObject({ missing: ["fail2ban", "python3-systemd"], running: [], bans: [] });
});

test("the page reads the bans of both jails and what sshd accepts", () => {
  const b = box({ enabled: true, active: true, jails: ["clp-addons-panel", "recidive"] });
  b.state.bans = "203.0.113.7 \t2026-11-04 11:18:24 + 3600 = 2026-11-04 12:18:24\n2001:db8::7 \t2026-11-04 11:18:24 + 3600 = 2026-11-04 12:18:24\n";
  applyLoginJails({ panel: true, ssh: false }, null, b.options);
  const status = loginJailsStatus(b.options);
  expect(status).toMatchObject({ missing: [], service: "active", running: ["clp-addons-panel"], panelLog: true });
  expect(status.bans).toEqual([
    { jail: "clp-addons-panel", ip: "203.0.113.7", until: "2026-11-04 12:18:24" },
    { jail: "clp-addons-panel", ip: "2001:db8::7", until: "2026-11-04 12:18:24" },
  ]);
  expect(status.sshd).toEqual({ password: true, rootLogin: "yes" });
});

test("parseBans and sshLogin read only what they recognise", () => {
  expect(parseBans("sshd", "not-an-ip \t2026 + 1 = 2026\n\n")).toEqual([]);
  expect(sshLogin(new Map())).toBeNull();
  expect(sshLogin(new Map([["passwordauthentication", "no"], ["usepam", "yes"], ["kbdinteractiveauthentication", "yes"], ["permitrootlogin", "prohibit-password"]])))
    .toEqual({ password: true, rootLogin: "prohibit-password" });
  expect(sshLogin(new Map([["passwordauthentication", "no"], ["permitrootlogin", "no"]]))).toEqual({ password: false, rootLogin: "no" });
});

test("unban takes only these jails and an address", () => {
  const b = box({ enabled: true, active: true, jails: [] });
  expect(() => unban({ jail: "recidive", ip: "203.0.113.7" }, b.options)).toThrow("jail must be one of clp-addons-panel, clp-addons-domain, sshd");
  expect(() => unban({ jail: "sshd", ip: "203.0.113.7; reboot" }, b.options)).toThrow("ip must be an IPv4 or IPv6 address");
  unban({ jail: "sshd", ip: "2001:db8::7" }, b.options);
  expect(b.state.commands).toContain("fail2ban-client set sshd unbanip 2001:db8::7");
});

/** The nginx map's regex for `name`, as JavaScript reads the same PCRE; `~*` is case-insensitive. */
function mapRegex(block: string, name: string): RegExp {
  const line = block.split("\n").find((entry) => entry.trim().endsWith(` ${name};`) && entry.includes("~*"))!;
  return new RegExp(/"~\*(.*)"/.exec(line)![1]!, "i");
}

test("every spelling Symfony's router decodes to /login/mfa counts as a two-factor failure", () => {
  const mfa = mapRegex(withLoginLog(PANEL_CONF)!, "mfa");
  for (const uri of [
    "/login/mfa", "/login/mfa?x=1", "/login/%6dfa", "/login/%6Dfa", "/login%2Fmfa", "/%6c%6f%67%69%6e/%6d%66%61",
    "/index.php/login/mfa", "/%69ndex%2ephp/login/mfa", "/LOGIN/MFA",
  ]) expect(`POST 200 ${uri}`).toMatch(mfa);
  for (const uri of ["/login/mfa/x", "/login/mfaa", "/login/%256dfa", "/x/login/mfa", "/index.php/x/login/mfa"]) {
    expect(`POST 200 ${uri}`).not.toMatch(mfa);
  }
  expect("GET 200 /login/mfa").not.toMatch(mfa);
  expect("POST 302 /login/mfa").not.toMatch(mfa);
  expect(anySpelling("/a.b")).toBe("(?:/|%2f)(?:a|%61)(?:\\.|%2e)(?:b|%62)");
});

test("a failed password login is a POST to /login sent back to /login", () => {
  const block = withLoginLog(PANEL_CONF)!;
  const password = mapRegex(block, "password");
  expect("POST 302 /login").toMatch(password);
  expect("POST 302 /login?_target=x").toMatch(password);
  expect("POST 302 /login/mfa").not.toMatch(password);
  const back = new RegExp(/"~\*(.*)" 1;/.exec(block)![1]!, "i");
  expect("/login").toMatch(back);
  expect("https://cp.example.com/login").toMatch(back);
  expect("/").not.toMatch(back);
  expect("/sites").not.toMatch(back);
});

test("the custom domain's vhost logs failures from the sites' nginx, and comes back as CloudPanel wrote it", () => {
  const added = withDomainLog(DOMAIN_VHOST)!;
  expect(added.startsWith("# clp-addons:login-log:start\nmap ")).toBe(true);
  expect(added).toContain("  server_name cp.example.com;\n  access_log syslog:server=unix:/dev/log,facility=authpriv,severity=notice,tag=clp_addons_domain,nohostname clp_addons_login if=$clp_addons_login_failed; # clp-addons:login-log\n");
  expect(withDomainLog(added)).toBe(added);
  expect(withoutDomainLog(added)).toBe(DOMAIN_VHOST);
  expect(customDomainName(added)).toBe("cp.example.com");
  expect(withDomainLog(`${DOMAIN_VHOST}${DOMAIN_VHOST}`)).toBeNull();
});

test("the custom domain gets its own jail on 443, matched on the sites' nginx workers' uid", () => {
  const files = jailFiles({ panel: true, ssh: false }, { panelUid: 1000, domainUid: 0, proxies: ["10.0.0.0/8"], sshPorts: [] });
  expect(files.jails).toContain("[clp-addons-domain]\nenabled = true\nfilter = clp-addons-panel\nbackend = systemd[journalflags=1]\njournalmatch = SYSLOG_IDENTIFIER=clp_addons_domain _UID=0\nport = 443\n");
  expect(files.filter).toContain("_daemon = clp_addons_(?:panel|domain)");
  expect(jailFiles({ panel: true, ssh: false }, { panelUid: 1000, domainUid: null, proxies: [], sshPorts: [] }).jails).not.toContain("clp-addons-domain");
});

test("switching the panel jail on and off edits the custom domain's vhost too", () => {
  const b = box();
  const { before } = applyLoginJails({ panel: true, ssh: false }, null, b.options);
  expect(readFileSync(b.domainVhost, "utf8")).toContain("tag=clp_addons_domain");
  expect(b.state.commands).toContain("nginx -t");
  expect(b.read("jail.d/clp-addons.local")).toContain("[clp-addons-domain]");
  expect(loginJailsStatus(b.options).customDomain).toEqual({ name: "cp.example.com", logged: true, supported: true });
  releaseLoginJails(before, b.options);
  expect(readFileSync(b.domainVhost, "utf8")).toBe(DOMAIN_VHOST);
  expect(loginJailsStatus(b.options).customDomain).toEqual({ name: "cp.example.com", logged: false, supported: true });
});
