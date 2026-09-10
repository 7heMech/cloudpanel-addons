# cloudpanel-addons

Addons for [CloudPanel](https://www.cloudpanel.io/). Multi-addon from the start:
`instatic` and `stager`.

The design decisions, and the reasoning behind them, live in `docs/DECISIONS.md`.
Read that before changing anything under `addons/*/wrapper/`. Those scripts are
the privilege boundary.

## instatic

Adds an Instatic option to CloudPanel, plus a page listing instances with their
pinned version, state, logs and an update button.

[Instatic](https://github.com/CoreBunch/Instatic) is not a static site. It is a
Bun server with SQLite or Postgres that bakes pages to its own disk, so there is
no directory to push files into. Each instance is a container from
`ghcr.io/corebunch/instatic`, pinned to an exact version and bound to
`127.0.0.1`, behind a stock CloudPanel reverse-proxy site.

## stager

Adds a Clone link beside each PHP, static, and reverse-proxy site in the
CloudPanel site list. It opens a page that copies that site into a new one:
same PHP version, same vhost template, files copied, database exported and
imported, and the application's own config rewritten to point at the copy.

It is [clp-stager](https://github.com/7heMech/clp-stager) as an addon. The script
is interactive and runs in a terminal as root; this runs the same steps from the
panel, behind CloudPanel SSO, with the argument validation in
`addons/stager/wrapper/clp-action-stager` between the web page and root.

A clone takes minutes on a real site, so it is a job rather than a request. The
wrapper hands the work to a transient systemd unit and answers with a job id;
the page polls it and shows the log as it goes. Putting the work in its own unit
is not decoration: the manager is a systemd service with `Restart=always`, and
anything it forked itself would be killed with it mid-clone.

If a step fails, everything that run created is removed: the database, the site,
the site user, the dump. What was already there is left alone.

The source's nginx config comes with it. Its stored vhost is registered as a
named template, the clone is created from that, and the template is removed
again, so CloudPanel renders it, expands every placeholder against the clone's
own certificate, document root and php-fpm port, and writes both its own record
and the file. Nothing here edits a vhost or writes a panel row.

One case cannot be carried: a source whose `server_name` line is itself the hand
edit, such as a multisite wildcard. CloudPanel requires the `{{server_name}}`
placeholder on that line and the edit cannot share it, so the panel refuses the
template, the clone is built from the stock one, and the job says which site to
copy by hand. That refusal is the point. A staging site that inherited
`server_name production.example.com` would answer for production.

A custom root directory is not copied either. `clpctl site:add:php` does not take
one, so the clone gets the template's default and the job says if that differs.

## Install

```bash
curl -fsSL https://github.com/7heMech/cloudpanel-addons/releases/latest/download/install.sh | bash
```

The installer requires a root CloudPanel host running x86-64 Linux. It asks
which addons to install, verifies checksums and build provenance, and checks or
installs Docker only when Instatic is selected. It does not ask for a domain,
DNS, a certificate, or a second login. For unattended installation:

```bash
install.sh --addons=instatic,stager --yes
```

The manager runs as the locked `clp-addons` system user. Its only listener is
`/run/clp-addons/manager.sock`, mode `0660`, owned by `clp-addons:clp`; Nginx
connects through the CloudPanel `clp` group. The installer injects a marked
`/addons/` proxy location into the CloudPanel master vhost and runs `nginx -t`
before reloading it. If validation fails, the injector restores its pristine
snapshot.

CloudPanel SSO is automatic. The manager reads the `PHPSESSID` session file
in-process with Bun, validates the `_security_main` token and completed
`mfaAuthenticated` state, and requires the session file to be owned by `clp`.
Requests without a valid session redirect to `/login`; authentication stays
inside the manager with no separate helper process.

## Commands

```text
clp-addons install <addon> [--version=vX.Y.Z] [--skip-attestation] [--local=DIR]
clp-addons update [--version=vX.Y.Z] [--skip-attestation]   # alias: upgrade
clp-addons repair [<addon>] [--quiet] [--anchors-only]
clp-addons status
clp-addons uninstall <addon> --yes [--purge]
clp-addons serve
```

`clp-addons update` verifies and atomically installs the CLI and wrappers for
every installed addon when artifacts are missing or changed,
restarts `clp-addons.service`, and reconciles the Twig and Nginx integration.
Same-version updates reuse artifacts only when their root-owned manifest hashes
match. The active paths are always
`/usr/local/bin/clp-addons` and `/usr/local/libexec/clp-addons/`; there is no
release directory or `current` symlink. `upgrade` is an alias. `self-update` is
removed as an operation; invoking it reports that `update` should be used.

`repair` is idempotent. Its timer reasserts the service account, socket
permissions, sudoers, units, panel snapshot, Twig anchors, and Nginx proxy after
reboots or CloudPanel updates. `status` is a compact dashboard for those
invariants and prints the `/addons/` URL.

Uninstalling an addon removes its wrapper, config, sudo permission, and panel
anchors. Instance data remains unless `--purge` is supplied; purge archives it
before asking the root wrapper to remove each instance. The manager itself never
creates a CloudPanel site. Instatic instances and Stager clones do create the
CloudPanel sites they represent.

## Integrated manager

All installed addons share the CloudPanel master origin at
`https://<cloudpanel-host>/addons/`. Nginx forwards that marked location to the
UNIX socket, and the manager dispatches `/addons/instatic/` and
`/addons/stager/` internally. Addon links and browser requests are built from
`lib/mount.ts`, so each addon remains isolated by path without another hostname
or reverse-proxy site.

The service account is not a CloudPanel site user and has no login shell or
Docker membership. It can invoke only the installed root-owned wrappers through
`/etc/sudoers.d/clp-addons`. The wrappers validate their complete argument set
before reading input, deriving paths, or taking locks. Instatic containers run
as their instance site users, and Stager work runs in transient systemd units so
long clones survive a manager restart.

Patching the panel's own templates belongs to `cli/inject.ts`. It snapshots the
pristine file, reconciles all installed addon markers in one pass, preserves
native ordering, and restores the original when the last addon is removed.

## Verification

Release artifacts carry `SHA256SUMS` and a build provenance attestation. The
checksum catches corruption; the attestation catches substitution. Verification
is enabled by default, and `--skip-attestation` is an explicit checksum-only
exception for staging.

## Reaching the manager

Open the CloudPanel master URL at `https://<cloudpanel-host>/addons/` while
logged in to CloudPanel. The injected navigation entries point to the same
origin. The panel's own TLS configuration protects the connection; addon
installation does not request or manage a separate certificate.

## Development

```bash
bun install
bun run typecheck
bun run test:inject
bun run test
bun run lint:wrapper     # needs shellcheck
bun run build            # dist/clp-addons-linux-x64
```

The wrapper contract tests run as root against an installed wrapper and are not
part of `bun run test`:

```bash
tools/test-wrapper.sh          # instatic
tools/test-wrapper-stager.sh   # stager
```

Neither creates a site: each invalid case is rejected before `clpctl`, and each
valid-shaped case names a hostname that does not exist.

`tools/recon.sh` is read-only and dumps facts about a CloudPanel host. Never
commit its output. CloudPanel templates are proprietary; the injector snapshots
them to `/var/lib/clp-addons/templates` at runtime instead of vendoring them.

### Testing a local build

```bash
bun run build
for w in addons/*/wrapper/*; do install -m 0755 "$w" "dist/$(basename "$w")"; done
(cd dist && sha256sum -- * > SHA256SUMS)
./dist/clp-addons-linux-x64 install instatic --local=dist
```

`--local` still verifies checksums but cannot verify provenance. Use it only for
staging or local development.
