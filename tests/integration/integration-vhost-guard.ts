// bun tests/integration/integration-vhost-guard.ts (requires Docker)
//
// Runs System Tweaks' vhost guard in PHP's own web server as the prepend file,
// on the oldest and newest PHP the panel can run on, with session files in
// Symfony's format and CloudPanel's user table, and sends it the requests
// CloudPanel's forms send.
import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import VALUES from "../fixtures/vhost-guard-values.json";

interface Case {
  name: string;
  /** Request parts: `body=`, `query=` or `cookie=`, each already encoded. */
  args: string[];
  refused: boolean;
}

const pair = (key: string, value: string) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
const form = (name: string, fields: Record<string, string>) =>
  [`body=${Object.entries(fields).map(([field, value]) => pair(`${name}[${field}]`, value)).join("&")}`];
const raw = (key: string, value: string) => [`body=${pair(key, value)}`];
const query = (key: string, value: string) => [`query=${pair(key, value)}`];
const as = (session: string) => [`cookie=cloudpanel=${encodeURIComponent(session)}`];

// The table tests/test-vhost-values.test.ts holds the stored-value check to.
const SHARED: Record<string, [string, string]> = {
  rootDirectory: ["site_domain_settings", "rootDirectory"], botName: ["site_blocked_bot", "name"],
  blockedIp: ["site_blocked_ip", "ip"], allowedIps: ["site_basic_auth", "whitelistedIps"],
  additionalConfiguration: ["site_php_settings", "additionalConfiguration"], varnishServer: ["site_varnish_cache_settings", "server"],
  reverseProxyUrl: ["site_reverse_proxy_settings", "reverseProxyUrl"], port: ["site_nodejs_settings", "port"],
};
const shared = (Object.entries(VALUES) as [string, [string, boolean][]][]).flatMap(([rule, cases]) => cases.map(([value, accepted], at): Case => ({
  name: `shared ${rule} #${at + 1}`, args: form(SHARED[rule]![0], { [SHARED[rule]![1]]: value }), refused: !accepted,
})));

const CASES: Case[] = [
  ...shared,
  { name: "a plain page", args: [], refused: false },
  { name: "a normal root directory", args: form("site_domain_settings", { rootDirectory: "example.com/public" }), refused: false },
  { name: "a root directory with a trailing slash", args: form("site_domain_settings", { rootDirectory: "example.com/" }), refused: false },
  { name: "the advisory's root directory", args: form("site_domain_settings", { rootDirectory: "x;\n  location /dav/ { dav_methods PUT; alias /tmp/; }\n#" }), refused: true },
  { name: "a root directory on one line", args: form("site_domain_settings", { rootDirectory: "x;location/{}" }), refused: true },
  { name: "an empty root directory", args: form("site_domain_settings", { rootDirectory: "" }), refused: false },
  { name: "a root directory with accented letters", args: form("site_domain_settings", { rootDirectory: "café/public" }), refused: false },
  { name: "a root directory that climbs out", args: form("site_domain_settings", { rootDirectory: "../../../etc" }), refused: true },
  { name: "a root directory with a space", args: form("site_domain_settings", { rootDirectory: "a b" }), refused: true },
  { name: "a root directory sent as a list", args: raw("site_domain_settings[rootDirectory][]", "x"), refused: true },
  { name: "a malformed domain settings form", args: raw("site_domain_settings", "x"), refused: true },
  { name: "a bot name", args: form("site_blocked_bot", { name: "AhrefsBot" }), refused: false },
  { name: "a bot name with a newline", args: form("site_blocked_bot", { name: "a))\n{return 200;}\nif ($a ~ (b" }), refused: true },
  { name: "a bot name nginx cannot compile", args: form("site_blocked_bot", { name: "+bot" }), refused: true },
  { name: "a blocked range", args: form("site_blocked_ip", { ip: "192.0.2.0/24" }), refused: false },
  { name: "a blocked IPv6 range", args: form("site_blocked_ip", { ip: "2001:db8::/32" }), refused: false },
  { name: "a blocked range with a third part", args: form("site_blocked_ip", { ip: "192.0.2.1/24/\")" }), refused: true },
  { name: "basic auth allowlist", args: form("site_basic_auth", { whitelistedIps: "192.0.2.1,198.51.100.0/24", userName: "a", password: "p;\"{" }), refused: false },
  { name: "basic auth allowlist with spaces", args: form("site_basic_auth", { whitelistedIps: "192.0.2.1, 198.51.100.0/24" }), refused: false },
  { name: "basic auth with no allowlist", args: form("site_basic_auth", { whitelistedIps: "" }), refused: false },
  { name: "basic auth with a directive in the netmask", args: form("site_basic_auth", { whitelistedIps: "192.0.2.1/x; allow all" }), refused: true },
  { name: "additional PHP settings", args: form("site_php_settings", { additionalConfiguration: "date.timezone=UTC;\ndisplay_errors=off;" }), refused: false },
  { name: "additional PHP settings that close the quote", args: form("site_php_settings", { additionalConfiguration: "a=b\";\n}\nserver {" }), refused: true },
  { name: "additional PHP settings naming an nginx variable", args: form("site_php_settings", { additionalConfiguration: "a=$undefined_var" }), refused: true },
  { name: "a Varnish server", args: form("site_varnish_cache_settings", { server: "127.0.0.1:6081" }), refused: false },
  { name: "a Varnish server with a directive", args: form("site_varnish_cache_settings", { server: "127.0.0.1;\nalias /" }), refused: true },
  { name: "a reverse proxy URL", args: form("site_reverse_proxy_settings", { reverseProxyUrl: "http://127.0.0.1:8080/app?x=1&y=2" }), refused: false },
  { name: "a new site's reverse proxy URL with a directive", args: form("site_new_reverse_proxy", { reverseProxyUrl: "http://127.0.0.1:8080; alias /;" }), refused: true },
  { name: "a Node.js port", args: form("site_nodejs_settings", { port: "3000" }), refused: false },
  { name: "a Python port with a directive", args: form("site_new_python", { port: "8000;" }), refused: true },
  { name: "an unrelated form with quotes", args: form("site_cron_job", { command: "echo \"a;b\" {x}" }), refused: false },
  { name: "the Vhost editor without a session", args: raw("vhost-template", "server {}"), refused: true },
  { name: "the Vhost editor from the query string", args: [...query("vhost-template", "server {}"), ...as("admin1")], refused: false },
  { name: "the Vhost editor as an administrator", args: [...raw("vhost-template", "server {}"), ...as("admin1")], refused: false },
  { name: "the Vhost editor as a site manager", args: [...raw("vhost-template", "server {}"), ...as("manager1")], refused: true },
  { name: "the Vhost editor as a user", args: [...raw("vhost-template", "server {}"), ...as("user1")], refused: true },
  { name: "the Vhost editor from the query string as a user", args: [...query("vhost-template", "server {}"), ...as("user1")], refused: true },
  { name: "the Vhost editor as an administrator still owing a TOTP code", args: [...raw("vhost-template", "server {}"), ...as("pending1")], refused: true },
  { name: "the Vhost editor as an administrator past the TOTP step", args: [...raw("vhost-template", "server {}"), ...as("verified1")], refused: false },
  { name: "the Vhost editor as a disabled administrator", args: [...raw("vhost-template", "server {}"), ...as("disabled1")], refused: true },
  { name: "the Vhost editor as a user posing as an administrator", args: [...raw("vhost-template", "server {}"), ...as("forged1")], refused: true },
  { name: "the Vhost editor with a session that does not exist", args: [...raw("vhost-template", "server {}"), ...as("missing1")], refused: true },
  { name: "the Vhost editor with a session id that climbs out", args: [...raw("vhost-template", "server {}"), ...as("../../x")], refused: true },
  { name: "the Vhost editor bringing back the Varnish placeholder as an administrator", args: [...raw("vhost-template", "location / { {{varnish_proxy_pass}} }"), ...as("admin1")], refused: true },
  { name: "the Vhost editor bringing back the Varnish placeholder in the query", args: [...query("vhost-template", "{{varnish_proxy_pass}}"), ...as("admin1")], refused: true },
  { name: "the Vhost editor bringing back the access log placeholder as an administrator", args: [...raw("vhost-template", "server { {{nginx_access_log}} }"), ...as("admin1")], refused: true },
  { name: "the Vhost editor bringing back the error log placeholder as an administrator", args: [...raw("vhost-template", "server { {{nginx_error_log}} }"), ...as("admin1")], refused: true },
  { name: "the Vhost editor pointing access_log under /home as an administrator", args: [...raw("vhost-template", "server {\n  access_log /home/shop/logs/nginx/access.log main;\n}"), ...as("admin1")], refused: true },
  { name: "the Vhost editor pointing error_log at //home as an administrator", args: [...raw("vhost-template", "server {\n  error_log //home/shop/logs/nginx/error.log;\n}"), ...as("admin1")], refused: true },
  { name: "the Vhost editor climbing into /home with .. in access_log as an administrator", args: [...raw("vhost-template", "server {\n  access_log /var/../home/shop/logs/nginx/access.log main;\n}"), ...as("admin1")], refused: true },
  { name: "the Vhost editor reaching /home with a relative error_log as an administrator", args: [...raw("vhost-template", "server {\n  error_log ../../home/shop/logs/nginx/error.log;\n}"), ...as("admin1")], refused: true },
  { name: "the Vhost editor pointing access_log at /./home as an administrator", args: [...raw("vhost-template", "server {\n  access_log \"/./home/shop/logs/nginx/access.log\" main;\n}"), ...as("admin1")], refused: true },
  { name: "the Vhost editor with access_log off and a syslog error_log as an administrator", args: [...raw("vhost-template", "server {\n  access_log off;\n  error_log syslog:server=unix:/dev/log;\n}"), ...as("admin1")], refused: false },
  { name: "the Vhost editor with managed /var/log/clp-addons-nginx log paths as an administrator", args: [...raw("vhost-template", "server {\n  access_log /var/log/clp-addons-nginx/shop/access.log main;\n  error_log /var/log/clp-addons-nginx/shop/error.log;\n}"), ...as("admin1")], refused: false },
  { name: "PageSpeed as an administrator", args: [...form("site_page_speed_settings", { settings: "pagespeed off;" }), ...as("admin1")], refused: false },
  { name: "PageSpeed as a user", args: [...form("site_page_speed_settings", { isEnabled: "1" }), ...as("user1")], refused: true },
];

// Classes shaped like Symfony's token and CloudPanel's user, so serialize()
// writes what the panel writes.
const SETUP = String.raw`<?php
namespace App\Entity { class User { private $id = 1; private $userName; private $role; private $roles;
  public function __construct($name, $role) { $this->userName = $name; $this->role = $role; $this->roles = [$role]; } } }
namespace Symfony\Component\Security\Http\Authenticator\Token { class PostAuthenticationToken {
  public function __construct(private $user, private $roles) {}
  public function __serialize(): array { return ['main', [$this->user, true, null, [], $this->roles]]; } } }
namespace {
  $sessions = '/home/clp/htdocs/app/files/var/sessions';
  mkdir($sessions, 0777, true);
  mkdir('/home/clp/htdocs/app/data', 0777, true);
  $db = new PDO('sqlite:/home/clp/htdocs/app/data/db.sq3');
  $db->exec('CREATE TABLE user (id INTEGER PRIMARY KEY, user_name TEXT, role TEXT, status BOOLEAN)');
  $db->exec("INSERT INTO user (user_name, role, status) VALUES ('boss', 'ROLE_ADMIN', 1), ('mea', 'ROLE_SITE_MANAGER', 1), ('tenant', 'ROLE_USER', 1), ('gone', 'ROLE_ADMIN', 0)");
  $write = function ($id, $name, $role, $last, $extra = []) use ($sessions) {
    $token = serialize(new Symfony\Component\Security\Http\Authenticator\Token\PostAuthenticationToken(new App\Entity\User($name, $role), [$role]));
    file_put_contents("$sessions/sess_$id", '_sf2_attributes|' . serialize(['_csrf/authenticate' => 'x', '_security.last_username' => $last, '_security_main' => $token] + $extra)
      . '_sf2_meta|' . serialize(['u' => 1, 'c' => 1, 'l' => 0]));
  };
  $write('admin1', 'boss', 'ROLE_ADMIN', 'boss');
  $write('manager1', 'mea', 'ROLE_SITE_MANAGER', 'mea');
  $write('user1', 'tenant', 'ROLE_USER', 'tenant');
  $write('disabled1', 'gone', 'ROLE_ADMIN', 'gone');
  // An administrator who has given the password but still owes the TOTP code.
  $write('pending1', 'boss', 'ROLE_ADMIN', 'boss', ['mfaAuthenticated' => false]);
  $write('verified1', 'boss', 'ROLE_ADMIN', 'boss', ['mfaAuthenticated' => true]);
  // A user whose typed login name holds a serialized administrator.
  $write('forged1', 'tenant', 'ROLE_ADMIN', "x\";s:25:\"\0App\\Entity\\User\0userName\";s:4:\"boss");
}
`;

const shell = (version: string) => `set -eu
php /work/setup.php
mkdir -p /app && echo '<?php echo "CLOUDPANEL";' > /app/index.php
php -d auto_prepend_file=/work/vhost-guard.php -d log_errors=0 -S 127.0.0.1:8000 -t /app >/dev/null 2>&1 &
sleep 1
failed=0
while IFS="|" read -r name refused body query cookie; do
  set -- -s -o /tmp/body -w '%{http_code}'
  [ -n "$body" ] && set -- "$@" --data-raw "$body"
  [ -n "$cookie" ] && set -- "$@" -b "$cookie"
  status=$(curl "$@" "http://127.0.0.1:8000/index.php$query")
  if [ "$refused" = 1 ]; then want=403; else want=200; fi
  if [ "$status" != "$want" ] || { [ "$want" = 200 ] && ! grep -q CLOUDPANEL /tmp/body; }; then
    echo "PHP ${version}: $name: expected $want, got $status: $(head -c 300 /tmp/body)"; failed=1
  fi
done < /work/cases.tsv
exit $failed
`;

const dir = mkdtempSync(join(tmpdir(), "clp-vhost-guard-"));
let failed = false;
try {
  chmodSync(dir, 0o755);
  cpSync(join(import.meta.dir, "../../addons/system-tweaks/vhost-guard.php"), join(dir, "vhost-guard.php"));
  writeFileSync(join(dir, "setup.php"), SETUP);
  const part = (c: Case, key: string) => c.args.filter((arg) => arg.startsWith(`${key}=`)).map((arg) => arg.slice(key.length + 1)).join("&");
  writeFileSync(join(dir, "cases.tsv"), CASES.map((c) => [
    c.name, c.refused ? "1" : "0", part(c, "body"), part(c, "query") ? `?${part(c, "query")}` : "", part(c, "cookie"),
  ].join("|")).join("\n") + "\n");
  for (const version of ["8.1", "8.4", "8.5"]) {
    writeFileSync(join(dir, "run.sh"), shell(version));
    const result = Bun.spawnSync(["docker", "run", "--rm", "--network", "none", "--mount", `type=bind,source=${dir},target=/work,readonly`,
      `php:${version}-cli`, "sh", "/work/run.sh"], { stdout: "pipe", stderr: "pipe" });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
    if (result.exitCode !== 0) {
      failed = true;
      console.error(output || `PHP ${version}: docker exited ${result.exitCode}`);
    } else {
      console.log(`PHP ${version}: ${CASES.length} requests answered as expected`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (failed) process.exit(1);
