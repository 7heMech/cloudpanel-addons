# Releases and updates

## Where a change is proven

`dev` is the integration branch and `main` is what gets tagged. A pull request
targets `dev`; the checks run and then that commit is installed on the staging
CloudPanel box -- for the pull request as it would merge, and again for `dev`
once it lands -- so a change is observed on a real panel before it reaches a
release. There is one box, so it holds whatever deployed last; a pull request
from a fork is skipped, because it cannot be given credentials that authenticate
as root on a live machine. Some of this project's behaviour has nowhere else to be
seen -- CloudPanel's own templates, a site's generated vhost, an addon injected
into a panel page -- and a unit test cannot stand in for it.

The deploy workflow calls `tools/deploy-stg.ts`, the same script a workstation
runs, rather than reproducing the upload-swap-restart-repair sequence in YAML.
Replacing the binary is a rename, so the services keep serving the old inode
until they are restarted; the restart is part of the install. The binary the box
was running is hard-linked aside just before the rename, so a restart or repair
that fails puts it back, including on a box deploying for the first time.
It reads the box from `STG_HOST` and its credentials from `STG_SSH_KEY` and
`STG_SSH_KNOWN_HOSTS`; the host key is pinned rather than learned on connection,
because the deploy authenticates as root and then runs a command sequence.

## Toolchain

Development, CI, staging, and release use the Bun version pinned by
`packageManager` in `package.json`; the workflows read it from there. Installs
use the frozen `bun.lock`.

Builds compile minified ESM with `--bytecode`. The gateway starts a fresh
`clp-addons action` process for every request, and bytecode roughly halves that
startup for about 4% more binary size.

`bun run typecheck` runs `bun check --project tsconfig.tools.json`, covering
the CLI, shared libraries, addons, manager, tools, and tests with the existing
strict compiler options. Bun supplies the checker and standard library types;
`@types/bun` supplies its API declarations, so a separate `typescript`
dependency is unnecessary.

`bun run test` uses
`bun test --isolate --max-concurrency=1 --parallel=4 --timeout=20000 --timings=tests/timings.json`.
Each test file gets a fresh global object and module registry, containing its
`mock.module` overrides and cleaning up its timers and I/O. Tests stay
sequential within a file because some fixtures share mutable state, and because
the code under test spawns commands and waits on SQLite locks synchronously, so
overlapping tests in one process would not save time. Files share nothing on
disk or network beyond their own temporary directories, so they run in four
worker processes at once. The suite waits on child processes and deadlines more
than the CPU, so four workers beat one per core on a two-core box, and two
suites can still run there at the same time. More workers starve the
timing-sensitive tests past their timeouts when two suites overlap. Several
tests need most of a second of CPU, so when four suites share two cores they
pass Bun's default 5-second limit; the 20-second limit lets an overloaded run
finish slowly instead of failing. Tests that check their own deadlines set them
explicitly. `tests/timings.json` holds measured per-file durations so the
slowest files start first; refresh it with `bun run test --update-timings` after
adding a slow file. Bun discovers the suite and accepts file filters through
`bun run test ./tests/test-update.test.ts`; a failure returns a nonzero exit
code to CI.

## Verified artifacts

The tag workflow builds one Linux x86-64 binary and publishes it with the
installer, SHA-256 sums, and GitHub build provenance. Updates verify the
checksum and repository-bound attestation before replacing the binary.
`--skip-attestation` is an explicit operator override.

The binary checks provenance itself with Sigstore's `@sigstore/verify`, the
checks `gh attestation verify --repo --signer-workflow` makes: a SLSA
provenance statement naming the artifact's SHA-256, signed in Sigstore's public
log by a GitHub Actions certificate for this repository's `release.yml` on the
release's own tag, with this repository as its source. An attestation of an
older tag does not vouch for the same bytes republished under a newer one. Sigstore's trusted keys come through its TUF
repository, `tuf-repo-cdn.sigstore.dev`, and are cached in
`/usr/local/libexec/clp-addons/sigstore`, where only root can write. They are
not frozen into the binary: a rotated key would then refuse the very update
that carries the new one. An update removes the GitHub CLI earlier releases
kept in `/usr/local/libexec/clp-addons/gh`.

## Installer

`install.sh` checks the host, downloads the binary from
`/releases/latest/download` or the `--version` tag, checks it against
`SHA256SUMS`, and installs it. It makes no GitHub API call. It then runs
`clp-addons install --local=DIR` with the addons from `--addons`, or with none
on the terminal the script was started from, so the binary asks. The question,
the addon names and what each addon needs, such as Docker, live only in the
binary, and the picker is the same list as the `clp-addons` menu.

The installer does not check provenance. Under `curl | bash`, `install.sh`
comes from the same release as the binary, so anyone able to substitute the
binary could substitute the script and its check with it. The checksum catches
a damaged download; provenance protects every update, which the installed
binary verifies. An operator who verifies `install.sh` itself, which is
attested with the binary, before running it gets the same assurance for the
first install. `install` takes no `--version`; changing version is `update`.

## Default selection

The installer preselects Panel Tweaks, System Tweaks, Maintenance Mode, Terminal
and Security Keys, each marked `preselected` in its addon definition. A default is useful on almost any box, needs no outside
account, and changes nothing until used unless the change is itself protective.
Addons that need a Cloudflare token or relay account, manage Postfix, or serve
one task (Stager, Instatic, Git Deploy, PHP Resources) are chosen by hand, as are
Cloudflare IP Access and WordPress Tools, which only some boxes want. The
selection only applies when the installer runs; `update` never adds an addon.

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
manifest. An update to the version already installed whose checksums all still
match says so and changes nothing; re-applying the panel side is `repair`'s job.
If a checksum differs, the release is downloaded, verified and installed again.

The binary being replaced is hard-linked aside under `/usr/local/libexec` with
its manifest. The outgoing process outlives the one it hands off to, so it is
what restores both, restarts the services and names the version the box is left
running when the replacement fails part-way, the handoff exits non-zero, or the
manager unit does not come back. The kept-aside binary is checked for being a
root-owned, non-group-writable executable at the moment it is restored rather
than trusted for having been written there. Its manifest's checksum is compared
and a disagreement is reported, not refused: the manifest is rewritten only by
the release install path, so a binary installed by `tools/deploy-stg.ts` or by
hand legitimately disagrees with the manifest left beside it, and refusing would
leave the box on the binary that just failed. Both files need root to write, so
the comparison catches drift rather than tampering: whoever could rewrite the
checksum could rewrite the binary, and authenticity is established upstream,
when the release is downloaded and verified. A box with no usable earlier copy
is told so rather than left looking rolled back.

This rolls the two artifacts back and nothing else. Config files, units,
templates and Nginx fragments the update had already written are the new
version's and stay, so the failure message asks for a `repair`, which is what
converges them.

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

On a box running a release, the update notice and a plain `clp-addons update`
never look past "latest", so it gets a pre-release only when asked:
`clp-addons update --allow-prerelease` installs the newest published release,
pre-releases included, and adding `--version` names one. A box running a pre-release
follows them without being asked: the notice, the panel's Update and a plain
`clp-addons update` all take the newest published release. A nightly or rc build
therefore moves to the next one, and to the release once that is the newest,
which puts the box back on releases. No setting records the choice; the
installed version is the channel. The newest is picked from the latest 100
releases GitHub lists, and without `--version` an update never moves to an
older version than the one installed. That is how a release candidate is
tried on a real box before anyone else gets it. The release is then tagged on
the candidate's commit, so what was tried is what ships, and versions compare
with semver's pre-release order, so a box on `2.0.0-rc.1` is offered `2.0.0`.
