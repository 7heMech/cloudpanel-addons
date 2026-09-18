# Releases and updates

## Where a change is proven

`dev` is the integration branch and `main` is what gets tagged. A pull request
targets `dev`; every push to `dev` runs the checks and then installs that commit
on the staging CloudPanel box, so a change is observed on a real panel before it
reaches a release. Some of this project's behaviour has nowhere else to be
seen -- CloudPanel's own templates, a site's generated vhost, an addon injected
into a panel page -- and a unit test cannot stand in for it.

The deploy workflow calls `tools/deploy-stg.ts`, the same script a workstation
runs, rather than reproducing the upload-stop-install-repair sequence in YAML.
It reads the box from `STG_HOST` and its credentials from `STG_SSH_KEY` and
`STG_SSH_KNOWN_HOSTS`; the host key is pinned rather than learned on connection,
because the deploy authenticates as root and then runs a command sequence.

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

Every request the manager serves asks whether a release is available, so the
answer is held for fifteen minutes, refreshed by one call at a time, and served
as it stands while that refresh runs. Only the first check waits for GitHub; a
box with no route there would otherwise pay the timeout on every request.

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
a new release. The manager job records `restarting background services`
immediately before the manager service is restarted. The browser treats the
expected SSE disconnect as a reconnecting state, waits for `/addons/health` to
recover, and then resumes from the on-disk job record. That probe is behind the
session gate like every other route, so the browser waits for the manager's own
JSON reply rather than for any 200 -- the login page a lapsed session is sent to
is also one. The job log therefore remains available across the restart instead
of making the update appear to stop at binary verification.

Published releases are immutable in the workflow. A failed draft can be
recreated, but an existing published tag is rejected.

A tag whose version carries a semver pre-release identifier -- anything after a
hyphen, such as `v1.2.0-rc.1` -- publishes as a GitHub pre-release. GitHub
treats the newest release that is not one as "latest", and that is the URL the
documented `curl | bash` bootstrap fetches `install.sh` from, so a tag that says
it is not finished must not become what a new install receives.
