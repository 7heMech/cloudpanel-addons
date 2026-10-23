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
`/var/log/unattended-upgrades/unattended-upgrades.log`. **Reboot** shows when
an update such as a kernel needs a restart. Switch on **Reboot when required**
to restart right after that run.

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

## Cloudflare connection check

Use **Check Cloudflare connections** when Cloudflare connects directly to this
server. It adds a connection-address check to sites using **Allow traffic from
Cloudflare only**, including sites enabled through CloudPanel itself. Choose
those sites in Cloudflare IP Access or each site's Security page.

The switch starts off. Leave it off when a load balancer or tunnel sits between
Cloudflare and the server: those connections would be blocked. Direct requests
for certificate validation are blocked too, so use validation through Cloudflare
or DNS. Sites without Cloudflare-only access keep working normally.

**Configured** means the extra check is present in the Nginx files. If the page
says **Needs repair**, run `clp-addons repair` and check any reported error.
CloudPanel replacing its range list triggers repair automatically, but until
repair finishes only CloudPanel's original rules may be active.

Switching off removes the added check and leaves CloudPanel's rules in place.
Disabling System Tweaks removes the check too; enabling it again restores your
choice. The setting does not change how visitor IPs are passed to applications.

## PHP upload-progress mitigation

Every installation turns off `session.upload_progress.enabled` on each PHP-FPM,
CloudPanel's own included, with `99-clp-addons-upload-progress.ini`. The table
shows each FPM's effective value and which file set it. Switching the mitigation
off removes only that file. It comes back if System Tweaks is disabled.
