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

The installer offers a keyboard checklist (arrows, Space, **a** for all,
**n** for none) and asks once whether to request a Let's Encrypt certificate.
DNS must point to the server. For unattended installs, pass
`--certificate=yes` to request one or `--certificate=no` to skip. `--yes` alone
never requests a certificate. Failure prints the retry command without undoing
the installation; use HTTPS only once a valid certificate is installed.

The manager authenticates every request itself. On first install it displays a
unique 32-character password in a login block; save it in your password manager.
Only a scrypt hash is stored. There is no shared default password, and the
manager checks the entire password. To replace a lost generated password, run
`clp-addons auth reset` as root.

CloudPanel Basic Auth is optional. If already configured, its credential is
also used by the manager, re-hashed with scrypt. Change that credential in
Site → Security and run `clp-addons repair`. CloudPanel's legacy DES hash may
only check eight characters at nginx; the manager still checks the full password.
An IP allowlist can further restrict access.

Deleting an Instatic site directly in CloudPanel removes its panel site, but
leaves the container and addon data. The manager flags missing sites after the
panel snapshot refreshes (normally within 15 minutes). Use **Delete** in the
Instatic manager to archive and clean up the remaining instance. Cleanup requires
a successful archive and retains data if Docker or panel deletion fails.

Deleting the **manager** site does not delete Instatic instances or staging
copies. The next full repair stops the manager and reports the missing site;
it does not recreate a site behind your back. Recover with
`clp-addons repair --restore-site`, then restore any site security settings and
issue its certificate when prompted. The stored manager credential is retained.

## Commands

```
clp-addons install <addon> [--domain=<host>] [--version=vX.Y.Z] [--skip-attestation]
clp-addons update [<addon>|--all] [--version=vX.Y.Z]     # alias: upgrade
clp-addons self-update
clp-addons repair [--quiet]
clp-addons status
clp-addons uninstall <addon> --yes [--purge]
clp-addons serve
```

One CloudPanel site serves every addon, each under its own path, so `--domain`
is asked once. The first install names the site; later ones join it, and
re-stating a different hostname is refused rather than moving the addons already
installed there. `clp-addons install stager` with no `--domain` is the ordinary
way to add a second addon.

`update` does the CLI first, then the addons. `upgrade` is the same command.

That order matters, and doing it in one process would not be enough. `update`
fetches whatever the *running* CLI believes a release contains, so a CLI older
than a change to the artifact set asks for something the new release does not
have -- moving to v0.6.0 with a v0.5.2 CLI asked for `instatic-app-linux-x64`
and stopped, because the per-addon app binaries had merged into one. Replacing
`/usr/local/bin/clp-addons` does not change the process already running either,
so `update` installs the new CLI and then re-runs itself as that copy. What a
release contains is therefore always read by the CLI from that release.

```bash
clp-addons update          # the CLI, then every installed addon
```

`self-update` still exists for moving the CLI alone.

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

## One site, one manager

Every addon used to get a CloudPanel site of its own: a hostname, a certificate,
a Basic Auth setup and a site user each. Four manual steps per addon before the
thing is safe to expose, and the addon is unreachable until the first two are
done. What that bought was isolation -- one compromised manager could reach its
own wrapper and not the other's -- and it is not worth an operator skipping any
of those steps, which is the failure it actually invites.

So there is one site, one `clp-addons.service`, one account, and the addons are
mounted under it by path. The one account can `sudo` every installed addon's
wrapper, which is the real cost and is stated plainly in the unit file. The
wrapper's argument validation was always the thing carrying the weight.

The routing is in the manager rather than in nginx, and that is forced rather
than chosen. CloudPanel's stock reverse-proxy vhost has exactly one
`{{reverse_proxy_url}}`, `site:add:reverse-proxy` does not accept
`--vhostTemplate`, and no `clpctl` verb rewrites an existing site's vhost -- so
per-path upstreams would mean writing `site.vhost_template` by hand, and adding a
second addon later would mean rewriting it again. One process on one port needs
none of that, and the vhost stays stock.

Each addon's views build their links from `lib/mount.ts` rather than from the
site root, and `call()` in the shared client script prefixes every fetch, so an
addon's own code reads as though it still owned the site.

## One binary

The release ships a single compiled artifact. `clp-addons` is the CLI, and
`clp-addons serve` is the manager for every installed addon -- which is what the
systemd unit ExecStarts. Each addon is a few tens of KB of code, so bundling them all
and choosing one at startup costs nothing, while a binary each meant a copy of
the Bun runtime each:

```
empty bun --compile binary   81,315,296 bytes
clp-addons-linux-x64         81,372,640   ->  56 KB of code
instatic-app-linux-x64       81,343,968   ->  28 KB
stager-app-linux-x64         81,339,872   ->  24 KB
```

244 MB of download for 108 KB of code, and another 77.6 MB for every addon
added. Merged it is 81.4 MB, and an addon costs a wrapper script.

The addon modules therefore export a starter rather than serving on import, so
the commands that are not `serve` pay nothing for them being compiled in.

## What runs where

| Component | Runs as | Notes |
|---|---|---|
| `clp-addons` CLI | root, on demand | installer and reconciler |
| `clp-addons serve` | the site's CloudPanel user | every addon's UI, bound to `127.0.0.1:38080` |
| `clp-action-instatic` | root, via one sudoers line | the privilege boundary |
| Instatic instances | that instance's CloudPanel site user | one container per site, `127.0.0.1:39000-39999` |
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

The manager binds `127.0.0.1` and one CloudPanel site is the only thing that
serves it, so you reach it at `https://<host>` once that hostname resolves to the
server. Each addon is under its own path -- `https://<host>/instatic`,
`https://<host>/stager` -- and the bare hostname lists what is installed. The
panel entries link straight to them: Instatic from the header nav, Stager from
each site's Staging tab.

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
bun run build            # one binary: dist/clp-addons-linux-x64
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
# the release tree carries one wrapper per addon, so --local needs them here too
for w in addons/*/wrapper/*; do install -m 0755 "$w" "dist/$(basename "$w")"; done
(cd dist && sha256sum -- * > SHA256SUMS)
./dist/clp-addons-linux-x64 install instatic --domain=addons.example.com --local=dist
./dist/clp-addons-linux-x64 install stager --domain=stager.example.com --local=dist
```

`--local` still verifies checksums but cannot verify provenance. Staging only.
