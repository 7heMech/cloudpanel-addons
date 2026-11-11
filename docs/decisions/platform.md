# Platform integration

## One manager process

The compiled `clp-addons` binary contains the CLI, manager, and all addon code.
`clp-addons serve` runs as the locked `clp-addons` account and serves enabled
addons from `/run/clp-addons/manager.sock`. It refuses to start outside the unit's cgroup or as
another account: run by hand, it replaced the live daemon's socket
with one the auth gateway rejects. `status` reports a socket the account does
not own, and `repair` restarts the manager when it finds one. A config file under
`/etc/clp-addons/` enables an addon; disabling it keeps the addon's state.

CloudPanel's master Nginx vhost proxies `/addons/` to the manager socket. The
manager uses the existing `cloudpanel` session and does not create a separate
site, hostname, or login.

The manager turns off Bun's idle timeout. Its 10-second default closes a
connection whose handler is still waiting on the gateway, which a Check now or
an enforced DNS plan routinely outlasts. Nginx's hour-long read timeout and each
gateway call's own deadline bound every request instead.

`manager/` holds that process: `server.ts` owns the socket, the request gate
and the mount dispatch, and `index.ts`, `service.ts` and `views.ts` are the
Addons page itself, laid out the way an addon's `app/` is. `action.ts` is the
root side of its verbs, as an addon's `action.ts` is; `cli/index.ts` hands it
the enable, disable, update and reconcile commands it runs.

The Addons page is two lists, Enabled and Available, one row per addon with its
one-line description and its buttons, so the whole catalog fits on a screen. A
search above them keeps only the rows whose name and description contain every
one of its words, and hides a list it empties.

An addon's `added` version (`2.0.0-rc.1`, for example) marks it New on a box
that started tracking notices before that release and has installed it. Each
entry in an existing addon's `changed` list marks it Changed on the same terms,
with one line saying what changed, newest first; an unread New covers them.
Changed is only for what an operator must know, such as a moved setting or a new
effect on sites; a new layout or a faster pick-up is the changelog's, which the
update page links. An entry stays in the list when a later release adds
another, so a box that skips releases sees every one it missed.

Where tracking starts is `manager/news-since` under the state directory, written
once: the first update writes the release it replaced, `install --local` the one
its artifact manifest named, or the installed release itself on a fresh install,
where nothing is new to whoever installed it. A box without the file sees every
notice up to the installed one. Later updates leave the file alone, so a notice
stays up through any number of updates until it is read, and an update that
rolls back puts the file back as it found it.

Each notice is read on its own key (`dns@2.0.0-rc.1`, the addon and the release
that declared it), for every administrator and device: the box usually has one
person who updates it, and a per-user record would need a panel identity for
nothing. Opening an addon from its row reads its notices; Mark all read, shown
beside Updates while any are unread, reads every addon's, available ones
included, without enabling them. Both go through the manager's `mark-news-seen`
verb, which takes an addon name or none and works out the keys itself.
`manager/news-seen.json` keeps only keys the catalog still declares in the
tracked range, so it never outgrows the catalog.

## One catalog, compiled in

`addons/catalog.ts` is the only registration seam. An addon declares itself
in `addons/<name>/addon.ts` -- title, description, injection targets, required
systemd units, its manager handler, its privileged action, the routes it opens
to non-administrators or answers ahead of the gate, and any repair upkeep -- and
the catalog derives its config file and state directory from its name
(`addonConfigFile` and `addonStateDir` in `lib/paths.ts`), so a definition
cannot name a file provisioning will not look for. An addon is enabled while
its config file exists; `addonEnabled` and `enabledAddons` in the catalog are
the only places that ask.

Everything the platform does for one addon is declared there too, so no
command, reconciler or toggle names an addon:

- `commands`: top-level commands the addon owns, such as `maintenance` or the
  `sync-*` hooks systemd runs, each with its `help` line if it has one.
- `panelBlock`: a marked block in a file CloudPanel owns, put in while the
  addon is enabled and taken out otherwise by install, update, repair, the
  toggles and self-uninstall, with its row in `status`.
- `anchors`: work `repair --anchors-only` runs when CloudPanel rewrites a
  file the anchor watcher sees.
- `conffiles`: dpkg conffile edits `apt-hook pre` hands back.
- `withdraw`: disabling under the addon's own locks.
- `stateDirMode`: a state directory something outside the addon must reach.

Repair upkeep runs inside repair's operation lock, so it stays short. Work that
waits on the network or on a site's own code is queued with `queueAddonPass`
instead: a transient unit that runs `clp-addons action <addon> <verb>` under a
runtime bound and is skipped while the previous pass is still running.

The catalog is an explicit list, not filesystem discovery. This ships as one
binary; a registry that depended on what happened to be on disk could be wrong.

An addon's verbs are declared in its `verbs.ts`, which imports nothing, so the
root gateway can read them without loading the addon. The gateway's allowlist,
the action's verb type, the services' typed gateway calls and the manager's
per-caller check all come from that one declaration, and a test reads each
action's dispatcher, or System Tweaks' handler table, to check it handles
exactly those verbs.
`tests/__snapshots__/test-web-verbs.test.ts.snap` lists every web-reachable verb
with who may call it, so a change to the gateway's surface shows in review.

The manager and the auth gateway are not in it. They have no config file to
enable, no mount path of their own and no state to keep, so they are dispatched
before the catalog is consulted rather than described by it.

## Where code lives

Imports point one way, from what changes most to what changes least:

- `cli/` holds the commands: argument handling, install, update, repair,
  toggles and the platform reconcilers they run. Nothing imports it except
  its own files and the binary's entry point.
- `manager/` is the manager process, laid out like an addon.
- `addons/<name>/` is one addon, and `addons/catalog.ts` lists them all.
  An addon imports `lib/` and, where it builds on another addon, that
  addon's exported functions; never `cli/` or `manager/`.
- `lib/` is what every side shares: paths (`lib/paths.ts`), the action reply
  protocol, command running, file locks, the panel database, Nginx and job
  helpers, the addon definition types, and the web pieces. It imports only
  `lib/`, plus the addons' `verbs.ts` tables, which import nothing.

## The CLI

`clp-addons` with no arguments in a root terminal is an interactive menu:
addons toggle through the same enable and disable the Addons page runs, and
status, repair and update run the commands of those names. Without a terminal or
root it prints the plain overview. Help lists operator commands only. `action`
is how the gateway runs an addon's root verbs, and `serve`, `smtp-submit` and
`terminal-pty` are started by systemd, Postfix and the terminal action. A
command no platform verb answers is looked up among the addons' `commands`.

Color is decided per stream: `paint` in `lib/log.ts` colors only when the
stream it writes to is a terminal and `hasColors` allows it, so `NO_COLOR` and
`TERM=dumb` are honored and journald, pipes and job logs stay plain even under
`FORCE_COLOR`; a terminal without `TERM` is plain. Bun's `Bun.color` is not
used, because it reads `TERM` without a stream and colors pipes and files. The
log helpers write through `console.*`, which waits for a pipe; Bun's
`process.stdout.write` does not, and whatever exceeds the pipe's buffer is lost
when the CLI exits. The menu clips lines with `Bun.sliceAnsi`, which measures
terminal columns and keeps escape sequences whole.

## Enable and disable apply a delta

A toggle is not an install. Enabling an addon writes that addon's config file,
creates its state directory, rewrites the managed unit definitions and starts
whatever those definitions newly introduce -- and nothing else. It does not
create the service user or probe the auth helper: those
answer "has this box ever been set up", which `install`, `update` and `repair`
ask and a toggle does not. An `enable` hands itself to the full install path
rather than applying a delta to nothing whenever the unit files, the service
user, a running manager or an armed reconcile timer are missing. The last two
are there because the unit files appear well before the install that wrote them
reaches `startUnits`: a bootstrap that failed in between leaves files a delta
would otherwise read as a finished install and then start nothing.

A managed definition is rewritten when its text differs, and also when what
stands at its path is not the plain `0644` file this binary writes -- a
group-writable unit, or a symlink to a file holding the right text. Comparing
text alone would leave either in place, and several managed units name no
`User=`, so systemd runs what they name as root.

`systemctl daemon-reload` runs only when a managed definition was created,
changed or removed, and a toggle starts only units it created -- never the auth
socket, the manager, the armed reconcile timer or the path watcher. Panel
templates are reconciled only for an addon that declares injection targets, and
the Twig cache is purged by that reconciliation when the markup actually
changes. The panel identity is written when the enabled set becomes non-empty
and removed when it becomes empty, so nothing of this project can act on a site
while no addon is enabled.

Which addons the manager serves is read per request from the config files, so
enabling one does not restart the manager. The handler map stays compiled in and
explicit: what is dynamic is availability, not code loading. The manager unit's
own text still changes with the addon set -- dependency ordering and per-addon
environment -- and `daemon-reload` makes that the text systemd uses at the next
start.

Repair remains the convergence path. A toggle assumes the platform is already
provisioned and does not attempt drift recovery.

## One operation at a time

`install`, `enable`, `disable`, `repair`, `update`, `self-uninstall` and the panel's
template reconcile all rewrite the same config files, units, Twig templates and
Nginx fragments, and none of that is atomic across the set. Each takes one
exclusive lock in `/run/lock/clp-addons/operation.lock` for the whole operation,
so a root shell, a panel job, the anchor path unit and the reconcile timer queue
instead of overwriting each other's work.

Every user can write `/run/lock`, and it is empty after a reboot, so anyone
could create `clp-addons` there before root does. Before opening a lock file, a
directory root does not own, or that others can write, is renamed aside and made
again as `0700`. Lock files are opened with `O_NOFOLLOW`, and a conffiles flag
root did not raise does not count.

The lock is taken at the entry point and nowhere below it. A nested call, and a
re-exec marked with `CLP_ADDONS_IN_OPERATION` such as the update handoff, run
inside the lock their caller already holds. The holder records its operation and
start time in the lock file, so a waiter that gives up names what it waited for.
The wait is generous, because an enable that installs Docker runs for minutes;
the template reconcile is the exception, answering a live panel request and
refusing after fifteen seconds.

The manager keeps its own short `manager.lock` for writing a job record. That is
what makes a second click follow the first click's job rather than start one.

## Managed CloudPanel changes

Nginx and Twig changes are marked and regenerated from a saved pristine copy.
Before changing Nginx, the reconciler validates the complete configuration and
restores the original vhost if validation or reload fails. If CloudPanel changes
the surrounding file, reconciliation stops instead of applying a patch against
unknown markup, unless a package upgrade explains the change and the patch
provably still fits (below).

`lib/panel-anchors.ts` names every CloudPanel template an addon patches, and the
anchor lines more than one addon patches against, so a CloudPanel release that
moves one is fixed once.

Maintenance Mode also owns a marked block in `/etc/nginx/global_settings`.
That block is reconciled from a hashed pristine copy and validated with the
customer-site Nginx configuration before reload. Runtime site toggles only
create or remove flag files, so they do not reload Nginx.

A path unit repairs managed blocks after CloudPanel rewrites watched files. A
15-minute timer repairs service, socket, permissions, and integration drift.
CloudPanel's legacy distro Nginx layout and its separate panel Nginx layout are
detected from their files and services rather than a version string.

The manager's block in CloudPanel's own header also makes room for its update
notice there. The panel lays the header out as one non-wrapping flex row of a
fixed height, sized for exactly the three things in it, so a fourth has nowhere
to go; flattening the right-hand wrapper lets the row wrap. Below 960px the
panel navigation takes the second row and the update notice takes the third, so
the navigation cannot be shrunk out of view by the added controls; the notice
then starts where the logo does, as on the addon pages. Those rules apply only
while a notice is actually in the row, so a panel with nothing to update is
shaped as CloudPanel drew it.

Panel Tweaks wants the same rules for a different reason, on a narrow screen
and on any day, so `headerWrapStyle` in `lib/panel-nav.ts` takes the header's own
selector and both ask for their own copy. What a phone additionally wants of the panel's own pages -- the navigation on a
row of its own, a logo that shrinks, an Admin Area link down to its icon, a
Dashboard chart that fits -- is the addon's alone, and a switch, because that is
the panel's own shape being changed rather than room being made for something an
addon added.

### After a CloudPanel upgrade

Every patched file has a record under `/var/lib/clp-addons` (`lib/baseline.ts`):
its text without our blocks, that text's SHA-256, the path, and the version of
the package that installed it. That is `cloudpanel` for the templates and the
panel's master vhost, and for `global_settings` whichever package `dpkg-query -S`
names, `nginx-common` on Debian. A file whose unmarked text still matches is
patched again, whatever version is installed, and its record takes the
installed version, so a later edit under that version reads as an edit.

A file whose text changed is recorded afresh and patched only when all of these
hold:

- dpkg reports the package fully installed: current state `i` with no error
  flag, whether it is wanted (`ii`) or held (`hi`, after `apt-mark hold`). While
  an upgrade unpacks and configures, the version is already the new one but
  files are still being replaced, and the anchor watcher fires on every write.
  A file read then could be half-written, and recording it would turn the
  finished file into an edit. Nothing is decided until the first repair after
  dpkg finishes: the 15-minute timer, `apt-hook post` after an unattended run,
  or a manual `repair`.
- The version reads the same before and after the file is read. A pass reads
  it before its first file and again after a changed one; if postinst finished
  in between, the file may be the half-written one, so it is refused as `busy`
  and the next pass decides.
- The installed version differs from the recorded one. The same version with
  different bytes is someone's edit. A record from before versions were kept
  cannot tell the two apart, so it refuses too.
- For a conffile, the new text is the package's own: its MD5 is the one
  `dpkg-query -W -f='${Conffiles}'` lists. dpkg keeps an operator's edit through
  an upgrade that ships the same conffile, without asking, so a moved version
  alone would accept an edit that was refused. Templates and the master vhost
  are replaced on every upgrade and need no such check.
- No marker text is left once the complete blocks are taken out.
- The new text fits. For a template, every anchor of every block wanted in it
  appears exactly once: missing gives the block nowhere to go, and twice means
  CloudPanel restructured around it, so the block could land in the wrong
  place. A required block that does not fit, or any repeated anchor, holds back
  the whole file, since its blocks are rendered together; an optional block
  whose anchor is gone is left out and the rest are patched, as on any pass.
  For the master vhost, there is exactly one server block on port 8443 and no
  `/addons/` location of CloudPanel's own;
  `nginx -t` and the rollback still guard the write. Maintenance Mode's block is
  appended rather than anchored, so `global_settings` fits unless it already
  defines one of the block's variables, its location or a 418 `error_page`; the
  Nginx transaction still validates it.

A file with no record yet is not recorded while dpkg is part-way through its
package (unpacked, half-configured, awaiting triggers): the record would be a
half-written file with no version to tell the finished one apart by. The next
pass after dpkg finishes records it. A record is written only once the file it
vouches for is in place and, for the master vhost and `global_settings`, Nginx
passed `nginx -t` and reloaded; a change Nginx rejects leaves the old record,
and the next pass decides again.

Otherwise the file is left exactly as the package wrote it, with a reason:
`busy`, `edited`, `unrecorded`, `stray-marker`, `anchor-missing`,
`anchor-repeated` or `conflict`.

The same rule is safe for the master vhost and for `global_settings` because
neither is ever restored from its record: disabling strips the block from the
live file, so the record only decides whether the file is the one the block was
built for, and the structural checks above decide that directly. Both need it.
The master vhost is a plain file of the `cloudpanel` package, not a conffile, so
every CloudPanel upgrade writes it back without the proxy; without the rule, a
release that changed it would take the `/addons/` page away until someone
deleted the record by hand. `global_settings` is covered by the conffile hook
for unattended upgrades (below), but an interactive upgrade where the operator
takes the package's new file would leave Maintenance Mode's check off for good.

The rule is never applied to the mitigations that replace CloudPanel code.
System Tweaks' `clpctl` wrapper and remote backup compression keep their own
pinned hash and version sets, which only a release extends after checking a new
CloudPanel on staging. A wrong guess there is not a missing button but a broken
or bypassed protection. So CloudPanel code with bytes or a version a release
does not know is never patched, a hardened wrapper is recognised only by the
exact bytes some release shipped, and `tests/test-clpctl-guard.test.ts` fails if
one of those stops being recognised
([the clpctl wrapper](system-tweaks.md#clpctl-injection),
[Retiring a mitigation](system-tweaks.md#retiring-a-mitigation)).

Neither CloudPanel's updates nor the addons are held back on an unknown panel
version. Pinning CloudPanel would keep its security fixes off the box, and
switching the addons off would drop System Tweaks' hardening exactly when the
panel has changed under it. A file the rule refuses costs one addon's link or
button until a release supports the version; everything else keeps running.

`repair --rebaseline` is the operator's way past `edited` and `unrecorded`: it
drops the version and conffile conditions and nothing else, so the package must be settled, no stray marker may be left and every block
must still fit.

What is refused is shown, not only logged. The manager's `holds` verb runs as
root and inspects the live files without writing; the Addons page asks it at
most every thirty seconds, since each answer queries dpkg and the list changes
only with an upgrade or `repair --rebaseline`. `clp-addons status` prints the
same list. `status` runs only as root,
since the records keep their text where only root can read it, and as another
user every patched file would look edited. Both group by file and name
the addons whose blocks are held, the package version, and what to do, in the
words of `lib/panel-holds.ts`. Repair logs each file it records afresh. The
operator procedure is [When CloudPanel updates](../cloudpanel-updates.md).

### Package conffiles

`/etc/nginx/global_settings` (Maintenance Mode), and `/etc/nginx/nginx.conf`
and `/etc/nginx/fastcgi_params` (System Tweaks) are dpkg conffiles of
`nginx-common`. unattended-upgrades holds
back a package whose modified conffile the upgrade would replace, because nobody
is there to answer dpkg's prompt, so these edits could keep an Nginx security
update out. A drop-in on `apt-daily-upgrade.service`, installed with the binary,
runs `clp-addons apt-hook pre` before each run and `apt-hook post` after it,
both allowed to fail without stopping the run (`cli/conffiles.ts`).

`pre` acts only on an edited file whose package `apt-cache policy` shows a
different candidate. It raises `/run/lock/clp-addons/conffiles-released` first, then
writes the package text back without a reload. Maintenance Mode's block comes
out only while the rest of the file still matches its recorded baseline, which is
then forgotten. `post` clears the flag and runs repair, which records what the
upgrade installed as the new baseline and edits it again. Repair does nothing
while the flag is up and the service still runs, however long it takes; a flag
left by a run that stopped without `post` holds nothing off. Only when systemd
cannot answer does the flag lapse after six hours. Between the two, a reload by
the Nginx package itself runs the package text: maintenance pages and narrowed
IP trust are off for the rest of that run. An interactive `apt upgrade` still
gets dpkg's prompt. `bun tests/integration/integration-conffile-upgrade.ts`
shows on Debian's real unattended-upgrades that an edited conffile holds the
package back and a released one is upgraded with its new conffile.

## New sites

An addon that has work for a site the moment it exists declares `newSites` in
its catalog definition. `clp-addons-new-sites.path` watches
`/etc/nginx/sites-enabled`, where CloudPanel writes every new site's vhost, and
its service runs `clp-addons sync-sites`: each installed addon's `newSites`, in
catalog order, so DNS normally writes a site's records before SMTP Relay binds
its user. Each gets a 15-second head start rather than waiting for the one
before it to finish: DNS can wait minutes for its lock behind a fleet check, and
until SMTP Relay binds the site its mail login is refused. One addon failing
does not skip the next. The units exist while any installed addon declares
`newSites`; repair restarts the watcher if it has stopped. It takes no
operation lock: each addon's work takes its own. Work that runs a site's own
code is queued rather than done in the hook, as WordPress Tools hands its checks
to background jobs (see [WordPress Tools](wp-tools.md#new-sites)). Update and
repair disable and remove the units listed in `LEGACY_UNITS` in `lib/paths.ts`.

The vhost is not the site yet. CloudPanel commits the site's row in its
database after writing the vhost: half a second later on staging, for a
WordPress site too, whose files and installation come after the row and do not
delay it. A busy panel database delays it further, because CloudPanel's insert
waits for the other writers. Deleting a site removes the vhost first and the row
about 0.75 s later. So the row's commit is the second event. `sync-sites` reads
the panel's sites, each domain with its id (read-only, so its own read is not a
write), and runs the hooks only when they differ from the ones they last ran
for, recorded in `/var/lib/clp-addons/new-sites-seen.json`. The panel never
reuses an id, so a site deleted and added again at its domain is a change even
if the deletion went unseen. Then, while a site is in flight, it
starts `clp-addons-new-site-rows.path`, which watches
`/home/clp/htdocs/app/data` and starts the same service; when none is, it stops
it again. In flight means a `<domain>.conf` vhost written in the last hour with
no row, or a row whose vhost is gone while the vhost directory changed in the
last hour. CloudPanel's own vhosts and ours, such as `default.conf`, have no dot
in their name, and the hour bounds a site that never finishes arriving.
CloudPanel's database uses a rollback journal, so every commit creates and
deletes `db.sq3-journal` in that directory; a connection closing is a change
too.

The rows watcher is not left running because the panel writes its database
every few seconds even when idle: its monitoring agent made 14 commits in two
minutes on an idle staging box. While it runs, each of those starts the service
for about 30 ms to read one table and find nothing new. A path unit does not
start a service again for a change made while that service is still running, so
`sync-sites` reads the sites once more after starting the watcher, and goes
round again if a row arrived while the hooks ran; a commit in the moment between
that read and the service ending is seen at the panel's next write. Several
starts in a few seconds are normal while a site is in flight, so the service has
no start limit: systemd's default fails a unit, and the path that started it,
after five starts in ten seconds. Hooks that ran for a set of sites do not run
again for it even if one failed, because the rows watcher would otherwise repeat
every hook on every panel write; the 15-minute pass retries it. Vhost rewrites
that add or remove no site run no hook. When the sites cannot be read, such as
behind a write that holds the database longer than the five-second busy wait,
the hooks run as they always did and the rows watcher is started, so the write
that releases the database brings another look.

Some of a site's creation comes after its row, in the same request, and
changes no file the watchers see: CloudPanel installs WordPress as root after
committing the row. An addon that waits for such a step gives its `newSites` a
`resumePending` step, which queues what the latest step allows and says whether
a site still waits. `sync-sites` runs it on every wake for an hour after the hooks
last ran for a change to the sites, by the time on `new-sites-seen.json`, and
keeps the rows watcher running while any says it is still waiting. It runs it
once more after starting the watcher, as it reads the rows again, because the
write that ends the request may come while the service runs. A step that fails
counts as waiting. While nothing waits, the rows watcher runs only for sites in
flight.

A site's certificate is a later step of its creation, and an addon whose work
needs the site's HTTPS declares `certificates`. `clp-addons-certificates.path`
watches `/etc/nginx/ssl-certificates`, where CloudPanel writes each site's
`<domain>.crt` and key in place, so the vhost, which names that path, is not
rewritten, and its custom domain's certificate. Its service runs `clp-addons sync-certificates`: each installed
addon's `certificates`, in catalog order, one after another. It is not part of
the new-site watcher because a certificate changes no domain, so `sync-sites`
would run no hook for it, and because a path that changes while its service is
running starts nothing. This service takes a second and runs again three
seconds later, because the key and the certificate are separate writes. Every
renewal wakes it too, so a hook does nothing when no site is waiting on it. The
units exist while any installed addon declares `certificates`, and repair
restarts the watcher as it does the new-site one.

An addon that follows CloudPanel's Firewall page declares `firewall`.
`clp-addons-firewall.path` watches ufw's `user.rules` and `user6.rules`, and its
service runs `clp-addons sync-firewall`, each installed addon's `firewall` in
catalog order. The units exist, and repair restarts the watcher, on the same
terms as the certificate one. See
[Firewall](firewall.md#protocols).

## One way to watch a job

`lib/job-stream.ts` owns both job-observation routes: `/api/jobs/:id` polls and
`/api/jobs/:id/events` streams, and `/api/jobs/:id` with
`Accept: text/event-stream` streams too. The poll route is unchanged. A stream
reads its first snapshot through the manager, then the manager opens one
`watch-job` stream through the gateway. The gateway starts one privileged worker
for that stream and pipes its NDJSON stdout; the worker watches the job
directory in-process rather than spawning a read for each poll. The addon
supplies the reader and watcher, so the worker emits the addon's own job view
and keeps fields such as clone results and generated credentials intact. The
helper returns no result for a path it does not own -- including a non-GET on a
path it does -- so the addon's own router still decides what that is, and the
HTML `/jobs/:id` page stays with each addon, because what a job looks like
differs and how it is watched does not.

Running a job is shared too, in `lib/job-store.ts`. `queueJob` checks the
addon's conflict rule against every queued or running job, writes the record,
releases the caller's lock and hands the job to a transient unit; the manager
writes its record with the same `recordQueuedJob`. A runner sends its
diagnostics into the job's log with `startJobTranscript`, and a write there
that fails is dropped rather than sent to the journal. `setJobStep`,
`failJob`/`recordJobFailure` and `markJobRunning`/`markJobDone` write the step,
failure and state, the state last because a watcher stops at it. `emitJob`,
`watchJob` and `jobViews` answer the `job`, `watch-job` and `jobs` verbs from
the addon's own view of a record. A queued or running job counts as live while
its unit is active or for its first five minutes, because `systemd-run` returns
before the unit is necessarily visible; `pruneJobs` fails the others and the
manager's one-job-at-a-time check uses the same `jobIsLive`. The addon keeps
its step texts, its job's name in the failure messages and whether a failure
records `finishedAt`, which Stager's does not.

A job that works through sites -- WordPress Tools' checks and connections,
Panel Tweaks' size measurement -- records its progress the same way, through
`runSiteJob` in `lib/job-store.ts`: how many sites are done of how many, the
one it is on, and a step such as `Measuring 12 of 40: site`, then its result.
The page draws that as `jobProgressHtml` from `lib/app-ui.ts`, and the client
half, `followJobProgress`, follows every bar on the page through the routes
above until the job ends. A page drawn while a job runs follows it again, so a
reload picks it up. The addon keeps only what the job means: its title, what it
disables meanwhile, and what it says when it ends.

A job id is defined once, in `lib/job-id.ts`, which `lib/job-store.ts`
re-exports. The app services needed the syntax without the CLI's job
orchestration; three copies of the pattern is how the checking side and the
creating side drift apart. An id reaches a path join, so it is anchored at both
ends and never rewritten.

Panel information is read through `readPanelSnapshot`, which returns the
snapshot and its age at receipt. A timestamp that cannot be parsed reads as
infinitely old rather than as `NaN`: every caller compares the age against a
staleness threshold, and `NaN` fails every comparison, so an unreadable snapshot
would look current. What a given age means stays with each addon.

## Shared interface

The shell's header reproduces CloudPanel's: the logo, the panel's own
navigation, and the three controls the panel puts on the right -- the theme
switch, the Admin Area, and an account menu of Settings and Logout, pointing at
the panel's own `/admin/users`, `/settings` and `/logout`. The avatar is a
drawing rather than the operator's gravatar, because the manager serves these
pages behind the panel's session without ever being told whose it is. The theme
and Admin Area icons are the panel's own paths rather than approximations of
them, so one control does not have two shapes depending on the page. Below
940px the logo and the three controls share one 64px row and the navigation
takes the row beneath; that shape is what Panel Tweaks gives the panel's own
header on a phone, so moving between the two does not move the header. Above
it the controls are laid out as the panel lays out its own, on a 75px line
with each icon at `vertical-align: middle`, because the panel's icons sit
where the font puts them and only the same layout matches them under every
font. CloudPanel's own logo is drawn in the page, its paths copied as the
icons' are, rather than linked: a linked image, even a cached one or a `data:`
URI, is drawn a frame after the page, so the header blinked without its logo on
the way in from a panel page. The panel's two files differ only in the colour
of the words, which the stylesheet sets for each theme. Theme & Branding's
uploaded logos are still images.

Every addon renders into one shell in `lib/app-ui.ts`: palette, cards, tables,
badges, switches, toolbars, one confirmation dialog and one notice holder per
page. The holder stacks up to three messages, the newest nearest its edge, and
replaces one already showing rather than repeating it. It is a popover, so it is
drawn in the top layer over any dialog or menu. It starts top right on a desktop
and at the bottom on a phone, at the other end when the pointer or the last tap
is in that corner -- where the switch that was just clicked usually is -- and
hovering it holds the messages until the pointer leaves. An error stays until it
is dismissed, as does a message whose caller says it stays. A screen reader
hears each message from two live regions that stay in the page, a status and an
alert for errors, since one inserted already filled or inside the closed
popover is often not read. A badge names a state rather than being read for itself, so it is set a
size below body text, as a tinted chip in one of five tones -- ok, info, warn,
bad, muted -- and every addon names its states through them (`tone-*`, with the
job states mapped onto the same five), so one colour means one thing on every
page; a running container is ok while a running job is info. A table cell keeps
its status to the chip and a line or two; the whole explanation is in the row's
details or tooltip. A value left at its default (no profile, no category,
CloudPanel's limits) reads muted, so what somebody chose stands out. A table has
at most one solid button per card, never one per row, and a row's Delete stays a
plain button that turns red only under the pointer or focus, so a column of
them does not outweigh the rows. On a wide screen a long hostname is cut to one
line, with the whole name on hover, and the actions column takes only its
buttons' width, so the status columns keep their room. A switch that
decides one thing for a whole page keeps its full size; one repeated per table
row comes down to the height of the line beside it, so the control does not set
the row's height. An addon supplies its mount path, its script and any rule only it
draws. The manager's own pages use the same two: disabling an addon asks through
that dialog, naming the addon as its card does and saying that its data is kept,
and a manager job that fails to start reports through the notice holder. The
browser's `confirm` and `alert` survive only as what the shell degrades to where
there is no `<dialog>` or no notice holder. Below 940px the shell tightens: a fleet table's rows become cards, a dialog
gives up its desktop padding and its buttons take the row, and the dialog is
bounded by the visual viewport so a phone's collapsing address bar cannot cover
them. 940px rather than a phone width because a fleet table is five or six
columns wide: below that the columns are narrower than the hostnames in them and
a domain wrapped a character at a time. Cell padding comes down from 1200px for
the same reason. Instatic's instance and inventory lists and Stager's clone,
source and promotion lists use the same fleet rows, with labels on secondary
cells so their meaning survives the hidden table heading. Empty cells disappear
and the site and type lead each card. A ticked row is tinted, and clicking
anywhere on a row but a control or its Manage menu ticks it; a phone shows no
selection checkboxes, only the tint. The table's header stacks there: its title
with Select all (`FLEET_SELECTION_HTML`) at its right, sized to its Deselect
all label so the toggle moves nothing, then the bulk actions across the width.
A bulk choice, such as the profile for Assign selected, shares its row with the
button that applies it. The count beside Select all is short there, "2 selected", and
hidden until a site is ticked; a screen reader still reads the full count. On a wide screen the count sits at the right, beside
the bulk actions it counts for, rather than under the title.

With a mouse, a select opens a list drawn like the filter menus: the chosen
option tinted and checked at the end of its row. This uses the browser's
customizable select, so the element and its form value stay native. A phone
keeps its own picker, which is the better one there, and a browser that cannot
style the list keeps the native one. A select drawn this way is as wide as its
chosen option rather than its widest, so choosing would move the controls
beside it. Only a select as wide as its content changes; one given a width,
such as a form's 100%, keeps it and is left alone, which the computed width
tells without a layout. `lib/assets/select-width.client.js` gives each of the
others its widest option's width as a minimum, as a native select has, capped
at the window's width less a margin rather than its container's, which would
be a loop in a container as wide as its contents. The width is the options'
text measured on a canvas in the select's font, plus its padding and border,
so no layout is forced, and a select not drawn yet, such as one in a closed
`<details>`, is held like any other. Each select is watched on its own and
worked out again when its options or their labels change; a web font arriving
or a mouse coming or going works them all out again, and a repaint holds what
it drew. Panel Tweaks draws the Sites page's application filter the same way
and joins the same file to its script.

On a wide screen a
list of more than twelve rows with something below its card scrolls in a box of
its own under a sticky heading; a list that ends the page grows with it. On a
phone a list longer than ten sites shows the first ten and a button for the rest,
so the settings below it stay close; a page that ends with its list, such as
Maintenance Mode's, leaves out the button (`FLEET_NONE_HTML` in place of
`FLEET_FOOTER_HTML`) and shows every site. Search covers every site, and Select all
and the bulk actions reach the sites past the cut too: those rows are marked
`data-cut` rather than deselected. A second long list on the page,
such as DNS's redirects, gets the same cut and button through
`tbody[data-phone-cut]` and `phoneMoreHtml`. Page and form actions wrap within the
available width. Two-column card and field grids hold until 760px, where the
tables have already given way. Live enable, disable and update jobs
put their state, current step and output in the manager card that owns the job,
with the log auto-expanding as output arrives so the operator can see the live
progress while remaining collapsible if desired. A job whose
card the page does not carry -- an update watched from the index -- takes a card
of its own under the heading and above the rest, whether the page was drawn
during the job or a duplicate request told the browser about it, so a job is
never reported under the action the operator happened to click. The shared
watcher scopes its updates to that card. A finished job asks the server for the
page again and swaps in the view it draws, so the server remains the source of
the result view. A successful update reloads instead: the page's script and
styles belong to the release it replaced.

Mutations that replace a view return `html` from the renderer used on first
load. `repaintView` swaps it into `#clp-content`, closes finished dialogs, and
preserves scroll, focus and disclosure state for elements with stable IDs, the
ticked site rows, and the value of every control marked `data-keep` (search and
filter boxes). Addon clients report outcomes with `notify`, never `alert()`.
Failed mutations leave the view intact.

A page reached from a site's tab strip is drawn in site mode: the shell
shows CloudPanel's site information and the applicable site tabs with the addon's
tab active, and the page belongs to Sites rather than to Addons. `lib/site-context.ts`
is the only description of that strip -- order, per-type conditions and routes
mirror `Frontend/Site/Partial/tab-container.html.twig` -- and both the shell and
the injected Twig snippet read it, so a tab cannot be labelled two ways. The
reproduced site information takes its column width, gutter and label styling
from the panel's own `assets/css/frontend/site.css`, so the blocks land where
the panel puts them.

A page that opens in a window of its own, such as the terminal, uses
`renderToolWindow`: the same head, palette, theme switch and base script as the
shell, without the header, navigation or footer, which a small window has no
room for.

A site-scoped page can also be mounted into the panel's own site page instead
of reproducing it. The manager injects a loader next to the tab strip: clicking
an addon's tab fetches that page as a fragment -- stylesheet, markup and script,
no document -- and mounts it in a shadow root inside the panel's content area,
so the panel's Bootstrap cannot reach the addon's markup and the addon's rules
cannot reach the panel. The fragment's script runs at global scope, because the
markup calls it from inline handlers, and learns which root its element lookups
are relative to from `CLP_MOUNT`. Shared client code therefore reaches elements
through `CLP_ROOT`, which is that root when mounted and the document otherwise;
a lookup written against `document` searches the panel's page instead and finds
nothing. One page is mounted at a time, held from before the fetch rather than
after it, because that script declares its bindings once per document. Clicking
the tab already shown does nothing; clicking a *different* addon's tab is handed
to the browser and costs a page load, which lands on the panel page that mounts
it cleanly. That distinction is the whole of it: a guard that covered both left
the other addon's tab dead, prevented but never followed. A panel
page without the markup the loader reads says so in the console, and hands over
to the addon's own page when a deep link is what brought the operator there.
A direct visit to the addon's own URL
redirects to the panel's site page carrying `clp-addon`, which the loader reads
on landing, so the address bar still names the page and a refresh still works.
`?embed=0` renders the standalone page instead. Git, Maintenance and Staging --
every addon with a site tab -- are mounted this way while the approach is being
evaluated; the reproduction above is what it would replace.

Such a landing knows which fragment it wants from the URL alone, so the loader
runs as the page is parsed and asks for it then rather than once the document is
ready, and hides the panel's content area from the same moment. The settings
page the redirect passes through is otherwise painted and then thrown away,
which reads as the wrong page. Only the half that reads the panel's markup
waits for the document; it marks the addon's tab active as soon as it has the
strip, ahead of the fragment it is still waiting for. The content area is
revealed by whatever finishes -- the mount, the fallback to the addon's own
page, or a timer -- so a page the loader never reached is never left blank.

CloudPanel sizes that strip for the tabs it ships, so an addon's tab wrapped it
onto a second row. The manager injects one rule making the strip a single
scrollable row and letting the site-information blocks wrap, rather than
widening the panel's limited-width container, which would only postpone the
break until the next addon. The rule is injected once, and only while an
installed addon patches that partial.

## Setup checklist

An administrator's addon pages carry a Setup helper: Setup in the header's tools
on a desktop, and on a phone, whose header row has no room beside the logo, at
the end of the navigation row in place of the root shell, which comes back once
Setup is hidden or has nothing left to suggest. It opens suggestions in four levels -- Connect your domain, Secure
the server, Run sites, Provision automatically -- each ticked from the server's
state, never from a click. It shows no counts: a step may not fit a server, so
any step can be skipped, and the helper hides itself once nothing is left to
suggest. Skips and Hide are kept per administrator; the Addons page's Setup
button brings it back.

Each addon declares its steps on `AddonDefinition.setup`: an id, a level, a
title, the page and card that set it up, and a `check` answering done, to do or
not applicable with a one-line reason. Remote backups, which is CloudPanel's
own, is the manager's (`manager/setup.ts`). A disabled addon's steps are listed
with Enable rather than checked, except a step marked `whileOff`, which can be
done without its addon: a custom domain set up by hand is a panel hostname.

`manager setup` runs every check as root and answers with the list for the
administrator `--user` names; `setup-pref` records a skip, an undo or Hide. Both
are admin verbs, and the manager names the user from its session gate, the only
place that knows it. The manager renders the list and the page fetches it after
it paints, keeping in the tab whether the helper showed, so the header does not
move when the answer comes. The checks run on every page an administrator
opens, so they read local files, the panel database and local services only,
never Cloudflare, Hetzner or a DNS lookup. What only an API knows is what the
addon last saw: Firewall records Hetzner's switches whenever its page or a
switch reads them. A check that fails reads as a suggestion with its error.

CloudPanel's own pages do not show the helper; it would need a block of its own
in the panel's header, beside the Addons link and the update notice.

## Browser assets are files

Stylesheets and browser scripts live in `.css` and `.client.js` files beside the
module that serves them, imported with `with { type: "text" }`. Keeping them in
their own files lets editors highlight, format and lint them.

Scripts are never bundled, and names are never shortened: the pages carry
inline handlers calling top-level functions by name from markup no bundler
sees, so tree-shaking and renaming would break them. Stylesheets are bundled by
Bun, so one shares another with `@import` (an addon's page imports
`lib/assets/job.css` or `fleet-row-selection.css`) rather than TypeScript
joining strings; a stylesheet chosen at runtime, such as Panel Tweaks' per-tweak
blocks, is still joined in code. `tools/build.ts` does this for the binary and
also minifies, scripts by whitespace only and stylesheets fully, about 12% off a
gzipped page. `tools/dev-assets.ts`, preloaded by `bunfig.toml` for anything Bun
runs from the repo, does the same for the preview and tests, without minifying,
as each stylesheet is first imported; `bun --watch` restarts when it or a file
it imports changes. Bun prints the CSS in
its own layout and order, so a test checks markup and behaviour, not a
stylesheet's text. Most assets land in CloudPanel's Twig templates, so the
build puts a space after any `{` that minifying leaves before `{`, `%` or `#`.
Nothing may depend on a comment, since minifying strips them all.

Values a file cannot know -- the addon's mount URL, the shared class names,
JSON the manager computes -- are bare identifiers or string tokens in the asset,
substituted by the module that imports it. That keeps each file valid CSS or
JavaScript on its own.

What stays in TypeScript is what a file could not hold on its own: a script fragment that is a function
body rather than a program, and a `<script>` element indented to sit inside a
Twig template.

Every addon page gets the shared base helpers, including `repaintView`, inline
notices and `confirmAction`. The one confirmation dialog can ask the operator to
type a word, such as the domain, before something that cannot be undone, and a
press on any dialog's backdrop closes it. Fleet tables also get site-selection
helpers: `paintFleetSelection` paints the count, select-all and every control
marked `data-needs-selection` by shared ids, and `fleetFilterHtml` adds a search
and an optional filter once a table has six sites. The filter is a menu of
options that each turn on and off, highlighted while on, in groups (a status group, and a type, version or category group
wherever the rows hold at least two values): within a group a row needs any
ticked word of its `data-show`, across groups all of them, so WordPress and PHP
together with Needs attention shows the WordPress and PHP sites that need
attention. The menu opens over the page, above its button when the window has
more room there. Sorting is by the headings, as on CloudPanel's Sites page with Panel
Tweaks: each `th[data-sort]` sorts by its column on a click or Enter, and again
reverses it. A row's `data-sort-<key>` gives the value where the cell's text
would not -- a status column ranks by tone, worst first, and a select's text is
every option it has -- rows without a value go last, ties go by domain, and the
rows keep the server's order until a heading is picked; tables under six sites
sort too. A phone hides the heading and has no sort: a card list is searched and
filtered rather than ordered. The ticked filters and the sort survive a repaint,
and the phone's ten-site cut is taken after both. A row search or a filter hides
is deselected, so an action on the selected sites only reaches the sites the
list leaves; WP Tools' Connect all unconnected ignores search and filters. Pages with background
jobs get the shared job watcher. Theme initialization runs before styles are
painted.

## Reading the panel database

Root-side code reads CloudPanel's SQLite database through `lib/panel-db.ts`:
`withPanelDb` opens it read-only with a busy timeout and closes it, and
`openPanelDatabase` holds it open for a caller that reads across several steps
or writes. Each caller keeps its own query and says what an unreadable database
means for it: a refusal, an empty answer, or a failed action.

## Live panel data

The manager requests current site and port information from the root gateway.
The gateway reads a consistent copy of CloudPanel's SQLite database and adds
ports recorded by addons or active listeners. Domain, site user, site type,
Varnish capability, and allocated ports cross the socket; no panel database
snapshot is stored on disk.

A site-scoped page also shows the instance address CloudPanel shows. There is no
column for it: the panel asks an external service and caches the answer for an
hour, so the gateway reads that cached value and reports nothing when it is
absent or expired. The addon then leaves the field out rather than print an
address the panel itself would not.
