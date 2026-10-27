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
Addons page itself, laid out the way an addon's `app/` is. It is not in `cli/`
because none of it is a command; `cli/index.ts` calls `cmdServe` and otherwise
knows nothing about it.

The Addons page is two lists, Enabled and Available, one row per addon with its
one-line description and its buttons, so the whole catalog fits on a screen. A
search above them keeps only the rows whose name and description contain every
one of its words, and hides a list it empties. An
addon's `added` release line (`2.0`) marks it New for as long as that line is
the one installed. An existing addon's `changed` line marks it Changed for the
same time, with one line saying what changed; the rest is the changelog's, which
the update page links.

## One catalog, compiled in

`cli/addon-catalog.ts` is the only registration seam. An addon declares itself
in `addons/<name>/addon.ts` -- title, description, injection targets, required
systemd units, its manager handler, its privileged action and any repair upkeep
-- and the catalog derives its config file and state directory from its name, so
a definition cannot name a file provisioning will not look for.

Repair upkeep runs inside repair's operation lock, so it stays short. Work that
waits on the network or on a site's own code is queued with `queueAddonPass`
instead: a transient unit that runs `clp-addons action <addon> <verb>` under a
runtime bound and is skipped while the previous pass is still running.

The catalog is an explicit list, not filesystem discovery. This ships as one
binary; a registry that depended on what happened to be on disk could be wrong.

The manager and the auth gateway are not in it. They have no config file to
enable, no mount path of their own and no state to keep, so they are dispatched
before the catalog is consulted rather than described by it.

`cli/paths.ts` is a leaf again. It held the registry, which meant the module
owning the project's path constants imported every addon's target list in order
to describe them; the injection-target shape now lives in `lib/addon-target.ts`,
which both sides import.

## The CLI

`clp-addons` with no arguments in a root terminal is an interactive menu:
addons toggle through the same enable and disable the Addons page runs, and
status, repair and update run the commands of those names. Without a terminal or
root it prints the plain overview. Help lists operator commands only. `action`
is how the gateway runs an addon's root verbs, and `serve`, `smtp-submit` and
`terminal-pty` are started by systemd, Postfix and the terminal action.

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

`install`, `enable`, `disable`, `repair`, `update`, `uninstall` and the panel's
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
unknown markup.

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

### Package conffiles

`/etc/nginx/global_settings` (Maintenance Mode) and `/etc/nginx/nginx.conf`
(System Tweaks) are dpkg conffiles of `nginx-common`. unattended-upgrades holds
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
does not skip the next. CloudPanel commits the site row
about 200 ms after writing the vhost, so the service runs again 10 seconds
later, even if the first run failed. The units exist while any installed addon
declares `newSites`; repair restarts the watcher if it has stopped. It takes no
operation lock: each addon's work takes its own. Vhost rewrites also wake the
watcher; when the site set is unchanged, the hooks make no network calls or
configuration writes. Update and repair disable and remove the units listed in
`LEGACY_UNITS` in `cli/paths.ts`.

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

A job that works through sites -- WordPress Tools' checks and connections,
Panel Tweaks' size measurement -- records its progress the same way, through
`runSiteJob` in `cli/job-store.ts`: how many sites are done of how many, the
one it is on, and a step such as `Measuring 12 of 40: site`, then its result.
The page draws that as `jobProgressHtml` from `lib/app-ui.ts`, and the client
half, `followJobProgress`, follows every bar on the page through the routes
above until the job ends. A page drawn while a job runs follows it again, so a
reload picks it up. The addon keeps only what the job means: its title, what it
disables meanwhile, and what it says when it ends.

A job id is defined once, in `lib/job-id.ts`, which `cli/job-store.ts`
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
anywhere on a row but a control or its Manage menu ticks it. On a wide screen a
list of more than twelve rows with something below its card scrolls in a box of
its own under a sticky heading; a list that ends the page grows with it. On a
phone a list longer than ten sites shows the first ten and a button for the rest,
so the settings below it stay close; the hidden rows are deselected like rows
search hides, and search covers every site. Page and form actions wrap within the
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

A page reached from a site's tab strip is drawn in site mode instead: the shell
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

## Browser assets are files

Stylesheets and browser scripts live in `.css` and `.client.js` files beside the
module that serves them, imported with `with { type: "text" }`. Keeping them in
their own files lets editors highlight, format and lint them.

They are served as they are, never bundled or minified. The pages carry inline
handlers calling top-level functions by name from markup no bundler sees, so
tree-shaking and renaming would break them. The panel's nginx already gzips
these responses, which is where the size saving comes from.

Values a file cannot know -- the addon's mount URL, the shared class names,
JSON the manager computes -- are bare identifiers or string tokens in the asset,
substituted by the module that imports it. That keeps each file valid CSS or
JavaScript on its own.

What stays in TypeScript is what a file could not hold on its own: a one-rule
string built from a shared class name, a script fragment that is a function
body rather than a program, and a `<script>` element indented to sit inside a
Twig template.

Every addon page gets the shared base helpers, including `repaintView`, inline
notices and `confirmAction`. The one confirmation dialog can ask the operator to
type a word, such as the domain, before something that cannot be undone, and a
press on any dialog's backdrop closes it. Fleet tables also get site-selection
helpers: `paintFleetSelection` paints the count, select-all and every control
marked `data-needs-selection` by shared ids, and `fleetFilterHtml` adds a search
and an optional filter once a table has six sites. A row the search hides is
deselected, so a bulk action only reaches sites on screen. Pages with background
jobs get the shared job watcher. Theme initialization runs before styles are
painted.

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
