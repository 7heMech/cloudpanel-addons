# System Tweaks

System Tweaks holds settings for the server rather than for CloudPanel's pages,
which stay with [Panel Tweaks](panel-tweaks.md). PHP worker limits stay with
[PHP Resources](php-resources.md), and the panel's own PHP version with Panel
Tweaks. It is in the installer's default selection.

## Automatic updates

Updates use the distro's own `unattended-upgrades`. Everything System Tweaks
sets is one drop-in, `/etc/apt/apt.conf.d/52clp-addons-unattended-upgrades`. It
sorts after `20auto-upgrades` and `50unattended-upgrades`, so its scalars win
over those and its `Origins-Pattern` entries add to the distro's list. Any later
operator file still has the last word. Switching off deletes only that file, so
the operator's previous setup comes back. The file sets:

- `APT::Periodic::Update-Package-Lists` and `Unattended-Upgrade` to `1`;
- the distro's security pocket: Debian matches
  `codename=${distro_codename}-security,label=Debian-Security`, and Ubuntu matches
  `archive=${distro_codename}-security`;
- CloudPanel's origin `packages-v1.cloudpanel.io` for `component=php-*`, always;
- `nginx`, on by default; `percona-*`/`mysql-*`/`mariadb-*` and `main`, off by
  default;
- `Automatic-Reboot`, off by default. The first switch-on copies the box's
  effective value, so a policy the operator already had stays in place.

PHP is always in because CloudPanel's PHP builds come only from its own
repository. Debian's security pocket alone would not have patched the php2shell
CVEs. Nginx is on by default because it faces the internet, and its package
upgrade (`invoke-rc.d nginx upgrade`) swaps the binary without dropping
connections. The database is off because an update restarts MySQL. `main` is off
because CloudPanel updates itself with `clp-update`. Varnish, ProFTPD and anything
else stay uncovered, and the page shows them as uncovered.

Ubuntu 22.04 (jammy), 24.04 (noble) and 26.04 (resolute) use the same
archive-based security pattern. The additive drop-in preserves Ubuntu's
`Allowed-Origins`, including existing `UbuntuESMApps` and `UbuntuESM` entries;
it does not enroll the machine in Ubuntu Pro or enable a repository. Coverage
comes from the repositories actually present. Ubuntu commonly enables automatic
updates already, so this is reported as an outside configuration until the
operator selects System Tweaks. See [Ubuntu's automatic updates guide](https://ubuntu.com/server/docs/how-to/software/automatic-updates/).
`bun tests/integration/integration-system-tweaks-ubuntu.ts` checks the generated
drop-in against each release's real `unattended-upgrades` matcher in Docker.
The containers do not boot systemd; timer ownership and restoration are tested
separately with the action fixtures.

Each write is parsed with `apt-config dump` before it is kept; a rejected file is
put back as it was. If `apt-daily.timer` or `apt-daily-upgrade.timer` is
disabled, switching on enables it and records that in the settings; switching
off disables only the timers it enabled. Both timers are read before anything
changes: a masked one is refused, not unmasked, and a timer that will not enable
undoes the drop-in and any timer that switch-on had enabled. The repair timer rewrites the drop-in when it has drifted from the
stored choice. Disabling the addon removes the drop-in and those timers, and
enabling it again restores both.

If `unattended-upgrades` is missing, the page says so and offers an install
button. That button runs a fixed `apt-get install unattended-upgrades` and
nothing else; the gateway verb takes no package name. If the install fails, it
runs `apt-get update` and tries once more. The whole action, including the state
read its reply carries, has one ten-minute deadline (`addons/system-tweaks/limits.ts`).
Each command gets its own guard or what is left, whichever is shorter: 280 s for
apt-get, of which 120 s may be waiting for dpkg's lock, and 30 s for a query. The
gateway, which kills an action at its timeout, waits 30 s longer, so it never
stops a root action that is still installing. The page keeps its "Installing"
notice up until the reply repaints it. Ubuntu's postinst may turn
updates on by itself, and the page then reports that as configured outside
System Tweaks.

### Reading the effective state

The page never reports what the drop-in meant to do. It reads the result:

- **On or off**: `APT::Periodic::Unattended-Upgrade` and `APT::Periodic::Enable`
  from `apt-config dump`, the package from `dpkg-query`, and both timers from
  `systemctl is-enabled`.
- **Who turned it on**: the last `APT::Periodic::Unattended-Upgrade` assignment
  in `/etc/apt/apt.conf` and `apt.conf.d`, in apt's byte order. That names the
  operator's file for "configured outside System Tweaks", and names a later file
  that switches the addon's own setting back off.
- **Coverage**: every index from `apt-cache policy`, matched against
  `Origins-Pattern` and the legacy `Allowed-Origins` the way
  `match_whitelist_string` does it, with `fnmatchcase` and the `${distro_id}` and
  `${distro_codename}` macros. Repositories are grouped by suite. A Debian pocket
  is named by its codename (`bookworm-security`) and an Ubuntu pocket by its
  archive (`jammy-security`), because Ubuntu gives every pocket the release
  codename. On staging, this matched `unattended-upgrade --dry-run -d`'s
  allowed and not-allowed list exactly.
- **Last run**: the last `Starting unattended upgrades script` block in
  `/var/log/unattended-upgrades/unattended-upgrades.log`, or in `.1.gz` just after
  logrotate empties it.
- **Reboot**: `/var/run/reboot-required` and `.pkgs`.

## Cloudflare connection check

System Tweaks owns the optional **Check Cloudflare connections** switch.
Cloudflare IP Access continues to manage CloudPanel's per-site flag, access-log
format and include. The check also works for sites enabled through CloudPanel
without the Cloudflare IP Access addon. It defaults off because another proxy
or tunnel between Cloudflare and Nginx changes the connection peer.

CloudPanel's broad real-IP trust can replace `$remote_addr` from a request
header before its access rules run. The extra check uses
[`$realip_remote_addr`](https://nginx.org/en/docs/http/ngx_http_realip_module.html#embedded_variables),
which retains the original connection address. Its lookup lives in the owned
HTTP-context file `/etc/nginx/sites-enabled/00-clp-addons-cloudflare-peer.conf`.
A marked block at the start of `/etc/nginx/cloudflare/ips` rejects peers outside
that lookup with 403. The rest of CloudPanel's include stays byte-for-byte
intact, so its existing address checks still apply too. The addon does not
change global real-IP trust, visitor-IP headers, logs or PHP's `REMOTE_ADDR`.

Ranges come from the trusted, root-owned CloudPanel include. Only numeric IPv4
and IPv6 `allow` rules followed by `deny all` are accepted; custom directives,
untrusted files, modified markers and an unrelated lookup file are refused.
An operator's access rule elsewhere remains in place; the page reports whether
this addon's check is configured, not whether every possible outside protection
exists. No local-network or loopback exemption is added. CloudPanel's normal
WordPress/Varnish backend has no Cloudflare include and is unaffected. A server
that puts that include in a backend must remove it there or leave this switch
off. Direct ACME requests are rejected too; validation must reach the site via
Cloudflare or use DNS. Unrestricted sites do not use the check.

The shared Nginx transaction writes both files, tests the complete configuration
and reloads once. Validation or reload failure restores both files and the
stored choice. Each Nginx command has a 30-second timeout; the gateway allows
450 seconds for validation/reload, possible rollback, state queries and lock
waiting. Both limits are in `addons/system-tweaks/limits.ts`.

Activation, repair and `repair --anchors-only` restore an opted-in check. The
existing path watcher watches the include and its directory, so a CloudPanel
range replacement refreshes the lookup and puts the block back. This is eventual
repair: a replacement loaded before the watcher finishes temporarily has only
CloudPanel's rules. The page reports missing or stale configuration as needing
repair, and watcher failures are logged. It reports configuration on disk,
not a probe of live Nginx workers. Disabling the switch or addon removes only
the exact marked block and owned lookup, preserving the current ranges rather
than restoring an old copy. Re-enabling the addon restores its saved choice.

`bun tests/integration/integration-cloudflare-peer.ts` tests the generated
configuration with real Nginx in an isolated Docker network: the original header
bypass, rejection after the fix, IPv4/IPv6 trusted peers, local backend proxying,
direct ACME requests and unrestricted sites.

## PHP upload-progress mitigation

The guard stays platform-wide (see [Security](security.md#php-session-upload-progress)):
install, update and repair write it whenever any addon is installed. System
Tweaks is where it is shown and the only place to opt out. The opt-out is
`uploadProgressGuard: false` in `/var/lib/clp-addons/system-tweaks/settings.json`,
and `cli/php-guard.ts` honours it only while `system-tweaks.conf` exists.
The shared disable and uninstall paths reconcile the guard once the config is
gone. Disabling puts it back even when no addon is left, because the binary
stays and repair keeps the guard while it is installed. Uninstalling puts it
back while another addon remains, and the last uninstall removes it with the
binary. A failure there warns and leaves the guard to the repair timer, since
the addon is already withdrawn. So an existing box
keeps its protection after an update without anyone enabling System Tweaks, and
no box loses the guard because an addon it never had was missing.

An operator who already turned the setting off keeps their own file. The guard is
still written, because it costs nothing and holds the setting if that file
changes. The page shows both: "Off, by clp-addons, and by your own config". After
an opt-out, the same operator sees "Off, by your config".

Each installed PHP-FPM's effective value is worked out from the files it reads,
in its order. First comes its main `php.ini`: `/etc/php/X.Y/fpm/php.ini`, or the
panel FPM's `-c`. Then come the `*.ini` files in `/etc/php/X.Y/fpm/conf.d` in
byte order, and the last assignment wins. Sections `[PATH=]` and `[HOST=]` are
skipped because they do not apply server-wide. Values are read as PHP reads
booleans. Pools whose `php_value` or `php_admin_value` (or `_flag`) turns the
setting back on are named per pool. The panel's FPM is read from
`systemctl show clp-php-fpm -p ExecStart`, so it follows Panel Tweaks moving it
to another version.

Reading the files, rather than asking `php-fpm -i`, tells the page which file
decided the value. That is the difference between "by clp-addons" and "by your
config". It also needs no process per version on every page load. Like
`php -i`, it shows the config on disk, which a running FPM picks up on its next
reload. A site's own `.user.ini` or an Nginx `PHP_VALUE` can still change this
per-directory setting for that site; neither is read.
