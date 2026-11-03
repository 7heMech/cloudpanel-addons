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
`~/logs/nginx.before-clp-addons-<time>`. Keep the include and log lines when
you edit a vhost: the **Vhost** editor refuses `{{varnish_proxy_pass}}`,
`{{nginx_access_log}}`, `{{nginx_error_log}}` and log paths under `/home`.
The addon only rewrites a vhost that root alone can write. The page lists any
site whose vhost still writes logs in the home: make that file in
`/etc/nginx/sites-enabled` mode 644, then run `clp-addons repair`.

CloudPanel's `/etc/logrotate.d/<user>` rotates everything in `~/logs` as root,
so the site's user could point a folder there at any directory and have root
rotate the logs in it. With the setting on, the file rotates `~/logs/php` and
`~/logs/varnish-cache` as the site's user and the nginx logs as root in their
own directory. A file someone edited by hand is left as it is and listed on
the page. Turning the setting off puts the placeholders, the `~/logs/nginx`
directories and CloudPanel's logrotate files back.

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
refreshes it when it starts or reloads, which is when CloudPanel adds, moves
or removes a site. A tool that connects to another site's PHP port from its own
account, such as a monitoring agent, stops working: run it as root or turn
the setting off.

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
