# System Tweaks

System Tweaks holds settings for the server rather than for CloudPanel's pages,
which stay with [Panel Tweaks](panel-tweaks.md). PHP worker limits stay with
[PHP Resources](php-resources.md). System Tweaks also owns the PHP version
that runs the panel itself, and the protocol of each rule on CloudPanel's own
Firewall page.

## The page

Three cards: Automatic updates, which an operator comes back to; one
Settings card for the panel's PHP, the upload-progress mitigation, forged
visitor IPs, phpMyAdmin and nginx config injection, which are set once; and
Failed logins, with the two fail2ban jails and the addresses they block. Each
row says what it does in a sentence; the
reasons are here. The Nginx, MySQL, CloudPanel and reboot rows appear only once
System Tweaks' own switch is on, since they change nothing before. The
repositories and each PHP-FPM's upload-progress value fold into a summary that
opens, and the summary says when something needs a look.

Three states would otherwise do nothing visible, so the page calls them out:
updates that run but leave CloudPanel's PHP uncovered; a reboot required for
over a week with automatic reboot off; and a panel still on PHP 8.1 when a newer
PHP-FPM is installed. The uncovered PHP is usually an outside setup with only
the distro's security pocket, which is working as configured, so the page
suggests the switch in a plain hint rather than a warning; under System Tweaks'
own file it is a fault and gets one. A required reboot with automatic reboot on
says when the box restarts by itself: unattended-upgrades checks for the flag
at the end of every run, even one that installs nothing, so the next run reboots
right away, after the set minutes, or at the set time. System Tweaks' file leaves
`Automatic-Reboot-WithUsers` alone, so when another file turns it off the page
adds that the reboot is skipped while anyone is logged in.

The page makes one change at a time. Every change answers with the whole page
as it stands, so a second change running beside it would be repainted over by
the first reply, its controls put back as if it had stopped. While a change
runs, every control on the page is disabled, the row it belongs to says what is
running, and a change slower than a moment also says so over the page, naming
it and that the other settings wait. Descriptions stop short of the switch
column, and a long one takes a line per thought.

Failed runs show a short summary with expandable log details, including the
failed package URL when unattended-upgrades logs one.

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
- `Automatic-Reboot` and `Automatic-Reboot-Time`, `now` or a validated 24-hour
  `HH:MM`. The first switch-on copies the box's effective values, so a policy
  the operator already had stays in place; a time the page cannot offer, such
  as `+15`, becomes `now`.

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

Reboot timing uses unattended-upgrades’ own scheduling on both Debian and
Ubuntu; no separate timer or direct shutdown command is added. The HTTP
boundary, root action and drop-in generator validate the time before writing
it. The control, shown while the reboot switch is on, offers right after the
run or a clock time. Right after the run saves at once; a time field reports
every digit typed as a change, so a time is saved when the field is left or
after a short pause, with the value it had then. Server timezone comes from the
root process’s system timezone (`Intl.DateTimeFormat`); effective timing comes
from `apt-config dump`. Later apt files remain authoritative, and a different
effective time, `+15` included, is reported under the control. Settings changes
do not change an already queued shutdown. See [Ubuntu’s reboot documentation](https://ubuntu.com/server/docs/how-to/software/automatic-updates/#reboots).

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
  codename. Coverage must match the allowed and not-allowed origins reported by
  `unattended-upgrade --dry-run -d`.
- **Last run**: the last `Starting unattended upgrades script` block in
  `/var/log/unattended-upgrades/unattended-upgrades.log`, or in `.1.gz` just after
  logrotate empties it.
- **Reboot**: `/var/run/reboot-required` and `.pkgs`.

## The panel's own PHP

CloudPanel runs its pages, phpMyAdmin and the root File Manager pool in
`clp-php-fpm`, started on PHP 8.1, which upstream no longer patches. The Panel
PHP row lets an administrator run that unit on any newer installed PHP-FPM.
It is a choice rather than a switch because the panel is CloudPanel's
code and was not tested on 8.2+: two pinned dependencies declare `php <8.2`.
Symfony then logs deprecation notices to `/home/clp/logs/php/error.log`.

The change is a systemd drop-in, `clp-php-fpm.service.d/clp-addons-php.conf`,
that replaces only the binary in CloudPanel's own `ExecStart` and keeps its
arguments, config and `php.ini`. Deleting it is the whole undo, and it survives
CloudPanel rewriting its unit. The FPM then scans that version's
`/etc/php/X.Y/fpm/conf.d`, the same directory the sites on it use, which is
where the [upload-progress guard](security.md#php-session-upload-progress)
already is.

A change is config-tested with the new binary first. After the restart, both
pools are asked for a page directly over their sockets with FastCGI: the login
page must answer 200 and the File Manager below 400. A request through Nginx
would meet the panel's optional basic auth instead of PHP. If either fails
within 20 seconds, the previous drop-in goes back and the panel restarts on it.

The repair timer keeps the unit to the stored choice. A version that failed
is recorded with its package release and is not retried every fifteen minutes,
only after that package is upgraded or the operator chooses again. Once
CloudPanel's own unit starts a version at least as new as the choice, the
drop-in is removed. A drop-in someone else wrote that sets `ExecStart`, such
as a hand-made `override.conf`, wins: the row says so and refuses a choice.
Automatic updates include the panel's PHP packages, and no package script
restarts CloudPanel's unit, so when its main process runs a binary that has been
replaced, repair reloads the unit, whose `USR2` re-executes the new one.
Disabling System Tweaks removes the drop-in and keeps the choice, which enabling
reapplies through the reconcile service. Disabling is synchronous, so it cannot
ask the pools for a page: under the same lock, it config-tests the PHP the unit
will start without the drop-in, CloudPanel's own or an operator's override, and
requires the unit to come back running it. Otherwise, including a failed
`daemon-reload`, it puts the drop-in back and refuses to disable; an uninstall
that aborts later reactivates the addon. While the addon is disabled the stored
choice is marked withdrawn, and a change that was waiting for the lock refuses,
as it does once the addon's config is gone, so neither can write the drop-in
again; enabling clears the mark. A disable whose other half fails after
withdrawal, or an enable whose settings half fails, still leaves the choice
applied, since the addon stays enabled. The page check is the one thing withdrawal
does not repeat: a PHP that starts but answers 500 is not caught. The row also shows a newer package
version when apt has one, revision included, because a newer minor is no fix
until it is patched, and a failure is retried once that version changes. A
chosen PHP that is removed afterwards is noticed by the next repair, which puts
the panel back on CloudPanel's own PHP and records the failure, rather than
leaving a unit that cannot start at its next restart.

A choice and its drop-in change under one lock, and a repair run reads the
choice only after it holds the lock. A file at the drop-in path that is not
root's, or that others can write, is never trusted: it is replaced when a
version is wanted and removed when none is.

The choice is stored in `/var/lib/clp-addons/system-tweaks/panel-php.json`.
The System Tweaks state action includes its status; `set-panel-php` accepts
`{"php":"8.4"}` (or an empty string for CloudPanel's own version). Its gateway
request allows 90 seconds for switching and rollback. Panel Tweaks does not
read, change or reconcile this setting.

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
`systemctl show clp-php-fpm -p ExecStart`, so it follows System Tweaks moving it
to another version.

Reading the files, rather than asking `php-fpm -i`, tells the page which file
decided the value. That is the difference between "by clp-addons" and "by your
config". It also needs no process per version on every page load. Like
`php -i`, it shows the config on disk, which a running FPM picks up on its next
reload. A site's own `.user.ini` or an Nginx `PHP_VALUE` can still change this
per-directory setting for that site; neither is read.

## Forged visitor IPs

CloudPanel's two Nginx instances trust a client IP header from every address
through `set_real_ip_from 0.0.0.0/0`: the sites' `/etc/nginx/nginx.conf` with the
default `real_ip_header X-Real-IP`, and the panel's
`/home/clp/services/nginx/nginx.conf` (CloudPanel 6, `clp-nginx.service`) with
`X-Forwarded-For`. Any IPv4 client can therefore name its own address. Nginx
uses it as `$remote_addr`: in access logs, PHP's `REMOTE_ADDR`, basic-auth and
Cloudflare-only `allow` rules, IP-based plugins and the panel. A direct request
with `X-Real-IP` set to a Cloudflare address passes a Cloudflare-only site.

**Block forged visitor IPs**, on by default (`blockForgedRealIp`), comments out
that line in both files, and a `::/0` one if present, by prefixing
`#clp-addons:untrusted `. The other `set_real_ip_from` lines stay: `127.0.0.1`,
which CloudPanel's front server uses when it proxies to a local backend such as
WordPress or Varnish, and the private ranges, where a load balancer would sit.
A peer in those ranges can still set the header.

The panel also trusts Cloudflare, in a marked block after the commented line
built from CloudPanel's `/etc/nginx/cloudflare/ips`, with each entry checked as
an address or prefix. Cloudflare appends the address it received the request
from to `X-Forwarded-For`, and the panel has `real_ip_recursive on`, so Nginx
skips trusted proxies from the right and stops at that address. A panel behind
Cloudflare keeps its visitors' addresses, and a forged entry sent through
Cloudflare sits to the left of the real one and is never reached. The sites get
no Cloudflare trust: Cloudflare passes a client's `X-Real-IP` through unchanged,
so trusting it would reopen the forgery for every site behind Cloudflare. Their
Cloudflare requests keep the edge address they have today, and CloudPanel's
`cloudflare` log format already reads `CF-Connecting-IP`. Only a proxy on a
public address other than Cloudflare loses its visitors' addresses; switch the
setting off there.

Switching off removes the prefix and leaves each file byte-for-byte as CloudPanel
wrote it. Each instance uses the shared Nginx transaction with its own
validation (`nginx -t`, or `nginx -t -c` for the panel) and reload (`nginx` or
`clp-nginx`), restoring the file on failure; a panel failure also undoes the
sites' half. The panel's file belongs to the `clp` account with mode 770, so it
is accepted when owned by that account and not world-writable. The gateway
timeout is in `limits.ts`. Activation and the 15-minute repair reapply the
edit when CloudPanel rewrites a file, and rebuild the panel's Cloudflare block
when CloudPanel's list changes, so a rewrite leaves the trust open until then. Disabling the addon restores both lines.

The sites' `nginx.conf` is a dpkg conffile of `nginx-common`. unattended-upgrades
holds back a package whose modified conffile the upgrade would replace, so an
edit left in place could keep a security update out. The shared hook described
in [Platform](platform.md#package-conffiles) gives the file its package text
back for the run when `nginx-common` has an upgrade waiting, and repair edits
whatever the upgrade installed. The panel's file is not a conffile: a
`cloudpanel` upgrade overwrites it and repair edits it again.

`bun tests/integration/integration-real-ip.ts` runs real Nginx in Docker: it
reproduces the bypass on the stock directives, then shows the edited ones reject
it while Cloudflare peers and loopback proxies keep working.

## phpMyAdmin

CloudPanel 6's panel vhost, `/home/clp/services/nginx/sites-enabled/cloudpanel.conf`,
sets `$basicAuth` on when `/home/clp/services/nginx/basic-auth/credentials`
exists, then off again when `$request_uri ~ ^/phpmyadmin`. `$request_uri` is the
raw request line, so `/phpmyadmin/../file-manager/` or
`/phpmyadmin/..%2ffile-manager/` matched it while Nginx served the normalized
`/file-manager/` without basic auth. phpMyAdmin also served its stock
`examples/signon.php`, which takes a MySQL host, port, user and password from
anyone and makes phpMyAdmin connect to them: a way to probe hosts and ports from
the server and to sign a victim's browser in to phpMyAdmin. `setup/`,
`composer.json`, `RELEASE-DATE-*`, `vendor/composer/installed.json` and `sql/`
were served too.

**Lock down phpMyAdmin**, on by default (`protectPhpMyAdmin`), adds one marked
block (`# clp-addons:phpmyadmin:start` to `:end`) right before the vhost's
`auth_basic $basicAuth;`, in `addons/system-tweaks/phpmyadmin.ts`. It leaves
CloudPanel's lines as they are and only ever sets `$basicAuth` on: on when the
credentials file named by the vhost's `auth_basic_user_file` exists and the
decoded, normalized `$uri` is not `/phpmyadmin` or under `/phpmyadmin/`. Server
`set` and `if` directives run in file order and again after each internal
redirect, so the block must come after CloudPanel's and before the
`if (-f $request_filename) { break; }` that ends them; the `auth_basic` line is
that place. A phpMyAdmin URL that falls through to the panel's `/index.php` now
needs basic auth, which no phpMyAdmin page does. A vhost without exactly one
`auth_basic $basicAuth;` and one `auth_basic_user_file` gets nothing and the
page says why.

The block also answers 404, before basic auth, for `examples/`, `setup/`,
`sql/`, `vendor/`, `libraries/`, `templates/`, `locale/` and `tmp/`, which no
phpMyAdmin page loads in the browser, and for its release and package files,
dotfiles and `config.sample.inc.php`. These are regex locations placed ahead of
CloudPanel's `\.php$` location, which would otherwise run the scripts. `doc/`
stays: phpMyAdmin's help links open it when it is present, and its static
files give the version away anyway. The panel opens phpMyAdmin through
`/pma/...`, which redirects to `/phpmyadmin/login.php`, so its sign-in is
unaffected; the staging check loaded that page and every script, stylesheet and
image it names, with and without basic auth.

It is a setting of its own rather than part of **Block nginx config
injection**: that one guards what panel accounts write into site vhosts, while
this changes the panel's own vhost and phpMyAdmin, and either can be wanted
without the other. It is on by default because nothing it removes is used.

The vhost belongs to the `clp` account, mode 770, so the change uses the shared
Nginx transaction as the forged-IP setting does: the file is accepted when owned
by that account and not world-writable, written with its owner kept, tested
with `nginx -t -c /home/clp/services/nginx/nginx.conf`, reloaded with
`clp-nginx`, and restored on failure. Switching off removes the block and leaves
the file as CloudPanel wrote it. A CloudPanel update rewrites the vhost, which
wakes `clp-addons-anchor.path`; its `repair --anchors-only` puts the block back
after the `/addons/` proxy, and the 15-minute repair does too. Disabling the
addon removes it.

The `/addons/` proxy's reconciler in `cli/inject.ts` records a hash of the vhost
without its own block, and refuses to touch a file whose hash changed. It
leaves the phpMyAdmin block out of that hash too, so neither reconciler reads
the other's block as a CloudPanel rewrite. Both write the vhost with its owner
kept, so CloudPanel's own account can still rewrite it.

## Nginx config injection

CloudPanel renders site settings into the site's vhost without checking them,
and the sites' Nginx runs as `user root;`. Any panel account with a site could
end a Root Directory with `;` and add directives: a WebDAV `alias` writes files
as root, and `fastcgi_pass` to the root File Manager pool runs them (Full
Disclosure 2026/Oct/14, CloudPanel 2.5.4-3). The same holds for blocked bot
names (only a length limit), blocked IPs and basic-auth allowlists (the netmask
is cast with `(int)` or not read), the Varnish server, the reverse-proxy URL,
ports, and PHP's additional configuration, which sits inside a quoted
`PHP_VALUE`. The Vhost editor and PageSpeed settings are raw Nginx config, and
CloudPanel offers both to every account that can open the site; its only check
refuses `disable_symlinks`.

**Block nginx config injection**, on by default (`blockVhostInjection`), puts
`vhost-guard.php` in front of CloudPanel as the `[clp]` pool's
`php_admin_value[auto_prepend_file]`. The setting is a pool file,
`pool.d/zz-clp-addons-vhost-guard.conf`, that reopens CloudPanel's `[clp]`
section; PHP-FPM merges a section it has seen, so CloudPanel's own
`cloudpanel.conf` is untouched and no other pool gets the guard. Both files sit in
`/home/clp/services/php-fpm/fpm`, which CloudPanel's update does not replace,
and next to each other, so removing the binary never leaves the pool naming a
missing script. An admin value cannot be overridden by `PHP_VALUE` or
`ini_set`.

The guard reads the same `$_POST` Symfony reads, keyed by the form names
CloudPanel's form types produce (`site_domain_settings[rootDirectory]` and so
on), so no URL spelling reaches CloudPanel's form without passing it. Each field
gets the allowlist its Nginx context can hold: folder names without `.` or `..`
for the Root Directory, IP addresses and CIDR ranges (each trimmed, as
CloudPanel does), digits for ports, a host and port for Varnish, an `http(s)`
URL without whitespace, quotes, `;`, braces or `$`, a Varnish server trimmed of
slashes as CloudPanel trims it, and no `"`, `\`, braces or
`$` in PHP's additional configuration. A bot name lands in an unquoted regex, so
it has no `+` or other regex operators that would stop Nginx loading. These
checks apply to administrators too, who can still use the Vhost editor for a
value they refuse. A `vhost-template` parameter, in the query or the body, or a
PageSpeed form is accepted only from an active `ROLE_ADMIN`, who can change the
server anyway. The guard finds the account from the `cloudpanel` session file,
read by `panel-session.php`, which the File Manager guard shares: it walks PHP's
`name|value` session format, re-serializing each value to find
where it ends, so a typed login name cannot pass for the next entry, unserializes
with `allowed_classes => false`, refuses a session whose `mfaAuthenticated` is
`false`, which CloudPanel leaves while a TOTP code is owed, and reads the role
and status from CloudPanel's database. Anything it cannot read counts as not an
administrator, and the refusal says which step failed, since a CloudPanel update
that changes its session or user layout would refuse every administrator until
this addon follows it. A refusal is a 403 page naming the field, and a line in
the panel's PHP error log.

Switching it on writes both files, config-tests with the binary and arguments
of the unit's merged `ExecStart`, reloads `clp-php-fpm`, and requires two
answers over FastCGI within 20 seconds: the login page, and a refusal of a
`vhost-template` query without a session, which CloudPanel alone answers with
the login page. Otherwise its own files go back as they were, if they were
there, and the FPM is reloaded again; a pool file it did not write is not kept.
It holds Panel PHP's lock while it does, and repair reads the setting under
System Tweaks' own lock first. Repair reinstalls and reloads when either file
differs or the running pool does not refuse, so an install interrupted before
its reload, or a script OPcache still holds, does not pass for one in force.
The page's "On" asks the running pool the same question.
CloudPanel's update runs `chown -R clp:clp /home/clp`, which repair also undoes.
Enabling the addon queues the reconcile service, since the synchronous enable
cannot wait for the panel, and `clp-addons update` queues it too.
Switching off or disabling removes the pool file and reloads before deleting
the script, even when the pool file had already gone, since the running FPM may
still prepend the script; it puts the pool file back if the reload fails. Repair waits only
five seconds for Panel PHP's lock, so it does not hold the page's switches
behind a Panel PHP change; the next run catches up.

The Varnish server never passes through the panel's form when the site's own
user writes it: CloudPanel's `{{varnish_proxy_pass}}` is filled from
`/home/<site user>/.varnish-cache/settings.json`, which that user owns, read with
`sudo cat` whenever the site's vhost is rendered. A shell or SFTP user, which a
panel account can create, or any code the site runs, could put directives there.
Checking the file before CloudPanel reads it races its owner; making it
root-owned does not hold, since the owner can rename it away, and CloudPanel's own
Varnish save and `clpctl system:permissions:reset` hand it back. A check when nginx
reloads races too: CloudPanel writes vhosts in place with `tee` and reloads in the
background, so a second save can land between the check and nginx reading the file.

So the setting also takes the file out of the vhost. Each site's stored vhost
names `include /etc/nginx/clp-addons-varnish/<domain>.conf;` where it had the
placeholder, and a drop-in on `nginx.service` runs `clp-addons sync-varnish`
before nginx starts or reloads, which is how CloudPanel applies every save. The
sync opens each settings file without following a link or waiting on a FIFO and
writes the line CloudPanel would render: `proxy_pass http://<server>;` when Varnish
is on and the server passes the guard's rule, CloudPanel's `127.0.0.1:8080`
backend otherwise, and nothing for a site whose `varnish_cache` is off. A refused
server logs to the journal, and the site goes on without Varnish. nginx reads only
these root-owned lines, so what the file holds at any moment cannot reach it. The
drop-in copies the unit's own `ExecStartPre=` and `ExecReload=` lines after the
sync, and refuses a unit without exactly one of each; the sync's failure does not
stop nginx loading the includes it last wrote.

The same sync also moves each site's nginx logs out of `/home/<site user>`.
CloudPanel renders `{{nginx_access_log}}` and `{{nginx_error_log}}` as paths in
`/home/<site user>/logs/nginx/`, which that user owns. The root nginx master
opens both files, following links, on start, reload, `nginx -t` and the `USR1`
log reopen, and appends to whatever they point at. A root-owned
`~/logs/nginx` in place would not hold, since the user owns `~/logs` and can
rename it away. So each stored and rendered vhost names
`/var/log/clp-addons-nginx/<site user>/access.log` and `error.log` instead, in a
directory only root can write (`0750 root:<site user>`, under `0711 root:root`).

The sync makes `~/logs/nginx` a link to that directory, so CloudPanel's **Logs**
tab (a `sudo ls` and read of `/home/<site user>/logs/nginx/`), the site user's
shell and `/etc/logrotate.d/<site user>` keep working. Logrotate's `create`
then leaves a new log owned by the site user in root's directory, which it can
write but not replace with a link. The first time, the sync copies each
log-named file from the old directory, opened without following links or
blocking on a FIFO and only with one link, at most its last 64 MiB. It removes a
file once it has copied all of it, and moves the old directory aside as
`nginx.before-clp-addons-<time>` when anything is left. Everything it does in
the user's directories goes through directory descriptors opened with
`O_NOFOLLOW`, and it sets owner and mode on open descriptors, never by path, so
a link the user swaps in meanwhile is never followed. `chown -R`, which
CloudPanel's `clpctl system:permissions:reset` runs on the home, changes the
link itself, not its target.

A deleted site's directory goes at the next sync. CloudPanel deletes a site's
vhost, reloads nginx, deletes the user with its home and logrotate file, then the
row; the reload's sync still sees the row, and the new-site watcher's, which the
row's deletion wakes, removes the directory. The sync removes a directory only
when no site row names its user and no vhost in `sites-enabled`, read through
links, names a path in it, and `rmSync` removes links without following them.
The logs go at once rather than being kept a while: CloudPanel deletes the
copies in the home at the same time, and a new site given the same user name
would otherwise get the old site's logs, since the sync gives the directory to
the user's new group.

The sync also rewrites CloudPanel's two exact log lines in each rendered vhost
before nginx loads it, with the access-log format the site's Cloudflare setting
asks for. That covers a new site before the watcher reaches it, a rendered vhost
whose placeholders cannot be read back, and CloudPanel's Cloudflare form, which
re-renders the stored line with its old format. It leaves a vhost that root is
not alone in being able to write, such as one with mode `0664`. The page lists
each site whose rendered vhost still names a log in the home, and is not "On"
while there is one.

Switching on writes the includes, log directories and the drop-in, then swaps
the Varnish and log placeholders in every stored vhost, and in each rendered one
whose placeholders read back from its stored one, in one database transaction
with `nginx -t` and a reload, undone together on failure. A rendered vhost that
differs from its stored one keeps its Varnish line until CloudPanel renders it,
but gets the log lines. The new-site watcher and repair do the same for new
sites, whose stored vhost comes from CloudPanel's template with the
placeholders. The guard refuses a Vhost editor save that brings
`{{varnish_proxy_pass}}`, `{{nginx_access_log}}`, `{{nginx_error_log}}` or an
`access_log` or `error_log` under `/home` back, administrators' included.
Switching off removes the drop-in, puts `~/logs/nginx` back as the user's
directory with a copy of the logs, puts the placeholders back in the stored
vhosts and the home and Varnish lines back in the rendered ones, reloads, then
removes each include no rendered vhost names; a rendered vhost that is not
root's alone refuses it, since the paths it names are about to go. The copy
follows the same rule as switching on: log-named files only, read without
following links, at most the last 64 MiB of each. So each log directory no
rendered vhost names is moved to `/var/log/clp-addons-nginx-kept/<site
user>-<time>`, in a directory only root can open, and only the files copied in
full and unchanged since are deleted from it. What is left, such as a larger
log, another file, or the lines nginx wrote between the copy and the reload,
stays there for the operator; a move that fails leaves the directory where it
is. A
switch-off that fails there puts the guard, drop-in and links back at once,
since the setting stays on. The page's "On" also needs the drop-in in place and
no stored vhost holding the placeholders or a log path in the home.

CloudPanel writes `/etc/logrotate.d/<site user>` once, at site creation, from
a template that rotates `/home/<site user>/logs/*/*.log` with `su root root`.
logrotate then renames and creates files as root wherever a folder the user
put in `~/logs` points. With the setting on, the sync swaps that exact file for
two blocks: `~/logs/php` and `~/logs/varnish-cache` with `su <site user>
<site user>`, and `/var/log/clp-addons-nginx/<site user>/*.log` as root with
`create 0640 root <site user>`. logrotate still runs the `postrotate` nginx
reload as root under `su`, and a rename through a link the user swapped in is
refused. A file that is neither CloudPanel's nor the
addon's stays as it is and is listed on the page; one still CloudPanel's keeps
the page from "On". Switching off puts CloudPanel's file back.

The guard also sees only new saves. A value saved before it was in place stays in
CloudPanel's database. So the state read and repair check every stored value the
guard has a rule for, and each site's Varnish file as the sync reads it.
`vhost-values.ts` holds the guard's rules again;
`tests/fixtures/vhost-guard-values.json` is sent to the PHP by the integration
test and checked against the TypeScript by `bun test`, so the two give the same
answers. A value either would refuse is listed by site and field,
on the page and in repair's output. Nothing is changed: a match is a value to
look at, not proof of an attack.

`bun tests/integration/integration-vhost-guard.ts` runs the guard in Docker on
PHP 8.1, 8.4 and 8.5 against the advisory's payloads, legitimate values,
sessions for each role, and a Vhost editor save holding the Varnish placeholder.

## PHP pool isolation

CloudPanel's pools listen on `127.0.0.1:<port>`, from 11000 for PHP 7.1 to
20000 for PHP 8.5 and the site ports above each, with `listen.allowed_clients
= 127.0.0.1`. That stops other hosts, not other accounts on this one: any local
process can send FastCGI with its own `SCRIPT_FILENAME` and `PHP_VALUE` and run
PHP as the pool's user. Unix sockets with per-pool permissions would close it
too, but CloudPanel renders `fastcgi_pass 127.0.0.1:{{php_fpm_port}};` into
every vhost and rewrites pool files on PHP changes, so a socket would break the
site whenever either side was re-rendered without the other.

So `pool-isolation.ts` loads `table inet clp_addons_php_pools`. It reads every
`[pool]` in `/etc/php/<version>/fpm/pool.d/*.conf` with a TCP `listen` and its
`user`, and on output to `lo` accepts those ports from uid 0, the panel's user,
nginx's `user`, and each port's own pool user (a set of `port . uid`), then
rejects the rest with a TCP reset. Only those exact ports are matched, since
memcached's 11211 sits inside the range. The table is loaded with `nft -f`
from `/var/lib/clp-addons/system-tweaks/php-pools.nft` in one transaction that
creates and deletes it first, so a refused file leaves the previous rules. ufw
rewrites only its own chains in `ip filter`, so `ufw reload` and CloudPanel's
Firewall page leave the table in place.

CloudPanel reloads or restarts a version's unit with `systemctl` whenever it
adds, moves or removes a pool, after writing the pool files. A drop-in on each
`php<version>-fpm.service` runs `clp-addons sync-php-pools` as `ExecStartPre=`,
which also loads the table after a reboot. On a reload the unit's own
`ExecReload=` sends `USR2` and returns before PHP-FPM has bound the new ports,
so the sync runs both before and after it. The drop-in resets `ExecReload=` and
lists `sync-php-pools --before-reload`, the unit's own reload lines as systemd
assembles them from its file and the other drop-ins, then `sync-php-pools`.
The first loads the pool files' ports together with those already in the
table, so a new or moved port is closed before PHP-FPM listens on it. PHP-FPM
takes over its sockets and lets the old ones go only after `systemctl reload`
returns, about 80 ms later on staging, so the second, and every other sync,
keeps a loaded port no pool file names while `/proc/net/tcp` or `tcp6` still
shows something listening on it, and drops it at the next sync after that. A
kept port admits only the user it had, and only while no pool file names it,
so a port handed to another site's pool admits that pool's user alone. Both
syncs ignore failure so PHP-FPM still reloads, and the 15-minute repair loads
the table again. A unit whose reload lines cannot be
read, such as one with a continued line, gets the sync after its reload only.
The page's "On" compares each drop-in with the unit's current reload lines, so
a package update that changes them is fixed by the next repair.
`ExecStartPost=` is not used: the units are `Type=notify` with a `PIDFile=`,
and with a start-post command systemd waits for a PID file PHP-FPM does not
write, so the start times out. The sync reads the setting without
the system tweaks lock, since a change on the page can be what reloads PHP-FPM,
and removes the table again if the setting went off while it was loading.
Repair and re-enabling the addon put the drop-ins and table back; switching
off and disabling the addon remove both. "On" needs the drop-in on every
version as the unit's reload lines give it now, the table loaded, and its
ruleset closing every pool file's port to the right users; a port it keeps
closed until the next sync does not count against it.

## File Manager

CloudPanel's File Manager runs in its own PHP-FPM pool, `[clp-file-manager]`,
as root. It takes the site user from the panel session and joins each path a
request names to `/home/<site user>/`. Its own `checkPath` resolves the path and
compares a string prefix, so `/home/user-other` passes for `/home/user`, and
several actions skip even that. On CloudPanel 2.5.4 a plain panel account can:

- read any file as root by compressing an ID with `..` in it, or a link the File
  Manager's own extract made, then downloading `archive.zip`;
- create a root-owned file anywhere by making `archive.zip` a link before
  compressing;
- move a file anywhere by moving it onto a link of the same name, since `mv`
  follows a link to a folder;
- write over any file by copying onto a link, or into an existing folder of the
  copy's name that holds a link where `cp -a` puts the copy: `cp` writes
  through a link it meets inside a target folder;
- give the site user any file, because creating a folder over a link runs
  `chown` and `chmod` on the link's target;
- extract device files and setuid-root programs, since `bsdtar` keeps an
  archive's owners, modes and device nodes when root runs it. A device file the
  site user can write is the raw disk.

**Keep the File Manager in the site's home**, on by default
(`confineFileManager`), puts `file-manager-guard.php` in front of CloudPanel as
the pool's `auto_prepend_file`, with a pool file,
`pool.d/zz-clp-addons-file-manager-guard.conf`, that reopens
`[clp-file-manager]`. It is a separate setting from Block nginx config
injection because it guards a different pool against a different attack, and
fails differently: an operator who has to switch one off for a false refusal
keeps the other. Installing, health checks, repair and removal are the vhost
guard's (`pool-guard.ts`), with the File Manager's page standing in for the
login page and a malformed session cookie for the probe: CloudPanel alone
answers it with an empty page, and the guard with a 403. Switching it off saves
the opt-out before removing the guard, and puts the setting back on if the
removal fails, so repair never reinstalls a guard the administrator took away
or leaves one in place that the setting says is off. A withdrawal that fails
after removing it queues it back while the setting is on, since the addon stays
enabled.

Each installed guard is one file. `panel-session.php` is written into both in
place of their `require` of it, so the two never depend on a third file and
`tests/integration` runs exactly what is installed.

The guard refuses with a 403, a JSON error naming the reason, and a line in the
panel's PHP error log. It refuses:

- a `cloudpanel` cookie that is not a session ID, or a session it cannot read,
  on both of CloudPanel's scripts, which put the cookie into a file path;
- a backend action it does not know, so a CloudPanel update that adds one is
  refused until this addon checks it;
- a site user name with anything but letters, digits and `._-`, which
  CloudPanel passes unescaped to `chown`;
- any path a request names, for every action, that has a `..` segment or passes
  through a symbolic link at any step from the home down, including the last;
  a path that does not exist yet is one CloudPanel will create;
- the paths CloudPanel derives: a rename's new name, a copy's `<name>_copy`, a
  move's destination file, an upload's file, a new file or folder,
  `archive.zip` in a compress target, and the copy and output of a `.gz` it
  extracts;
- a copy, move or `.gz` copy target that already exists as a folder and holds a
  link anywhere under it, since `cp` and `mv` put the item inside that folder
  and `cp` writes through a link it meets there. `bsdtar` replaces links in its
  destination, and the `chown -R` and `find -P` CloudPanel runs afterwards do
  not follow them, so a tar or zip destination is checked only at its own path;
- the site's home itself as the file to delete, rename, copy, move or extract;
- a permissions value other than three or four octal digits;
- an archive whose `bsdtar -tv` listing has a device file, FIFO, socket,
  setuid or setgid entry, or does not list cleanly. Links inside an archive are
  extracted, since `bsdtar` will not extract through one, and the rules above
  refuse them afterwards.

### Every write as the site user

The checks above run before CloudPanel acts, so a site user with SSH, SFTP or
PHP on the site can plant a link in between, and every action CloudPanel ran as
root then wrote, read or changed where it points. On staging, loops flipping a
link into root-only files won against new files and folders, saving a text
file, tar and zip extraction and copies, and put a root-only file's contents
into downloads and archives. So once a request passes the checks, the guard is
CloudPanel's backend for every action that writes, deletes, changes
permissions, or reads a file's contents: text reads and saves, download,
rename, delete, new file and folder, upload, permissions, copy, move, extract
and compress. CloudPanel's code for those never runs. Each command runs as the
site user with `runuser -u <user> --` and an argument list, never a shell
string. Steps CloudPanel does with PHP's own functions run under the pool's
umask (022), and steps it does through `sudo` under `sudo`'s (the pool's with
022 added). A link planted at any moment can then only reach what that user
could already reach.

Where CloudPanel calls a PHP function rather than a command, so the result
depends on that function's own behaviour, the guard runs the same function in a
PHP CLI of the pool's version, as the site user: `file_get_contents` and
`readfile` for text and downloads, with `finfo_file` and `filesize` for the
download's headers; `file_put_contents` for a save; `mkdir`, `rename` and the
`chmod` `move_uploaded_file` does, for an upload, whose temporary file the guard
hands it on standard input; and `ZipArchive`, walked as CloudPanel's compress
walks folders, for an archive. The helper's code is in the guard and goes to
the CLI as an argument, since the site user cannot read CloudPanel's or this
addon's files. The guard refuses before doing anything when that CLI, or its
`zip` or `fileinfo` extension, is missing.

The guard does what CloudPanel does, step for step, and answers as it does,
since the File Manager's page reads those answers:

- It starts the File Manager's own PHP session before answering, as
  CloudPanel's backend does, so the replies carry the same cookie and cache
  headers.
- A path that does not resolve ends the request with `File is not valid: `, as
  CloudPanel's `checkPath` does. The guard clears PHP's realpath cache first,
  which outlives a request in an FPM worker. Where CloudPanel answers `[]`, an
  empty body, or nothing, so does the guard, for the same inputs, including
  names its `isFilenameValid` refuses.
- Replies that describe a file are that file as CloudPanel's own
  `App\File\Manager::getFileData` describes it: the guard loads CloudPanel's
  class and calls that private method by reflection, so the fields are
  CloudPanel's and follow its updates. It refuses before doing anything if the
  class or the method is missing.
- A failed command CloudPanel leaves uncaught answers an empty 500, as its
  uncaught exception does, and the guard logs the command's error. One it
  catches, in extract and compress, gives its
  `Command " : <command>" failed, error message: <output>` text, with the
  command as CloudPanel shows it less `/usr/bin/sudo`.
- Names and steps follow CloudPanel's: a copy's `<name>_copy.<ext>` or
  `<name>_copy` (`noext_copy.` for a file without an extension), `chmod 770` on
  what a copy, move, new file or new folder produces, `rm -rf` or `rm -f` for a
  delete, `find -P` running `chmod` on folders then files for permissions,
  `bsdtar -p` for tar and zip (root's `bsdtar` keeps the archive's modes, and
  `-p` does that for anyone), and `mkdir -p`, `cp` and `gunzip` for a `.gz`.
- CloudPanel's `chown` to the site user after each action has nothing to do
  for files that user made, so the guard runs none. Its `chmod 770` after an
  upload or extract runs in the background and is killed with its request, so
  the guard runs none either.

One step stays root's: the permissions action hands everything under the file
to the site user, which only root can do. The guard runs it as
`find -P <home> ... -execdir chown -h <user>:<user> {} +`, which starts at the
home, which only root can replace, descends only along the file's own path and
then through the file, never follows a link, and runs `chown -h` from inside
each folder by name, so a link planted anywhere is changed itself rather than
followed. With `fs.protected_hardlinks` the site user cannot link one of root's
files in either; without it the guard skips this step.

The guard's checks stay in front of all of it as a first refusal, including the
archive listing, now also run as the site user. A site user cannot make a
device file, and a setuid program they extract is their own, but such an
archive is still refused before anything happens.

Results differ only where root could do more than the site user: a file the
site user cannot read cannot be read, downloaded, copied or compressed, and a
folder they cannot write takes no new files; every file in a copy is the site
user's, where root's `cp -a` kept other owners below the top; and an upload or
extract no longer hands the rest of an existing folder to the site user, which
CloudPanel's `chown -R` did.

Folder listings stay with CloudPanel. They read names and file details, not
contents, so a link planted mid-listing shows at most the names, sizes, owners
and dates in a folder it points to. The file details in the guard's own
replies are read as root the same way.

The File Manager's own listings give every file and folder the ID of its
resolved path, so browsing and acting on listed files never names a link. A link under the home is still there and still works for the site; only
the File Manager will not follow it. CloudPanel's compress walks folders
without following links to folders and stops at a link to a file outside the
home, so the guard checks only the named sources.

The same pool file sets `listen.owner = clp` and `listen.mode = 0600`. The
socket was `root:clp 0660`, and group `clp` holds the `clp-addons` service
account as well as `clp`. Any of its members could have asked the root pool to
run a PHP file. `clp-addons` needs the group for one thing: the manager sets its
own socket's group to `clp`, which a process can do only for a group it is in,
so the panel's Nginx, running as `clp`, can reach `/addons/`. Taking it out of
the group would close that page. The File Manager has no client but the panel's
Nginx, so its socket goes to `clp` alone. A reload keeps the socket FPM already
has, so the install sets its owner and mode itself, and the page's "On" needs
them. Switching off gives it back to `root:clp 0660`.

What a guard in front of CloudPanel cannot fix:

- `checkPath`'s prefix comparison and the unescaped arguments in CloudPanel's
  `ChmodCommand` and `ChownCommand` stay in its code. The guard refuses every
  request that would reach them with a sibling home or a shell word.

`bun tests/integration/integration-file-manager-guard.ts` runs the guard in
Docker on PHP 8.1, 8.4 and 8.5 against each action, with a home holding links
out of it and archives with device files, FIFOs and setuid programs. Every
action the guard does runs as a real site user against a stand-in for
CloudPanel's class, and the test checks each answer, the download's headers,
the owner, mode and contents of what is left on disk, that files and folders
only root can reach stay out of reach, and that the permissions action hands
root's files under its target to the site user.

## Abandoned temp files

A PHP request stopped by `max_execution_time` or `request_terminate_timeout`
skips the cleanup that would remove its scratch files, and a CloudPanel box
empties `/tmp` only at boot. An image too large for ImageMagick's memory limit
is cached on disk, so a WordPress image job that keeps timing out leaves close
to a gigabyte in `/tmp` on every try, and has filled a production disk that way.
Clearing them is upkeep for the server rather than a PHP-FPM limit, so System
Tweaks owns it, and an install with the installer's defaults has it. PHP
Resources runs the same pass while System Tweaks is off, since an update never
enables an addon and a box with PHP Resources alone would otherwise lose it.

The repair timer removes them every 15 minutes, as the first step of System
Tweaks' upkeep, so a failing update or panel PHP check cannot stop it. It takes
the PHP sites' users from CloudPanel's own records, reads only the top level of
`/tmp`, never follows a symlink, and removes a regular file only when a PHP
site's own user owns it, no process has it open or mapped, and it matches one of
three names: ImageMagick's `magick-*` after two idle hours, and PHP's
`php??????` uploads and WordPress's `wp_tempnam()` `*-??????.tmp` files after a
day, since those are closed between being written and being read.

Cleanup inspects process file descriptors and memory maps before deleting any
file. A closed descriptor or a process that has exited can be skipped; an
inspection failure for a process whose directory still exists stops the cleanup,
and the pass reports it, as it does unlink errors other than a file that has
already gone. The rest of the upkeep still runs.

## Login jails

CloudPanel has no limit on failed panel logins, and several of its weaknesses
start with one. Two settings give fail2ban a jail each: **Block panel login
guessing** (`loginJails.panel`, on by default) and **Block SSH login guessing**
(`loginJails.ssh`, off by default). Both ban after 5 failures within an hour,
for an hour, and only on their own port: 8443 for the panel, sshd's ports for
SSH. An operator who mistypes the panel password from the office can still SSH
in and unblock themselves, and the reverse.

### Where failed panel logins come from

CloudPanel's `event` table records only successful logins, and the panel's
nginx has `access_log off;`. Its login form is Symfony's: a failed `POST /login`,
a bad CSRF token included, answers 302 to `/login`, and a successful one 302 to
`/` or the page the visitor wanted. A wrong two-factor code re-renders
`/login/mfa` with 200, and the right one answers 302. The panel's basic auth
answers 401, and a 401 to a request carrying a user name is a wrong password.

So the panel's `nginx.conf` gets a marked block in place of its http-level
`access_log off;` (kept, commented, as `#clp-addons:login-log access_log off;`):
three `map`s that name a failure `password`, `mfa` or `basic-auth`, and an
`access_log` to `syslog:server=unix:/dev/log` tagged `clp_addons_panel` with
`if=` on that name. Nothing else is logged. The server block in `cloudpanel.conf`
has no `access_log` of its own, so it inherits this one; editing the http block
leaves `cloudpanel.conf` alone, which the `/addons/` proxy's baseline hash
covers. If an operator gives the server block its own `access_log`, the jail
sees nothing.

The maps match `$request_uri`, the path as the client sent it, because by the
time nginx logs, `try_files` has changed `$uri` to `/index.php`. Symfony 6's
router matches the path after `rawurldecode`, and it takes `/index.php` off the
front as the base URL, so `/login/%6dfa`, `/login%2Fmfa` and
`/index.php/login/mfa` all reach the two-factor form. Each map therefore
accepts any character of the path, and of an optional `/index.php` prefix,
either as itself or percent-encoded, and ignores case. A spelling that matches
but that CloudPanel does not route, such as `/LOGIN/MFA`, gets a 404 and is not
counted, so the wider match adds no false failures. The password login needs no
such care: Symfony's form authenticator runs only when the raw path is exactly
`/login`, and every other spelling just renders the form.

The line names `$realip_remote_addr`, the address that opened the connection,
because that is what nftables can block. `$remote_addr` would be wrong both
ways: behind Cloudflare it is the visitor, whom a ban on this server cannot
stop, and through a proxy the panel trusts it can come from a header. The
panel jail's `ignoreip` holds the private ranges and Cloudflare's list (from
`/etc/nginx/cloudflare/ips`), the proxies the panel trusts, so the jail never
blocks a proxy and everyone behind it. Behind Cloudflare the jail therefore
blocks nothing; Cloudflare's own rate limiting is the tool there.

### The custom domain

CloudPanel's custom domain (Admin → Settings) is a vhost of the sites' nginx,
`/etc/nginx/sites-enabled/custom-domain.conf`, that proxies to
`https://127.0.0.1:8443/` with `X-Forwarded-For $remote_addr`. The panel's
nginx sees every such login from `127.0.0.1`, which the panel jail never bans.
Trusting the forwarded address when it comes from loopback would let any local
account, a site's SSH user included, connect to `127.0.0.1:8443` with a
header naming the operator's address and have it banned.

So the same maps go at the top of that vhost, outside its server block, and an
`access_log` tagged `clp_addons_domain` goes after its `server_name`. The sites'
nginx logs `$realip_remote_addr`, the client's own connection. Its workers run
as root on CloudPanel (the `user` line of `/etc/nginx/nginx.conf`), so the
`clp-addons-domain` jail matches `_UID=0`, and only root can write a line it
counts. It bans on 443. nftables cannot see which host a client asked for, so
an address blocked there loses HTTPS to every site on the server for the hour;
the page says so. The jail has the panel jail's `ignoreip`, so a custom domain
behind Cloudflare is not throttled either.

CloudPanel rewrites the vhost whenever an administrator saves the custom
domain, and the 15-minute repair puts the log back, so logins through a newly
saved domain can go uncounted for up to 15 minutes. The new-site watcher wakes
on that write too, but runs its hooks only when the list of sites changes. A vhost with more than one server block or
`server_name` is left alone, and the page says that logins through it are not
counted. The edit uses the shared nginx transaction for the sites' nginx: `nginx
-t`, a reload, and the file restored on failure.

journald stores the lines of an account with uid 1000 or above, such as `clp`,
in that user's journal, which fail2ban's systemd backend skips by default, so
the jail uses `backend = systemd[journalflags=1]` (local journals, every user).
Its `journalmatch` is `SYSLOG_IDENTIFIER=clp_addons_panel _UID=<clp's uid>`.
journald takes `_UID` from the socket's credentials, so another local account
can `logger -t clp_addons_panel` but cannot get a line matched, and cannot get
an address banned. A log file would need rotating, and nginx gives a reopened
log to its worker account.

### fail2ban's files and bans

Three files, each rewritten whole and removed when both jails are off:

- `/etc/fail2ban/jail.d/clp-addons.local` holds the jails. A `.local` in
  `jail.d` is read after `jail.local`, so its `[sshd]` decides: `enabled = false`
  while the SSH setting is off, which also stops Debian's `defaults-debian.conf`
  from starting an sshd jail that fails without `/var/log/auth.log` and takes
  fail2ban down with it.
- `/etc/fail2ban/jail.d/00-clp-addons.conf` sets `[DEFAULT] ignoreip =
  127.0.0.1/8 ::1`. The jails add to it with `%(known/ignoreip)s`, which fails
  when nothing defined it before; as a `.conf` read first, an operator's own
  `ignoreip` in `jail.local` replaces it and is kept. fail2ban's
  `ignoreself` covers the server's own addresses.
- `/etc/fail2ban/filter.d/clp-addons-panel.conf` matches the nginx line.

Bans use `nftables-multiport`, which keeps them in fail2ban's own
`inet f2b-table`. CloudPanel's Firewall page runs `ufw --force reset`, and ufw
flushes only the iptables-nft `ip filter` and `ip6 filter` tables, so the bans
stay. Debian's default `iptables-multiport` chains would be flushed with them.
The chain hooks input at priority -1, before ufw's.

The SSH jail reads the journal with `backend = systemd`, since Debian 12 ships
without rsyslog. It is off by default because a client that offers several
wrong keys counts as failed logins, which could block the operator from the one
way in that does not depend on the panel. The setting never edits
`sshd_config`: turning off password or root login without a working key locks
the operator out. The page reads `sshd -T` and says when sshd accepts passwords
or root can log in with one, and how to change it.

### The service

The jails need `fail2ban`, `python3-systemd` and `nftables`; the page offers to
install whichever are missing, and does nothing until they are there. Writing
the files runs `fail2ban-client -t`, and a refused config puts the files back.
A running fail2ban is reloaded, a stopped or failed one restarted and enabled
at boot. A masked unit is left alone.

The first time it starts fail2ban, System Tweaks records whether the unit was
enabled and running (`fail2banBefore`). Switching both jails off, or disabling
System Tweaks, removes the files and both nginx edits, then stops or disables
fail2ban only if it was not running or enabled before; an operator's own fail2ban
is reloaded and keeps running. If fail2ban was already running with an `sshd`
jail when System Tweaks took over, the SSH setting turns on with it, so the
operator's SSH protection stays. Installing fail2ban from the page records it
as not running before.

The 15-minute repair rewrites the files and both nginx edits, restarts a
fail2ban that stopped, and puts the block back after CloudPanel rewrites the
panel's `nginx.conf`. The page lists each jail's bans with
`fail2ban-client get <jail> banip --with-time`, and its Unblock runs
`fail2ban-client set <jail> unbanip <ip>`; the `unban` verb takes only these
three jails and an address.

On a CloudPanel whose panel shares the sites' nginx there is no panel
`nginx.conf` to edit, so the panel jail says it cannot run there.

## Firewall

CloudPanel's Firewall page (Admin → Security → Firewall) opens every rule for
TCP only, so a UDP port such as WireGuard's or DNS needed ufw by hand. That does
not last: every add, edit or delete there runs `ufw --force reset`, re-adds each
row of its `firewall_rule` table with `ufw allow proto tcp from <source> to any
port <range>`, adds UDP 443 for HTTP/3 from `0.0.0.0/0` and `::/0`, and enables
ufw. Anything else, an edit to `/etc/ufw/*.rules` included, is gone after the
next change on that page. The table has no protocol column, and Symfony refuses
a field its form does not declare.

So System Tweaks keeps the protocol itself, in
`/var/lib/clp-addons/system-tweaks/firewall.json`, keyed by what the rule is:
its port range, as CloudPanel's form stores it, and its source, as ufw writes
it (`"51820 0.0.0.0/0": "udp"`). CloudPanel already refuses two rows with the
same port range and source. A protocol applies only to rows that match exactly;
every other row is TCP, CloudPanel's own, so choosing TCP deletes the entry.
Rule ids are not used: a rebuilt table (a restore, a CloudPanel migration) can
give an id to another rule, which a stored "UDP only" would then strip of TCP,
SSH included, and ids say nothing on a box whose rules were renumbered. Rows
whose source differs only in spelling (`203.0.113.9` and `203.0.113.9/32`) share
a protocol.

It adds a Protocol field (TCP, UDP, TCP and UDP) after Port Range on the add and
edit forms, and a Protocol column after Port Range in the table, which fills
from the `firewall` verb. The field has no name and shows once System Tweaks
answers. Both forms send their Port Range, Source, protocol and, on the edit
form, the rule's id to `set-firewall-protocol`, then submit. That refuses UDP
alone for port 8443, which would close CloudPanel's own panel to TCP, and a
change to a port range and source another rule already has, since CloudPanel
then refuses the form as a duplicate or saves a row that shares the protocol. A
failed request stops the form with an error. System Tweaks' page gets one line:
the UDP ports the protocols open, with a link to the Firewall page.

The form sends its choice before CloudPanel saves the row, and a pass can run in
between, so an entry no row has matched yet waits an hour. One that matched and
no longer does is forgotten at once: deleting a rule, or editing its port range
or source, retires it. An entry left by a form CloudPanel refused can only ever
apply to a rule with exactly its port range and source.

`clp-addons-firewall.path` watches `/etc/ufw/user.rules` and `user6.rules`
while System Tweaks is enabled, which is how it learns that CloudPanel rebuilt
ufw; the 15-minute repair runs the same pass. `clp-addons sync-firewall` runs
each installed addon's `firewall` hook. The pass waits until both files have
been still for two seconds, since the rebuild writes them once per command,
then, under its own lock, forgets entries as above and compares ufw's `### tuple ###` lines with the protocols. Sources are
compared the way ufw records them: the network address, without `/32` or
`/128`, IPv6 compressed. It repeats until a pass changes nothing, at most five
times, so a rebuild still running when it starts is caught, and refuses to loop
on commands ufw does not take. Its own writes wake the watcher once more, which
finds nothing to do.

It touches only what a protocol asks for. UDP adds `allow proto udp` and deletes
CloudPanel's TCP rule for that port and source, unless another TCP rule for both
still wants it; TCP and UDP adds the UDP rule. Additions run before deletions.
The rules it changed are recorded, so a rule set back to TCP, or every rule when
System Tweaks is disabled or uninstalled, goes back to CloudPanel's own: TCP
for each row, and UDP 443 untouched. Rules the operator added for other ports
are left alone, until CloudPanel's next rebuild removes them as it always did.
ufw runs with argument arrays; ports and sources from the table must match a
port, a range, an address or a CIDR, or the row is skipped.

Disabling marks the protocols withdrawn under the same lock before putting
ufw back, because that change wakes the watcher, which must not apply them
again. A failure there warns and does not keep System Tweaks on. Enabling clears
the mark and applies the kept protocols.

CloudPanel v3: CloudPanel's own migration carries the rules, and keying by
port range and source is what lets the choices follow them. Nothing for v3 is
built yet. If v3 has a protocol of its own, the plan is to write each stored
choice onto the v3 rule with the same port range and source, then retire this
file and the page patch. Without the addon, a UDP rule comes back as TCP.
