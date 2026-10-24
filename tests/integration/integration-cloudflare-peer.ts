// bun tests/integration/integration-cloudflare-peer.ts (requires Docker)
import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOUDFLARE_PEER_BLOCK, cloudflarePeerGeo } from "../../addons/cloudflare-ips/cloudflare-peer";

const dir = mkdtempSync(join(tmpdir(), "clp-peer-nginx-"));
try {
  chmodSync(dir, 0o755);
  // Loopback addresses stand in for Cloudflare inside an isolated network.
  writeFileSync(join(dir, "geo.conf"), cloudflarePeerGeo(["127.0.0.2/32", "::1/128"]));
  const stock = "allow 127.0.0.2;\nallow ::1;\ndeny all;\n";
  writeFileSync(join(dir, "ips"), CLOUDFLARE_PEER_BLOCK + stock);
  writeFileSync(join(dir, "stock"), stock);
  writeFileSync(join(dir, "index.html"), "served\n", { mode: 0o644 });
  writeFileSync(join(dir, "nginx.conf"), `pid /tmp/clp-peer.pid;
events {}
http {
  access_log off;
  set_real_ip_from 0.0.0.0/0;
  set_real_ip_from ::/0;
  real_ip_header X-Real-IP;
  real_ip_recursive on;
  include /probe/geo.conf;
  server {
    listen 127.0.0.1:8080;
    listen [::1]:8080;
    include /probe/ips;
    location / { proxy_pass http://127.0.0.1:8081; proxy_set_header X-Real-IP $remote_addr; }
    location /.well-known/ { allow all; root /probe; try_files /index.html =404; }
    location /maintenance { return 503; }
  }
  server { listen 127.0.0.1:8081; root /probe; location / { try_files /index.html =404; } }
  server { listen 127.0.0.1:8082; root /probe; location / { try_files /index.html =404; } }
  server { listen 127.0.0.1:8083; include /probe/stock; root /probe; location / { try_files /index.html =404; } }
}
`);
  const result = Bun.spawnSync(["docker", "run", "--rm", "--network", "none", "--mount", `type=bind,source=${dir},target=/probe,readonly`,
    "--entrypoint", "sh", "nginx:stable", "-c", `set -eu
nginx -t -c /probe/nginx.conf
nginx -c /probe/nginx.conf
check() {
  expected="$1"; shift
  result=$(curl --noproxy '*' --max-time 5 -s -o /dev/null -w '%{http_code}' "$@")
  test "$result" = "$expected" || { echo "expected $expected, received $result: $*"; exit 1; }
}
check 200 --interface 127.0.0.1 -H 'X-Real-IP: 127.0.0.2' http://127.0.0.1:8083/
check 403 --interface 127.0.0.1 http://127.0.0.1:8080/
check 403 --interface 127.0.0.1 -H 'X-Real-IP: 127.0.0.2' http://127.0.0.1:8080/
check 403 --interface 127.0.0.1 -H 'X-Real-IP: ::1' -H 'CF-Connecting-IP: ::1' -H 'X-Forwarded-For: ::1' http://127.0.0.1:8080/
check 403 --interface 127.0.0.1 -H 'X-Real-IP: 127.0.0.2' http://127.0.0.1:8080/maintenance
check 403 --interface 127.0.0.1 -H 'X-Real-IP: 127.0.0.2' http://127.0.0.1:8080/.well-known/acme-challenge/probe
check 200 --interface 127.0.0.2 -H 'CF-Connecting-IP: 192.0.2.1' http://127.0.0.1:8080/
check 200 --interface ::1 'http://[::1]:8080/'
check 200 --interface 127.0.0.1 -H 'X-Real-IP: 192.0.2.1' http://127.0.0.1:8082/
echo 'Cloudflare peer integration passed: original bypass reproduced; spoofing blocked; trusted IPv4/IPv6, backend and unrestricted sites served.'
`], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  assert.equal(result.exitCode, 0, result.stdout.toString() + result.stderr.toString());
  process.stdout.write(result.stdout);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
