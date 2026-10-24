# System Tweaks

## Automatic updates

1. Open **Addons → System Tweaks**. If `unattended-upgrades` is missing, choose
   **Install unattended-upgrades**. It can take up to ten minutes when apt is
   busy.
2. Switch on **Install updates automatically**. It runs once a day, from
   `apt-daily-upgrade.timer`, and installs the distro's security updates and
   every PHP version CloudPanel ships. Nginx is included by default; MySQL and
   CloudPanel itself only if you switch them on.
3. Check **Repositories**: it lists every apt source and whether it is covered.
   An uncovered source still needs `apt upgrade`.

**Last run** shows the last result from
`/var/log/unattended-upgrades/unattended-upgrades.log`. Expand **Failure details**
for the complete error, including the package URL if recorded. HTTP 404 means
the repository did not provide the requested package; it is not a successful
update. **Reboot** shows when
an update such as a kernel needs a restart. Switch on **Reboot when required**
to allow automatic restarts. Under **Reboot timing**, choose **After the update
run** or **At a specific time**, enter a 24-hour time, and select **Save time**.
The time uses the server timezone shown next to the control, not your phone or
browser timezone. A required reboot is scheduled for the next occurrence of
that time after the update run.

**Use existing configuration** leaves the reboot time to your other apt files
(or immediately after the run if no time is configured). This is the default
for existing and new installations. **Automatic reboot** shows the effective
timing; a later operator file may override your choice. Changes affect future
update runs and do not reschedule or cancel an already queued shutdown.

If updates were already on before System Tweaks, the page says **Configured
outside System Tweaks** and names your file. Switching on adds CloudPanel's PHP
to that setup. Switching off removes only
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
CloudPanel's own included, with `99-clp-addons-upload-progress.ini`. The table
shows each FPM's effective value and which file set it. Switching the mitigation
off removes only that file. It comes back if System Tweaks is disabled.

## Panel PHP

Under **Addons → System Tweaks → Panel PHP**, choose a newer installed version
in **Panel runs on**. This changes the PHP used by CloudPanel's pages,
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
