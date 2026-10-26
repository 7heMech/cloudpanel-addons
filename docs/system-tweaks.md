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

**Last run** shows the last result from
`/var/log/unattended-upgrades/unattended-upgrades.log`. Expand **Failure details**
for the complete error, including the package URL if recorded. HTTP 404 means
the repository did not provide the requested package; it is not a successful
update. **Reboot** appears when an update such as a kernel needs a restart; after
a week without one, the page warns.

Switch on **Reboot when required** to allow automatic restarts, then choose
**Right after the update run** or **At a set time**. Each change is saved at
once. The time uses the server timezone shown next to it, not your browser's.
Switching updates on the first time keeps the reboot policy your apt files
already had. If a later apt file sets another time, the page says so under the
control. Changes affect future update runs and do not reschedule or cancel an
already queued shutdown.

If updates were already on before System Tweaks, the page says **Configured
outside System Tweaks** and names your file, and warns when that setup skips
CloudPanel's PHP. Switching on adds it. Switching off removes only
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

## Abandoned temp files

Every 15 minutes System Tweaks removes the PHP and ImageMagick temp files that
timed-out requests left in `/tmp`: ImageMagick's after two idle hours, PHP
uploads and WordPress downloads after a day. It removes only files a PHP site's
own user owns and no process has open. There is nothing to set.
