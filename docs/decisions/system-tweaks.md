# System Tweaks

System Tweaks holds settings for the server rather than for CloudPanel's pages,
which stay with [Panel Tweaks](panel-tweaks.md). PHP worker limits stay with
[PHP Resources](php-resources.md). System Tweaks also owns the PHP version
that runs the panel itself, and the protocol of each rule on CloudPanel's own
Firewall page.

## The page

Two cards: Automatic updates, which an operator comes back to, then one
Settings card for the panel's PHP, the upload-progress mitigation and forged
visitor IPs, which are set once. Each row says what it does in a sentence; the
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
`/var/lib/clp-addons/system-tweaks/firewall.json`, by CloudPanel's rule id
(AUTOINCREMENT, so never reused). A rule with no entry is TCP, CloudPanel's own.
It adds a Protocol field (TCP, UDP, TCP and UDP) after Port Range on the add and
edit forms, and a Protocol column after Port Range in the table, which fills
from the `firewall` verb. The field has no name. The edit form sets its rule's
protocol through `set-firewall-protocol` before it submits. On the add form the
rule has no id yet, so `expect-firewall-rule` records the port range, as
CloudPanel's form normalises it, with the highest rule id at that moment; the
next rules saved above that id with that range take the protocol. A choice
waits ten minutes. A failed request stops the form with an error, except a TCP
choice on the add form, which is CloudPanel's own and submits anyway. System
Tweaks' page gets one line: the UDP ports the protocols open, with a link to
the Firewall page.

`clp-addons-firewall.path` watches `/etc/ufw/user.rules` and `user6.rules`
while System Tweaks is enabled, which is how it learns that CloudPanel rebuilt
ufw; the 15-minute repair runs the same pass. `clp-addons sync-firewall` runs
each installed addon's `firewall` hook. The pass waits until both files have
been still for two seconds, since the rebuild writes them once per command,
then, under its own lock, settles waiting choices, forgets ids no longer in the
table, and compares ufw's `### tuple ###` lines with the protocols. Sources are
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
