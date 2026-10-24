// bun tests/integration/integration-real-ip.ts (requires Docker)
import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withoutAnyAddress } from "../../addons/system-tweaks/real-ip";

// CloudPanel trusts 127.0.0.1 alone, so 127.0.0.2 stands in for Cloudflare and
// 127.0.0.3 for any other client inside an isolated network.
const conf = (http: string, port: number, pid: string) => `pid /tmp/${pid}.pid;
events {}
http {
  access_log off;
${http}
  server {
    listen 127.0.0.1:${port};
    allow 127.0.0.2;
    deny all;
    root /probe;
    location / { try_files /index.html =404; }
  }
  server { listen 127.0.0.1:${port + 1}; location / { return 200 "$remote_addr\\n"; } }
}
`;
const cloudpanel = `    real_ip_recursive on;

    set_real_ip_from 127.0.0.1;
    set_real_ip_from 10.0.0.0/8;
    set_real_ip_from 172.16.0.0/12;
    set_real_ip_from 192.168.0.0/16;
    set_real_ip_from 0.0.0.0/0;
    #real_ip_header X-Forwarded-For;
`;

const panel = cloudpanel.replace("#real_ip_header X-Forwarded-For;", "real_ip_header X-Forwarded-For;");

const dir = mkdtempSync(join(tmpdir(), "clp-real-ip-nginx-"));
try {
  chmodSync(dir, 0o755);
  writeFileSync(join(dir, "index.html"), "served\n", { mode: 0o644 });
  writeFileSync(join(dir, "stock.conf"), conf(cloudpanel, 8080, "stock"));
  writeFileSync(join(dir, "blocked.conf"), conf(withoutAnyAddress(cloudpanel), 8090, "blocked"));
  // The panel's own Nginx reads X-Forwarded-For, and trusts Cloudflare too.
  writeFileSync(join(dir, "panel.conf"), conf(withoutAnyAddress(panel, ["127.0.0.2"]), 8100, "panel"));
  const result = Bun.spawnSync(["docker", "run", "--rm", "--network", "none", "--mount", `type=bind,source=${dir},target=/probe,readonly`,
    "--entrypoint", "sh", "nginx:stable", "-c", `set -eu
check() {
  expected="$1"; shift
  result=$(curl --noproxy '*' --max-time 5 -s "$@")
  test "$result" = "$expected" || { echo "expected $expected, received $result: $*"; exit 1; }
}
nginx -t -c /probe/stock.conf
nginx -c /probe/stock.conf
check served --interface 127.0.0.3 -H 'X-Real-IP: 127.0.0.2' http://127.0.0.1:8080/
check 192.0.2.1 --interface 127.0.0.3 -H 'X-Real-IP: 192.0.2.1' http://127.0.0.1:8081/
nginx -t -c /probe/blocked.conf
nginx -c /probe/blocked.conf
check 403 -o /dev/null -w '%{http_code}' --interface 127.0.0.3 -H 'X-Real-IP: 127.0.0.2' http://127.0.0.1:8090/
check served --interface 127.0.0.2 -H 'CF-Connecting-IP: 192.0.2.1' http://127.0.0.1:8090/
check 127.0.0.3 --interface 127.0.0.3 -H 'X-Real-IP: 192.0.2.1' http://127.0.0.1:8091/
check 192.0.2.1 --interface 127.0.0.1 -H 'X-Real-IP: 192.0.2.1' http://127.0.0.1:8091/
nginx -t -c /probe/panel.conf
nginx -c /probe/panel.conf
check 127.0.0.3 --interface 127.0.0.3 -H 'X-Forwarded-For: 192.0.2.1' http://127.0.0.1:8101/
check 192.0.2.1 --interface 127.0.0.2 -H 'X-Forwarded-For: 192.0.2.1' http://127.0.0.1:8101/
check 192.0.2.1 --interface 127.0.0.2 -H 'X-Forwarded-For: 198.51.100.7, 192.0.2.1' http://127.0.0.1:8101/
check 192.0.2.1 --interface 127.0.0.1 -H 'X-Forwarded-For: 192.0.2.1' http://127.0.0.1:8101/
echo 'Real-IP integration passed: forged header reproduced on the stock config; blocked after the edit; Cloudflare peers and loopback proxies unaffected; the panel takes the visitor Cloudflare appended, not a forged one.'
`], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  assert.equal(result.exitCode, 0, result.stdout.toString() + result.stderr.toString());
  process.stdout.write(result.stdout);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
