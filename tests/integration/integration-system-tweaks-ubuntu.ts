// bun tests/integration/integration-system-tweaks-ubuntu.ts (requires Docker and apt network access)
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_UPDATE_SETTINGS, dropInFor } from "../../addons/system-tweaks/updates";

const dir = mkdtempSync(join(tmpdir(), "clp-ubuntu-updates-"));
try {
  writeFileSync(join(dir, "drop-in"), dropInFor({ ...DEFAULT_UPDATE_SETTINGS, enabled: true }, "Ubuntu"));
  writeFileSync(join(dir, "probe.py"), `import apt_pkg, os, runpy, shutil, subprocess
from types import SimpleNamespace
apt_pkg.init()
uu = runpy.run_path('/usr/bin/unattended-upgrade', run_name='probe')
before = uu['get_allowed_origins']()
target = '/etc/apt/apt.conf.d/52clp-addons-unattended-upgrades'
shutil.copyfile('/probe/drop-in', target)
for key in list(apt_pkg.config.keys()):
    apt_pkg.config.clear(key)
apt_pkg.init()
patterns = uu['get_allowed_origins']()
assert set(before).issubset(patterns), (before, patterns)
codename = subprocess.check_output(['lsb_release', '-cs'], text=True).strip()
def covered(origin, archive, component='main'):
    source = SimpleNamespace(origin=origin, archive=archive, codename=codename, label=origin, component=component, site='example.test')
    return any(uu['match_whitelist_string'](pattern, source) for pattern in patterns)
assert covered('Ubuntu', codename + '-security')
assert not covered('Ubuntu', codename + '-updates')
assert not covered('Ubuntu', codename + '-backports')
assert covered('UbuntuESMApps', codename + '-apps-security')
assert covered('UbuntuESM', codename + '-infra-security')
assert covered('packages-v1.cloudpanel.io', '', 'php-8.3')
assert covered('packages-v1.cloudpanel.io', '', 'nginx')
assert not covered('packages-v1.cloudpanel.io', '', 'main')
assert not covered('packages-v1.cloudpanel.io', '', 'percona-server-server-8.0')
assert apt_pkg.config.find('APT::Periodic::Unattended-Upgrade') == '1'
assert not apt_pkg.config.find_b('Unattended-Upgrade::Automatic-Reboot')
os.unlink(target)
for key in list(apt_pkg.config.keys()):
    apt_pkg.config.clear(key)
apt_pkg.init()
assert uu['get_allowed_origins']() == before
print(codename + ': real unattended-upgrades origin matching and additive configuration passed')
`);
  for (const release of ["22.04", "24.04", "26.04"]) {
    const proc = Bun.spawn(["docker", "run", "--rm", "--mount", `type=bind,source=${dir},target=/probe,readonly`,
      `ubuntu:${release}`, "sh", "-c", "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades lsb-release >/tmp/install.log && python3 /probe/probe.py"],
    { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    assert.equal(code, 0, `Ubuntu ${release}: ${stdout}\n${stderr}`);
    process.stdout.write(stdout);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
