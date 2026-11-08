// bun tests/integration/integration-visitor-ip.ts (requires Docker)
import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyVisitorIp } from "../../addons/system-tweaks/visitor-ip";

// 127.0.0.2 stands in for Cloudflare, 127.0.0.1 for cloudflared on this server
// and 127.0.0.3 for any other client. The http block is CloudPanel's, with its
// trust in every address already commented out by Block forged visitor IPs.
const http = `    real_ip_recursive on;
    set_real_ip_from 127.0.0.1;
    set_real_ip_from 10.0.0.0/8;
    #clp-addons:untrusted set_real_ip_from 0.0.0.0/0;
    #real_ip_header X-Forwarded-For;

    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent" "$http_x_forwarded_for"';

    log_format cloudflare '$http_cf_connecting_ip - $remote_user [$time_local] "$request" '
                          '$status $body_bytes_sent "$http_referer" '
                          '"$http_user_agent" "$http_x_forwarded_for"';
`;

const dir = mkdtempSync(join(tmpdir(), "clp-visitor-ip-nginx-"));
try {
  chmodSync(dir, 0o755);
  const paths = {
    nginxConf: join(dir, "http.conf"), fastcgiParams: join(dir, "fastcgi_params"), maps: join(dir, "maps.conf"),
    cloudflareIps: join(dir, "ips"), rootUid: process.getuid!(),
  };
  writeFileSync(paths.nginxConf, http, { mode: 0o644 });
  writeFileSync(paths.fastcgiParams, "fastcgi_param\tREMOTE_ADDR\t\t$remote_addr;\nfastcgi_param\tREMOTE_PORT\t\t$remote_port;\n", { mode: 0o644 });
  writeFileSync(paths.cloudflareIps, "allow 127.0.0.2;\ndeny all;\n");
  applyVisitorIp(true, { paths, run: () => ({ ok: true, stdout: "", stderr: "" }) });
  assert.match(readFileSync(paths.nginxConf, "utf8"), /log_format main '\$clp_visitor_ip - /);
  assert.match(readFileSync(paths.nginxConf, "utf8"), /log_format cloudflare '\$clp_visitor_ip - /);
  assert.match(readFileSync(paths.fastcgiParams, "utf8"), /REMOTE_ADDR\t\t\$clp_visitor_ip;/);
  for (const file of [paths.nginxConf, paths.fastcgiParams, paths.maps]) chmodSync(file, 0o644);

  // A front server on 80 that proxies to a backend on 8080 as CloudPanel's
  // templates do; the backend answers what PHP would get as REMOTE_ADDR.
  writeFileSync(join(dir, "nginx.conf"), `pid /tmp/nginx.pid;
events {}
http {
include /probe/http.conf;
include /probe/maps.conf;
server {
  listen 80;
  access_log /tmp/access.log cloudflare;
  location = /front { return 200 "$clp_visitor_ip"; }
  location / {
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_pass http://127.0.0.1:8080;
  }
}
server {
  listen 8080;
  access_log off;
  location / {
    include /probe/fastcgi_params;
    return 200 "$clp_visitor_ip";
  }
}
}
`);
  const result = Bun.spawnSync(["docker", "run", "--rm", "--network", "none", "--mount", `type=bind,source=${dir},target=/probe,readonly`,
    "--entrypoint", "sh", "nginx:stable", "-c", `set -eu
check() {
  expected="$1"; shift
  result=$(curl --noproxy '*' --max-time 5 -s "$@")
  test "$result" = "$expected" || { echo "expected $expected, received $result: $*"; exit 1; }
}
both() {
  expected="$1"; shift
  check "$expected" "$@" http://127.0.0.1/front
  check "$expected" "$@" http://127.0.0.1/php
}
nginx -t -c /probe/nginx.conf
nginx -c /probe/nginx.conf
both 192.0.2.1 --interface 127.0.0.2 -H 'CF-Connecting-IP: 192.0.2.1'
both 192.0.2.1 --interface 127.0.0.1 -H 'CF-Connecting-IP: 192.0.2.1'
both 2001:db8::1 --interface 127.0.0.1 -H 'CF-Connecting-IP: 2001:db8::1'
both 127.0.0.1 --interface 127.0.0.1
both 127.0.0.2 --interface 127.0.0.2 -H 'CF-Connecting-IP: 192.0.2.1 x'
both 127.0.0.3 --interface 127.0.0.3 -H 'CF-Connecting-IP: 192.0.2.1'
both 127.0.0.3 --interface 127.0.0.3 -H 'CF-Connecting-IP: 192.0.2.1' -H 'X-Real-IP: 127.0.0.2'
check 127.0.0.3 --interface 127.0.0.3 -H 'CF-Connecting-IP: 192.0.2.1' -H 'X-Real-IP: 127.0.0.2' http://127.0.0.1:8080/
grep -q '^192.0.2.1 - ' /tmp/access.log
if grep -v '^192.0.2.1 \\|^2001:db8::1 \\|^127.0.0.[123] ' /tmp/access.log; then exit 1; fi
echo 'Visitor-IP integration passed: Cloudflare and a tunnel on this server name the visitor in the log and to PHP; anyone else, or a malformed header, keeps the connecting address.'
`], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  assert.equal(result.exitCode, 0, result.stdout.toString() + result.stderr.toString());
  process.stdout.write(result.stdout);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
