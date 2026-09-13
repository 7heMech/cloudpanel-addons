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

The installed binary and helper checksums are recorded in a root-owned
manifest. Reapplying the same version reuses files only when every checksum
still matches; otherwise the release is downloaded and verified again.

Published releases are immutable in the workflow. A failed draft can be
recreated, but an existing published tag is rejected.
