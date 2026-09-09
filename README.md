# cloudpanel-addons

CloudPanel Addons provides the `instatic` and `stager` tools inside the
CloudPanel master UI. Both are served at `/addons/` by one manager process.

## Install

```bash
curl -fsSL https://github.com/7heMech/cloudpanel-addons/releases/latest/download/install.sh | bash
```

The installer requires a root CloudPanel host running x86-64 Linux. It asks
which addons to install, checks Docker only when Instatic is selected, verifies
checksums and build provenance, and does not ask for a domain, DNS, certificate,
or secondary login. Non-interactive installation is available with
`--addons=instatic,stager --yes`.

The manager is installed as the `clp-addons` system user. Its only listener is
`/run/clp-addons/manager.sock`, mode `0660`; Nginx connects through the `clp`
group. The installer injects a marked `/addons/` proxy location into the
CloudPanel master vhost. It runs `nginx -t` before every reload and restores the
pristine vhost if validation fails.

CloudPanel SSO is automatic. The manager validates the CloudPanel `PHPSESSID`
through `/usr/local/libexec/clp-addons/clp-verify-session` once, then uses a
short-lived HMAC cookie at `/addons/` for subsequent requests. Unauthenticated
requests redirect to `/login`.

## Addons

### Instatic

Adds static-site hosting through containers from
`ghcr.io/corebunch/instatic`. Instances use exact image tags and ports in the
reserved `39000–39999` range. Their data and site records are managed by the
root wrapper `clp-action-instatic`.

### Stager

Adds clone actions for PHP, static, and supported Instatic reverse-proxy sites.
Long-running clones use a transient systemd job and retain their logs and
database credentials only for the configured job-retention period.

## Commands

```text
clp-addons install <addon> [--version=vX.Y.Z] [--skip-attestation]
clp-addons update [--version=vX.Y.Z] [--skip-attestation]
clp-addons upgrade                         # alias for update
clp-addons repair [<addon>] [--quiet] [--anchors-only]
clp-addons status
clp-addons uninstall <addon> --yes [--purge]
clp-addons serve
```

`clp-addons update` downloads and verifies the binary, session validator, and
installed wrappers; atomically replaces them; restarts `clp-addons.service`; and
reconciles the CloudPanel Twig anchors and Nginx proxy. There is one active
binary at `/usr/local/bin/clp-addons` and one helper directory at
`/usr/local/libexec/clp-addons`. The old `self-update` command is deprecated.

`repair` is safe to run repeatedly. It recreates the dedicated account and
socket key permissions, refreshes the panel snapshot, validates sudoers,
reinstalls service units, and restores marked Twig/Nginx changes after a
CloudPanel update.

`status` prints a compact dashboard showing daemon state, socket permissions,
Nginx and Twig integration, installed routes, wrapper state, and the dashboard
URL (`https://<cloudpanel-host>/addons/`).

Uninstalling an addon removes its wrapper, config, sudo permission, and panel
anchors. Instance data remains unless `--purge` is supplied; purge archives
before asking the wrapper to remove each instance.

## Development

```bash
bun install
bun run typecheck
bun tools/test-inject.ts
bun run test
bun run lint:wrapper
bun run build
```

The compiled release is `dist/clp-addons-linux-x64`. Release assets also include
the two wrapper scripts and `clp-verify-session`; all are listed in
`SHA256SUMS` and attested by the release workflow.
