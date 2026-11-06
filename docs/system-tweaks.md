# System Tweaks

## Automatic updates

1. Open **Addons → System Tweaks**. If `unattended-upgrades` is missing, choose
   **Install unattended-upgrades**. It can take up to ten minutes when apt is
   busy.
2. Switch on **Install updates automatically**. It runs once a day, from
   `apt-daily-upgrade.timer`, and installs the distro's security updates and
   every PHP version CloudPanel ships. Its options appear under it: Nginx is
   included by default; MySQL and CloudPanel itself only if you switch them on.
3. Open **Repositories** to see every apt source and whether it is covered. An
   uncovered source still needs `apt upgrade`.

The page makes one change at a time: while one runs, its row shows **Working**
and the other settings are disabled until it finishes.

**Last run** shows the last result from
`/var/log/unattended-upgrades/unattended-upgrades.log`. Expand **Failure details**
for the complete error, including the package URL if recorded. HTTP 404 means
the repository did not provide the requested package; it is not a successful
update. **Reboot** appears when an update such as a kernel needs a restart. With
automatic reboot on, it says when the server restarts by itself; with it off,
the page warns after a week.

Switch on **Reboot when required** to allow automatic restarts, then choose
**Right after the update run** or **At a set time**. A time is saved when you
leave the field or stop typing. The time uses the server timezone shown next to it, not your browser's.
Switching updates on the first time keeps the reboot policy your apt files
already had. If a later apt file sets another time, the page says so under the
control. Changes affect future update runs and do not reschedule or cancel an
already queued shutdown.

If updates were already on before System Tweaks, the page says **Configured
outside System Tweaks** and names your file. If that setup leaves out
CloudPanel's PHP, the page suggests switching on **Install updates
automatically**, which adds it. Switching off removes only
`/etc/apt/apt.conf.d/52clp-addons-unattended-upgrades`, so your own setup is
left as it was. Disabling System Tweaks removes it too.

On Ubuntu 22.04, 24.04 and 26.04 this uses Ubuntu's security pocket and preserves
any existing Ubuntu Pro/ESM update rules. It does not activate Ubuntu Pro. Ubuntu
may already have automatic updates on; check **Repositories** because that alone
does not cover CloudPanel's PHP builds.

To try a run without installing anything:

```bash
unattended-upgrade --dry-run -d
```

## Remote backup compression

**Compress remote backups with Zstandard** is off by default. CloudPanel
2.5.4-3 creates uncompressed `backup.tar` files for Remote Backups. Switching
this on makes the next remote backup create and upload `backup.tar.zst`.
It applies to scheduled backups and **Create Backup** in CloudPanel.

Compression level defaults to **3**, with **1 worker thread**. Levels 1–19
and 1–8 workers are available. Higher levels trade CPU time and memory for
potentially smaller archives; more workers use more CPU and memory. The space
saved depends on the contents, and already compressed media and database dumps
may shrink little. Scheduling, storage destinations, exclusions and retention
remain CloudPanel's. Database dumps keep their `.sql.gz` format, and existing
backups are untouched.

The server needs the `zstd` package. If the page reports it missing, install it
as root with `apt-get install zstd`. An unsupported CloudPanel version or edited
backup implementation is reported on the page and is not replaced. Repair
re-applies the setting after a supported CloudPanel package restores its own
code. If the package or compressor becomes unsupported while the recognized
tweak is still installed, repair restores the stock command and reports the
problem. Switching off, or disabling System Tweaks, restores the original backup
command; a backup already running finishes in the format it started with.

Restore `.tar.zst` archives over SSH. CloudPanel's File Manager does not offer
extraction for this format. Save the archive as `~/tmp/backup.tar.zst` and, as
the site user, extract it into an empty directory before copying the files you
need:

```bash
mkdir ~/tmp/backup-restore
cd ~/tmp/backup-restore
zstd -t ../backup.tar.zst
tar --zstd -xf ../backup.tar.zst
```

The restore machine also needs `zstd`. Old `.tar` backups still restore with
`tar -xf backup.tar`. Disabling compression does not convert or delete backups
already stored remotely.

## PHP upload-progress mitigation

Every installation turns off `session.upload_progress.enabled` on each PHP-FPM,
CloudPanel's own included, with `99-clp-addons-upload-progress.ini`. Open the
summary under the switch to see each FPM's effective value and which file set
it. Switching the mitigation
off removes only that file. It comes back if System Tweaks is disabled.

## Panel PHP

Under **Addons → System Tweaks → Settings**, choose a newer installed version
in **Panel PHP**. The page warns while the panel is left on PHP 8.1. This changes the PHP used by CloudPanel's pages,
phpMyAdmin and File Manager. Site PHP versions keep their own settings.

The change restarts the panel's PHP service and checks its login page and File
Manager. If either check fails, the previous configuration is restored.
Choose **CloudPanel's own** to undo the override. Disabling System Tweaks also
removes the override; enabling it again reapplies the saved choice through repair.

## Forged visitor IPs

**Block forged visitor IPs** is on by default. Without it, any client can claim
another IP address with a header, and sites, logs, basic auth, the panel and
**Allow traffic from Cloudflare only** believe it. It comments out
`set_real_ip_from 0.0.0.0/0` in the sites' and the panel's `nginx.conf`.
Cloudflare traffic and CloudPanel's own proxying are unaffected. It never holds
an update back: automatic updates still install Nginx, and CloudPanel when that
is switched on.

A panel behind Cloudflare keeps its visitors' addresses. Switch the setting off
only if a load balancer or proxy other than Cloudflare, on a public address,
sits in front of this server or its panel.

## phpMyAdmin

**Lock down phpMyAdmin** is on by default. CloudPanel's own basic auth for the
panel (`clpctl cloudpanel:enable:basic-auth`) skips every address that starts
with `/phpmyadmin`, so `/phpmyadmin/../file-manager/` reached the File Manager
without the password. With the setting on, basic auth skips only phpMyAdmin.
phpMyAdmin's example and setup scripts, the folders its pages never load, and
the files that show its version, such as `composer.json`, return 404. Opening
phpMyAdmin from a site's **Databases** page works as before. Its help links
still open the documentation that ships with it.

Turning the setting off takes the rules out of CloudPanel's panel vhost. While
it is on, repair puts them back within seconds when a CloudPanel update rewrites
that file. The panel vhost can belong to root or `clp`; it does not need a
change of owner. System Tweaks keeps its owner and permissions and refuses
files writable by anyone outside root and the panel's group.

## Panel certificate

**Replace the shared panel certificate** is on by default. CloudPanel serves its
panel on port 8443 with the same certificate and private key on every server, so
anyone who can see the traffic can read it. System Tweaks replaces it with a
certificate made on this server for its hostname and IP addresses. Your browser
warns about the new certificate once. Compare the SHA-256 fingerprint in the
row with the one your browser shows, then accept it.

A certificate you installed yourself is left alone. A CloudPanel custom domain,
set under **Admin → Settings**, keeps its own Let's Encrypt certificate on port
443. Port 8443 still answers on the server's IP, so it gets the new certificate
too.

A CloudPanel update puts the shared certificate back, and the next repair,
within 15 minutes, installs the same generated one again. Run `clp-addons
repair` to do it at once. Switching the setting off stops that and keeps the
certificate the panel has.

To see what the panel serves:

```bash
openssl s_client -connect 127.0.0.1:8443 </dev/null 2>/dev/null | openssl x509 -noout -subject -enddate -fingerprint -sha256
```

## Nginx config injection

**Block nginx config injection** is on by default. CloudPanel writes site
settings such as **Root Directory** into the site's Nginx config without
checking them, so without it any panel account with a site can take over the
server. With it, a value that would add Nginx directives is refused with a page
saying which field, and only administrators can save the **Vhost** editor and
PageSpeed settings. Other users can still view the vhost.

Refusals are logged to `/home/clp/logs/php/error.log` as `clp-addons vhost
guard: refused ...`, with the reason. If an administrator is refused the Vhost
editor and the reason is not a pending two-factor code, the guard could not read
their session: switch the setting off until clp-addons is updated. Turning it off removes the guard.

A site's own shell or SFTP user can also write a Varnish server into
`~/.varnish-cache/settings.json`, which CloudPanel renders into the vhost, or
replace `~/logs/nginx/access.log` and `error.log` with links to any file, which
the root nginx master then appends to. With the setting on, each site's vhost
includes `/etc/nginx/clp-addons-varnish/<domain>.conf` in place of
`{{varnish_proxy_pass}}`, and the addon rewrites that file from the site's
settings each time nginx reloads. A server that would add nginx directives is
left out, and the site skips Varnish until it is fixed.

Each site's nginx logs move to `/var/log/clp-addons-nginx/<user>/`, which only
root can write, and `~/logs/nginx` becomes a link to it, so CloudPanel's
**Logs** tab, the site user's shell and logrotate keep working. If the old
directory held anything besides logs, it stays as
`~/logs/nginx.before-clp-addons-<time>`. Deleting a site deletes its folder
there too, as CloudPanel deletes the logs in its home. Keep the include and log lines when
you edit a vhost: the **Vhost** editor refuses `{{varnish_proxy_pass}}`,
`{{nginx_access_log}}`, `{{nginx_error_log}}` and log paths under `/home`.
The addon only rewrites a vhost that root alone can write. The page lists any
site whose vhost still writes logs in the home: make that file in
`/etc/nginx/sites-enabled` owned by root with mode 644 (`chown root:root`,
`chmod 644`), then run `clp-addons repair`.

CloudPanel's `/etc/logrotate.d/<user>` rotates everything in `~/logs` as root,
so the site's user could point a folder there at any directory and have root
rotate the logs in it. With the setting on, the file rotates `~/logs/php` and
`~/logs/varnish-cache` as the site's user and the nginx logs as root in their
own directory. A file someone edited by hand is left as it is and listed on
the page. Turning the setting off puts the placeholders, the `~/logs/nginx`
directories and CloudPanel's logrotate files back. Anything it cannot copy back
in full, such as a log over 64 MiB, stays in
`/var/log/clp-addons-nginx-kept/<user>-<time>/`, which only root can open;
delete that folder when you no longer need it.

The setting also lists saved site settings it would refuse now, such as a Root
Directory saved before it was on, and Varnish servers it refuses. Check each
one and that site's vhost in `/etc/nginx/sites-enabled/`. `clp-addons repair`
prints the same list.

## Isolate PHP pools

CloudPanel runs each site's PHP on its own port on `127.0.0.1`, which any
account on the server can connect to. A site's shell user, or a script on
another site, could send PHP to that port and run it as that site's user, with
its files and database password. With this setting on, only nginx, the panel
and the site's own user can connect to the site's PHP port. Memcached, Redis
and other local services are not affected.

The rule lives in its own nftables table, `inet clp_addons_php_pools`, which
CloudPanel's **Firewall** page and ufw leave alone. Each PHP-FPM version
refreshes it when it starts, and before and after it reloads, which is when
CloudPanel adds, moves or removes a site. A tool that connects to another site's PHP port from its own
account, such as a monitoring agent, stops working: run it as root or turn
the setting off.

## File Manager

**Restrict File Manager to site files** is on by default. CloudPanel's File
Manager runs as root, and without the setting a panel account with a site can
use it to read, write or take over files anywhere on the server. With it, the
File Manager refuses a request that names a path outside the site's home or
through a symbolic link, and an archive that holds device files or setuid
programs. Browsing, editing, uploading, extracting, compressing and downloading
ordinary files work as before. Links stay where they are and keep working for
the site; the File Manager just will not open them.

Every File Manager action that changes or reads a file runs as the site's own
user rather than as root, so it cannot reach anywhere that user could not:
editing, saving, downloading, uploading, renaming, deleting, creating, copying,
moving, extracting, compressing and changing permissions. Folder listings are
unchanged. Changing permissions still hands everything under the file to the
site user, as before. Files and folders the site user cannot read or write can
no longer be opened or changed from the File Manager, where root used to; fix
their ownership with **Change Permissions** first. Each action logs `runuser`
sessions opening and closing in the system journal.

Refusals are logged to `/home/clp/logs/php/error.log` as `clp-addons file
manager guard: refused ...`, with the reason. If the File Manager refuses
everything with a reason about the panel session, CloudPanel has changed its
session format: switch the setting off until clp-addons is updated.

The setting also lets only the panel's own nginx connect to the File Manager's
PHP. Turning it off removes the guard and gives the socket back to group `clp`.

## Failed logins

**Block panel login guessing** is on by default. After 5 failed panel logins
from one address within an hour, fail2ban blocks that address from port 8443 for
an hour. Wrong passwords, wrong two-factor codes and wrong basic-auth passwords
all count. The block covers only the panel, so you can still reach the server
over SSH.

Logins through CloudPanel's custom domain count too. They pass through the
sites' nginx on port 443, so an address blocked for them loses HTTPS to every
site on this server for the hour, not only the panel.

**Block SSH login guessing** is off by default. Switched on, it blocks an address
from SSH for an hour after 5 failed logins within an hour. An SSH client that
offers several wrong keys counts as failing, so make sure yours offers the right
key first.

Both need fail2ban. If it is missing, choose **Install fail2ban**, which installs
`fail2ban`, `python3-systemd` and `nftables`. Switching both jails off, or
disabling System Tweaks, puts fail2ban back as it was: stopped if it was not
running before, and still running with your own jails if it was.

Never blocked: loopback, this server's own addresses, private networks and
Cloudflare. Behind Cloudflare the server sees only Cloudflare's addresses, so
the panel jail blocks nothing; use Cloudflare's rate limiting there. Add your
own addresses to `ignoreip` under `[DEFAULT]` in `/etc/fail2ban/jail.local`,
keeping `127.0.0.1/8 ::1`, then run `fail2ban-client reload`.

Blocked addresses are listed under the jails, each with **Unblock**. Over SSH:

```bash
fail2ban-client status clp-addons-panel   # or clp-addons-domain, sshd
fail2ban-client unban 203.0.113.7
```

The setting never changes sshd. The page warns when sshd accepts passwords or
root can log in with one. To stop that, first check that your key logs in, then
put these lines in a file such as `/etc/ssh/sshd_config.d/10-keys-only.conf` and
run `systemctl reload ssh`:

```
PasswordAuthentication no
PermitRootLogin prohibit-password
```

## clpctl injection

**Block clpctl injection** is on by default. CloudPanel's `clpctlWrapper` lets
every local account, including each site's own Unix user, run four clpctl
commands as root, and a crafted option value can break out of the shell clpctl
builds and run anything as root. A hacked site runs as its site user, so without
this a site compromise becomes a server compromise.

With it, System Tweaks replaces `/usr/bin/clpctlWrapper` with a version that
passes root and the panel through unchanged and, for every other caller, allows
only `db:export`, `system:permissions:reset` and `varnish-cache:purge` with
option values that hold no shell metacharacter:

- `db:import` is **refused** for site users. CloudPanel runs an imported dump as
  the database administrator, so its SQL could read or change any site's
  database, not just the caller's. Import your own database instead with your own
  credentials — through phpMyAdmin, or `mysql -u<your database user> <your
  database> < dump.sql` — which confines the import to that database.
- `system:permissions:reset` is allowed only on the caller's own home directory
  as a whole, which cannot be redirected by a symlink. Resetting a single
  subfolder is no longer possible with the guard on.
- `db:export` is written by clpctl as the caller and only for the caller's own
  database, so it works as before.

The panel's own operations and `clpctl db:import`, `site:add`, `db:add` and the
rest are untouched when run as root, so the panel, the Stager and operators are
unaffected.

The setting is version-pinned: it installs only over a wrapper and CloudPanel
version it was built against, saving the original first. If CloudPanel ships a
wrapper it does not recognise, or a version it does not know, the page shows
**Paused** and leaves CloudPanel's own wrapper in place, so clpctl is never
broken; update clp-addons to pick up the new version. Once the hardened wrapper
is installed it stays on across a CloudPanel version bump; the version is checked
again only if a CloudPanel update has put its own wrapper back, in which case
`clp-addons repair` re-hardens when the version is known and otherwise leaves the
original in place. Turning the setting off restores CloudPanel's original wrapper
exactly. If the saved copy of the original is ever lost while the hardened
wrapper is installed, the page says so and clpctl stops until you restore
CloudPanel's wrapper and run `clp-addons repair`.

This closes the break-out. CloudPanel itself still has to fix the root cause:
clpctl stripping backslashes from its arguments, its commands building shell
strings from option values, `db:import` running the dump as the database
administrator, and the panel user `clp` having full `sudo`.

## CloudPanel telemetry

**Block CloudPanel telemetry** is on by default. Once a day CloudPanel's
`clp-agent` sends CloudPanel the server's ID and hardware, every site's domain
and every panel user's name and email. The setting cuts the agent off from the
network, so nothing leaves the server; it keeps drawing the dashboard's graphs.
CloudPanel's update and announcement checks still work.

To check it, `systemctl show clp-agent -p IPAddressDeny` prints
`IPAddressDeny=0.0.0.0/0 ::/0`. Switching it off removes the drop-in and
restarts the agent.

## Abandoned temp files

Every 15 minutes System Tweaks removes the PHP and ImageMagick temp files that
timed-out requests left in `/tmp`: ImageMagick's after two idle hours, PHP
uploads and WordPress downloads after a day. It removes only files a PHP site's
own user owns and no process has open. There is nothing to set. PHP Resources
does the same while System Tweaks is off.

## UDP ports

CloudPanel's own **Admin → Security → Firewall** gets a **Protocol** for each
rule: TCP, UDP, or TCP and UDP. Choose it on **Add Rule** or a rule's edit page,
after **Port Range**. The rules table shows it in its **Protocol** column, and
System Tweaks' page lists the UDP ports that are open. A protocol belongs to
the rule's port range and source. UDP alone is refused for port 8443, which
would close CloudPanel itself to TCP; choose TCP and UDP there.

The change reaches ufw a few seconds after the page saves, and stays through
later changes on the Firewall page. Check it with `ufw status`. Disabling
System Tweaks sets every rule back to TCP in ufw and keeps the choices for
when it is enabled again.

## MySQL access

The **Database** card shows where MySQL listens, whether the firewall rules
loaded now let anyone reach it (**Firewalled**, **Open** or **Unknown**), any client connected from another address, and whether its `root` account
still logs in with the password `root` or none.

Switch on **MySQL on this server only** to restrict MySQL or MariaDB to local
connections. It writes `zz-clp-addons-loopback.cnf` into
`/etc/mysql/mysql.conf.d` (or `mariadb.conf.d`) and restarts the database. Sites
lose their database connection briefly. The configuration is checked first;
conflicting startup options or unsupported configurations are reported before
restarting. If the database does not come back within a minute, the previous
configuration is restored and started again. A running server that answers but
still listens publicly is rolled back immediately.

On servers using **mariadb.socket**, systemd owns the listeners and ignores
MariaDB's `bind-address` for those sockets. The setting also adds its own socket
override, keeps the existing Unix sockets, and restricts TCP to localhost.
IPv6 listeners retain access through `::1`. It stops and starts the database
and socket together so the old public listener is closed. Original unit files,
other overrides and socket activation stay in place; switching off removes
only the addon's configuration and restores the server's own listening setup.

Sites, the panel and phpMyAdmin keep working. Anything on another machine that
connects to this MySQL stops working, including a desktop SQL client. Use an SSH
tunnel instead:

```bash
ssh -L 3306:127.0.0.1:3306 root@your-server
```

The setting is off by default, because the page cannot tell whether something
remote uses the database. Check the **Connected now from** line and your
Firewall page for a rule on port 3306 before switching it on. Switching it off
removes the addon's configuration and restarts MySQL (and its socket when used).
Repair and addon activation/deactivation reconcile configuration without
restarting the database. The page reports when the live listener still needs
the saved change applied. For socket activation, a service-only restart does
not replace systemd's listener; apply it during a suitable interruption with:

```bash
systemctl stop mysql mariadb.socket
systemctl start mariadb.socket mysql
```

If the page says root logs in with a default password, change it on every root
account the list below shows. "From this server" is usually `'root'@'127.0.0.1'`
or `'root'@'localhost'`; "from other hosts" is an account such as `'root'@'%'`.
CloudPanel logs in as `'root'@'127.0.0.1'` with the password it stores, so that
account's new password must also go into CloudPanel, or its Databases page stops
working. Change it in MySQL first.

1. List root's accounts, then set a new password on each one:

   ```bash
   mysql -h 127.0.0.1 -u root -p -e "SELECT user, host FROM mysql.user WHERE user = 'root'"
   # The account CloudPanel uses:
   mysql -h 127.0.0.1 -u root -p -e "ALTER USER 'root'@'127.0.0.1' IDENTIFIED BY 'new-password'"
   # Every other host the list shows, such as '%' or 'localhost':
   mysql -h 127.0.0.1 -u root -p -e "ALTER USER 'root'@'%' IDENTIFIED BY 'another-password'"
   ```

   If you do not use `'root'@'%'` from another machine, drop it instead:
   `DROP USER 'root'@'%'`.

2. In CloudPanel, open **Admin → Settings → Database Servers**, edit the `127.0.0.1` server,
   enter the `'root'@'127.0.0.1'` password and save. CloudPanel checks it before
   saving. The other accounts' passwords do not go into CloudPanel.
3. Open a site's **Databases** page to confirm the panel still connects.
