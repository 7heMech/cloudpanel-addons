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
| `instatic-app-linux-x64` | `instatic-app` | manager UI, bound to `127.0.0.1:38080` |
| `clp-action-instatic` | root, via one sudoers line | the privilege boundary |
| Instatic instances | container `bun` user | one container per site, `127.0.0.1:39000-39999` |

The manager has no Docker access of its own. Membership in the `docker` group is
equivalent to root — a member can start a container with the host filesystem
bind-mounted — so every container operation, including reading state and logs,
goes through the wrapper. `clp-addons status` reports it if the account ever
ends up in that group, and `repair` removes it.

## Verification

Releases carry `SHA256SUMS` and a build provenance attestation. The checksum
catches corruption; the attestation catches substitution, which a checksum
served next to the binary cannot. Provenance verification is on by default and
skipping it requires `--skip-attestation`.

## Reaching a staging box from your machine

Everything binds loopback or is a name-based vhost, and on staging the
hostnames are hosts-file entries rather than real DNS, so a browser needs both
a tunnel and a local hosts entry.

Two ports matter, and they are served by different nginx instances:

| Port | Serves |
|---|---|
| 8443 | the CloudPanel UI (`clp-nginx`) |
| 443  | every site, including the addon manager and each Instatic instance |

Forward both. Local **443** rather than some other port, because the nav entry
the addon injects into the panel links to `https://<addon-host>` with no port,
and a browser will not rewrite it:

```bash
sudo ssh -L 443:127.0.0.1:443 -L 8443:127.0.0.1:8443 root@<box>
```

`sudo` is only needed for the privileged local 443. Then, on your machine:

```
# /etc/hosts   (%SystemRoot%\System32\drivers\etc\hosts on Windows)
127.0.0.1 addons.example.invalid demo.example.invalid
```

Use the hostnames the box actually serves — `clpctl` and the addon record them,
and `clp-addons status` prints the manager's. Then:

- panel: `https://localhost:8443`
- addon manager: `https://<addon-host>` — the panel's Instatic nav entry goes here
- an instance: `https://<instance-host>`

Certificates are per-site and self-signed until Let's Encrypt runs, so expect a
browser warning on staging. The manager also sits behind whatever per-site
security you configured, so a basic-auth prompt there is the correct behaviour,
not a fault.

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
