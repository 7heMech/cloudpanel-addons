# Hardening

These are the holes in a stock CloudPanel install that the addons close. All of
them are in System Tweaks. Operator steps are in
[System Tweaks](../docs/system-tweaks.md), and the design is in
[Decisions](../docs/decisions/system-tweaks.md).

## On by default

**Nginx config injection.** CloudPanel writes site settings such as Root
Directory into the site's vhost without checking them, and nginx runs as root.
Any panel account with a site can add directives and take over the server
([Full Disclosure 2026/Oct/14](https://seclists.org/fulldisclosure/2026/Oct/14)).
A guard in front of the panel refuses values that would add directives, and
only administrators can save the Vhost editor and PageSpeed settings.
[Guide](../docs/system-tweaks.md#nginx-config-injection)

**The site's Varnish file.** CloudPanel renders the Varnish server from
`~/.varnish-cache/settings.json`, which the site's own shell or SFTP user can
write. Each vhost includes a root-owned file in its place, rewritten from the
site's settings before nginx reloads. A server that would add directives is
left out. [Guide](../docs/system-tweaks.md#nginx-config-injection)

**Forged visitor IPs.** CloudPanel trusts a client's IP header from any
address, so a request can claim any IP and get past Cloudflare-only rules and
IP allowlists, and into logs under that IP. The setting stops trusting it,
except from loopback, private ranges and, for the panel, Cloudflare.
[Guide](../docs/system-tweaks.md#forged-visitor-ips)

**PHP upload progress.** `session.upload_progress.enabled` is one path of the
php2shell CVE-2026-109619. It is turned off on every PHP-FPM, the panel's
included. This mitigates one path; patched PHP packages are the fix.
[Guide](../docs/system-tweaks.md#php-upload-progress-mitigation)

## Off until you choose

**The panel's PHP.** CloudPanel runs its pages, phpMyAdmin and the root File
Manager on PHP 8.1, which no longer gets security fixes. Panel PHP moves them to
a newer installed PHP and rolls back if the panel stops answering. CloudPanel
has not tested itself on 8.2+, so this is your choice.
[Guide](../docs/system-tweaks.md#panel-php)

**Automatic updates.** The distro's security updates leave out CloudPanel's own
PHP builds, which come from CloudPanel's repository. Automatic updates install
both, and nginx by default.
[Guide](../docs/system-tweaks.md#automatic-updates)
