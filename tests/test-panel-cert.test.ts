import { afterEach, expect, test } from "bun:test";
import { X509Certificate, createPrivateKey } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, type CommandResult } from "../lib/command";
import { panelCertStatus, replacePanelCert, type PanelCertOptions } from "../addons/system-tweaks/panel-cert";
import { panelCertLine } from "../addons/system-tweaks/app/views";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const VHOST = (cert: string, key: string) => `server {
  server_name _;
  listen 8443 ssl http2;
  ssl_certificate_key ${key};
  ssl_certificate ${cert};
  # ssl_certificate /commented/out.crt;
}
`;

/** A self-signed pair made the way CloudPanel's shared one is shaped. */
function pair(dir: string, name: string, days = 365): { cert: string; key: string; fingerprint: string } {
  const key = join(dir, `${name}.key`);
  const cert = join(dir, `${name}.crt`);
  const made = runCommand("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-days", String(days), "-subj", `/CN=${name}`, "-keyout", key, "-out", cert]);
  if (!made.ok) throw new Error(made.stderr);
  const pem = { cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") };
  rmSync(key);
  rmSync(cert);
  return { ...pem, fingerprint: new X509Certificate(pem.cert).fingerprint256 };
}

interface Box {
  options: PanelCertOptions;
  dir: string;
  cert: string;
  key: string;
  vhost: string;
  storedCert: string;
  shared: { cert: string; key: string; fingerprint: string };
  commands: string[];
  /** Make the panel's `nginx -t` fail. */
  reject: boolean;
}

function box(now = new Date()): Box {
  const dir = mkdtempSync(join(tmpdir(), "clp-panel-cert-"));
  dirs.push(dir);
  const uid = process.getuid!();
  const shared = pair(dir, "cloudpanel.clp");
  mkdirSync(join(dir, "ssl-certificates"));
  const cert = join(dir, "ssl-certificates", "cert.crt");
  const key = join(dir, "ssl-certificates", "private.key");
  writeFileSync(cert, shared.cert, { mode: 0o770 });
  writeFileSync(key, shared.key, { mode: 0o770 });
  const vhost = join(dir, "cloudpanel.conf");
  writeFileSync(vhost, VHOST(cert, key), { mode: 0o770 });
  // CloudPanel's mode, whatever the umask.
  for (const file of [cert, key, vhost]) chmodSync(file, 0o770);
  const b: Box = {
    dir, cert, key, vhost, shared, commands: [], reject: false,
    storedCert: join(dir, "state", "panel-cert.crt"),
    options: {} as PanelCertOptions,
  };
  // Nginx is faked; like the real one, its test refuses a key that is not the certificate's.
  const run = (command: string, args: string[]): CommandResult => {
    if (command === "openssl") return runCommand(command, args);
    b.commands.push(`${command} ${args.join(" ")}`);
    if (command === "nginx") {
      const matches = new X509Certificate(readFileSync(cert, "utf8")).checkPrivateKey(createPrivateKey(readFileSync(key, "utf8")));
      return b.reject || !matches ? { ok: false, stdout: "", stderr: "nginx: [emerg] rejected" } : { ok: true, stdout: "", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };
  b.options = {
    run, now: () => now, hostname: () => "Panel.Example.com", addresses: () => ["203.0.113.10", "2001:db8::10"],
    sharedFingerprint: shared.fingerprint,
    paths: {
      vhost, panelConf: join(dir, "nginx.conf"), cert, key, storedCert: b.storedCert, storedKey: join(dir, "state", "panel-cert.key"),
      customDomain: join(dir, "clp_custom_domain"), customDomainVhost: join(dir, "custom-domain.conf"), panelUid: uid, rootUid: uid,
    },
  };
  return b;
}

test("the shared certificate is replaced by one made on the box, validated and reloaded", () => {
  const b = box();
  expect(panelCertStatus(b.options)).toMatchObject({ kind: "shared", subject: "CN=cloudpanel.clp" });
  expect(replacePanelCert(b.options)).toBe("panel's shared certificate replaced");
  expect(b.commands).toEqual([`nginx -t -c ${join(b.dir, "nginx.conf")}`, "systemctl reload clp-nginx"]);
  const served = new X509Certificate(readFileSync(b.cert, "utf8"));
  expect(served.subject).toBe("CN=panel.example.com");
  expect(served.subjectAltName).toBe("DNS:panel.example.com, IP Address:203.0.113.10, IP Address:2001:DB8:0:0:0:0:0:10");
  expect(served.checkPrivateKey(createPrivateKey(readFileSync(b.key, "utf8")))).toBe(true);
  expect(readFileSync(b.storedCert, "utf8")).toBe(readFileSync(b.cert, "utf8"));
  expect(statSync(b.key).mode & 0o777).toBe(0o770);
  expect(statSync(b.storedCert).mode & 0o777).toBe(0o600);
  const status = panelCertStatus(b.options);
  expect(status).toMatchObject({ kind: "generated", fingerprint: served.fingerprint256, names: ["panel.example.com", "203.0.113.10", "2001:DB8:0:0:0:0:0:10"] });
  expect(Date.parse(status.expires!) - Date.now()).toBeGreaterThan(799 * 86_400_000);

  b.commands.length = 0;
  expect(replacePanelCert(b.options)).toBeNull();
  expect(b.commands).toEqual([]);
});

test("a CloudPanel update that puts the shared certificate back gets the same generated one again", () => {
  const b = box();
  replacePanelCert(b.options);
  const generated = readFileSync(b.cert, "utf8");
  writeFileSync(b.cert, b.shared.cert);
  writeFileSync(b.key, b.shared.key);
  expect(replacePanelCert(b.options)).toBe("panel's shared certificate replaced");
  expect(readFileSync(b.cert, "utf8")).toBe(generated);
  expect(panelCertStatus(b.options).kind).toBe("generated");
});

test("a certificate the panel already has of its own is left alone", () => {
  const b = box();
  const own = pair(b.dir, "panel.example.net");
  writeFileSync(b.cert, own.cert);
  writeFileSync(b.key, own.key);
  expect(panelCertStatus(b.options)).toMatchObject({ kind: "own", subject: "CN=panel.example.net", fingerprint: own.fingerprint });
  expect(replacePanelCert(b.options)).toBeNull();
  expect(readFileSync(b.cert, "utf8")).toBe(own.cert);
  expect(b.commands).toEqual([]);

  // So is a server block that names other files, whatever the stock ones hold.
  writeFileSync(b.cert, b.shared.cert);
  writeFileSync(b.vhost, VHOST("/etc/ssl/panel.crt", "/etc/ssl/panel.key"));
  expect(panelCertStatus(b.options).kind).toBe("own");
  expect(replacePanelCert(b.options)).toBeNull();
  expect(readFileSync(b.cert, "utf8")).toBe(b.shared.cert);
});

test("a pair Nginx rejects is rolled back and not kept", () => {
  const b = box();
  b.reject = true;
  expect(() => replacePanelCert(b.options)).toThrow("Nginx validation failed");
  expect(readFileSync(b.cert, "utf8")).toBe(b.shared.cert);
  expect(readFileSync(b.key, "utf8")).toBe(b.shared.key);
  expect(existsSync(b.storedCert)).toBe(false);
  expect(b.commands).toEqual([`nginx -t -c ${join(b.dir, "nginx.conf")}`, `nginx -t -c ${join(b.dir, "nginx.conf")}`]);
});

test("a generated certificate is renewed within 30 days of expiring; no panel config is nothing to do", () => {
  const b = box();
  replacePanelCert(b.options);
  const first = panelCertStatus(b.options);
  const late = { ...b.options, now: () => new Date(Date.parse(first.expires!) - 10 * 86_400_000) };
  expect(replacePanelCert(late)).toBe("panel certificate renewed");
  const renewed = panelCertStatus(late);
  expect(renewed.kind).toBe("generated");
  expect(renewed.fingerprint).not.toBe(first.fingerprint);

  rmSync(b.vhost);
  expect(panelCertStatus(b.options).kind).toBe("unknown");
  expect(replacePanelCert(b.options)).toBeNull();
});

test("the page names the certificate and a custom domain", () => {
  const b = box();
  writeFileSync(join(b.dir, "custom-domain.conf"), "server {}\n");
  writeFileSync(join(b.dir, "clp_custom_domain"), "cp.example.com");
  const shared = panelCertLine({ ...panelCertStatus(b.options), replace: true });
  expect(shared).toContain("Shared");
  expect(shared).toContain("whose private key is public. Run clp-addons repair.");
  expect(shared).toContain("Your custom domain cp.example.com serves its own certificate on port 443");
  replacePanelCert(b.options);
  const generated = panelCertLine({ ...panelCertStatus(b.options), replace: true });
  expect(generated).toContain("made on this server for panel.example.com, 203.0.113.10, 2001:DB8:0:0:0:0:0:10.");
  expect(generated).toContain("SHA-256 ");
  expect(panelCertLine({ kind: "own", subject: "CN=panel.example.net", replace: true })).toContain("its own certificate, CN=panel.example.net.");
});

test("a symlink in place of the panel's certificate is refused, not followed", () => {
  const b = box();
  const elsewhere = join(b.dir, "elsewhere.crt");
  writeFileSync(elsewhere, b.shared.cert);
  rmSync(b.cert);
  symlinkSync(elsewhere, b.cert);
  expect(panelCertStatus(b.options)).toMatchObject({ kind: "unknown", problem: `${b.cert} is a symlink` });
  expect(() => replacePanelCert(b.options)).toThrow("is a symlink");
  expect(readFileSync(elsewhere, "utf8")).toBe(b.shared.cert);
});

test("files the package left root's are replaced and stay root's", () => {
  const b = box();
  // The fixture's own uid stands in for root; the panel account is another.
  b.options.paths!.panelUid = process.getuid!() + 1;
  expect(replacePanelCert(b.options)).toBe("panel's shared certificate replaced");
  expect(statSync(b.key).uid).toBe(process.getuid!());
  expect(panelCertStatus(b.options).kind).toBe("generated");
});
