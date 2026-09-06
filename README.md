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

Adds a Staging tab to every PHP site in CloudPanel, and a Clone link beside each
one in the site list. Both open a page that copies that site into a new one:
same PHP version, same vhost template, files copied, database exported and
imported, and the application's own config rewritten to point at the copy.

It is [clp-stager](https://github.com/7heMech/clp-stager) as an addon. The script
is interactive and runs in a terminal as root; this runs the same steps from the
panel, behind the addon's per-site authentication, with the argument validation
in `addons/stager/wrapper/clp-action-stager` between the web page and root.

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

That URL redirects to the newest release's copy of the installer, so it does not
go stale between releases. The installer defaults to the newest release of the
binaries too. Pass `--version=vX.Y.Z` to pin those.

It is a release asset rather than a file read off a branch, and that is
deliberate. Pipe a moving branch into a root shell and the script you audited is
not necessarily the script that runs. A release asset changes only when a
release is cut, is listed in that release's `SHA256SUMS`, and carries the same
build provenance attestation as the binaries.

To read it before running it, or to pin the installer itself:

```bash
curl -fsSL -O https://github.com/7heMech/cloudpanel-addons/releases/download/v0.1.3/install.sh

# Verify it came from this repository's release workflow. Every release ships
# the sigstore bundles as an asset, so this is checked offline and needs no
# GitHub account -- `gh attestation verify` without --bundle would demand one.
curl -fsSL -O https://github.com/7heMech/cloudpanel-addons/releases/download/v0.1.3/attestations.jsonl
gh attestation verify install.sh --bundle attestations.jsonl --repo 7heMech/cloudpanel-addons

less install.sh && bash install.sh
```

Requirements: a CloudPanel host, x86-64, root, and Docker. The installer refuses
to continue without them.

Two things are not done for you, and the addon is not safe to expose until they
are:

1. Add per-site security to the manager's own site in the panel, under
   Site → Security → Basic Auth. The IP allowlist lives on that same page, so
   use it too if your addresses are static. The manager can create and delete
   CloudPanel sites. It binds `127.0.0.1`, so its own site's vhost is the only
   route in, and that vhost is where authentication happens.

   Use the panel's feature rather than editing the vhost by hand. Both put
   `auth_basic` in front of the site, but only the panel's own one is recorded
   against the site, so a hand edit leaves the Security tab showing Basic Auth as
   off, and switching it there can rewrite the edit away. `clp-addons status`
   reports which of the two you have.
2. Issue a certificate for it:
   `clpctl lets-encrypt:install:certificate --domainName=<host>`

## Commands

```
clp-addons install <addon> --domain=<host> [--version=vX.Y.Z] [--skip-attestation]
clp-addons update [<addon>|--all] [--version=vX.Y.Z]
clp-addons self-update
clp-addons repair [--quiet]
clp-addons status
clp-addons uninstall <addon> --yes [--purge]
```

Each addon is served as its own CloudPanel site, so each needs a hostname of its
own. The bootstrap installer takes `--domain=HOST` when you are installing one
addon and `--domain-<addon>=HOST` when you are installing several; it refuses one
hostname shared between two, because the site it creates proxies a single port
and the second manager would install cleanly and answer on the first one's port.

`install`, `update` and `self-update` refuse a release marked as a prerelease.
These artifacts run as root, so installing one should be a decision rather than
something that happens because a tag was handy. Add `--allow-prerelease` when
you mean it.

`uninstall` removes the service, the wrapper, the sudoers line, the addon's
config and the panel patches. When no other addon is left installed it also
removes `/usr/local/bin/clp-addons` and the release tree, so nothing of the
platform is left behind. Then it stops. Instances and their data survive, so
uninstalling the manager is not a way to lose a customer's site. `--purge` goes
further and removes the instances too, each one archived to
`/var/backups/clp-addons/<addon>` first. Either way the command prints exactly
what it will destroy, by name, and does nothing until you add `--yes`.

A purge only deletes CloudPanel sites this addon created. A site that already
existed when the addon adopted it was serving something first, and the purge
leaves it alone.

`repair` is `install` without the download, and is idempotent. A systemd timer
calls it every 15 minutes, which is how the panel-side nav entry comes back
after a CloudPanel update wipes it. One implementation of "make the box match
what should be installed", not two.

`status` prints when that timer will next fire. Check it, because a timer that
has stopped is not obvious from anywhere else. `systemctl is-active` says
`active` for a timer that has elapsed and will never run again.

## What runs where

| Component | Runs as | Notes |
|---|---|---|
| `clp-addons` CLI | root, on demand | installer and reconciler |
| `instatic-app-linux-x64` | the addon site's CloudPanel user | manager UI, bound to `127.0.0.1:38080` |
| `clp-action-instatic` | root, via one sudoers line | the privilege boundary |
| Instatic instances | that instance's CloudPanel site user | one container per site, `127.0.0.1:39000-39999` |
| `stager-app-linux-x64` | the addon site's CloudPanel user | manager UI, bound to `127.0.0.1:38081` |
| `clp-action-stager` | root, via one sudoers line | the privilege boundary |
| a clone in progress | root, in its own transient systemd unit | survives a restart of the manager |

Patching the panel's own templates belongs to the platform, not to an addon.
An addon declares which template it wants to appear in and the markup to insert.
`cli/inject.ts` owns the pristine snapshot, the markers and the ordering, and
rebuilds each template with every installed addon's markup in one pass. Adding a
second addon is a registry entry plus its own files.

The manager stores nothing of its own. What exists is whatever the wrapper finds
on disk, so an instance created by calling the wrapper directly shows up in the
dashboard with no registration step in between.

The manager runs as the user CloudPanel already created for the addon's own
site, rather than an account this installer invents. One account per addon site
instead of two, and CloudPanel owns its lifecycle. Delete the site and the user
goes with it.

The same rule applies one level down. Every Instatic instance is a CloudPanel
site, so every instance has its own site user, and the wrapper starts the
container with `--user` set to that account. Two instances on the same box
therefore cannot read each other's databases, and no instance runs as the
panel's own account. Without `--user` a container runs as the uid baked into its
image. That is 1000 for the Instatic image, which on a CloudPanel box is `clp`,
the account that owns the panel and its database.

Because docker fixes a container's configuration at creation time, restarting an
instance built by an older release will not move it onto its site user.
`clp-action-instatic recreate --domain=<host>` rebuilds the container from the
tag already recorded, without touching the data.

CloudPanel gives that account a login shell and a password so operators can use
SFTP. The installer disables both. The addon's site is a pure reverse proxy with
no docroot anyone edits, and this is the one account permitted to `sudo` the
root wrapper, so leaving it reachable would turn that site's SFTP credentials
into a path to root. `repair` re-asserts it, since editing the site in the panel
can put the shell back.

The manager has no Docker access of its own either. Membership in the `docker`
group is equivalent to root, because a member can start a container with the
host filesystem bind-mounted. So every container operation, including reading
state and logs, goes through the wrapper. `clp-addons status` reports both the
shell lock and the docker group, and `repair` fixes either.

## Verification

Releases carry `SHA256SUMS` and a build provenance attestation. The checksum
catches corruption. The attestation catches substitution, which a checksum
served next to the binary cannot. Verification is on by default, and skipping it
takes an explicit `--skip-attestation`.

## Reaching the manager

Each manager binds `127.0.0.1` and its own CloudPanel site is the only thing that
serves it, so you reach it at `https://<addon-host>` once that hostname resolves
to the server. The panel entries link there: Instatic from the header nav, Stager
from each site's Staging tab.

If the hostname is not in public DNS yet, forward the server's port 443 and add
a hosts entry for it locally. Forward 443 specifically, because the injected nav
entry has no port in its URL and a different local port will not follow.

## Development

```bash
bun install
bun run typecheck
bun run lint:wrapper     # needs shellcheck; a finding here blocks a release
bun run test:app
bun run test:inject
bun run build
```

The wrapper contract tests run as root against an installed wrapper, so they are
not part of `bun run`:

```bash
tools/test-wrapper.sh          # instatic
tools/test-wrapper-stager.sh   # stager
```

Neither creates a site. Every case either fails validation or names a hostname
that does not exist, so the wrapper answers before it reaches `clpctl`.

`tools/recon.sh` is read-only and dumps facts about a CloudPanel host. **Never
commit its output.** On a production clone it names real customer domains and
real site users. `.gitignore` covers `recon*.txt`, and also `*.twig`, because
CloudPanel's templates are proprietary. The injector snapshots them to
`/var/lib/clp-addons/templates` at runtime instead of vendoring them here.

### Testing an install with no release cut yet

```bash
bun run build
(cd dist && sha256sum -- * > SHA256SUMS)
./dist/clp-addons-linux-x64 install instatic --domain=addons.example.com --local=dist
./dist/clp-addons-linux-x64 install stager --domain=stager.example.com --local=dist
```

`--local` still verifies checksums but cannot verify provenance. Staging only.
