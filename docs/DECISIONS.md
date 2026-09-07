# Decisions

Why the code is shaped the way it is. Where something here says a decision is
settled, don't relitigate it in code — argue it here first.

## The wrapper is the whole security model

`addons/*/wrapper/clp-action-*` runs as root via one sudoers line. Everything it
permits, the unprivileged app account can do as root. The account's isolation is
worth exactly as much as the wrapper's argument validation is strict, so that
file is the one to review line by line.

Rules, none negotiable:

- **Validate before acting.** Parse every argument, validate it, *then* derive
  paths and take locks. Deriving the lock path from an unvalidated `--domain`
  once let `../../../tmp/x` place a root-owned file outside the lock directory.
- **Reject; never sanitize.** A sanitizer that silently rewrites hostile input
  hides the attempt and eventually rewrites it wrong.
- **argv arrays only.** No `sh -c`, no `eval`, no backticks, no interpolating
  into a command string.
- **No free-form arguments.** No paths, no filenames, no registry host, no
  compose file location. One such argument and the verb list stops being closed.
- **The registry is hardcoded.** Only the tag crosses the boundary.
- **One wrapper per addon**, so a bug in one cannot be walked through to reach
  another's verbs. `ALL=(root)`, one absolute path, no wildcards:
  `NOPASSWD: /usr/bin/clpctl *` is equivalent to full root.
- **stdout is a contract**: exactly one JSON object. Progress goes to stderr.
  Never scrape prose for meaning.

### `set -e` in the wrapper, specifically

Two silent failures have come from the same shape:

```bash
foo() {
  [[ cond ]] && emit_err "..."     # returns 1 when cond is FALSE
}
foo "$x"                            # set -e: exits, with no output at all
```

A trailing `&&` list returns non-zero on the *success* path. The function then
returns non-zero, and `set -e` aborts the script producing nothing — which is
indistinguishable from a no-op. Use `if`, and end validators with `return 0`.

The same applies to `pipefail`: `x=$(cmd | tr ...)` aborts the assignment when
`cmd` exits non-zero, even though the pipeline produced the value you wanted.
Add `|| true` where a non-zero exit is expected.

`tools/test-wrapper.sh` asserts that every verb with valid input *emits
something*, which is what catches this class. A rejection-only test suite does
not — the bug lives on the success path.

## Placement: the addon is its own CloudPanel site

The manager binds `127.0.0.1` and is reached through a stock CloudPanel
reverse-proxy site, with per-site security in front. Not a path on the panel's
own vhost.

The panel-vhost variant is tempting because it is same-origin, and it was tried:
a `location /instatic/` block proxying to the app. It was removed because

- `proxy_pass` bypasses CloudPanel's PHP session check entirely, so the page was
  reachable with no credentials at all while every real panel path redirected to
  `/login`;
- the panel regenerates its own vhost and `cloudpanel.postinst` replaces
  `/home/clp/htdocs/app` wholesale on upgrade, so the block is a second fragile
  surface the reconciliation timer would have to watch;
- same-origin buys nothing anyway, because there is no way to share the panel's
  PHP session. Authentication has to be added either way.

An own site gets SSL, backups and the panel's own security UI for free.

## The manager runs as CloudPanel's site user

Decision 2.4 says the addon runs as the site user CloudPanel creates. An earlier
version created a dedicated `instatic-app` account instead, which meant two
accounts existed for one addon site and uninstall had its own user to clean up.
The site user is now resolved from the panel database after the site is created,
and the legacy account is removed on install and repair.

CloudPanel gives site users a login shell and a password so operators can reach
the docroot over SFTP. For this site that is a liability rather than a feature:
it is a pure reverse proxy with an empty docroot, and it is the one account
permitted to `sudo` the root wrapper. Left as-is, the site's SFTP credentials —
visible to anyone with panel access to that site — would be a path to root.

So the installer sets the shell to `nologin` and locks the password, and
`repair` re-asserts both, because editing the site in the panel can restore the
shell. `clp-addons status` reports the state.

This is the one place the design deliberately hardens something CloudPanel set
up, rather than leaving panel-managed state alone. It is worth the exception
because the alternative is a documented escalation path.

## Instances run as their own site user too

The first pass at decision 2.4 changed only the manager. Instances kept the uid
baked into the Instatic image, and the wrapper chowned their data to `1000:1000`
to match it. On a CloudPanel box uid 1000 is `clp`, the account that owns the
panel and `db.sq3`, so every instance's data belonged to the panel's own
identity and all instances shared one.

Each instance already has a CloudPanel site, and therefore a site user. That
account is now the instance's identity: `docker run --user <uid>:<gid>`, with
`data` and `uploads` owned by it. The uid is read from the `site` table rather
than derived from the domain, because a site the addon adopted keeps whatever
user it already had. `instatic.env` stays root-owned: it holds the master key,
and the site user has SFTP.

Ownership is re-applied on every container start rather than only at create.
The failure it prevents is quiet — a container that cannot write its database
still answers `GET /`, so the health check passes and the instance looks fine
until someone tries to save something. `tools/test-wrapper.sh` asserts the
running container's uid matches the panel's record and that it can actually
write, because neither is visible from the outside.

Docker fixes a container's configuration at creation, so restarting an instance
built by an older release will not move it. The `recreate` verb rebuilds it
from the recorded tag, leaving the data in place.

## The bootstrap installer is a release asset

The documented one-liner used to read `install.sh` off
`raw.githubusercontent.com` at a hardcoded tag. Two problems, and the second was
live: the tag had to be edited into the README by hand after every release, and
because nobody did, the published command was still serving the v0.1.0
installer -- which predates the tokenless provenance fix and therefore demanded
`gh auth login` from anyone who ran it.

`install.sh` is now built into `dist/` alongside the binaries, so it appears in
`SHA256SUMS`, is covered by the same build provenance attestation, and is
reachable through GitHub's `/releases/latest/download/` redirect. The README
points at that redirect and stops going stale.

The original rule was "point at a tag, never at `main`", on the grounds that
piping a moving target into a root shell means the script you audited is not the
script that runs. The redirect is still a moving target, so that reasoning is
narrowed rather than abandoned: it moves only when a release is cut, the thing
it moves to is immutable within that release, and it is attested -- none of
which is true of a branch. An operator who wants to audit first can fetch a
pinned release asset and verify it before running it, which the README shows.

## Provenance is verified from a released bundle, not from the API

Verification has to work without a GitHub account: `gh attestation verify` on
its own reaches for the attestations API and demands `gh auth login` or a token
even for a public repository, which would put an account in the path of every
install. Passing `--bundle` avoids that, but something has to produce the
bundle first.

Fetching it from the attestations API works and needs no credentials, but the
API returns bundles wrapped in an envelope, so the caller has to parse JSON to
unwrap them. In the bootstrap installer that meant a Python heredoc -- a
dependency the preflight check did not even test for, added by a comment
explaining that `jq` could not be relied on. Trading `jq` for `python3` is not
an improvement, and needing either to install a shell script is the wrong shape
of problem.

The release now publishes `attestations.jsonl`, every artifact's bundle, one
per line. `gh` reads that file directly, and a single file verifies any one of
the artifacts, so the installer parses nothing and the CLI makes one download
instead of an API call per artifact.

Serving the bundles from the release rather than the API is not a weaker
position. A bundle is signed and bound to its subject's digest, so an attacker
who can replace a release asset cannot produce one that verifies against the
replacement -- the failure mode is a refused install, not a silent accept.

## An artifact already in the release tree is not downloaded again

The artifact set is per release, not per addon: `current` is shared, so every
call has to fetch every installed addon's copy. That made the cost quadratic in
addons. `update` with two installed fetched all five artifacts twice, about 480
MB where 240 would do, and `install.sh` did the same by invoking the CLI once
per addon.

`releases/<tag>` is where `placeRelease` has already written whatever an earlier
call fetched, so it doubles as the cache. No second directory, no cleanup path
of its own: `pruneReleases` already owns it.

Reuse is gated on the release's own recorded checksum, so it is not a weaker
check than downloading. A file sitting in the right directory under the right
name whose bytes hash to something else is downloaded again rather than trusted
for being in the right place, and the provenance attestation afterwards runs
over the same bytes either way. The sigstore bundle is still fetched every time,
because it is a few kilobytes and is what detects substitution.

The bootstrap installer seeds that directory with the CLI it has just verified,
before handing off. Otherwise the CLI was downloaded twice on every fresh
install: once by `install.sh`, which then deletes its temp directory, and once
by the CLI itself, whose cache looks in a release tree nothing had created yet.
On a single-addon install that was a third of the whole download. Seeding cannot
smuggle anything in, because the CLI re-hashes whatever it finds against the
release's own SHA256SUMS before using it, and what the installer places there
has already been checked against the same file.

The tag is shape-checked in `install.sh` before it is used, because at that
point it stops being only a URL fragment and becomes a path component that root
writes to.

The directory is a parameter with a default so the reuse logic can be tested
somewhere writable, for the same reason the injector's paths are parameters.

## The platform owns the panel templates; addons only supply markup

The injector used to live inside the Instatic addon, and `cli/index.ts`
imported it directly. That read as untidy layering. It was worse than untidy:
two addons could not coexist, and none of it was visible with one installed.

Pristine state was keyed by the addon's target rather than by the template. So
the second addon to install snapshotted a file that already contained the first
addon's block -- with that block stripped as if it were its own, because the
markers were a module-level constant naming Instatic. Reconstructed against the
real code, with two synthetic addons patching one template:

    both installed        : A=false B=true
    uninstall addon A     : A=false B=false
    B reconciles (15 min) : A=false B=true
    A reconciles (15 min) : A=true  B=false

Installing B silently deleted A's nav entry; the two reconciliation timers then
overwrote each other every fifteen minutes; and uninstalling either removed
both.

The pristine copy is now keyed by the template, because the template is what is
shared, and rendering re-applies every installed addon's snippet in one pass
from that copy. Removal is not a separate operation: uninstalling an addon
means reconciling without its injections, so there is no second code path that
could disagree with the first. Reconciling with none restores the file exactly
and deletes the snapshot.

Three supporting choices:

- The injector owns the markers, which name the addon and the target
  (`{# clp-addons:instatic:header-nav:start #}`). An addon supplying its own
  could pick another addon's by accident, which is precisely what happened.
- Addons declare a template path relative to CloudPanel's templates directory.
  An addon has no business knowing where the panel keeps its files, and a value
  import from the registry back into an addon would close an import cycle.
- Injections for one file are applied in a stable order, so two addons patching
  one anchor cannot swap places on each reconciliation and produce a file that
  never settles.

`tools/test-inject.ts` runs the whole scenario against a throwaway template and
asserts what the old design got wrong: installing the second addon keeps the
first, uninstalling one leaves the other, repeated reconciliation is idempotent
and byte-stable, and removing the last addon restores the original exactly.

Markers written before v0.3.0 had no slug segment. The strip pattern still
matches them, because the first reconciliation after an upgrade would otherwise
snapshot a file with the old block still in it and bake that nav entry into the
pristine copy permanently. Snapshots from the old per-addon keying are deleted
on sight: they have no `.path` sidecar, nothing reads them, and an operator
would reasonably mistake them for current.

## The wrapper's files are the only record of what exists

The manager kept its own SQLite table of instances beside the wrapper's
`meta.json` files. Two records of one fact drift, and these did: an instance
created by calling the wrapper directly never appeared in the dashboard, and a
delete that failed part-way left a row describing something that was already
gone. The table was also the thing `nextPort` consulted, so a drifted row meant
a port handed out twice or never reused.

The files on disk and the running container are the state. The wrapper now has
a `list` verb that walks its own data directory and reports each instance's
recorded metadata with live container state, and the manager holds nothing of
its own -- `app.db` and `db.ts` are gone, along with every write that kept them
in step.

It has to be one call rather than one per instance, because the manager cannot
read those directories: each belongs to its instance's own site user. `list` is
also the one verb exempt from the per-domain lock. It names no domain, so there
is nothing to lock, and locking would mean the dashboard stops rendering
whenever any instance is mid-update -- precisely when someone is looking at it.

Port allocation is now a proposal rather than a reservation: the manager picks
the lowest free port and the wrapper re-checks it under the lock. That is the
honest description of what was always happening, and it no longer depends on a
record only the manager maintained.

## One naming scheme for the accounts CloudPanel creates for us

`clpctl site:add:reverse-proxy` requires `--siteUser` and only generates a name
for sites created through the panel's own UI, so this addon has to supply one.
It used to supply two: `a<addon>-<domain>` for the manager's site and
`inst_<domain>` for an instance's, both truncated to fifteen characters.

Two schemes for one job is the smaller problem. The larger one is that
truncation made uniqueness rest on a prefix of the domain, and `site.user` is
UNIQUE, so `demo.clp-stg.local` and `demo.clp-stg.example.com` both reduced to
`inst_democlpstg` and the second site failed from inside clpctl with nothing
explaining why.

There is now one scheme, used for every site this addon creates:

    addon-<first 8 alphanumerics of the domain>-<6 hex of sha256(domain)>

Hashing the whole domain is what makes it safe; the readable fragment is for
operators reading `/etc/passwd`, and the `addon-` prefix both marks ownership
and guarantees the name starts with a letter, which a domain beginning with a
digit would not. CloudPanel accepts the resulting 21 characters -- verified
against a real `site:add:reverse-proxy` before adopting the length.

The manager's site and an instance's site are named the same way on purpose.
They are both just sites this addon created; which one is the manager's is
already recorded in `OWN_DOMAIN`, and encoding a role in the account name would
be a second source of truth for something the config already answers.

It is written twice -- once in `cli/provision.ts` and once in the wrapper,
which is bash and cannot import TypeScript. Two implementations of one rule
drift silently, and the failure would be the manager creating a site under one
name while the wrapper looks for another, so `tools/test-app.ts` runs both over
a list of domains and asserts they agree, including the pair that used to
collide.

Nothing migrates. The name is only ever used at creation; everywhere else the
account is read back from the panel's `site` table, so sites created under the
old schemes keep working under their old names.

## The dashboard's inline script is syntax-checked in CI

The client-side script is a TypeScript template literal interpolated into the
page, which means TypeScript consumes one level of backslash before a browser
ever sees it. A `\n` written for the browser arrives as a real newline, and
inside a single-quoted JavaScript string that is a SyntaxError.

The consequence is out of all proportion to the typo: the error takes down the
entire `<script>` element, so every handler on the page is undefined and every
button silently does nothing. Nothing else notices. The server renders, the
routes answer, the wrapper works, the tests pass -- the failure is visible only
in a browser console. It shipped, and the dashboard's buttons were dead through
four releases while the wrapper underneath them was being exercised directly.

`tools/test-app.ts` compiles the script with the `Function` constructor, which
parses without executing, and separately reports any line that leaves a quote
open so the failure names a line rather than an offset into a 4 KB blob. It
runs in CI. Escapes intended for the browser must be doubled, and this is what
enforces that.

## Uninstall reverses install, and says what it will destroy

`uninstall` removes the manager and un-patches the panel but leaves instances
alone, so it cannot become an accidental way to delete a customer's site.
`--purge` is the full reversal, and it delegates each instance to the wrapper's
own `delete` verb rather than reimplementing the teardown: that path already
archives the data, passes `--force` so `clpctl` cannot block on a prompt, and
refuses to delete a site the addon did not create.

Ordering matters and was wrong at first: instances are removed through the
wrapper, so the wrapper has to outlive that loop and is deleted afterwards, not
before. The release tree and `clp-addons` itself are shared between addons, so
they go only when no other addon's config remains -- deleting the binary that
is currently executing is safe, since the inode survives until the process
exits.

Both forms print an inventory naming every instance and site they will touch,
and refuse to act without `--yes`. "and every instance" is not something an
operator can check against what they believe is on the box; a list of domains
is. Whether the manager's own site is removed depends on a marker written at
install time — if the addon adopted an existing site, that site was serving
something first and is left in place.

## The app has no Docker access

Membership in the `docker` group is equivalent to root: a member can start a
container with `/` bind-mounted. The app was briefly in that group so it could
run `docker inspect` and `docker logs` directly, which made every restriction in
the wrapper decorative.

Container state and logs are wrapper verbs (`status`, `logs`) for this reason.
`clp-addons status` reports the group if it reappears; `repair` removes it.

## Systemd sandboxing is deliberately thin

`NoNewPrivileges` is left off, and the usual hardening directives are absent.
This is not an oversight:

- the app's only privileged path is `sudo <wrapper>`, and `NoNewPrivileges=yes`
  blocks sudo outright. `ProtectKernel*`, `RestrictNamespaces`,
  `RestrictAddressFamilies`, `SystemCallArchitectures`, `MemoryDenyWriteExecute`
  and `RestrictSUIDSGID` all imply it;
- namespace directives are inherited by children, so `ProtectSystem` and
  `ProtectHome` would apply to the wrapper too — and the wrapper legitimately
  needs `/home/clp` to read the panel database and `/etc` because `clpctl`
  writes vhosts.

Sandboxing the unit would break the boundary rather than reinforce it. The
isolation that holds is the unprivileged account plus a one-line sudoers rule.

## Panel state is a sanitized snapshot

The port-collision check needs the panel's site list, but the panel database
holds password hashes and site credentials, and the app's account cannot read
`/home/clp` at all. So the privileged side reads non-secret columns and writes
`/var/lib/clp-addons/snapshot.json` (0640, temp-file-and-rename); the app reads
only that.

This is enforced by file layout: `lib/panel-snapshot.ts` is root-only and
`lib/snapshot-reader.ts` is what the app imports. "The app cannot read the panel
database" should be visible in the imports, not be a convention someone has to
remember.

## The panel-side anchor

CloudPanel's Twig templates are proprietary and are never committed here, in any
form. The pristine copy is snapshotted off the running box into
`/var/lib/clp-addons/templates`, patched from there, and hashed there.

- **Outside `/home/clp/htdocs/app`**, because `cloudpanel.postinst` moves that
  directory aside and extracts a fresh copy on upgrade. A pristine backup kept
  beside the template is destroyed by the exact event it exists to survive.
- **Regenerate from pristine**, never patch what is on disk. Patching a
  possibly-patched file eventually double-applies.
- **Hash the pristine copy.** The panel's PHP is obfuscated and cannot be
  diffed, but Twig is plain text. If upstream's copy stops matching the recorded
  hash, CloudPanel has touched the file our patch targets, so stop and flag.
  Applying a patch built for the old markup is worse than having no link.
- **The check is functional, not a file diff.** A marker block whose content no
  longer matches the expected snippet counts as stale, not present — otherwise
  changing the addon's hostname leaves the nav pointing at the old one forever.
- **Purging the Twig cache is mandatory.** Twig serves the compiled copy until
  the cache is gone.

### Reconciliation: a timer plus a path unit

Reconciliation is a systemd timer, not a dpkg hook: a hook catches apt-driven
updates and misses manual ones, while a timer catches every path including
unattended-upgrades at 6am. It calls `clp-addons repair`, so there is one
implementation of "make the box match what should be installed".

A 15-minute timer means up to 15 minutes with the nav entry missing, so a
`.path` unit watches the two templates and repairs on change. Measured on a
real `cloudpanel.postinst` run with the timer stopped: wiped at 09:36:45,
repaired at 09:36:50.

The watch is a **root-run systemd path unit, not a watcher inside the addon
service**. The obvious idea is that the Bun service is still running during a
panel update and could re-patch the files itself, but `/home/clp` is `0700
clp:clp` — the service account cannot even traverse into it. Giving it the
access would mean either the `clp` group, which is read/write over the entire
panel tree, or a new wrapper verb. Both widen the privilege boundary to save a
few minutes, and systemd already does the job from outside it.

The path unit triggers `clp-addons-anchor.service`, which runs
`repair --anchors-only`, rather than the full reconciliation. Pointing it at the
full repair was measurably wrong: an update rewrites the templates repeatedly
while it extracts, and that produced six wrapper reinstalls, twelve `visudo`
runs and six `daemon-reload`s inside twenty seconds, in the middle of a package
upgrade. A two-second `ExecStartPre` coalesces the burst.

Both stay. The path unit is fast but can miss an event; the timer is the
backstop and also refreshes the snapshot and the sudoers drop-in.

## Instances

- **Reverse Proxy site type, never a new value in `site.type`.** The panel keys
  tab rendering, vhost regeneration and clpctl validation off that column.
- **Never edit vhosts or write to the panel database.** `clpctl` covers site
  creation; anything after that means writing an undocumented schema while the
  panel is running, where a wrong row shape corrupts panel state rather than
  failing cleanly. This costs a feature: an instance's port cannot be changed
  from the UI. Accepted.

  Read as "never write panel state ourselves", not "never reproduce a vhost".
  This bullet is about instances, and it was taken as a platform-wide ban, which
  cost the Stager addon a feature it could have had all along -- see "Carrying a
  site's vhost to its clone". The test is whether `clpctl` can be made to do the
  writing. When it can, doing it through `clpctl` is not an exception to this
  rule, it is the rule.
- **Pin an exact version, never `latest`.** With a floating tag you cannot tell
  what is running or roll back.
- **Bind to `127.0.0.1` explicitly.** Docker publishes past ufw, so `3001:3001`
  exposes the instance to the internet with the firewall shut.
- **Ports from 39000-39999**, well clear of where CloudPanel hands out Node.js
  and Python app ports. The manager itself sits outside that block (38080) so it
  can never collide with an instance.
- **`INSTATIC_SECRET_KEY` is generated once per instance and never rotated by an
  update.** The image runs `NODE_ENV=production`, where Instatic refuses to boot
  without it, and it encrypts recoverable secrets such as API keys and TOTP
  seeds — a new key leaves every previously encrypted row unreadable. It is
  passed by `--env-file`, not `-e`, so it never appears in `ps` output, and it
  travels inside snapshots, because a restored database without it has
  unreadable secret columns.
- **Snapshot with `sqlite3 .backup`, not `cp` or `tar` over the live file**,
  which can capture a database mid-write. The `-wal`/`-shm` pair is skipped;
  `.backup` folds it in, and copying it alongside would restore a torn pair.
- **Update is snapshot, pull, restart, health check, auto rollback.** The health
  check polls the container, then confirms nginx actually serves the hostname.
  On failure the container logs are captured before rolling back. Auto-update is
  off by default: Instatic is 0.0.x and its APIs will shift before 1.0.

## The reconciliation timer needs a calendar trigger

The timer carried only monotonic triggers: `OnBootSec=2min` and
`OnUnitActiveSec=15min`. Both anchor to an event in the past, and once systemd
decides there is no future elapse the unit parks in `SubState=elapsed` and never
fires again. It still reports `active`.

Found on the staging box, thirteen and a half hours dead:

    NextElapseUSecMonotonic=infinity      SubState=elapsed
    LastTriggerUSec=Sun 2026-09-06 01:10:45 EEST

Two things made it worse than a missed tick. `systemctl restart` on the timer
does not revive it -- measured, it came back still `elapsed` with no next elapse,
and only activating the service itself re-anchored `OnUnitActiveSec`. And
`startUnits()` restarts this timer on every install and update, so cutting a
release was itself a chance to kill reconciliation. The recovery line in
`repair` was `systemctl start` on an already-active unit, which is a no-op, so
the self-healing path could never fix the one state that needed fixing.

What stops silently when it dies: the nav entry stays gone after a CloudPanel
update, the panel snapshot goes stale, and nothing re-asserts `nologin` on the
one account permitted to `sudo` the wrapper. The `.path` unit still covers the
template case, which is why the box looked fine.

`OnCalendar=*:0/15` always has a next elapse, so the unit cannot get stuck.
Verified against the failing operations: a scratch unit held its next elapse
through three restarts and a `daemon-reload` issued while the triggered service
was running. `Persistent=true` also starts meaning something, having only ever
applied to `OnCalendar=`.

`status` now prints the next elapse rather than `is-active` alone. "Active" was
the answer that hid this for thirteen hours, so it is not the question to ask.

## Snapshot archives are secrets at rest

`make_snapshot` copies `instatic.env` into the tarball on purpose -- decision
2.10 says the master key travels with the data, because a restored database
without it has unreadable secret columns. What was missing is that this makes
every archive as sensitive as the key file the wrapper keeps at 0600 root.

The mode was left to the caller's umask. Through the app's `sudo` that meant
0640, because the unit sets `UMask=0027`; run by root from a shell, which is the
`uninstall --purge` path, it meant 0644. `/var/backups/clp-addons/instatic` was
0755. So a deleted instance's entire database and the key that decrypts its API
keys and TOTP seeds sat world-readable, and on a CloudPanel box every site user
has SFTP. Confirmed on staging by reading one as an unrelated instance's uid.

The archive mode is now set here rather than inherited: `umask 077` around the
`tar`, an explicit `chmod 600`, and 0700 on both the backup directory and each
instance's `snapshots/`. Files written before this keep their old mode and
nothing else would ever revisit them, so `repair` tightens them, which is the
same reason `repair` re-asserts the login shell.

## `update --all` asked the wrong question

The loop skipped an addon when `currentRelease() === rel.tag`. That is a fact
about the shared release tree, not about the addon: the first addon called
`placeRelease()` and moved `current` onto the new tag, so every addon after it
matched, logged "already on", and had its app binary and wrapper skipped. The
run reported success for all of them.

`addonIsAtRelease()` asks about the addon's own files instead -- the release has
to carry its artifacts, and the wrapper actually installed has to be byte-equal
to the one in that release. Consistent with the rule that what is on disk is the
record.

## The dashboard says when a release happened

Auto-update is off by default because Instatic is 0.0.x, and that is only a
defensible policy if something tells the operator a release exists. Nothing did.
`listAvailableTags()` was wired into the New Site page alone, the dashboard
showed each instance's pinned tag with nothing to compare it against, and the
update dialog was a free-text box. Learning about 0.0.19 meant going to look at
ghcr.io and remembering the number.

The dashboard now fetches the same listing, badges instances behind the newest
version, counts them in a tile, and offers the real tags in a `<select>`.

Two things the listing has to get right. Versions are compared by number, not as
strings, or 0.0.9 outranks 0.0.18. And the registry paginates: it returns tags in
push order, so page one holds the *oldest* tags, and ignoring the `Link` header
would not produce an obviously broken dropdown -- it would keep offering a stale
version labelled "(latest)", which is worse. With 20 tags ghcr.io answers in one
response today, so this is a trap set for later rather than a bug now.

Only a listing that actually reached the registry may claim an instance is
behind. The offline fallback is one hardcoded version, and badging against it
would invent updates that do not exist. A stale cache still counts as a real
answer and says so; the fallback reports no newest version at all.

## The platform is multi-addon; most of it now actually is

"Multi-addon from the start" was the goal, and the injector was rebuilt for it
after two addons turned out to overwrite each other's nav entries. That fix was
real but narrow: the injector became addon-agnostic while the rest of the
platform kept the shape it had when Instatic was the only addon. A review found
five more places where the second addon would have been the one to discover it.

- `repair` reconciled whatever `resolveAddon()` defaulted to, which is instatic,
  and the timer runs `repair --quiet` naming no addon. A second addon would never
  have had its wrapper reinstalled, its sudoers line re-validated, its site user
  re-hardened or its service restarted. Anchors were the exception, because
  `reconcileAnchors()` already covered everything -- so the one visible symptom,
  a missing nav entry, was the one thing that still worked.
- `uninstall` deleted the reconcile timer, its service and the anchor path unit
  unconditionally, and all three are shared. Removing addon A stopped
  reconciliation for addon B, permanently: `repair` rewrites those units, and the
  timer that runs `repair` was what had just been deleted.
- The port scan in `panel-snapshot.ts` read one hardcoded directory. The `ss`
  scan beside it catches another addon's *running* instances, so the hardcoded
  path left exactly the case the directory scan exists for -- a stopped instance,
  whose port is still spoken for but not listening.
- `TEMPLATE_WATCH_PATHS` was a hand-written copy of Instatic's two templates. It
  is derived from the registry now, because nothing connected the two lists, so
  an addon patching a third template would have got no fast repair and no
  warning.
- `status` and `update` with no addon named defaulted to instatic rather than to
  everything installed.

`repair`, `status` and `update` now act on every addon with a config file on
disk, which is what "installed" means here.

## Authentication is CloudPanel's, not ours

The manager can create and delete sites, so it must not be reachable without
authentication, and the question of where that comes from keeps coming up.
Reusing the panel's admin login was checked properly rather than assumed, and
all three routes are closed:

- **Share the session cookie.** `session.name = PHPSESSID`, scoped to the
  panel's origin, so we would have to be served from the panel's vhost. That is
  the injected-tab variant, and `proxy_pass` hands the request over without
  running any of the panel's PHP, so nothing validates the cookie. Same-origin
  gets you the cookie and none of the checking.
- **Validate the session ourselves.** Sessions are files under
  `/var/lib/php/sessions`, mode `1733 root:root` -- write and traverse for
  others, readable only by root, which is deliberate PHP hardening so one app
  cannot read another's sessions. The manager is unprivileged precisely so it is
  not root. Reading them anyway means a wrapper verb where root parses
  PHP-serialized Symfony security tokens, a format we cannot inspect because the
  panel's PHP is obfuscated and which upstream can change in any release. A
  root-privileged parser for an undocumented format, added to the one file that
  is the whole security model.
- **`api_token`.** The table exists. It authenticates calls *to* CloudPanel's
  API: "may this script act on the panel", not "is this browser a logged-in
  admin". Wrong direction, and reading it means reading the panel database.

The `user` table also carries `mfa` and `mfa_secret`, so anything reimplemented
here would have to honour MFA or become the weakest door to the same box.

So authentication is nginx basic auth, and specifically **CloudPanel's own
per-site Basic Auth feature**, not a mechanism of ours. `site.basic_auth_id`
points at a `basic_auth` row, `is_active` is the toggle and `whitelisted_ips` is
the IP allowlist, which covers both things the README asks for. Enabling it stays
a panel action: `clpctl cloudpanel:enable:basic-auth` protects the panel's own
login rather than a site, and writing `basic_auth` rows ourselves would mean
writing an undocumented schema while the panel is running (decision 2.6).

What the addon adds is a read. `status` reports whether the manager's own site is
protected, because that is the precondition the README leads with and the one
command an operator runs to check an install had nothing to say about it. It
tells apart four states, including the one a real box was found in: `auth_basic`
in the vhost with `basic_auth_id` NULL. That does protect the site and survives
regeneration, since the panel rebuilds the vhost from the template the edit lives
in, but the Security tab shows Basic Auth as off, so an operator reading the UI
sees an unprotected site and toggling the switch can rewrite the edit away.

The cost of not reusing the panel login is honest and worth stating: it is a
second credential, not single sign-on.

## The Stager addon

`clp-stager` is a Bash script you paste into `nano` on the server and run as
root. It works. Turning it into an addon is not about the steps, which are
unchanged in substance; it is about who is allowed to ask for them and what the
request may contain.

**The button is Twig, not HTML.** Instatic's injections are static markup: a nav
entry pointing at one hostname. The Stager button has to name the site whose
page it is rendered on, and `{{ site.domainName }}` is how the panel's own
templates already do that, so the snippet is a Twig fragment rather than a
string of HTML. The cost is that it is only correct where `site` is in scope,
which is a property of the target template rather than of the snippet -- both
targets either receive `site` as an include parameter or set it as a loop
variable, and a third one may not. It is also guarded by `site.type == 'php'`,
because only a PHP site can be cloned and a button that always errors is worse
than no button.

**Cloning is a job, not a request.** A clone of a real site takes minutes:
`clpctl db:export`, a tar pipeline over the whole document root, `db:import`.
The manager's own vhost gives it 900 seconds and Bun caps a request well below
that, so a synchronous clone is not merely slow, it cannot finish. The wrapper
writes a job record, hands the work to `systemd-run`, and answers with an id the
page polls.

The transient unit is not a detail. The manager is a systemd service with
`Restart=always`, so anything it forks lives in that service's cgroup and is
killed with it -- and a fifteen-minute clone is long enough for a restart to be
ordinary rather than hypothetical, leaving a site half built. `systemd-run` asks
PID 1 for a cgroup of its own, which nothing this addon does can interrupt.
`Type=exec` rather than `oneshot`, because `oneshot` makes `systemd-run` wait
for the whole clone, which is the opposite of the point; `Type=exec` returns as
soon as the job has been exec'd, so a job that could not start at all is still
reported rather than sitting queued forever.

The lock is released before the job starts. Holding the target's lock across
`systemd-run` deadlocked the two against each other: the job blocked on `flock`
until its timeout, failed, and the failure surfaced as systemd refusing to start
it.

**The dump goes in the job directory, not `/tmp`.** The original writes
`/tmp/<production database>.sql.gz`, which is a full dump of a customer's
database in a world-readable directory under a name anyone can predict, and a
path any local user can pre-create as a symlink for root to write through. Job
directories are `0700 root` and the dump is deleted as soon as it is imported.

**Job records expire.** A record holds the staging database password, which is
the one credential in a clone that the panel cannot show again and that the
operator needs whenever the application's config could not be rewritten. It is
kept for fourteen days, and `repair` runs the addon's `prune` verb on every
reconciliation -- the expiry has to be something that actually runs, and the
timer that runs `repair` every fifteen minutes already exists. Giving the addon
a timer of its own would be two answers to one question.

**A custom root directory is not copied**, because `clpctl site:add:php` has no
option for one. The job says when the clone's differs from the source's.

**Names come from the one scheme.** The staging site's account is
`addon-<8>-<6 hex of sha256(domain)>`, the same as any other site this project
creates, and the database and its user are derived from the target domain the
same way rather than randomly. Deterministic names mean a retry after a failed
clone proposes the same names, so "already exists" means something.

## Carrying a site's vhost to its clone

A staging copy that does not reproduce its source's nginx config is not a
staging copy of the thing you are testing. On the box this was built against, 2
of 25 PHP sites have hand edits: one adds a Content-Security-Policy and strips
`X-Frame-Options` off the backend, the other widens `server_name` to a wildcard
and rewrites the WordPress multisite rules. Cloning either without its vhost
produces a site that behaves differently from production in exactly the way you
were trying to test.

The first attempt refused to do it, citing the "never edit vhosts or write to
the panel database" bullet under Instances. That bullet is about instances, and
applying it as a platform-wide law cost a feature that `clpctl` could deliver
without breaking it at all.

**`clpctl vhost-template:add` is the route.** The source's stored vhost becomes
a named template, the clone is created from it, and the template is deleted
again. The panel renders it, expands every placeholder against the clone's own
values, writes its own database record and the file on disk, and reloads nginx.
Nothing here writes panel state or touches a vhost.

Three facts make it work, and none of them were obvious:

- **`site.vhost_template` is not a rendered config.** It keeps
  `{{ssl_certificate}}`, `{{root}}`, `{{php_fpm_port}}` and the rest; only the
  hostnames are concrete. So the copy needs one substitution rather than a
  general rewrite, and the clone's certificate, document root, php-fpm port and
  log paths go on tracking its own settings. The original script copies the
  *rendered file* into that column instead, which freezes the source's values:
  the staging site keeps working, but a later certificate renewal or PHP version
  change regenerates from a column that can no longer follow it.
- **CloudPanel's own validator is half the safety.** `vhost-template:add`
  requires `{{server_name}}`. When the source's `server_name` line *is* the hand
  edit, folding it back into the placeholder would drop the edit and keeping it
  literal leaves no placeholder, so the panel refuses the template and the clone
  falls back to the stock one with a note. The dangerous outcome -- a staging
  site carrying `server_name production.example.com` and answering for it -- is
  structurally unreachable rather than merely avoided.
- **A hostname is not a substring.** `example.com` occurs inside
  `stg.example.com` and inside `notexample.com`. Rewriting it as a substring
  mangles hostnames that merely end in it, and testing for it as a substring
  reports the clone's own name as the source leaking through, which rejected
  every ordinary clone. Both are done on whole-hostname boundaries.

The remaining checks are made before the panel is asked, so a refusal names the
line responsible: the source hostname must not survive anywhere, and every
`server_name` token must be the target or below it. A clone that would answer
for another site is the failure worth spending a gate on.

**The handoff file is root:clp 0640 in a 0710 root:clp directory.**
`/usr/bin/clpctlWrapper` ends with `su -s /bin/bash -c "$COMMAND" clp`, so
clpctl reads `--file` as the `clp` user, not as root. A template written into a
job directory, which is 0700 root, reached the panel as an empty file and was
rejected as such. This applies to every path handed to `clpctl`, not just this
one.

**The base template is checked before it is used.** `site.application` records
the *name* a site was created from, not a reference to it, so that template can
have been deleted or renamed since. Falling back to one that is gone fails
`site:add:php` with "does not exist", which is a confusing way to lose a clone;
a missing one falls back to Generic and says so.

## A release tree has to serve every installed addon

`current` is a symlink shared by every addon: each service unit ExecStarts
`current/<its app binary>`. `install` fetched the artifacts for the addon being
installed, wrote them into a new release directory and moved `current` onto it.

With one addon that is correct. With two it takes the other addon's binary out
from under its own unit, and the symptom is `status=203/EXEC` on a service that
had been running for weeks, produced by installing something else entirely.
`update <one addon>` had the same shape.

Both now fetch the artifacts of every installed addon, not just the one named,
and `placeRelease` refuses to move `current` onto a directory that is missing
any of them. The guard lives with the symlink swap rather than in the callers,
because every caller of it has the same obligation.

## One snapshot, one shared group

`snapshot.json` is the panel's sanitized site list, written by root and read by
the managers. It was `root:<that addon's site user>` 0640, which is right for one
addon and silently wrong for two: installing the second chowned the file to its
own user and the first addon's dashboard lost its site list.

There is now a `clp-addons` system group. Every addon's site user joins it, the
file is `root:clp-addons` 0640, and each unit names `SupplementaryGroups=` rather
than relying on how systemd treats an account's group list. `install` brings
along the addons already installed rather than leaving them to the next timer
tick, since otherwise installing one addon takes another one's site list away
for up to fifteen minutes.

The group is the smallest thing that fixes it. The file holds the panel's
non-secret site list, which does not justify anything more elaborate.

## Known gaps

- `--local` installs skip provenance verification by construction. Staging only.
- Only `x86_64` is built. `recon.sh` confirmed `avx2` on the target, so the
  standard glibc target applies rather than the baseline variant.
- Snapshot archives written under an instance's `snapshots/` before the mode was
  set explicitly keep their old 0644. They are protected by the 0700 directory
  above them, so this is untidy rather than exposed, and `repair` deliberately
  does not walk instance directories -- those belong to the wrapper.
- The Stager addon does not delete a staging site. CloudPanel already does, from
  Site -> Settings, and deleting a site is where a mistake costs the most; a
  second button for it would be a second way to get it wrong.
- URL rewriting inside a cloned database is WordPress only, through `wp-cli`.
  A Laravel or Symfony clone gets its `.env` credentials rewritten but nothing
  reaches into its database, so anything storing an absolute URL there still
  names the source site.
- A source whose `server_name` line is itself hand edited cannot have its vhost
  carried across: CloudPanel requires the `{{server_name}}` placeholder, and the
  edit and the placeholder cannot both occupy that line. The clone is built from
  the stock template and the job says so. On the box this was built against that
  is 1 site in 25.
- A clone copies the source's files and database as they are at that moment.
  There is no quiescing: a site written to during the copy can produce a staging
  copy whose files and database are from slightly different instants.
- Each addon needs a hostname of its own, so two addons mean two DNS records,
  two certificates and two Basic Auth setups. Serving both from one host would
  mean either editing a vhost or adding a routing service, and the first is
  forbidden while the second is a new component to keep alive.
