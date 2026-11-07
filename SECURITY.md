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

Addon pages use the existing CloudPanel session. A separate authentication
gateway checks it on every addon page request: it rejects expired or malformed
sessions and rechecks the account's current status and role in the panel
database. The manager requires an administrator by default. Named
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
trusted. For most operations, the root gateway relies on the manager to
identify the caller and enforce their role. A compromised manager could request
those allowed root operations. Terminal and own-account security-key operations
add a session check in the root gateway itself.

The addons put a guard in front of CloudPanel's root File Manager pool and limit
its socket to `clp`, but do not change its root user or CloudPanel's root nginx
workers, and do not provide per-site operating-system isolation. Protecting known
configuration inputs does not remove those privileges. The Vhost editor remains
administrator-only while the injection guard is on.
[Trust boundaries](docs/decisions/security.md#trust-and-limits)

## Mitigations

Each fix the addons make to CloudPanel is listed here, with the setting that
applies it. [System Tweaks](docs/system-tweaks.md) shows whether each setting is
applied, and the [design](docs/decisions/system-tweaks.md) describes its checks
and limits.

### On by default

**Nginx config injection.** The guard validates new panel settings before
CloudPanel renders them into nginx config, addressing the
[CloudPanel 2.5.4-3 disclosure](https://seclists.org/fulldisclosure/2026/Oct/14).
Only active administrators can save raw Vhost and PageSpeed configuration,
which also closes
[CVE-2024-44765](https://nvd.nist.gov/vuln/detail/CVE-2024-44765), where a
non-admin account edited its vhost to serve the panel's own files.
[Guide](docs/system-tweaks.md#nginx-config-injection)

**The site's Varnish file.** A checked, root-owned include replaces the backend
CloudPanel reads from the tenant's writable settings file. Invalid servers fall
back to the local backend without Varnish.
[Guide](docs/system-tweaks.md#nginx-config-injection)

**Site nginx logs.** Each site's logs move from its home to a directory only
root can write, and `~/logs/nginx` becomes a link to it. The root nginx master
can no longer be made to append to a file the tenant links in its place.
logrotate rotates the tenant's own log folders as the tenant, not as root.
[Guide](docs/system-tweaks.md#nginx-config-injection)

**PHP pools.** Only nginx and a site's own user can connect to the site's
PHP-FPM port, so one tenant cannot run PHP as another.
[Guide](docs/system-tweaks.md#isolate-php-pools)

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

**phpMyAdmin.** The panel's basic auth skips only phpMyAdmin itself, not any
address that merely starts with `/phpmyadmin`, such as
`/phpmyadmin/../file-manager/`. phpMyAdmin's example sign-on script, which let
anyone make the server try MySQL logins on other hosts, its setup script, its
internal folders and the files that show its version return 404. Signing in to
phpMyAdmin from the panel is unchanged.
[Guide](docs/system-tweaks.md#phpmyadmin)

**File Manager paths.** CloudPanel's File Manager runs as root and followed `..`
and symbolic links out of the site's home, so a panel account could read, create
or take over files anywhere on the server, and extract device files and setuid
programs. A guard refuses such requests and archives, and only the panel's nginx
can reach the File Manager's PHP. Every File Manager action that writes, deletes,
changes permissions or reads a file's contents runs as the site's own user, so a
link planted mid-request can only reach what that user could already reach.
Folder listings still run as root and could show a raced folder's file names, but
no contents.
[Guide](docs/system-tweaks.md#file-manager)

**Password guessing against the panel and SSH.** CloudPanel records only
successful logins and has no limit on failed ones. System Tweaks makes the
panel's nginx log each failed password, two-factor code and basic-auth attempt to
the journal, and a fail2ban jail blocks the address from port 8443 for an hour
after 5 failures within an hour. Logins through CloudPanel's custom domain are
logged by the sites' nginx with the client's own address and blocked on port 443,
which covers every site on the server. An opt-in jail does the same for SSH. Bans
are kept in fail2ban's own nftables table, so CloudPanel's Firewall page doesn't
clear them. Loopback, the server's own addresses, private networks and Cloudflare
are never blocked, so behind Cloudflare the panel jail blocks nothing. sshd's
settings are not changed; the page warns when password or root login is allowed.
Switching it off puts fail2ban back as it was.
[Guide](docs/system-tweaks.md#failed-logins)

**The panel's shared certificate.** CloudPanel serves its panel on port 8443
with one certificate and private key shared by every install
([CVE-2023-0391](https://nvd.nist.gov/vuln/detail/CVE-2023-0391)), so anyone who
can see the traffic can decrypt it. The setting replaces them with a pair
generated on the server, and repair puts it back after a CloudPanel update. A
certificate the operator installed is left alone.
[Guide](docs/system-tweaks.md#panel-certificate)

**clpctl injection.** A hardened `clpctlWrapper` replaces CloudPanel's, so a
site's own Unix user can no longer reach root or another tenant's data through
clpctl and the `NOPASSWD` sudoers rule. Root and the panel pass through unchanged;
other callers may run only `db:export`, `system:permissions:reset` and
`varnish-cache:purge`, with values holding no shell metacharacter, a permissions
reset confined to the caller's own home, and an export written as the caller.
`db:import` is refused for them, because CloudPanel runs the dump as the database
administrator, which can read any site's database; they import with their own
database credentials instead. Version-pinned and fail-safe, it leaves an
unrecognised wrapper in place. CloudPanel must still fix clpctl's backslash
stripping, its shell-string command builders, `db:import` running as the database
administrator, and `clp`'s own `NOPASSWD: ALL`.
[Guide](docs/system-tweaks.md#clpctl-injection)

**CloudPanel telemetry.** `clp-agent` sends CloudPanel every site's domain and
every panel user's name and email once a day, with no opt-out. The setting
denies the agent every address but the server's own, so it keeps drawing the
dashboard's graphs and sends nothing.
[Guide](docs/system-tweaks.md#cloudpanel-telemetry)

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

**MySQL reachable from other hosts.** CloudPanel's MySQL listens on every
address, and CloudPanel creates every database user for any host (`'%'`), so only
the firewall keeps the database private. A box with ufw off, or a rule opening
port 3306, exposes every site's database login, and possibly `root` with the
install's default password `root`. System Tweaks' Hardening card shows where MySQL
listens, what the loaded firewall rules allow, clients connected from elsewhere,
and whether root still uses a default password. **MySQL on this server only**
(opt-in) binds it to `127.0.0.1` and undoes the change if MySQL does not come
back.
[Guide](docs/system-tweaks.md#mysql-access)
