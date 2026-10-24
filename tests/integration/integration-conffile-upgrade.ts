// bun tests/integration/integration-conffile-upgrade.ts (requires Docker)
import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAnyAddress, withoutAnyAddress } from "../../addons/system-tweaks/real-ip";

// A package standing in for nginx-common ships nginx.conf as a conffile, and
// its next version changes that file, as a CloudPanel release might.
const v1 = "http {\n    set_real_ip_from 127.0.0.1;\n    set_real_ip_from 0.0.0.0/0;\n}\n";
const v2 = "http {\n    set_real_ip_from 127.0.0.1;\n    set_real_ip_from 0.0.0.0/0;\n    server_tokens off;\n}\n";
assert.equal(withAnyAddress(withoutAnyAddress(v1)), v1);

const dir = mkdtempSync(join(tmpdir(), "clp-conffile-upgrade-"));
try {
  chmodSync(dir, 0o755);
  writeFileSync(join(dir, "v1.conf"), v1);
  writeFileSync(join(dir, "v2.conf"), v2);
  writeFileSync(join(dir, "edited.conf"), withoutAnyAddress(v1));
  writeFileSync(join(dir, "released.conf"), withAnyAddress(withoutAnyAddress(v1)));
  const result = Bun.spawnSync(["docker", "run", "--rm", "--mount", `type=bind,source=${dir},target=/probe,readonly`,
    "debian:bookworm", "sh", "-c", `set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq unattended-upgrades apt-utils >/dev/null
build() {
  root=/tmp/pkg-$1; mkdir -p $root/DEBIAN $root/etc/clp-demo
  cp /probe/$1.conf $root/etc/clp-demo/nginx.conf
  printf 'Package: clp-demo-common\\nVersion: %s\\nArchitecture: all\\nMaintainer: t <t@t>\\nDescription: t\\n' "$2" > $root/DEBIAN/control
  echo /etc/clp-demo/nginx.conf > $root/DEBIAN/conffiles
  dpkg-deb -b -Zgzip $root /repo/clp-demo-common_$2_all.deb >/dev/null
}
publish() {
  cd /repo && apt-ftparchive packages . > Packages
  apt-ftparchive -o APT::FTPArchive::Release::Origin=clp-test -o APT::FTPArchive::Release::Suite=stable release . > Release
  cd / && apt-get update -qq -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/clp-test.list -o Dir::Etc::sourceparts=- >/dev/null
}
mkdir /repo
echo 'deb [trusted=yes] file:/repo ./' > /etc/apt/sources.list.d/clp-test.list
echo 'Unattended-Upgrade::Origins-Pattern { "origin=clp-test"; };' > /etc/apt/apt.conf.d/52test
build v1 1.0; publish
apt-get install -y -qq clp-demo-common >/dev/null
cp /probe/edited.conf /etc/clp-demo/nginx.conf
build v2 2.0; publish
unattended-upgrade -d > /tmp/held.log 2>&1 || true
test "$(dpkg-query -W -f='\${Version}' clp-demo-common)" = 1.0 || { echo "edited conffile was not held back"; exit 1; }
grep -q "conffile prompt" /tmp/held.log || { cat /tmp/held.log; echo "no conffile prompt logged"; exit 1; }
cp /probe/released.conf /etc/clp-demo/nginx.conf
unattended-upgrade -d > /tmp/released.log 2>&1
test "$(dpkg-query -W -f='\${Version}' clp-demo-common)" = 2.0 || { cat /tmp/released.log; echo "released conffile was not upgraded"; exit 1; }
cmp -s /etc/clp-demo/nginx.conf /probe/v2.conf || { echo "the package's new conffile was not installed"; exit 1; }
echo 'Conffile upgrade integration passed: an edited conffile holds the package back; with the edit released, unattended-upgrades installs the new version and its new conffile.'
`], { stdout: "pipe", stderr: "pipe", timeout: 300_000 });
  assert.equal(result.exitCode, 0, result.stdout.toString() + result.stderr.toString());
  process.stdout.write(result.stdout);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
