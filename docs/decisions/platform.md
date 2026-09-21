# Platform integration

## One manager process

The compiled `clp-addons` binary contains the CLI, manager, and all addon code.
`clp-addons serve` runs as the locked `clp-addons` account and serves enabled
addons from `/run/clp-addons/manager.sock`. A config file under
`/etc/clp-addons/` enables an addon; disabling it keeps the addon's state.

CloudPanel's master Nginx vhost proxies `/addons/` to the manager socket. The
manager uses the existing `cloudpanel` session and does not create a separate
site, hostname, or login.

## One catalog, compiled in

`cli/addon-catalog.ts` is the only registration seam. An addon declares itself
in `addons/<name>/addon.ts` -- title, description, injection targets, required
systemd units, its manager handler, its privileged action and any repair upkeep
-- and the catalog derives its config file and state directory from its name, so
a definition cannot name a file provisioning will not look for. Adding an addon
used to mean editing the registry in `cli/paths.ts`, the handler map and the
action conditionals in `cli/index.ts`, and repair's per-addon upkeep calls: four
files that share nothing but the addon's name.

The catalog is an explicit list, not filesystem discovery. This ships as one
binary; a registry that depended on what happened to be on disk could be wrong.

The manager and the auth gateway are not in it. They have no config file to
enable, no mount path of their own and no state to keep, so they are dispatched
before the catalog is consulted rather than described by it.

`cli/paths.ts` is a leaf again. It held the registry, which meant the module
owning the project's path constants imported every addon's target list in order
to describe them; the injection-target shape now lives in `lib/addon-target.ts`,
which both sides import.

## Enable and disable apply a delta

A toggle is not an install. Enabling an addon writes that addon's config file,
creates its state directory, rewrites the managed unit definitions and starts
whatever those definitions newly introduce -- and nothing else. It does not
create the service user, probe the auth helper or sweep legacy installs: those
answer "has this box ever been set up", which `install`, `update` and `repair`
ask and a toggle does not. An `enable` hands itself to the full install path
rather than applying a delta to nothing whenever the unit files, the service
user, a running manager or an armed reconcile timer are missing. The last two
are there because the unit files appear well before the install that wrote them
reaches `startUnits`: a bootstrap that failed in between leaves files a delta
would otherwise read as a finished install and then start nothing.

A managed definition is rewritten when its text differs, and also when what
stands at its path is not the plain `0644` file this binary writes -- a
group-writable unit, or a symlink to a file holding the right text. Rewriting
unconditionally used to converge that as a side effect, and several managed
units name no `User=`, so systemd runs what they name as root.

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

`install`, `enable`, `disable`, `repair`, `update`, `uninstall` and the panel's
template reconcile all rewrite the same config files, units, Twig templates and
Nginx fragments, and none of that is atomic across the set. Each takes one
exclusive lock in `/run/lock/clp-addons/operation.lock` for the whole operation,
so a root shell, a panel job, the anchor path unit and the reconcile timer queue
instead of overwriting each other's work.

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
unknown markup.

Maintenance Mode also owns a marked block in `/etc/nginx/global_settings`.
That block is reconciled from a hashed pristine copy and validated with the
customer-site Nginx configuration before reload. Runtime site toggles only
create or remove flag files, so they do not reload Nginx.

A path unit repairs managed blocks after CloudPanel rewrites watched files. A
15-minute timer repairs service, socket, permissions, and integration drift.
CloudPanel's legacy distro Nginx layout and its separate panel Nginx layout are
detected from their files and services rather than a version string.

When Cloudflare IP Access is enabled, a separate one-minute timer applies its
new-site policy. Disabling the addon removes that timer while keeping the policy
state for a later re-enable.

The manager's block in CloudPanel's own header also makes room for its update
notice there. The panel lays the header out as one non-wrapping flex row of a
fixed height, sized for exactly the three things in it, so a fourth has nowhere
to go; flattening the right-hand wrapper lets the row wrap. Below 960px the
panel navigation takes the second row and the update notice takes the third, so
the navigation cannot be shrunk out of view by the added controls. Those rules
apply only while a notice is actually in the row, so a panel with nothing to
update is shaped as CloudPanel drew it.

Panel Tweaks wants the same rules for a different reason, on a narrow screen
and on any day, so `headerWrapStyle` in `lib/panel-nav.ts` takes the header's own
selector and both ask for their own copy. What a phone additionally wants of the panel's own pages -- the navigation on a
row of its own, a logo that shrinks, an Admin Area link down to its icon, a
Dashboard chart that fits -- is the addon's alone, and a switch, because that is
the panel's own shape being changed rather than room being made for something an
addon added.

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

A job id is defined once, in `lib/job-id.ts`, which `cli/job-store.ts`
re-exports. The app services needed the syntax without the CLI's job
orchestration; three copies of the pattern is how the checking side and the
creating side drift apart. An id reaches a path join, so it is anchored at both
ends and never rewritten.

Panel information is read through `readPanelSnapshot`, which returns the
snapshot and its age at receipt. A timestamp that cannot be parsed reads as
infinitely old rather than as `NaN`: every caller compares the age against a
staleness threshold, and `NaN` fails every comparison, so an unreadable snapshot
used to look current. What a given age means stays with each addon.

## Shared interface

The shell's header reproduces CloudPanel's: the logo, the panel's own
navigation, and the three controls the panel puts on the right -- the theme
switch, the Admin Area, and an account menu of Settings and Logout, pointing at
the panel's own `/admin/users`, `/settings` and `/logout`. The avatar is a
drawing rather than the operator's gravatar, because the manager serves these
pages behind the panel's session without ever being told whose it is. The theme
and Admin Area icons are the panel's own paths rather than approximations of
them, so one control does not have two shapes depending on the page. Below
760px the logo and the three controls share one 64px row and the navigation
takes the row beneath; that shape is what Panel Tweaks gives the panel's own
header on a phone, so moving between the two does not move the header.

Every addon renders into one shell in `lib/app-ui.ts`: palette, cards, tables,
badges, switches, toolbars, one confirmation dialog and one inline notice per
page. A badge names what something is rather than being read for itself, so it
is set a size below the smallest body text wherever it appears. A switch that
decides one thing for a whole page keeps its full size; one repeated per table
row comes down to the height of the line beside it, so the control does not set
the row's height. An addon supplies its brand, its own tabs, its script and any rule only it
draws. The manager's own pages use the same two: disabling an addon asks through
that dialog, naming the addon as its card does and saying that its data is kept,
and a manager job that fails to start reports through the inline notice. The
browser's `confirm` and `alert` survive only as what the shell degrades to where
there is no `<dialog>` or no notice holder. Below 760px the shell tightens: a dialog gives up its desktop padding and
its buttons take the row, and it is bounded by the visual viewport so a phone's
collapsing address bar cannot cover them. Live enable, disable and update jobs
put their state, current step and output in the manager card that owns the job,
with the log auto-expanding as output arrives so the operator can see the live
progress while remaining collapsible if desired. A job whose
card the page does not carry -- an update watched from the index -- takes a card
of its own under the heading and above the rest, whether the page was drawn
during the job or a duplicate request told the browser about it, so a job is
never reported under the action the operator happened to click. The shared
watcher scopes its updates to that card; a completed job still reloads the page
so the server remains the source of the result view.

A page reached from a site's tab strip is drawn in site mode instead: the shell
shows CloudPanel's site information and the applicable site tabs with the addon's
tab active, and the page belongs to Sites rather than to Addons. `lib/site-context.ts`
is the only description of that strip -- order, per-type conditions and routes
mirror `Frontend/Site/Partial/tab-container.html.twig` -- and both the shell and
the injected Twig snippet read it, so a tab cannot be labelled two ways. The
reproduced site information takes its column width, gutter and label styling
from the panel's own `assets/css/frontend/site.css`, so the blocks land where
the panel puts them.

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

Such a landing knows which fragment it wants from the URL alone, so a second
block ahead of the loader asks for it as the page is parsed rather than once the
document is ready, and hides the panel's content area from the same moment. The
settings page the redirect passes through is otherwise painted and then thrown
away, which reads as the wrong page. The area is revealed by whatever finishes
-- the mount, the fallback to the addon's own page, or a timer -- so a page the
loader never reached is never left blank.

CloudPanel sizes that strip for the tabs it ships, so an addon's tab wrapped it
onto a second row. The manager injects one rule making the strip a single
scrollable row and letting the site-information blocks wrap, rather than
widening the panel's limited-width container, which would only postpone the
break until the next addon. The rule is injected once, and only while an
installed addon patches that partial.

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
