# Panel UI tweaks

## One addon for the small additions

Small changes to CloudPanel's own pages ship as one addon with a switch each,
not as an addon each. A site count, a search box, two extra columns, a narrow
screen that reads, a login-page theme: each is a card's worth of description and
none of them is a system; listing them separately on the Addons dashboard would
have put a fifteen-line script beside Instatic and Stager and implied they were
comparable.

The switches are separate because what they cost is. Most are markup; one reads
the whole disk every fifteen minutes, so measured sizes are off until asked for.
The layout switches are separate for a different reason: they change the shape
of a page CloudPanel drew itself, and the operator who prefers the panel's own
shape is not wrong. So the narrow-screen site list, the panel's own pages on a
phone and the row menu are each their own switch, and the row menu -- which is a click
more than a link -- is off until asked for.

What is deliberately not here is the WordPress sign-in, which shipped as a
fourth switch and is now [its own addon](wp-login.md). Everything here changes
what CloudPanel's own pages look like; that one writes a file into a customer's
site. An operator who wants a filterable site list should not have to install
the code that can do that, and a switch is a weaker withdrawal than not having
it on the box.

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
data, so the count, the filter, the extra columns and the measured sizes take
effect on the next panel page rather than at the next reconciliation.

Four switches cannot work that way. The login page has no session to ask with,
and every route the manager serves is behind the administrator gate. The other
three -- the narrow-screen site list, the panel's own pages on a phone and the
row menu
-- decide how a page looks the first time it is painted, and a rule that waits
for a reply is a rule the reader watches arrive. So for those four the switch
decides whether the markup is there at all, and moving one asks the manager to
render the templates again through a `reconcile` verb. That verb belongs to the
manager rather than to the addon because one pass regenerates every addon's
block in a shared file; an addon that reconciled only its own would strip the
others.

The header rules are two blocks, one for each of CloudPanel's headers, anchored
ahead of the `<header>` tag both of them open with rather than inside it. What
makes that row able to wrap at all is `headerWrapStyle` in `lib/panel-nav.ts`,
shared with the manager, which asks for the same rules while its update notice
is in the row; the addon asks for them whenever its switch is on. They carry a
`body` in front so they outrank the manager's block, which the panel renders
after them.

Below 760px those rules give the panel's header the shape the addon's own pages
already use: the logo and the tools in one 64px row of equal cells, the
navigation on the row beneath. The panel's 75px row and its 25px cell padding
are drawn for a desktop and only crowd a phone, and an operator moving between
CloudPanel's pages and an addon's should not see the header change height. The
same switch fixes the Dashboard, whose charts are drawn at a fixed 545px and
whose information boxes at a fixed 240px -- both wider than the phone they are
on.

## Nothing moves once it is on the screen

The narrow-screen rules are keyed on CloudPanel's own `table-sites` class rather
than on a class the script adds, so they apply while the browser is still
parsing the page. Keyed on the added class, a phone painted the panel's
four-column table and then rearranged it into cards when the reply arrived: the
layout moved under whoever was reading it, for as long as the request took.

The same reasoning splits the script in two. Naming the cells for the card
layout needs nothing but the document, so it happens as soon as the table
exists; only the extra columns wait for data. The request itself is started when
the block is parsed, above the table, rather than when the document is ready, so
it is in flight while the rest of the page is still being built.

The row menu hides the panel's own action links the same way: with a class put
on `<html>` by a one-line script above the table, not by the script that builds
the menus. Added later, the links would be read and then taken away. The script
removes that class again if it cannot find the table it expects, so a page a
CloudPanel release has changed keeps its links rather than losing them to a menu
that was never built.

An open menu is a child of `<body>` positioned against its button, not a child
of the cell it came from: the table sits in a horizontal scroller, which clips
anything hanging out of it. The links themselves are moved into it rather than
copied, so another addon's link keeps working with no arrangement between the
two: the addon does not know what is in the action cell, only that it is a link.

`lib/row-actions.ts` is the whole agreement between the two addons. An addon
with an action worth a place in the menu but not a link in every row of a list
read every day marks it `clp-addons-menu-only` and emits the rule that hides it;
the menu's own rule for the links inside it is what shows it again, last in the
menu: an action nobody thought worth a link in the row is not the first thing in
the menu either, and saying so here means the order does not depend on which
addon's template patch went in first. Stager's `Clone` is the one that wants
this. The hide is the owning addon's rather than
this one's, because an operator who never installed this addon must still not be
shown that link.

## The data the panel does not have

CloudPanel's sites template carries the domain, the site user and the site type.
The certificate, the runtime version and the application are columns of a
database the unprivileged manager cannot open, so the site list is assembled by
the privileged action in one query and sent as data the script paints into
cells. The runtime tables and the certificate table arrived at different
CloudPanel versions, and SQLite will not prepare a statement naming a table the
database has not got, so the query is built from what `sqlite_master` says is
there: a build without `python_settings` selects that column as NULL and reports
no Python runtime rather than failing the list.

Every value the script writes goes in as text or as an element it built. None of
it is markup, because all of it came out of somebody's database.

The App column is the one the addon rewrites rather than adds. CloudPanel prints
the site's type there, uppercased, so a WordPress reads as PHP and a reverse
proxy as REVERSE-PROXY; the application it recorded is both more use and what
the filter beside the table offers, so the two agree. For a PHP site that column
holds the vhost template the site was created from, which is a set an operator
can add to, so only the two run-together names the panel ships are respelled and
anything else is printed as it was written.

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
