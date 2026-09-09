# Decisions

This document describes the current architecture. The implementation
specification is [SPEC_VHOST_UNIX_SOCKET_SSO.md](SPEC_VHOST_UNIX_SOCKET_SSO.md).

## Privilege boundary

The addon applications run as `clp-addons` and can invoke only the root-owned
helpers named by `/etc/sudoers.d/clp-addons`:

```text
clp-addons ALL=(root) NOPASSWD: /usr/local/libexec/clp-addons/*
```

Every wrapper validates its complete argument set before reading input,
deriving paths, or taking a lock. Commands use argument arrays; no shell
evaluation or caller-supplied paths cross the boundary. Wrapper stdout is one
JSON object and diagnostics go to stderr.

## Integrated manager

The manager does not create a CloudPanel site or write the `site` table. A
single process serves installed addons at `/addons/` on CloudPanel's master
origin. Nginx receives a marked location block that proxies to
`/run/clp-addons/manager.sock`.

The injector finds the master vhost and records the current upstream as the
rollback snapshot, refreshing it when CloudPanel regenerates the vhost. It
always runs `nginx -t` before a reload. A failed validation or reload restores
the pristine vhost immediately.

Twig navigation uses the same reconcile-from-pristine model. Markers are
owned by `cli/inject.ts`, so multiple addons can share a template and removing
one cannot remove another's link.

## Identity and transport

`clp-addons` is a locked system account with `/usr/sbin/nologin` and membership
in CloudPanel's `clp` group. `clp-addons.service` runs as that user and group,
uses `RuntimeDirectory=clp-addons`, and starts the one active binary:

```text
/usr/local/bin/clp-addons serve
```

The socket is mode `0660`, owned by the service user and the `clp` group. The
HMAC key is root-owned and readable only by the service group; an elevated
`ExecStartPre` recreates it after `/run` is cleared during a reboot.

## Authentication

Requests first verify the short-lived `clp_addons_token` HMAC cookie. A valid
token does not invoke `sudo`. When the token is absent or invalid, the manager
validates the `PHPSESSID` through the root-owned
`clp-verify-session` helper. The helper accepts only a strict session ID,
checks `_sf2_meta` lifetime data and an authenticated security token, and
returns the fixed JSON contract. Valid sessions receive a cookie scoped to
`/addons`; other requests redirect to `/login`.

## Artifacts and updates

The active binary is always `/usr/local/bin/clp-addons`. Wrapper scripts and
the session validator live in `/usr/local/libexec/clp-addons`. There is no
release directory or `current` symlink in the active layout.

`clp-addons update` resolves a release, verifies every requested artifact
against `SHA256SUMS` and its Sigstore bundle, atomically replaces the active
files, restarts the service, and reconciles the panel integration. `upgrade`
is an alias; `self-update` is retained only as a deprecation error.

## CloudPanel data access

The root reconciliation command reads the panel database's non-secret site and
port fields into `/var/lib/clp-addons/snapshot.json`. Applications read only
that sanitized snapshot. Instance wrappers may manage the CloudPanel sites
that represent addon instances; the manager itself never creates one.

## Maintenance

The periodic timer and template path unit invoke the same idempotent repair
commands used by installation. Repair restores service-user, key, sudoers,
unit, snapshot, Twig, and Nginx invariants without requiring a second login or
manual domain configuration.
