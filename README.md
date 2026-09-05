# cloudpanel-addons

Addons for [CloudPanel](https://www.cloudpanel.io/). Multi-addon from the start;
`instatic` is the first.

The design decisions, and the reasoning behind them, live in `docs/DECISIONS.md`.
Read that before changing anything under `addons/*/wrapper/` — those scripts are
the privilege boundary.

## instatic

Adds an Instatic option to CloudPanel, plus a page listing instances with their
pinned version, state, logs and an update button.

[Instatic](https://github.com/CoreBunch/Instatic) is not a static site: it is a
Bun server with SQLite or Postgres that bakes pages to its own disk, so there is
no directory to push files into. Each instance is a container from
`ghcr.io/corebunch/instatic`, pinned to an exact version and bound to
`127.0.0.1`, behind a stock CloudPanel reverse-proxy site.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/7heMech/cloudpanel-addons/v0.1.0/install.sh | bash
```

Point that URL at a tag, never at `main`: piping a moving branch into a root
shell means the script you audited is not necessarily the script that runs.

Requirements: a CloudPanel host, x86-64, root, and Docker. The installer refuses
to continue without them.

Two things are **not** done for you, and the addon is not safe to expose until
they are:

1. **Add per-site security** to the manager's own site in the panel
   (Site → Security → Basic Auth, plus an IP allowlist if you have static
   addresses). The manager can create and delete CloudPanel sites. It binds
   `127.0.0.1`, so its own site's vhost is the only route in, and that vhost is
   where authentication happens.
2. **Issue a certificate** for it:
   `clpctl lets-encrypt:install:certificate --domainName=<host>`

## Commands

```
clp-addons install <addon> --domain=<host> [--version=vX.Y.Z] [--skip-attestation]
clp-addons update [<addon>|--all] [--version=vX.Y.Z]
clp-addons self-update
clp-addons repair [--quiet]
clp-addons status
clp-addons uninstall <addon> --yes
```

`repair` is `install` without the download, and is idempotent. A systemd timer
calls it every 15 minutes, which is how the panel-side nav entry comes back
after a CloudPanel update wipes it. There is deliberately one implementation of
"make the box match what should be installed" rather than two.

## What runs where

| Component | Runs as | Notes |
|---|---|---|
| `clp-addons` CLI | root, on demand | installer and reconciler |
| `instatic-app-linux-x64` | the addon site's CloudPanel user | manager UI, bound to `127.0.0.1:38080` |
| `clp-action-instatic` | root, via one sudoers line | the privilege boundary |
| Instatic instances | container `bun` user | one container per site, `127.0.0.1:39000-39999` |

The manager runs as the user CloudPanel already created for the addon's own
site, rather than an account this installer invents. One account per addon site
instead of two, and CloudPanel owns its lifecycle: deleting the site removes the
user.

That account is given a login shell and a password by CloudPanel so operators
can use SFTP. The installer disables both, because the addon's site is a pure
reverse proxy with no docroot anyone edits, and this is the one account
permitted to `sudo` the root wrapper — leaving it reachable would turn that
site's SFTP credentials into a path to root. `repair` re-asserts it, since
editing the site in the panel can put the shell back.

The manager has no Docker access of its own either. Membership in the `docker`
group is equivalent to root — a member can start a container with the host
filesystem bind-mounted — so every container operation, including reading state
and logs, goes through the wrapper. `clp-addons status` reports both the shell
lock and the docker group, and `repair` fixes either.

## Verification

Releases carry `SHA256SUMS` and a build provenance attestation. The checksum
catches corruption; the attestation catches substitution, which a checksum
served next to the binary cannot. Provenance verification is on by default and
skipping it requires `--skip-attestation`.

## Reaching the manager

The manager binds `127.0.0.1` and is served only through its own CloudPanel
site, so it is reached at `https://<addon-host>` once that hostname resolves to
the server. The Instatic nav entry in the panel links there.

If the hostname is not in public DNS yet, forward the server's port 443 and add
a hosts entry for it locally. Forward **443** specifically: the injected nav
entry has no port in its URL, so a different local port will not follow.

## Development

```bash
bun install
bun run typecheck
bun run lint:wrapper     # needs shellcheck; a finding here blocks a release
bun run build
```

`tools/recon.sh` is read-only and dumps facts about a CloudPanel host. **Never
commit its output**: on a production clone it names real customer domains and
real site users. `.gitignore` covers `recon*.txt`, and also `*.twig`, because
CloudPanel's templates are proprietary and are snapshotted to
`/var/lib/clp-addons/templates` at runtime rather than vendored here.

### Testing an install with no release cut yet

```bash
bun run build
(cd dist && sha256sum -- * > SHA256SUMS)
./dist/clp-addons-linux-x64 install instatic --domain=addons.example.com --local=dist
```

`--local` still verifies checksums but cannot verify provenance. Staging only.
