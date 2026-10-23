# System Tweaks

## Automatic updates

1. Open **Addons → System Tweaks**. If `unattended-upgrades` is missing, choose
   **Install unattended-upgrades**.
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

To try a run without installing anything:

```bash
unattended-upgrade --dry-run -d
```

## PHP upload-progress mitigation

Every installation turns off `session.upload_progress.enabled` on each PHP-FPM,
CloudPanel's own included, with `99-clp-addons-upload-progress.ini`. The table
shows each FPM's effective value and which file set it. Switching the mitigation
off removes only that file. It comes back if System Tweaks is disabled.
