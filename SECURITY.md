# Security model and hardening

CloudPanel Addons limits which requests can reach root and adds protections to
CloudPanel. These controls address specific risks; they do not make the server
unhackable. Implementation details are in [Security decisions](docs/decisions/security.md).

## Is CloudPanel Addons safe to use?

CloudPanel Addons is an independent open-source project. A bare install enables
no addons and leaves site vhosts, MySQL and firewall rules untouched; its only
site-wide change is turning off PHP session upload progress across every
PHP-FPM version with a graceful reload. It separates web requests from root
(see [Security model](#security-model) and
[Trust and limits](#trust-and-limits)), verifies release downloads, and restores
CloudPanel's files on uninstall.

### Does installing change my sites, MySQL, Nginx, or firewall?

Running `install.sh` without `--addons` enables no addons. It does not edit
customer site vhosts or files, restart MySQL or MariaDB, change `ufw` or
`nftables` rules, edit SSH configuration, or install Docker or Postfix.

The base installation sets up only what the Addons interface needs:

- Installs `/usr/local/bin/clp-addons` and creates the unprivileged `clp-addons`
  system account and directories under `/etc/clp-addons`, `/var/lib/clp-addons`,
  `/run/clp-addons`, `/run/lock/clp-addons`, `/usr/local/libexec/clp-addons`,
  and `/var/backups/clp-addons`.
- Installs and starts the base systemd units: the unprivileged web manager
  (`clp-addons.service`), the socket-activated root gateway
  (`clp-addons-auth.socket` and `clp-addons-auth.service`), the 15-minute repair
  timer (`clp-addons-reconcile.timer`), the CloudPanel template and vhost
  watcher (`clp-addons-anchor.path`), and an `apt-daily-upgrade.service` drop-in
  that yields managed Nginx conffile edits during unattended upgrades. That
  drop-in does nothing until an addon edits a conffile.
- Saves pristine snapshots and SHA-256 hashes of CloudPanel's header Twig
  templates, adds the admin-only **Addons** link and update notice, and purges
  the Twig cache. It also adds one marked `location ^~ /addons/` proxy block to
  CloudPanel's master vhost (`cloudpanel.conf` on port 8443), tests the config
  with `nginx -t` before reloading that Nginx instance, and rolls back
  automatically if validation or reload fails.
- Writes `/etc/php/<version>/fpm/conf.d/99-clp-addons-upload-progress.ini` with
  `session.upload_progress.enabled = Off` to mitigate CVE-2026-109619 and
  CVE-2026-115560, tests each changed PHP-FPM config with `php-fpm<version> -t`,
  and gracefully reloads active PHP-FPM units and `clp-php-fpm.service`. Because
  those pools serve all PHP sites, every PHP site receives this setting on base
  install. If a config test or reload fails, it restores the previous files and
  reloads.
- On a fresh server with no previous install, locks `system-tweaks` in
  `/etc/clp-addons/locks.json` before enabling any addon. Because System Tweaks
  is still disabled on a bare install, this lock changes nothing on its own. If
  you enable System Tweaks later, the lock stops the web panel from switching
  its hardening protections off or disabling the addon. Root can undo it at any
  time with `clp-addons unlock system-tweaks`.

### Does System Tweaks or another addon restart MySQL or break existing setups?

No addon runs until you enable it. Enabling [System Tweaks](docs/system-tweaks.md)
turns on its default hardening protections: Nginx config injection blocking,
Varnish backend checks, root-owned site Nginx log directories, PHP-FPM pool
isolation, forged visitor IP fixes, phpMyAdmin lockdown, File
Manager confinement, version-pinned `clpctl` hardening, a per-server panel
certificate on port 8443, the panel login jail when `fail2ban` is already
installed, `clp-agent` telemetry blocking, and the SSH login summary.

Its default protections change some behaviour: sites behind a non-Cloudflare
public proxy lose visitor IPs (because `set_real_ip_from 0.0.0.0/0` is
commented out), site users can no longer run `clpctl db:import`, and repeated
failed logins on the panel's custom domain block an address from HTTPS on every
site for an hour. When `fail2ban` is installed but stopped, the panel login
jail enables and starts it. Read [System Tweaks](docs/system-tweaks.md) before
enabling it.

These stay off until you switch them on, even after System Tweaks is enabled
and even when a fresh install starts with System Tweaks locked:

- **MySQL on this server only.** Off by default. It restarts MySQL, and
  `mariadb.socket` when socket-activated, only if you turn it on or choose
  **Lock settings** in the Hardening card. Before restarting, it checks startup
  arguments and effective `bind-address`. After restarting, it waits up to 60
  seconds for MySQL to answer on `127.0.0.1` and restores the previous config
  and restarts MySQL if it fails to come back or still listens publicly.
- **Panel PHP.** Keeps CloudPanel's own PHP version unless you choose a newer
  installed version. Before restarting `clp-php-fpm.service`, it runs
  `php-fpm -t`, then probes CloudPanel's login page and File Manager over their
  FastCGI sockets. If either check fails, it restores the previous PHP version
  automatically.
- **SSH login jail, automatic updates, and backup compression.** **Block SSH
  login guessing**, **Install updates automatically**, and **Compress remote
  backups with Zstandard** all stay off by default. Choosing **Lock settings**
  in the Hardening card also turns **Block SSH login guessing** on. System
  Tweaks never edits `sshd` config, never installs `fail2ban` or
  `unattended-upgrades` on its own, and keeps the automatic reboot setting your
  apt files already have. Automatic reboots stay off unless apt already enables
  them or you switch on **Reboot when required**.

### How can I verify downloads and inspect the code?

The project is open source under the [Apache-2.0](LICENSE) license. Public
GitHub Actions workflows run typechecking, the full test suite, ShellCheck on
`install.sh`, and native builds on both `x86_64` and `arm64` Linux runners, with
third-party actions pinned by commit SHA.

Every tagged release publishes `SHA256SUMS` and GitHub build provenance
attestations covering the binaries, `install.sh`, and `cloudpanel.json`.
`install.sh` checks the binary's SHA-256 checksum before installing it. If you
prefer not to pipe `curl` to `bash`, download `install.sh` first, inspect it,
optionally verify its attestation with
`gh attestation verify install.sh --repo 7heMech/cloudpanel-addons --signer-workflow 7heMech/cloudpanel-addons/.github/workflows/release.yml`,
and run `bash install.sh` as root. On updates, `clp-addons update` verifies
both the SHA-256 checksum and the Sigstore build provenance attestation bound
to this repository's `release.yml` workflow and release tag before replacing
the binary (unless `--skip-attestation` is passed). It also hard-links the
previous binary aside so a failed update or restart rolls back automatically.
[Release verification](docs/decisions/releases.md)

### Can I uninstall, and what happens when CloudPanel updates?

Every CloudPanel template and master vhost edit saves a pristine baseline copy
and SHA-256 hash under `/var/lib/clp-addons`. Every Nginx change runs `nginx -t`
against the owning Nginx config and rolls back automatically if validation or
reload fails.

To remove CloudPanel Addons:

1. Disable every enabled addon as root with `clp-addons disable <addon>`.
   Disabling runs each addon's own withdrawal steps. The Addons page cannot
   disable a locked System Tweaks until you run `clp-addons unlock
   system-tweaks` as root.
2. Run `clp-addons self-uninstall --yes` as root.

`self-uninstall` restores CloudPanel's Twig templates and master vhost, purges
the Twig cache, stops and removes all `clp-addons` systemd units and drop-ins,
removes `99-clp-addons-upload-progress.ini` and reloads PHP-FPM, and deletes
`/usr/local/bin/clp-addons` and `/usr/local/libexec/clp-addons`. All sites keep
running, including Instatic containers. The `clp-addons` account,
`/etc/clp-addons` (including `locks.json`), `/var/backups/clp-addons` and
`/var/lib/clp-addons` stay on disk.

When CloudPanel updates, addons never hold the package back. Files whose anchor
lines still match cleanly are re-applied automatically. Any file that changed in
an unexpected way is left as CloudPanel shipped it and marked **Paused until
checked**. Version-pinned replacements such as the `clpctl` wrapper and
Zstandard backup compression stay paused if CloudPanel ships unrecognized code.
See [When CloudPanel updates](docs/cloudpanel-updates.md).

### Who maintains it and how is it tested?

CloudPanel Addons is an independent, unofficial open-source project and is not
affiliated with or endorsed by CloudPanel. Changes from `dev` and release pull
requests deploy to a staging CloudPanel server before stable versions are
tagged.

The maintainer reports CloudPanel security vulnerabilities found during
development to the CloudPanel team. System Tweaks mitigates the issues listed
under [Mitigations](#mitigations) while upstream patches are pending or on
older hosts, but addons complement rather than replace keeping CloudPanel, PHP
and operating system packages updated.

## Security model

The web manager (`clp-addons.service`) runs as the dedicated `clp-addons`
system account (`/usr/sbin/nologin`, locked password, `SupplementaryGroups=clp`,
no `docker` group, no `sudo` rule of its own) under systemd sandboxing
(`NoNewPrivileges=yes`, `ProtectSystem=full`, `ProtectHome=read-only`,
`PrivateTmp=yes`, `ProtectKernelTunables=yes`). `NoNewPrivileges=yes` prevents
`sudo` inside the service, including CloudPanel's own `clpctlWrapper` rule. A
separate root gateway (`clp-addons-auth.service`) listens on
`/run/clp-addons/auth.sock` (`0660`, `root:clp-addons`). It checks the caller's
Unix identity and installed executable, accepts only declared addon operations,
and starts them with an argument array. Root actions validate their inputs
before changing the host. Root locks (`clp-addons lock <addon>`) keep even a
panel administrator from turning protections off from the browser; `unlock` is
only available from a root shell.
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

Release verification details are in
[How can I verify downloads and inspect the code?](#how-can-i-verify-downloads-and-inspect-the-code)
and [Release verification](docs/decisions/releases.md).

## Trust and limits

Root and CloudPanel administrators can change the host. The installed addon
binary, the web manager, CloudPanel's authentication and its database are
trusted. For most operations, the root gateway relies on the manager to
identify the caller and enforce their role. A compromised manager could request
those allowed root operations. Terminal, own-account security-key operations and
an account's own default plugins in WordPress Tools add a session check in the
root gateway itself.

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
arbitrary public clients. Private proxies remain trusted; the panel also trusts
Cloudflare.
[Guide](docs/system-tweaks.md#forged-visitor-ips)

**Visitor IPs through Cloudflare.** Managed by [Firewall](docs/firewall.md#cloudflare-visitor-ips)
and on by default when Firewall is enabled. A Cloudflare Tunnel reaches nginx
from `127.0.0.1`, which CloudPanel trusts for `X-Real-IP`. Cloudflare passes
that header through from the visitor, so anyone could set their own IP through a
tunnel. Sites stop trusting `127.0.0.1` and take the visitor from
`CF-Connecting-IP`, only when Cloudflare or the tunnel set it. CloudPanel's
`cloudflare` log format no longer records that header from other clients. Run
`clp-addons lock firewall` as root to keep the browser from switching it off.
[Guide](docs/firewall.md#cloudflare-visitor-ips)

**PHP upload progress.** Every addon installation sets
`session.upload_progress.enabled=Off` for PHP-FPM, including the panel. This
mitigates the session path of
[CVE-2026-109619](https://github.com/php/php-src/security/advisories/GHSA-6wmf-4rv5-p3rp)
and [CVE-2026-115560](https://github.com/php/php-src/security/advisories/GHSA-658j-r8rw-q6mx);
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
denies the agent every address but loopback, so it keeps drawing the
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
