import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, type CommandResult } from "../lib/command";
import {
  applyPanelGate, applySitesGate, cleanUpPanelGate, keepPanelGateNginx, panelGateOffLocally, panelGateSummary, panelGateView,
  repairPanelGate, setPanelGate, withdrawPanelGate, type GateOptions,
} from "../addons/firewall/panel-gate";
import {
  hasPanelGate, hasSitesGate, panelGateMisfit, sitesGateMisfit, withoutPanelGate, withoutSitesGate, withPanelGate, withSitesGate,
} from "../addons/firewall/panel-gate-nginx";
import { FakeCloudflare, policy } from "./fixtures/dns-api";
import { FIREWALL_ACTIONS } from "../addons/firewall/setup";
import { actionItems } from "../manager/setup";

const uid = process.getuid!();
const gid = process.getgid!();
const HOST = "cp.example.com";
const TOKEN = "cf-token-0123456789abcdefghijklmnop";
const ALL_ZONES = { "com.cloudflare.api.account.zone.*": "*" };
const GATE_GROUPS = ["SSL and Certificates Write", "Access: Apps and Policies Write", "Access: Organizations, Identity Providers, and Groups Write"];

// CloudPanel's custom-domain vhost on the staging box, System Tweaks' login log included.
const CUSTOM_DOMAIN = `# clp-addons:login-log:start
map "$request_method $status $request_uri" $clp_addons_login_form {
    default "";
    "~*^POST 302 (?:/|%2f)login(?:\\?.*)?$" password;
}
log_format clp_addons_login escape=none '$clp_addons_login_failed login failed from $realip_remote_addr';
# clp-addons:login-log:end
server {
  listen 80;
  listen [::]:80;
  listen 443 ssl http2;
  listen [::]:443 ssl http2;
  ssl_certificate_key /etc/nginx/ssl-certificates/custom-domain.key;
  ssl_certificate /etc/nginx/ssl-certificates/custom-domain.crt;
  server_name ${HOST};
  access_log syslog:server=unix:/dev/log,tag=clp_addons_domain,nohostname clp_addons_login if=$clp_addons_login_failed; # clp-addons:login-log
  client_max_body_size 5048M;

  if ($scheme != "https") {
    rewrite ^ https://$host$uri permanent;
  }

  location / {
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_pass https://127.0.0.1:8443/;
 }
}
`;

// The panel's vhost on the staging box, shortened.
const PANEL = `server {
  server_name _;
  listen 8443 ssl http2;
  listen [::]:8443 ssl http2;
  ssl_certificate_key /home/clp/services/nginx/ssl-certificates/private.key;
  ssl_certificate /home/clp/services/nginx/ssl-certificates/cert.crt;
  root /home/clp/htdocs/app/files/public;

  location ~ /.well-known {
    auth_basic off;
    allow all;
  }

  set $basicAuth "off";

  if (-f /home/clp/services/nginx/basic-auth/credentials) {
    set $basicAuth "on";
  }

  try_files $uri $uri/ /index.php?$args;

  if (-f $request_filename) {
    break;
  }

    # clp-addons:proxy:start
    location ^~ /addons/ {
        proxy_pass http://unix:/run/clp-addons/manager.sock:/;
    }
    # clp-addons:proxy:end
}
`;

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface Box {
  dir: string;
  cf: FakeCloudflare;
  options: GateOptions;
  commands: string[][];
  /** Commands that fail, by their joined text. */
  failing: Set<string>;
  zoneId: string;
  account: string;
}

function box(): Box {
  const dir = mkdtempSync(join(tmpdir(), "panel-gate-test-"));
  dirs.push(dir);
  for (const sub of ["state", "dns", "locks", "sites", "panel"]) mkdirSync(join(dir, sub), { mode: 0o700 });
  writeFileSync(join(dir, "sites", "custom-domain.conf"), CUSTOM_DOMAIN, { mode: 0o644 });
  writeFileSync(join(dir, "custom-domain"), `${HOST}\n`, { mode: 0o644 });
  writeFileSync(join(dir, "panel", "cloudpanel.conf"), PANEL, { mode: 0o640 });
  writeFileSync(join(dir, "panel", "nginx.conf"), "", { mode: 0o640 });
  const db = new Database(join(dir, "panel.db"));
  db.exec("CREATE TABLE user (id INTEGER PRIMARY KEY, user_name TEXT, email TEXT, role TEXT, status INTEGER)");
  const users: [string, string, string, number][] = [
    ["admin", "Admin@Example.com", "ROLE_ADMIN", 1],
    ["site", "site@example.net", "ROLE_USER", 1],
    ["manager", "manager@example.org", "ROLE_SITE_MANAGER", 1],
    ["gone", "gone@example.com", "ROLE_ADMIN", 0],
  ];
  for (const user of users) db.query("INSERT INTO user (user_name, email, role, status) VALUES (?, ?, ?, ?)").run(...user);
  db.close();

  const cf = new FakeCloudflare();
  const account = cf.account("Agency");
  cf.token(TOKEN, { owner: "user", accounts: [account], policies: [policy(["DNS Write", "API Tokens Read", "Zone Settings Read", ...GATE_GROUPS], ALL_ZONES)] });
  const zone = cf.zone("example.com", account);
  cf.record("example.com", { type: "A", name: HOST, content: "203.0.113.10", proxied: true });
  writeFileSync(join(dir, "dns", "secrets.json"), JSON.stringify({ cloudflare: { agency: TOKEN } }), { mode: 0o600 });
  writeFileSync(join(dir, "dns", "policy.json"), JSON.stringify({ connections: [{ id: "agency", label: "Agency" }] }), { mode: 0o600 });

  const commands: string[][] = [];
  const failing = new Set<string>();
  const run = (command: string, args: string[]): CommandResult => {
    if (command === "openssl") return runCommand(command, args, 60_000);
    commands.push([command, ...args]);
    return failing.has([command, ...args].join(" ")) ? { ok: false, stdout: "", stderr: `${command} refused` } : { ok: true, stdout: "", stderr: "" };
  };
  return {
    dir, cf, commands, failing, zoneId: zone.id, account,
    options: {
      fetch: cf.fetch,
      run,
      sleep: async () => {},
      paths: {
        stateFile: join(dir, "state", "panel-gate.json"),
        lockFile: join(dir, "locks", "panel-gate.lock"),
        operationLockDir: join(dir, "locks"),
        certDir: join(dir, "certs"),
        dnsDir: join(dir, "dns"),
        panelDb: join(dir, "panel.db"),
        customDomain: join(dir, "custom-domain"),
        customDomainVhost: join(dir, "sites", "custom-domain.conf"),
        panelVhost: join(dir, "panel", "cloudpanel.conf"),
        panelConf: join(dir, "panel", "nginx.conf"),
        rootUid: uid, rootGid: gid, panelUid: uid, panelGid: gid,
      },
    },
  };
}

const readGateState = (options: GateOptions): Record<string, any> => {
  const file = options.paths!.stateFile!;
  return existsSync(file) ? { on: false, ...JSON.parse(readFileSync(file, "utf8")) } : { on: false };
};
const sitesVhost = (b: Box) => readFileSync(join(b.dir, "sites", "custom-domain.conf"), "utf8");
const panelVhost = (b: Box) => readFileSync(join(b.dir, "panel", "cloudpanel.conf"), "utf8");
const certFile = (b: Box) => join(b.dir, "certs", "origin-pull.crt");

async function turnOn(b: Box) {
  const first = await setPanelGate(true, undefined, b.options);
  if (!("review" in first)) throw new Error(`expected a review, got ${JSON.stringify(first)}`);
  return { review: first.review, reply: await setPanelGate(true, first.review.digest, b.options) };
}

describe("Nginx edits", () => {
  test("the custom domain asks for the client certificate after its server_name, and comes back byte for byte", () => {
    const gated = withSitesGate(CUSTOM_DOMAIN, HOST, "/etc/clp-addons/panel-gate/origin-pull.crt")!;
    expect(gated).toContain(`  server_name ${HOST};\n  ssl_client_certificate /etc/clp-addons/panel-gate/origin-pull.crt; # clp-addons:panel-gate\n  ssl_verify_client on; # clp-addons:panel-gate\n  access_log`);
    expect(hasSitesGate(gated, HOST, "/etc/clp-addons/panel-gate/origin-pull.crt")).toBe(true);
    expect(withSitesGate(gated, HOST, "/etc/clp-addons/panel-gate/origin-pull.crt")).toBe(gated);
    expect(withoutSitesGate(gated)).toBe(CUSTOM_DOMAIN);
  });

  test("a custom-domain vhost that does not fit is refused, not guessed at", () => {
    expect(sitesGateMisfit(CUSTOM_DOMAIN, "other.example.com")).toContain("does not serve other.example.com alone");
    expect(sitesGateMisfit(CUSTOM_DOMAIN.replace(/listen (?:\[::\]:)?443 ssl http2;\n/g, ""), HOST)).toContain("443 with TLS");
    expect(sitesGateMisfit(`${CUSTOM_DOMAIN}server { listen 443 ssl; server_name ${HOST}; }\n`, HOST)).toContain("2 server blocks");
    expect(sitesGateMisfit(CUSTOM_DOMAIN.replace("server_name", "ssl_verify_client optional;\n  server_name"), HOST)).toContain("already checks client certificates");
    expect(withSitesGate(CUSTOM_DOMAIN, HOST, "/etc/x y.crt")).toBeNull();
  });

  test("the panel's loopback rule goes first in its 8443 server, before a rewrite can break out", () => {
    const gated = withPanelGate(PANEL, HOST)!;
    expect(gated.startsWith('server {\n  # clp-addons:panel-gate:start\n  if ($realip_remote_addr !~ "^(?:127\\.0\\.0\\.1|::1)$") {\n    return 444;\n  }\n')).toBe(true);
    expect(gated).toContain('  # clp-addons:panel-gate:end\n  server_name _;');
    expect(gated).not.toContain("$remote_addr !~");
    expect(hasPanelGate(gated, HOST)).toBe(true);
    expect(gated).toContain('if ($host !~* "^(?:cp\\.example\\.com|127\\.0\\.0\\.1|localhost|\\[?::1\\]?)$") {\n    return 444;');
    expect(withPanelGate(PANEL, "cp.example.com; return 200")).toBeNull();
    expect(withoutPanelGate(gated)).toBe(PANEL);
    expect(panelGateMisfit(PANEL.replace(/8443/g, "9443"))).toContain("0 server blocks on 8443");
  });

  test("applied, then rolled back when Nginx refuses it", () => {
    const b = box();
    expect(applySitesGate(true, HOST, b.options)).toBe(true);
    expect(sitesVhost(b)).toContain("ssl_verify_client on; # clp-addons:panel-gate");
    expect(b.commands).toEqual([["nginx", "-t"], ["systemctl", "reload", "nginx"]]);
    expect(applySitesGate(true, HOST, b.options)).toBe(false);

    b.commands.length = 0;
    b.failing.add(`nginx -t -c ${join(b.dir, "panel", "nginx.conf")}`);
    expect(() => applyPanelGate(true, HOST, b.options)).toThrow("Nginx validation failed");
    expect(panelVhost(b)).toBe(PANEL);
    expect(b.commands.map((command) => command.join(" "))).not.toContain("systemctl reload clp-nginx");
    expect(statSync(join(b.dir, "panel", "cloudpanel.conf")).mode & 0o777).toBe(0o640);

    b.failing.clear();
    expect(applyPanelGate(true, HOST, b.options)).toBe(true);
    expect(b.commands.at(-1)).toEqual(["systemctl", "reload", "clp-nginx"]);
    expect(applySitesGate(false, null, b.options)).toBe(true);
    expect(applyPanelGate(false, null, b.options)).toBe(true);
    expect(sitesVhost(b)).toBe(CUSTOM_DOMAIN);
    expect(panelVhost(b)).toBe(PANEL);
  });
});

describe("turning it on", () => {
  test("in order: certificate, origin pulls, Access, then both Nginx edits; the review says how to get back in", async () => {
    const b = box();
    b.cf.deployPolls = 2;
    const { review, reply } = await turnOn(b);
    expect(review.text).toContain("https://<this server's IP>:8443 stops working");
    expect(review.text).toContain("SSH tunnel to 127.0.0.1:8443");
    expect(review.text).toContain("clp-addons firewall panel-gate off");
    expect(review.text).toContain("emails a one-time code");
    expect(review.details).toEqual(["admin@example.com", "manager@example.org", "site@example.net"]);
    expect(reply).toEqual({ notice: `The Panel gate is on. CloudPanel answers only at https://${HOST}, after a Cloudflare Access sign-in.` });

    const state = readGateState(b.options);
    expect(state).toMatchObject({ on: true, hostname: HOST, zoneId: b.zoneId, accountId: b.account, connectionId: "agency" });
    expect(statSync(certFile(b)).mode & 0o777).toBe(0o600);
    expect(statSync(join(b.dir, "certs", "origin-pull.key")).mode & 0o777).toBe(0o600);
    expect(statSync(join(b.dir, "certs")).mode & 0o777).toBe(0o700);

    expect([...b.cf.originHosts.values()]).toMatchObject([{ hostname: HOST, cert_id: state.certId, enabled: true, status: "active" }]);
    const app = b.cf.accessApps.get(state.appId!)!;
    expect(app).toMatchObject({ domain: HOST, type: "self_hosted", auto_redirect_to_identity: true, policies: [{ id: state.policyId, precedence: 1 }] });
    const otp = [...b.cf.identityProviders.values()].find((idp) => idp.type === "onetimepin")!;
    expect(app.allowed_idps).toEqual([otp.id]);
    expect(b.cf.accessPolicies.get(state.policyId!)).toMatchObject({
      decision: "allow",
      include: [{ email: { email: "admin@example.com" } }, { email: { email: "manager@example.org" } }, { email: { email: "site@example.net" } }],
    });

    expect(hasSitesGate(sitesVhost(b), HOST, certFile(b))).toBe(true);
    expect(hasPanelGate(panelVhost(b), HOST)).toBe(true);
    // Nginx asks for the certificate only once Cloudflare reports it deployed.
    const writes = b.cf.calls.map((call) => `${call.method} ${call.path}`);
    expect(writes.filter((call) => call.startsWith("GET") && call.endsWith(`/hostnames/${HOST}`))).toHaveLength(3);
    expect(writes.indexOf(`PUT /zones/${b.zoneId}/origin_tls_client_auth/hostnames`)).toBeLessThan(writes.findIndex((call) => call.startsWith("POST /accounts/")));
    expect(b.commands.map((command) => command.join(" "))).toEqual([
      "nginx -t", "systemctl reload nginx", `nginx -t -c ${join(b.dir, "panel", "nginx.conf")}`, "systemctl reload clp-nginx",
    ]);
  });

  test("the card says what is missing, and the switch refuses until it is there", async () => {
    const b = box();
    b.cf.tokens.get(TOKEN)!.policies = [policy(["DNS Write", "API Tokens Read", "Access: Apps and Policies Write"], ALL_ZONES)];
    b.cf.recordsOf("example.com")[0]!.proxied = false;
    const view = await panelGateView(b.options);
    expect(view.on).toBe(false);
    expect(view.problems.join(" ")).toContain("lacks SSL and Certificates: Edit, Access: Organizations, Identity Providers, and Groups: Edit");
    expect(view.problems.join(" ")).toContain(`${HOST} is not proxied through Cloudflare`);
    expect(view.editUrl).toBe("https://dash.cloudflare.com/profile/api-tokens");
    await expect(setPanelGate(true, undefined, b.options)).rejects.toThrow("cannot be turned on yet");
    expect(b.cf.writes()).toEqual([]);
    expect(sitesVhost(b)).toBe(CUSTOM_DOMAIN);
  });

  test("a token that cannot read itself, a missing custom domain and Flexible SSL are each refused", async () => {
    const b = box();
    delete b.cf.tokens.get(TOKEN)!.policies;
    b.cf.settings.set(`${b.zoneId}:ssl`, "flexible");
    const problems = (await panelGateView(b.options)).problems.join(" ");
    expect(problems).toContain("lacks API Tokens: Read");
    expect(problems).toContain("SSL mode Flexible");
    rmSync(join(b.dir, "custom-domain"));
    expect((await panelGateView(b.options)).problems).toEqual(["CloudPanel has no custom domain. Add one under Admin → Settings, in a zone on Cloudflare."]);
  });

  test("a review that changed since it was shown is shown again", async () => {
    const b = box();
    const first = await setPanelGate(true, undefined, b.options);
    const db = new Database(join(b.dir, "panel.db"));
    db.query("INSERT INTO user (user_name, email, role, status) VALUES ('new', 'new@example.com', 'ROLE_USER', 1)").run();
    db.close();
    const second = await setPanelGate(true, (first as { review: { digest: string } }).review.digest, b.options);
    expect("review" in second && second.review.details).toContain("new@example.com");
    expect(readGateState(b.options).on).toBe(false);
  });

  test("a panel Nginx that refuses the rule undoes every earlier step, Cloudflare's included", async () => {
    const b = box();
    b.failing.add(`nginx -t -c ${join(b.dir, "panel", "nginx.conf")}`);
    await expect(turnOn(b)).rejects.toThrow("Nginx validation failed");
    expect(sitesVhost(b)).toBe(CUSTOM_DOMAIN);
    expect(panelVhost(b)).toBe(PANEL);
    expect(b.cf.originHosts.size).toBe(0);
    expect(b.cf.originCerts.size).toBe(0);
    expect(b.cf.accessApps.size).toBe(0);
    expect(b.cf.accessPolicies.size).toBe(0);
    expect(existsSync(certFile(b))).toBe(false);
    expect(readGateState(b.options)).toMatchObject({ on: false });
    expect(readGateState(b.options).leftover).toBeUndefined();
  });

  test("a certificate Cloudflare never deploys stops before Nginx is touched", async () => {
    const b = box();
    b.cf.deployPolls = 1000;
    await expect(turnOn(b)).rejects.toThrow("has not finished deploying");
    expect(b.commands).toEqual([]);
    expect(b.cf.originCerts.size).toBe(0);
    expect(b.cf.accessApps.size).toBe(0);
  });

  test("a failed rollback at Cloudflare is recorded, and repair finishes it", async () => {
    const b = box();
    b.failing.add("nginx -t");
    let deletes = 0;
    b.cf.failOn = (method, path) => method === "DELETE" && path.includes("/access/apps/") && deletes++ === 0;
    await expect(turnOn(b)).rejects.toThrow("Undoing it did not finish, so this is left: Let's Encrypt bypass application");
    expect(readGateState(b.options)).toMatchObject({ on: false, leftover: true });
    expect(b.cf.accessApps.size).toBe(1);
    expect(readGateState(b.options).appId).toBeUndefined();
    expect(await repairPanelGate(b.options)).toBe("Panel gate: its Cloudflare objects are deleted");
    expect(b.cf.accessApps.size).toBe(0);
    expect(b.cf.accessPolicies.size).toBe(0);
    expect(b.cf.originCerts.size).toBe(0);
    expect(readGateState(b.options).leftover).toBeUndefined();
  });
});

test("a run that stopped after the custom domain's edit is taken back out before its certificate is deleted", async () => {
  const b = box();
  await turnOn(b);
  const state = readGateState(b.options);
  writeFileSync(join(b.dir, "state", "panel-gate.json"), JSON.stringify({ ...state, on: false, leftover: true }), { mode: 0o600 });
  writeFileSync(join(b.dir, "panel", "cloudpanel.conf"), PANEL);
  await repairPanelGate(b.options);
  expect(sitesVhost(b)).toBe(CUSTOM_DOMAIN);
  expect(b.cf.originCerts.size).toBe(0);
});

describe("keeping it and turning it off", () => {
  test("repair puts back what CloudPanel rewrote and keeps the Access policy on the active panel users", async () => {
    const b = box();
    await turnOn(b);
    writeFileSync(join(b.dir, "sites", "custom-domain.conf"), CUSTOM_DOMAIN);
    writeFileSync(join(b.dir, "panel", "cloudpanel.conf"), PANEL);
    const db = new Database(join(b.dir, "panel.db"));
    db.exec("UPDATE user SET status = 0 WHERE user_name = 'site'");
    db.close();
    const line = await repairPanelGate(b.options);
    expect(line).toContain("Panel gate put back: port 8443 loopback only, cp.example.com asks for Cloudflare's certificate");
    expect(line).toContain("Access policy follows the panel users");
    expect(hasSitesGate(sitesVhost(b), HOST, certFile(b))).toBe(true);
    expect(hasPanelGate(panelVhost(b), HOST)).toBe(true);
    const state = readGateState(b.options);
    expect((b.cf.accessPolicies.get(state.policyId!)!.include as unknown[]).length).toBe(2);
    expect(state.drift).toEqual([]);
  });

  test("drift: the Access app deleted, origin pulls off and the token's permissions gone", async () => {
    const b = box();
    await turnOn(b);
    const state = readGateState(b.options);
    b.cf.accessApps.delete(state.appId!);
    b.cf.originHosts.clear();
    await repairPanelGate(b.options);
    b.cf.tokens.get(TOKEN)!.policies = [policy(["DNS Write", "API Tokens Read"], ALL_ZONES)];
    await repairPanelGate(b.options);
    const view = await panelGateView(b.options);
    expect(view.on).toBe(true);
    expect(view.drift.join(" ")).toContain("lacks SSL and Certificates: Edit");
    expect(view.checkedAt).not.toBeNull();
    writeFileSync(join(b.dir, "panel", "cloudpanel.conf"), PANEL);
    expect((await panelGateView(b.options)).drift).toContain("Port 8443 answers more than loopback; the next repair puts the rule back.");
  });

  test("the drift names a missing Access app and origin pulls that are off", async () => {
    const b = box();
    await turnOn(b);
    const state = readGateState(b.options);
    b.cf.accessApps.delete(state.appId!);
    b.cf.originHosts.clear();
    await repairPanelGate(b.options);
    const drift = readGateState(b.options).drift!.join(" ");
    expect(drift).toContain(`The Access application for ${HOST} is missing`);
    expect(drift).toContain("no longer presents the origin-pull certificate");
  });

  test("a moved custom domain is reported and its new vhost left alone", async () => {
    const b = box();
    await turnOn(b);
    writeFileSync(join(b.dir, "custom-domain"), "new.example.com\n");
    writeFileSync(join(b.dir, "sites", "custom-domain.conf"), CUSTOM_DOMAIN.replaceAll(HOST, "new.example.com"));
    expect(keepPanelGateNginx(b.options)).toBeNull();
    expect(sitesVhost(b)).not.toContain("panel-gate");
    expect((await panelGateView(b.options)).drift[0]).toContain("now new.example.com");
  });

  test("off takes Nginx out first, then deletes what it made at Cloudflare", async () => {
    const b = box();
    await turnOn(b);
    b.commands.length = 0;
    const first = await setPanelGate(false, undefined, b.options);
    if (!("review" in first)) throw new Error("expected a review");
    expect(await setPanelGate(false, first.review.digest, b.options)).toEqual({ notice: "The Panel gate is off." });
    expect(b.commands.map((command) => command[0] === "nginx" ? command.slice(0, 2).join(" ") : command.join(" "))).toEqual([
      "nginx -t", "systemctl reload clp-nginx", "nginx -t", "systemctl reload nginx",
    ]);
    expect(sitesVhost(b)).toBe(CUSTOM_DOMAIN);
    expect(panelVhost(b)).toBe(PANEL);
    expect(b.cf.accessApps.size + b.cf.accessPolicies.size + b.cf.originCerts.size + b.cf.originHosts.size).toBe(0);
    // The one-time PIN login may serve other Access apps, so it stays.
    expect(b.cf.identityProviders.size).toBe(1);
    expect(existsSync(certFile(b))).toBe(false);
    expect(readGateState(b.options)).toMatchObject({ on: false });
  });

  test("the root command takes the gate off without Cloudflare, and repair cleans up after", async () => {
    const b = box();
    await turnOn(b);
    b.cf.tokens.get(TOKEN)!.status = "disabled";
    const before = b.cf.calls.length;
    const message = await panelGateOffLocally(b.options);
    expect(message).toContain(`The Panel gate is off on this server: port 8443 answers any address again, and ${HOST} no longer asks`);
    expect(message).toContain(`Cloudflare still has the gate's Access applications, Access policies, origin-pull certificate for ${HOST}`);
    expect(message).toContain("clp-addons repair firewall");
    expect(message).toContain(`“CloudPanel ${HOST} (clp-addons panel gate)”`);
    expect(await panelGateOffLocally(b.options)).toStartWith("The Panel gate was already off. Cloudflare still has");
    expect(b.cf.calls.length).toBe(before);
    expect(sitesVhost(b)).toBe(CUSTOM_DOMAIN);
    expect(panelVhost(b)).toBe(PANEL);
    expect(readGateState(b.options)).toMatchObject({ on: false, leftover: true });
    b.cf.tokens.get(TOKEN)!.status = "active";
    await repairPanelGate(b.options);
    expect(b.cf.accessApps.size).toBe(0);
    expect(await panelGateOffLocally(b.options)).toBe("The Panel gate was already off.");
  });

  test("disabling Firewall turns the gate off; enabling leaves it off; the clean-up verb empties Cloudflare", async () => {
    const b = box();
    await turnOn(b);
    expect(withdrawPanelGate(b.options)).toBe(true);
    expect(sitesVhost(b)).toBe(CUSTOM_DOMAIN);
    expect(panelVhost(b)).toBe(PANEL);
    expect(readGateState(b.options)).toMatchObject({ on: false, leftover: true });
    expect(keepPanelGateNginx(b.options)).toBeNull();
    expect(panelVhost(b)).toBe(PANEL);
    expect(await cleanUpPanelGate(b.options)).toEqual({ notice: "The Panel gate left nothing in Cloudflare." });
    expect(b.cf.accessApps.size + b.cf.accessPolicies.size + b.cf.originCerts.size + b.cf.originHosts.size).toBe(0);
    expect(readGateState(b.options).leftover).toBeUndefined();
  });
});

describe("review fixes", () => {
  test("turning on again first deletes what an earlier gate left, or refuses while it cannot", async () => {
    const b = box();
    await turnOn(b);
    const old = readGateState(b.options);
    await panelGateOffLocally(b.options);
    // The review alone deletes nothing, so cancelling it leaves everything as it was.
    const writes = b.cf.writes().length;
    const review = await setPanelGate(true, undefined, b.options);
    expect("review" in review && review.review.text).toContain("It first deletes the Access applications and origin-pull certificate an earlier gate left");
    expect(b.cf.writes().length).toBe(writes);
    expect(b.cf.accessApps.has(old.appId)).toBe(true);

    b.cf.failOn = (method, path) => method === "DELETE" && path.includes("/access/apps/");
    await expect(turnOn(b)).rejects.toThrow("Cloudflare still has the Access application or origin-pull certificate of the earlier gate");
    expect(readGateState(b.options)).toMatchObject({ on: false, leftover: true, acmeAppId: old.acmeAppId });
    expect(sitesVhost(b)).toBe(CUSTOM_DOMAIN);

    // The connection that made them was replaced by another reaching the same zone.
    writeFileSync(join(b.dir, "dns", "secrets.json"), JSON.stringify({ cloudflare: { renamed: TOKEN } }), { mode: 0o600 });
    const { reply } = await turnOn(b);
    expect(reply).toMatchObject({ notice: expect.stringContaining("The Panel gate is on") });
    expect(b.cf.accessApps.has(old.appId)).toBe(false);
    expect(b.cf.originCerts.has(old.certId)).toBe(false);
    expect([...b.cf.originCerts.keys()]).toEqual([readGateState(b.options).certId]);
  });

  test("a repair whose Nginx step fails still syncs the Access policy and records the failure", async () => {
    const b = box();
    await turnOn(b);
    writeFileSync(join(b.dir, "panel", "cloudpanel.conf"), PANEL);
    b.failing.add(`nginx -t -c ${join(b.dir, "panel", "nginx.conf")}`);
    const db = new Database(join(b.dir, "panel.db"));
    db.query("INSERT INTO user (user_name, email, role, status) VALUES ('new', 'new@example.com', 'ROLE_ADMIN', 1)").run();
    db.close();
    await expect(repairPanelGate(b.options)).rejects.toThrow("Nginx edits could not be put back");
    const state = readGateState(b.options);
    expect(state.drift[0]).toContain("The gate's Nginx edits could not be put back");
    expect(JSON.stringify(b.cf.accessPolicies.get(state.policyId)!.include)).toContain("new@example.com");
  });

  test("a certificate upload and an app create whose replies were lost are still undone", async () => {
    const b = box();
    b.cf.loseReplyOn = (method, path) => method === "POST" && path.endsWith("/hostnames/certificates");
    await expect(turnOn(b)).rejects.toThrow();
    expect(b.cf.originCerts.size).toBe(0);
    expect(readGateState(b.options).leftover).toBeUndefined();

    b.cf.loseReplyOn = (method, path) => method === "POST" && path.endsWith("/access/apps");
    await expect(turnOn(b)).rejects.toThrow();
    expect(b.cf.accessApps.size).toBe(0);
    expect(b.cf.accessPolicies.size).toBe(0);
    expect(b.cf.originCerts.size).toBe(0);
    expect(b.cf.originHosts.size).toBe(0);
  });

  test("waiting for the deployment asks again after a 5xx, and ends on the clock", async () => {
    const b = box();
    let polls = 0;
    b.cf.failOn = (method, path) => method === "GET" && path.endsWith(`/hostnames/${HOST}`) && polls++ === 0;
    expect((await turnOn(b)).reply).toMatchObject({ notice: expect.stringContaining("is on") });

    const slow = box();
    slow.cf.deployPolls = 1000;
    let clock = 0;
    slow.options.now = () => clock;
    slow.options.sleep = async () => { clock += 60_000; };
    await expect(turnOn(slow)).rejects.toThrow("has not finished deploying");
    expect(slow.cf.calls.filter((call) => call.path.endsWith(`/hostnames/${HOST}`) && call.method === "GET").length).toBeLessThanOrEqual(5);
  });

  test("the turn-off review names no hostname it does not know, and does not promise the deletions", async () => {
    const b = box();
    await turnOn(b);
    const state = readGateState(b.options);
    delete state.hostname;
    writeFileSync(join(b.dir, "state", "panel-gate.json"), JSON.stringify(state), { mode: 0o600 });
    const reply = await setPanelGate(false, undefined, b.options);
    if (!("review" in reply)) throw new Error("expected a review");
    expect(reply.review.text).not.toContain("undefined");
    expect(reply.review.text).toContain("what it cannot delete is retried by repair");
  });

  test("the page's first draw of a gate that is off asks Cloudflare nothing", () => {
    const b = box();
    expect(panelGateSummary(b.options)).toMatchObject({ on: false, hostname: HOST, pending: true });
    expect(b.cf.calls).toEqual([]);
  });
});

test("Setup raises the gate's drift as Action needed, from local state alone, and clears it once repaired", async () => {
  const b = box();
  const gate = FIREWALL_ACTIONS.filter((action) => action.id === "panel-gate");
  const source = { core: [], addons: [{ name: "firewall", title: "Firewall", enabled: true, steps: [], actions: gate }] };
  expect(await actionItems(source, { gate: b.options })).toEqual([]);
  await turnOn(b);
  expect(await actionItems(source, { gate: b.options })).toEqual([]);

  writeFileSync(join(b.dir, "panel", "cloudpanel.conf"), PANEL);
  const calls = b.cf.calls.length;
  const items = await actionItems(source, { gate: b.options });
  expect(b.cf.calls.length).toBe(calls);
  expect(items).toEqual([{
    id: "panel-gate", title: "Panel gate needs attention", href: "/addons/firewall/#panel-gate-card",
    reason: "Port 8443 answers more than loopback; the next repair puts the rule back.", addon: { name: "firewall", title: "Firewall" },
  }]);

  await repairPanelGate(b.options);
  expect(await actionItems(source, { gate: b.options })).toEqual([]);
});

describe("final review fixes", () => {
  test("Let's Encrypt's path gets its own Bypass application, which off deletes and repair checks", async () => {
    const b = box();
    await turnOn(b);
    const state = readGateState(b.options);
    expect(b.cf.accessApps.get(state.acmeAppId)).toMatchObject({
      domain: `${HOST}/.well-known/acme-challenge`, type: "self_hosted", policies: [{ id: state.acmePolicyId, precedence: 1 }],
    });
    expect(b.cf.accessPolicies.get(state.acmePolicyId)).toMatchObject({ decision: "bypass", include: [{ everyone: {} }] });

    b.cf.accessApps.delete(state.acmeAppId);
    await repairPanelGate(b.options);
    expect(readGateState(b.options).drift.join(" ")).toContain(`${HOST}'s certificate cannot renew`);

    const first = await setPanelGate(false, undefined, b.options);
    if (!("review" in first)) throw new Error("expected a review");
    await setPanelGate(false, first.review.digest, b.options);
    expect(b.cf.accessPolicies.size + b.cf.accessApps.size).toBe(0);
  });

  test("a moved custom domain is raised in Setup at once and its proxy is refused by the panel's Host check", async () => {
    const b = box();
    await turnOn(b);
    writeFileSync(join(b.dir, "custom-domain"), "new.example.com\n");
    const gate = FIREWALL_ACTIONS.filter((action) => action.id === "panel-gate");
    const items = await actionItems({ core: [], addons: [{ name: "firewall", title: "Firewall", enabled: true, steps: [], actions: gate }] }, { gate: b.options });
    expect(items[0]!.reason).toContain("new.example.com, which the gate refuses");
    expect(panelVhost(b)).toContain('if ($host !~* "^(?:cp\\.example\\.com|');
    expect(panelVhost(b)).not.toContain("new\\.example\\.com");
  });

  test("a confirmed change waits for the platform's operation lock", async () => {
    const b = box();
    const { acquireFileLock } = await import("../lib/file-lock");
    const held = await acquireFileLock(join(b.dir, "locks", "operation.lock"), 5, () => "busy");
    const first = await setPanelGate(true, undefined, b.options);
    if (!("review" in first)) throw new Error("expected a review");
    let done = false;
    const pending = setPanelGate(true, first.review.digest, b.options).then(() => { done = true; });
    await Bun.sleep(300);
    expect(done).toBe(false);
    held.release();
    await pending;
    expect(readGateState(b.options).on).toBe(true);
  });
});
