// bun tests/integration/integration-panel-gate.ts (requires Docker)
import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withPanelGate, withSitesGate } from "../../addons/firewall/panel-gate-nginx";

// The sites' Nginx with CloudPanel's default server, another site and the
// custom domain, and the panel's Nginx trusting X-Forwarded-For from loopback,
// both as CloudPanel writes them. 127.0.0.3 stands in for any remote client.
const sites = (customDomain: string) => `pid /tmp/sites.pid;
events {}
http {
  access_log off;
  server { listen 443 ssl default_server; http2 on; ssl_reject_handshake on; return 444; }
  server {
    listen 443 ssl; http2 on;
    server_name other.example.com;
    ssl_certificate /probe/server.crt; ssl_certificate_key /probe/server.key;
    location / { return 200 "other site\\n"; }
  }
${customDomain}
}
`;

const CUSTOM_DOMAIN = `server {
  listen 80;
  listen 443 ssl; http2 on;
  ssl_certificate_key /probe/server.key;
  ssl_certificate /probe/server.crt;
  server_name cp.example.com;

  if ($scheme != "https") {
    rewrite ^ https://$host$uri permanent;
  }

  location / {
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_pass https://127.0.0.1:8443/;
 }
}`;

const panelConf = (vhost: string) => `pid /tmp/panel.pid;
events {}
http {
  access_log off;
  real_ip_header X-Forwarded-For;
  real_ip_recursive on;
  set_real_ip_from 127.0.0.1;
${vhost}
}
`;

const PANEL = `server {
  server_name _;
  listen 8443 ssl; http2 on;
  ssl_certificate_key /probe/server.key;
  ssl_certificate /probe/server.crt;
  location / { return 200 "panel for $remote_addr\\n"; }
  if (-f $request_filename) {
    break;
  }
}
`;

const openssl = (dir: string, args: string[]): string => {
  const result = Bun.spawnSync(["openssl", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  assert.equal(result.exitCode, 0, result.stderr.toString());
  return result.stdout.toString();
};

const dir = mkdtempSync(join(tmpdir(), "clp-panel-gate-nginx-"));
try {
  chmodSync(dir, 0o755);
  openssl(dir, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.crt", "-days", "2", "-subj", "/CN=cp.example.com",
    "-addext", "subjectAltName=DNS:cp.example.com,DNS:other.example.com"]);
  // The origin-pull pair, made as the gate makes it.
  writeFileSync(join(dir, "client.key"), openssl(dir, ["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048"]));
  writeFileSync(join(dir, "client.crt"), openssl(dir, ["req", "-x509", "-new", "-key", "client.key", "-days", "3650", "-subj", "/CN=clp-addons panel gate",
    "-addext", "basicConstraints=critical,CA:FALSE", "-addext", "keyUsage=critical,digitalSignature", "-addext", "extendedKeyUsage=clientAuth"]));
  // Another self-signed client certificate, as anyone else's zone would present.
  writeFileSync(join(dir, "stranger.key"), openssl(dir, ["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048"]));
  writeFileSync(join(dir, "stranger.crt"), openssl(dir, ["req", "-x509", "-new", "-key", "stranger.key", "-days", "3650", "-subj", "/CN=clp-addons panel gate"]));
  for (const file of ["server.key", "client.key", "stranger.key"]) chmodSync(join(dir, file), 0o644);
  const gated = withSitesGate(CUSTOM_DOMAIN, "cp.example.com", "/probe/client.crt");
  const panel = withPanelGate(PANEL);
  assert.ok(gated && panel);
  writeFileSync(join(dir, "sites.conf"), sites(gated));
  writeFileSync(join(dir, "panel.conf"), panelConf(panel));
  assert.ok(readFileSync(join(dir, "panel.conf"), "utf8").includes("$realip_remote_addr"));

  const result = Bun.spawnSync(["docker", "run", "--rm", "--network", "none", "--mount", `type=bind,source=${dir},target=/probe,readonly`,
    "--entrypoint", "sh", "nginx:stable", "-c", `set -eu
check() {
  expected="$1"; shift
  result=$(curl --noproxy '*' --max-time 5 -sk "$@" || true)
  test "$result" = "$expected" || { echo "expected '$expected', received '$result': $*"; exit 1; }
}
nginx -t -c /probe/sites.conf && nginx -c /probe/sites.conf
nginx -t -c /probe/panel.conf && nginx -c /probe/panel.conf
cp="--resolve cp.example.com:443:127.0.0.1"
check 'panel for 127.0.0.3' --interface 127.0.0.3 $cp --cert /probe/client.crt --key /probe/client.key https://cp.example.com/
check 'panel for 127.0.0.3' --http2 --interface 127.0.0.3 $cp --cert /probe/client.crt --key /probe/client.key https://cp.example.com/
check 400 -o /dev/null -w '%{http_code}' --interface 127.0.0.3 $cp https://cp.example.com/
check 400 -o /dev/null -w '%{http_code}' --interface 127.0.0.3 $cp --cert /probe/stranger.crt --key /probe/stranger.key https://cp.example.com/
check 421 -o /dev/null -w '%{http_code}' --interface 127.0.0.3 --resolve other.example.com:443:127.0.0.1 -H 'Host: cp.example.com' https://other.example.com/
check 421 -o /dev/null -w '%{http_code}' --http2 --interface 127.0.0.3 --resolve other.example.com:443:127.0.0.1 -H 'Host: cp.example.com' https://other.example.com/
check 000 -o /dev/null -w '%{http_code}' --interface 127.0.0.3 -H 'Host: cp.example.com' https://127.0.0.1/
check 301 -o /dev/null -w '%{http_code}' --interface 127.0.0.3 -H 'Host: cp.example.com' http://127.0.0.1/
check 000 -o /dev/null -w '%{http_code}' --interface 127.0.0.3 https://127.0.0.2:8443/
check 000 -o /dev/null -w '%{http_code}' --interface 127.0.0.3 -H 'X-Forwarded-For: 127.0.0.1' https://127.0.0.2:8443/
check 'panel for 127.0.0.1' --interface 127.0.0.1 https://127.0.0.1:8443/
echo 'Panel gate integration passed: the custom domain needs the origin-pull certificate, another SNI gets 421, port 8443 answers loopback only and proxied visitors keep their address.'
`], { stdout: "pipe", stderr: "pipe", timeout: 90_000 });
  assert.equal(result.exitCode, 0, result.stdout.toString() + result.stderr.toString());
  process.stdout.write(result.stdout);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
