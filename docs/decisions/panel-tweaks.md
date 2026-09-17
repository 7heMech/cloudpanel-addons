# Panel Tweaks

## One addon for the small additions

Four small changes to CloudPanel's own pages ship as one addon with four
switches, not as four addons. A site count, a search box, two extra columns, a
login-page theme and a WordPress sign-in are each a card's worth of description
and none of them is a system; listing them separately on the Addons dashboard
would have put a fifteen-line script beside Instatic and Stager and implied they
were comparable.

The switches are separate because the costs are. Two of them are markup, one
reads the whole disk every fifteen minutes, and one writes into a customer's
site. An operator who wants a filtered site list should not have to take the
other two, so measured sizes and the WordPress sign-in are off until asked for.

`login-theme` used to be its own addon and is the device-theme switch here.
`install`, `update` and `repair` carry a box over: the old config file is what
recorded the addon as enabled, so writing `panel-tweaks.conf` and removing
`login-theme.conf` is the whole migration. Its state directory held nothing, and
its Twig block goes on the next reconciliation, because the injection set is
read from the config files rather than from what is in the templates.

## Two anchors, and one of them optional

Everything the addon adds to an authenticated page is one script and one toolbar
injected above the sites table, which then edits the table below it. The
alternative -- separate anchors for the heading, the table head, the loop body
and the action cell -- is four more pieces of CloudPanel's markup to match
exactly, and the reconciler stops on all of them when any one changes.

That anchor is not `required`, so a CloudPanel release that renames the sites
card costs the site list its enhancements rather than preventing the addon from
being enabled. The login page's anchor is required: it is one line inside
`{% block stylesheets %}` and there is nothing to degrade to.

## What is read at request time, and what is not

The injected script asks the addon for the current switches along with the site
data, so three of the four take effect on the next panel page rather than at the
next reconciliation. The login page cannot do that: it has no session, and every
route the manager serves is behind the administrator gate. So the device theme's
switch decides whether the markup exists at all, and moving it asks the manager
to render the templates again through a `reconcile` verb. That verb belongs to
the manager rather than to the addon because one pass regenerates every addon's
block in a shared file; an addon that reconciled only its own would strip the
others.

## The data the panel does not have

CloudPanel's sites template carries the domain, the site user and the site type.
The certificate, the runtime version and the application are columns of a
database the unprivileged manager cannot open, so the site list is assembled by
the privileged action in one query and sent as data the script paints into
cells. Each runtime table and the certificate table is an outer join: a panel
build without one of them reports no runtime rather than failing the list.

Every value the script writes goes in as text or as an element it built. None of
it is markup, because all of it came out of somebody's database.

## Measured sizes ride the repair timer

A site's size is `du` over its home directory, plus its databases' directories
under the MySQL data directory, which root can read without asking CloudPanel
for the master password. The sweep runs from the addon's `maintenance` hook, so
it happens with the existing fifteen-minute repair rather than from a timer of
its own: that timer already runs as root on the interval this wants, and a
second one would only be another unit to install, arm and repair.

It is the one thing here a loaded box would feel, and it runs unattended, so it
asks the kernel to schedule it last -- idle I/O class, lowest CPU priority.
Where `ionice` is absent the measurement still happens without the concession.
The answer is cached in the addon's state directory; the panel's table reads the
cache and never runs `du` itself. A site whose account has gone, or whose home
directory is not owned by it, is skipped rather than guessed at.

The operator-pressed sweep is the same work with a four-minute budget. A box
large enough to exceed it gets its sizes from the unattended sweep instead,
which has no deadline.

## The WordPress sign-in

A must-use plugin and a one-time secret, both written as the site's own user.

The plugin is inert on every request but one: with no secret file on disk it
returns immediately. The secret exists only between the operator pressing the
button and the browser arriving -- at most a minute -- and the plugin removes it
before it compares it, so a failed attempt spends it too. It holds a SHA-256 of
the token, never the token.

It lives in a subdirectory of `mu-plugins`, because WordPress auto-loads every
PHP file directly inside that directory and a data file that is also a plugin
would run on every request. It is a `.php` file rather than plain data so that a
request for it over HTTP executes it and prints nothing, instead of serving its
contents to whoever asked.

The token reaches the site in a POST body, not a query string: a single-use
secret in a URL is still a secret in the site's access log and in the browser's
history. The window is opened inside the click that starts it, before anything
is awaited, because a window opened after a fetch resolves is a popup the
browser blocks.

Switching the tweak off removes the plugin from every site it was installed in.
An addon that left files in somebody else's site after its switch moved would be
one an operator cannot fully withdraw.

The sign-in is for the site's first administrator by user id. Which
administrator an operator becomes is not a choice this offers, because the
operator is already root on the box that serves the site.
