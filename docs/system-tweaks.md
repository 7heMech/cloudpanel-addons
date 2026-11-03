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
`~/.varnish-cache/settings.json`, which CloudPanel renders into the vhost. With
the setting on, each site's vhost includes
`/etc/nginx/clp-addons-varnish/<domain>.conf` in place of
`{{varnish_proxy_pass}}`, and the addon rewrites that file from the site's
settings each time nginx reloads. A
server that would add nginx directives is left out, and the site skips Varnish
until it is fixed. Keep that include line when you edit a vhost: the **Vhost**
editor refuses `{{varnish_proxy_pass}}`. Turning the setting off puts the
placeholder back.

The setting also lists saved site settings it would refuse now, such as a Root
Directory saved before it was on, and Varnish servers it refuses. Check each
one and that site's vhost in `/etc/nginx/sites-enabled/`. `clp-addons repair`
prints the same list.

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
