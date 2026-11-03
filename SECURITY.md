# Security model and hardening

CloudPanel Addons limits which requests can reach root and adds protections to
CloudPanel. These controls address specific risks; they do not make the server
unhackable. Implementation details are in [Security decisions](docs/decisions/security.md).

## Security model

The web manager runs as the dedicated `clp-addons` account, without sudo or
Docker access. A separate root gateway accepts requests over a Unix socket.
It checks the caller's Unix identity and installed executable, accepts only
declared addon operations, and starts them with an argument array. Root actions
validate their inputs before changing the host.
[Design](docs/decisions/security.md#privileged-actions)

Addon pages use the existing CloudPanel session. The gateway rejects expired
or malformed sessions and checks the account's current status and role in the
panel database. The manager requires an administrator by default. Named
exceptions let other accounts work with their permitted sites or their own
security keys. Browser changes require the panel's origin and a CSRF token.
Git webhooks and passkey sign-in have separate credential checks.
[Authentication](docs/decisions/security.md#cloudpanel-authentication)

Git commands and WordPress tooling run as the site's Unix user. Terminal is
administrator-only and also opens a shell as that site user. Credential files
and job records containing secrets have restricted permissions. WordPress
tooling and Terminal use restricted child environments.
[Git](docs/decisions/git.md), [WordPress Tools](docs/decisions/wp-tools.md),
[Terminal](docs/decisions/terminal.md), [secrets](docs/decisions/security.md#files-and-secrets)

Release updates check SHA-256 checksums and GitHub build provenance unless an
operator explicitly skips provenance verification. The first-install shell
script checks only the download's checksum.
[Release verification](docs/decisions/releases.md)

## Trust and limits

Root and CloudPanel administrators can change the host. The installed addon
binary, the web manager, CloudPanel's authentication and its database are
trusted. For most operations, the gateway relies on the manager to identify
the caller and enforce their role. A compromised manager could request those
allowed root operations. Terminal and own-account security-key operations
add a session check in the gateway itself.

The addons do not change CloudPanel's root nginx workers or root File Manager
pool, and do not provide per-site operating-system isolation. Protecting known
configuration inputs does not remove those privileges. The Vhost editor remains
administrator-only while the injection guard is on.
[Trust boundaries](docs/decisions/security.md#trust-and-limits)

## Hardening with System Tweaks

[System Tweaks](docs/system-tweaks.md) shows whether each setting is applied.
The [design](docs/decisions/system-tweaks.md) describes its checks and limits.

### On by default

**Nginx config injection.** The guard validates new panel settings before
CloudPanel renders them into nginx config, addressing the
[CloudPanel 2.5.4-3 disclosure](https://seclists.org/fulldisclosure/2026/Oct/14).
Only active administrators can save raw Vhost and PageSpeed configuration.
[Guide](docs/system-tweaks.md#nginx-config-injection)

**The site's Varnish file.** A checked, root-owned include replaces the backend
CloudPanel reads from the tenant's writable settings file. Invalid servers fall
back to the local backend without Varnish.
[Guide](docs/system-tweaks.md#nginx-config-injection)

**Forged visitor IPs.** The setting removes nginx's trust in IP headers from
arbitrary public clients. Loopback and private proxies remain trusted; the
panel also trusts Cloudflare.
[Guide](docs/system-tweaks.md#forged-visitor-ips)

**PHP upload progress.** Every addon installation sets
`session.upload_progress.enabled=Off` for PHP-FPM, including the panel. This
mitigates the session path of
[CVE-2026-109619](https://github.com/php/php-src/security/advisories/GHSA-6wmf-4rv5-p3rp);
patched PHP packages are still required.
[Guide](docs/system-tweaks.md#php-upload-progress-mitigation)

The nginx settings default to on when System Tweaks is enabled. PHP upload
progress is disabled independently of that addon; System Tweaks provides its
opt-out. Existing saved nginx values are flagged for review, not repaired.
Other PHP configuration can override the upload-progress setting. These are
mitigations to check on each host, not a declaration that it is patched.

### Opt in

**The panel's PHP.** PHP 8.1 has
[ended upstream support](https://www.php.net/eol.php). Panel PHP can move
CloudPanel, phpMyAdmin and File Manager to a newer installed PHP, with health
checks and rollback. Check panel compatibility when choosing a version.
[Guide](docs/system-tweaks.md#panel-php)

**Automatic updates.** The policy covers the distro's security packages and
CloudPanel's own PHP builds, which the distro's security rules alone leave out.
It includes nginx by default; database and CloudPanel updates are separate choices.
[Guide](docs/system-tweaks.md#automatic-updates)
