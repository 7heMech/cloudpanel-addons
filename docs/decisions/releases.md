# Releases and updates

## Verified artifacts

The tag workflow builds one Linux x86-64 binary and publishes it with the
installer, SHA-256 sums, and GitHub build provenance. Installation and updates
verify the checksum and repository-bound attestation before replacing the
binary. `--skip-attestation` is an explicit operator override.

If an attestation-capable GitHub CLI is unavailable, the installer or binary
downloads GitHub CLI's official archive, checks its published checksum, tests
the candidate, and installs it in `/usr/local/libexec/clp-addons/`.

## Update behavior

Updates are manual. The manager shows an available release and starts the same
verified update path as `clp-addons update` only after an administrator selects
**Install update**. The work runs in a transient systemd job because replacing
the binary restarts the manager.

The native CloudPanel header asks the manager for update state; it does not
depend on the updater process's compile-time version. That process can reconcile
Twig after replacing the binary, so the version-independent header reads
`GET /addons/api/update` and rechecks restored or refocused pages. The running
manager is the source of truth.

The installed binary and helper checksums are recorded in a root-owned
manifest. Reapplying the same version reuses files only when every checksum
still matches; otherwise the release is downloaded and verified again.

After replacement, the outgoing process performs no provisioning. It re-runs
the same update command through the installed binary with an internal flag that
bounds the handoff. That process generates configuration, units and panel
integrations from its own definitions, then restarts services last. Re-entering
the stable update command also preserves explicit downgrades to releases from
before the handoff existed. Merely moving the restart would not be sufficient:
the old process could still write old Twig or unit definitions after installing
a new release.

Published releases are immutable in the workflow. A failed draft can be
recreated, but an existing published tag is rejected.
