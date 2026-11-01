# WordPress Tools

## Why it is an addon and not a tweak

WordPress Tools groups sign-in, plugins chosen while creating a site, optional
Varnish installation and optional MainWP Child enrollment.
[Panel Tweaks](panel-tweaks.md) changes what CloudPanel's own pages look like;
this addon writes into a customer's site. An operator who enables a filterable
site list does not thereby authorize those actions, and the gateway's fixed
addon-and-verb table refuses
`panel-tweaks sign-in` rather than allowing it and checking a stored switch.

Its identifier was `wp-login` before 2.0.0. `update` and `repair` move
`wp-login.conf` and `/var/lib/clp-addons/wp-login/` to the new name, the state
also when the addon is disabled, since it holds the MainWP connections and any
login setting an enrollment changed. When both directories hold state, nothing
is renamed and update and repair say which to keep. If the update fails after
the move, it puts both back under `wp-login` first, because the binary the
rollback restores knows only that name. The old name is not accepted anywhere
else.

Sign-in is available whenever the addon is enabled. Automatic Varnish installation and
MainWP enrollment are separate opt-in policies, off when no settings exist.

Disabling or uninstalling removes the sign-in helper from every site it is in.
A site whose files cannot be deleted does not stop the ones after it; withdrawal
names it and the reason. A maintenance bypass an administrator accepted while
signing in belongs to Maintenance Mode: it stays in that site's bypass list
until removed there. A basic-auth IP bypass belongs to CloudPanel's Security
settings and stays there until removed. The official CLP plugin is an ordinary
WordPress plugin and remains installed when automation or the addon stops. Its
updates, settings, deactivation and deletion belong to WordPress.

## Varnish installation

The policy and last-check records live in root-owned
`/var/lib/clp-addons/wp-tools/varnish.json`, written atomically with mode `0600`.
Disabling keeps this state. Entries for a domain the panel no longer has are
dropped, so a recreated site starts fresh. Missing state means automation off;
invalid state is an error rather than a reason to reinstall plugins. The page
then shows that error in place of the Varnish controls and still offers
sign-in.

Every 15 minutes repair queues `clp-addons action wp-tools sync` through
`queueAddonPass`. That pass runs outside repair's operation lock. The transient
unit has a 180-second runtime limit and skips an already running pass. Each policy checks
the enabled config under its own lock before reading state or discovering sites;
disable and uninstall hold both locks while removing config and state. The
Varnish pass checks only sites automation can still act on: no record yet, or a
plugin not yet seen. It has a 30-second budget. **Check now** checks every
eligible site in a background job (see below) and refreshes what the page
shows. It is offered whether or not automation is on: with automation off it
only records what each site has and installs nothing, which is what lets an
operator see a site's state before choosing Install. An administrator can also
request an installation for one site, also as a job. The timer's checks do
nothing while the policy is off. A single-site explicit installation can run
while automation is off, but still honors eligibility. Only PHP sites with CloudPanel's `varnish_cache`
flag and `wp-includes` plus `wp-content` on disk are eligible. The page and
installer share this discovery and eligibility calculation. A panel without
the Varnish column contributes no eligible sites. Varnish itself is never
enabled by the addon.

Fixed WP-CLI commands run through `runuser` as the site account sign-in
discovery resolved, so the same accounts are refused. They use the site's
`php_settings.php_version` to choose `/usr/bin/php<version>`, and the installed WP-CLI phar at `/usr/bin/wp`
or `/usr/local/bin/wp`. Neither dependency is downloaded by the addon.
Arguments never pass through a shell. The child receives only a fixed PATH,
its account's HOME and a disabled global WP-CLI config. Plugins, themes and
WP-CLI packages are skipped; WordPress still loads its config and must-use
plugins, all after dropping root. WordPress resolves the plugin directory and
activation status, supporting a customized plugin directory. The status is
read from a marked line, so anything the site's own code prints does not break
it.

A multisite network is treated like any other site, except that activation is
network activation: install uses `--activate-network`, Activate uses
`--network`, and only `is_plugin_active_for_network` counts as active, so a
plugin active on some of the network's sites reads as inactive. That is safe
because of how the plugin works: it reads its settings from the site account's
`~/.varnish-cache/settings.json`, which CloudPanel writes per site, purges by
the request's host and by that site's cache-tag prefix, and puts its settings
page in the network admin when network-activated. A network's sites are all in
the one CloudPanel site whose files and Varnish settings they share, so one
network activation is what that site's Varnish needs, not a decision on behalf
of other CloudPanel sites. A stored `unsupported` record is dropped when read,
so such a network is checked afresh.

Automation installs the fixed WordPress.org slug `clp-varnish-cache` with
`--activate` only when absent and never previously observed or attempted.
Existing active and inactive installations are left unchanged. A persistent
`seen` bit prevents reinstallation after manual removal. Installation intent
is saved before execution so interruption cannot erase that protection; an
interrupted run therefore needs an explicit Retry. A command that fails
outright put nothing there, so its intent is undone and the next pass retries.
Explicit installation can reinstall an absent plugin or activate an inactive
one. There is no force overwrite or plugin update.

Policy changes and each check hold a dedicated Varnish lock, so a download
does not block sign-in or helper removal. Each pass processes the least
recently checked sites first within its budget. Each WP-CLI command
runs under `timeout` for at most 60 seconds, and root kills it and stops
reading a few seconds later whatever is left: `wp-config.php` is the site's
code, and a process it detaches could otherwise hold the pipes, the Varnish
lock and the pass open. Output is bounded to 64 KiB per stream, and saved
error text is a 500-character summary with control characters removed.
Per-site failures are saved and do not stop subsequent sites. The page
reads saved status without bootstrapping WordPress; it exposes the last-check
time and bounded error text. Pending sites are handled on subsequent passes.
Every Varnish route remains administrator-only; the sign-in route's role
exception does not grant plugin-management access.

The page opens with one sites table -- Site, CLP Varnish Cache, MainWP Child,
Sign in -- since sign-in is the most-used action and the one the addon started
with; each status has its Install, Activate, Connect or Retry beside it, on one
line on a wide screen, so the table spreads across the page instead of stacking
each cell. A site that has not been checked shows Not checked and no button:
until a check says the plugin is missing or inactive, Install is a guess, and
the same holds for MainWP's Connect. With a Dashboard on this server the table
also gets a selection column and **Connect selected to MainWP** and **Connect
all unconnected** above it, for sites checked or not; see Background jobs. On a
phone the heading's selection count sits under it, with Select all beside both,
and the two batch buttons share the next line under shorter labels. The two automation policies are set once, so they share one card
below the table. A row has no automation switch of its own: Varnish automation
acts only on a site it has never seen, so a listed site has normally been
handled by a pass already, and MainWP automation acts on every site. The
page draws only controls that do something: the MainWP column and switch
appear once a Dashboard is chosen, here or on another server; until then the
card holds only the picker, plus cleanup while Child plugins the addon
installed remain from a deleted Dashboard, and automation reads as off; a site
without Varnish in CloudPanel says Varnish off. A muted line under the table offers to remove the
sign-in helper while any site has it, and the shared search (site or user)
appears from six sites, with filters for needs attention, CLP Varnish Cache not
active and MainWP not connected; each heading sorts, a status column worst
first. Sign in is
a plain button: on every row, a solid one would be the loudest thing on the
page. After any change the page fetches
`/api/dashboard`, a server-rendered fragment of everything below the heading,
and repaints from it, so row status always comes from the same renderer as the
first load and the page never reloads.

## What is in the site

A must-use plugin and a one-time secret, both written and removed as the site's
own user through `runuser`, never by root, which would follow any symlink the
site's user put in the path.

Must-use rather than a normal plugin because it has to be there when the request
arrives, must not be something a site owner can deactivate by accident, and
because WordPress loads it before the plugins that would otherwise redirect an
anonymous request away.

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

The token reaches the site in a POST body to `/wp-login.php`, not a query string
or the root URL: a single-use secret in a URL is still a secret in the site's
access log and in the browser's history, and posting to `/wp-login.php` avoids
front-end redirects or firewalls that bounce unauthenticated visitors away from
the root path before WordPress boots. The window is opened inside the click that
starts it, before anything is awaited, because a window opened after a fetch
resolves is a popup the browser blocks.

The addon's page refuses form submissions, as every response does by default.
Its sign-in window opens on the addon's page for that one site, whose policy
lets a form go only to the site's HTTPS origin, and the token's form is written
into it once it has loaded. This keeps the response header size independent
of the site count and within the panel's proxy buffer. CloudPanel's own pages
set no policy, so their links open a blank window. Either way the window's
`opener` is cut before the form is submitted, so a page on the site cannot send
the panel's tab elsewhere.

The site user creates `mu-plugins/clp-addons` itself, so every directory it adds
is that user's. A missing `wp-includes` or `wp-content` is a refusal rather than
something to invent.

The sign-in is for the site's first administrator by user id. Which
administrator an operator becomes is not a choice this offers, because the
operator is already root on the box that serves the site.

## A site in maintenance

Maintenance Mode answers in Nginx, before WordPress could read the secret, so the
sign-in asks the same question first: while that addon is installed it checks
the flag and bypass files Nginx checks, for the address the panel saw the
browser at. If Nginx would turn that browser away, no secret is minted. An
administrator is offered that address as a site bypass; agreeing is a second
click, which opens the window and signs in, and cancelling opens nothing. The
secret is minted before the bypass is added, so a sign-in that fails leaves no
bypass behind. The address comes from the request, never the page, and the
root action refuses
`--add-bypass` with `--as-user`: lifting maintenance is an administrator's
decision. Anyone else is told the site is in maintenance. The wording comes
from the action, so every page that signs in says the same thing. On the
panel's own pages it is shown in CloudPanel's own Bootstrap modal, as are
failures.

A browser that reaches the panel over IPv4 and the site over IPv6 is still
turned away after the bypass, as it would be after adding the address by hand.
Maintenance's handling of forwarded addresses is described in
[Maintenance Mode](maintenance.md).

## A site protected by basic authentication

CloudPanel links `site.basic_auth_id` to `basic_auth`. Its `is_active` and
comma-separated `whitelisted_ips` decide whether sign-in needs a bypass; the
site's username and password are never read. IPv4 and IPv6 hosts and CIDRs are
matched as Nginx matches them. Request addresses, including CLI input, normalize
mapped IPv4 to dotted IPv4. Accepted updates normalize stored mapped hosts,
deduplicate them and preserve CIDRs. Mapped IPv6 hosts and networks do not count
as effective IPv4 allowances until an administrator approves an IPv4 entry.

An administrator whose address is blocked receives a separate confirmation
before a token is minted. It states that the bypass covers the whole site and
everyone sharing that address until removed in Security → Basic Authentication,
and warns about spoofing and Cloudflare. Both `/wp-login.php` and `/wp-admin/`
are covered. Other panel users cannot add a bypass, including site managers:
root rejects `--allow-basic-auth` with `--as-user` or without a request address.
Existing allowances still permit their ordinary sign-ins and ownership checks.
`--add-bypass` authorizes maintenance alone; both gates require separate consent.

Acceptance updates the native allowlist and exactly one complete generated
`satisfy any`, `allow`, `deny all` and basic-auth block. Customized or ambiguous
blocks are refused with a pointer to the native Security page. Extra access
rules in that server or its protected locations, and unknown includes, are
refused because adding `satisfy any` could make them bypass authentication.
A location whose only access rule is `deny all`, as CloudPanel's templates
close `.git` and `xmlrpc.php`, is accepted and given `satisfy all;`: its own
rules replace the server's, but it would inherit `satisfy any` and let the
basic-auth password through. A later rewrite accepts that pair. The check runs before the bypass is offered, so a vhost it would
refuse gets a pointer to the Security page instead of the offer.
This also refuses CloudPanel's Cloudflare IP range include in the same server:
otherwise every allowed edge could bypass basic auth. The parser is shared
with maintenance in `cli/nginx-config.ts`. Only a regular,
root-owned vhost that is not writable by other users can be replaced. Its mode
and ownership survive atomic replacement; credentials and other content remain.

Disable and uninstall remove the helper from every site and then the addon's
config under the sign-in lock, and a sign-in refuses once the config is gone,
so one that was waiting cannot put a helper back. The sign-in lock waits up to
five seconds. Minting as the site user has ten
seconds and runs before the SQLite write transaction; panel reads and writes
wait at most one second for database contention. The transaction, shared with
Cloudflare IP Access and maintenance in `cli/nginx-transaction.ts`, validates
and reloads before commit. Each Nginx command is killed after two seconds, and
each reload waits at most three more seconds for new workers to accept requests
and old workers to stop accepting, using `/run/nginx.pid` and `/proc`.
Failure restores the vhost before releasing SQLite's write lock, then rolls
back the database and validates the files. If reload was
attempted, it waits for the restored generation. Recovery errors accompany the
original failure. These waits, including maintenance's database and lock waits,
leave recovery time inside the gateway's 60-second deadline.

A token minted before a later failure expires after its normal minute.
Maintenance bypasses are added after the basic-auth commit, so a failure there
leaves the accepted native allowance in CloudPanel's Security settings. Neither
gate changes during preflight. No probe adds the server's address.

### Native real-IP limits

CloudPanel trusts `X-Real-IP` from every IPv4 peer through
`set_real_ip_from 0.0.0.0/0` and the default `real_ip_header X-Real-IP`. Anyone
who knows an allowed address can replay it to bypass basic authentication;
the IP is not a secret or a reliable identity. With ordinary Cloudflare proxying,
`CF-Connecting-IP` carries the visitor address but Nginx still sees the edge
address, so adding the administrator's panel IP may leave the password prompt.
A panel reached over IPv4 and a site reached over IPv6 can also disagree.

This feature retains native behavior and states both real-IP limits in its
confirmation. It installs no trust rules of its own; [System Tweaks](system-tweaks.md#forged-visitor-ips)
narrows the global trust, by default, for every site. A native allowlist change
persists through CloudPanel's regeneration without separate addon state.

## Two answers to "which sites are WordPress"

The addon's own page asks the disk: a site is WordPress when its root holds
`wp-includes` and `wp-content`. That is what the sign-in itself checks, so the
list and what will actually work are the same set, and a WordPress installed
under the Generic vhost template is in it.

The links on CloudPanel's pages cannot ask the disk. Their condition is Twig,
and what Twig has is the `application` column -- which for a PHP site is the
vhost template the site was created from. So the links appear for the WordPress-family templates the panel
ships and the action refuses anything that turns out not to be one, the same
bargain the Stager addon's own site-list condition made. The complete list is
the addon's page; the links are the shortcut for the common case.

## Every role that can see the site

The links are not administrator-only. CloudPanel lists and opens for a
`ROLE_USER` only the sites `user_sites` maps to their account, and that account already has the site
through the panel's file manager and its database, so signing in to its
WordPress is a shortcut past work they can already do rather than authority they
did not have. `ROLE_SITE_MANAGER` and `ROLE_ADMIN` see every site, and are not
narrowed.

The page is not what decides that. The manager passes the session's user name
to the action, and the action -- which is the only side that can open
CloudPanel's database -- refuses a domain the panel would not list for that
account, and refuses a deactivated account whatever its role, because a session
outlives the status change that should have ended it. An administrator's
request carries no name and is not narrowed.

Two things follow from the links living on pages this addon did not render. The
manager's blanket administrator gate has to name the sign-in route as an
exception, which `docs/decisions/security.md` describes; and the browser may
hold no CSRF cookie, because the only responses that set one are addon pages a
non-administrator cannot open. So the script fetches `/api/session` -- which
reads nothing and answers with the cookie and its token -- but only when there
is no token to send.

## Where the links go

On the Sites page the link and the script are separate injections into the same
template because the page has two places for them: anything put in the action cell is emitted
once per row, which suits a Twig condition and not a script. The script goes
above the table, where it is emitted once, and binds one listener to the
document rather than one per row -- the rows belong to CloudPanel, and the Panel
Tweaks filter moves them around.

The link goes before Manage, not after it. Manage is the panel's own primary
action and the rightmost thing in a right-aligned cell, which is where a reader
looks first; an addon taking that place pushes the panel's action inward on
every WordPress row. The menu Panel Tweaks can build reads the other way and
restores the order, so the link carries `clp-addons-row-action` from
`lib/row-actions.ts` for it to sort on.

On a site's own pages the domain itself signs in. The panel's link to the site
there repeats what the Sites page and the address bar already give, while a way
into wp-admin is what an operator on a site's pages is usually after. The block
goes in the Domain box, after the panel's own link, and puts a link of its own
there with a rule hiding the panel's: CloudPanel's markup is matched, never
rewritten. Ours keeps the site's address, and the script leaves a Ctrl-, Cmd-,
Shift- or Alt-click to the browser, so the site still opens from it in a new
tab. That box is `Frontend/Site/Partial/site-info.html.twig`, rendered once per
page on every site tab, so one injection carries the link, the script and its
rules. Addon pages in a site's tab strip draw their own copy of the box, which
still opens the site.

CloudPanel's site pages hand Twig a site without its id or application, so the
block cannot test for WordPress as the Sites page does. It draws the link hidden
on every PHP site, and the script asks `GET /api/site-kind` whether to show it.
The action answers with the same disk check a sign-in makes, held as the
sign-in is to a site the caller's account has. The panel's link is hidden only
once ours is shown; the two look alike, so the swap does not show.

The **Sign in from the domain** switch, under **CloudPanel's pages** and on by
default, turns that off; the
panel's link then stays and a WP Login link goes beside it. It is markup, so
the setting is read when the templates are rendered:
`/var/lib/clp-addons/wp-tools/domain-link.json`, root-owned, written
atomically with mode `0600`, absent meaning on. Saving it asks the manager to
render the templates again. The setting is saved even when that fails; the page
repaints with it and says CloudPanel's site pages still show the old link. An unreadable file renders as the
default and the page reports it.

None is `required`, so a CloudPanel release that renames the sites card, the
Manage link or the Domain link costs the shortcut rather than stopping the addon from being
enabled. The addon's own page signs in to the same sites either way.

## MainWP enrollment

The Dashboard is one WordPress site on this server, chosen from the same
discovery as everything else, or "on another server". Connecting to a Dashboard
elsewhere would need its credentials and network policy, which the addon does
not manage, so for one it only installs the Child; see below. Child steps run
as the child's site user and Dashboard steps as the Dashboard's, through the
shared WP-CLI runner.
A fixed adapter, `mainwp.php`, is passed to `wp eval` with JSON on stdin and
answers on a marked line. Its failures are fixed codes the addon turns into its
own messages, so text a site prints in reply is never shown or logged; a failed
plugin download keeps WP-CLI's bounded summary, as Varnish's does. The adapter loads
the Dashboard plugin after WordPress and registers through MainWP's own
`rest_api_add_site`, which generates and stores the keys.

Connecting uses the child's first administrator, as sign-in does. The adapter
sets a random Security ID and turns off that administrator's password
requirement for connecting, which lets MainWP register with the ID alone. The
previous setting is journaled first. It is restored in `finally`, or by the next
queued pass after a crash, even when automation is off.
Interrupted children are recovered first, within the pass budget and before
querying the Dashboard. A successful recovery is journaled as `restored`, so an
unavailable Dashboard cannot prevent disable or uninstall once authentication
is safe.
A site the Dashboard already has a record for is reconnected through MainWP's
own reconnect rather than removed and added again, so the record keeps its id,
groups, tags and client. The adapter gives the record the new Security ID and
the child's administrator first, which is all the Child checks while that
administrator's password requirement is off.
MainWP stores "use the global setting" for a new record's certificate check, so
the adapter sets it to verify. It also cuts MainWP's request timeout to 20
seconds, so registration fails inside the addon's deadline instead of being
killed half-way.

Before any change, the Dashboard's user fetches the child's HTTPS URL with
certificate verification, no redirects, a five-second timeout and a 1 KiB limit.
Anything but 200–399 is Waiting for HTTPS: no `seen`, no claim, retried on every
pass. A maintenance page or a Cloudflare-only rule is not ready either.

Root-only `/var/lib/clp-addons/wp-tools/mainwp.json`, written atomically with
mode `0600`, holds the policy and each site's status, `seen`, and
separate plugin and connection ownership. While it owns anything it also keeps
a snapshot of the settings it may change, the Security ID until the connection
is verified or cleaned up, the Dashboard record's id and key fingerprint, and a phase written
before each step that changes the site. The page gets a projection without
snapshots, IDs or keys. Connected means the child's and the Dashboard's
public-key fingerprints match; with no claim, that connection is the operator's.

With a Dashboard on this server, automation is enforcement: every pass keeps
every site connected to that Dashboard, whatever happened to its Child since.
The server's sites are the operator's fleet, and a site that drifts out of the
Dashboard unnoticed is the failure this exists to prevent. Installing and
connecting are one step, since a Child left unconnected would only switch
itself off. A Child connected to another Dashboard, or holding a key no
Dashboard has any more, is disconnected the way the Child's own Disconnect does
and connected here; so is one the operator chooses with Connect while automation
is off. A takeover whose registration does not land gives the Child back the
connection it had. Turning automation on, or choosing a Dashboard with it on, asks first,
since it takes sites from any other Dashboard. An attempt whose readback shows
nothing changed and no Dashboard record gives up its claim and is retried on
the next pass, like a failed Varnish download. Otherwise the claim stays, and
the next pass or Retry resumes it, undoing first its own registration the
Dashboard never recorded. With automation off, a phase left by a crash is
reported as interrupted, after its setting is restored.

A connected site gets a guard, `clp-addons-mainwp.php` in `mu-plugins`, written
and removed as the site's user through the adapter. It hides MainWP Child from
the Plugins list, refuses `deactivate_plugin` for it, removes the Child's
settings page and drops its Disconnect post, so a site administrator cannot
undo the connection between passes. A site whose `wp-config.php` moves the
must-use folder reports that instead, since the guard would not load. WP-CLI and the Dashboard's own requests are
unaffected, so checks see the site as it is. The guard is beside the Child, not
the Child itself as a must-use plugin: the Child sets itself up in an activation
hook and finds its own path in the plugins directory, and WordPress does not
update must-use plugins, so the Dashboard could no longer update it. Deletion
over SSH or SFTP is not something WordPress can stop; the next pass puts the
Child back. Once nothing enforces the connection -- automation paused, cleanup,
a Dashboard elsewhere or none usable -- the next passes remove each guard. Withdrawing the
addon removes them without WordPress, as it removes the sign-in helper.

A connection the addon takes over is never in its snapshot, so cleanup leaves
that Child disconnected rather than handing it back to the other Dashboard. A
Dashboard record it reconnected was the operator's and stays theirs, so cleanup
leaves it; only a Child the addon installed for it is removed, as anywhere else. Cleanup acts on a child only if its key is the recorded one, comes from the
addon's Security ID, or is gone. A Child someone has connected since is left as
it is and only forgotten. Where the addon installed the plugin, cleanup deletes
it and restores every MainWP option (`mainwp_`, `wp_mainwp_` and their
transients) to the snapshot, with its cron events, tables and an empty uploads
folder. On an existing plugin it restores the connection options, Security ID,
activation and the administrator's MainWP metadata; the plugin's other settings,
tables and events stay. The Dashboard record goes only if its id and key still
match. It is removed through MainWP's database removal without the request that
asks the child to deactivate, as MainWP's own Abilities API does, with its key
file and cookie jar. Settings-backup and request-log rows, which MainWP leaves,
go too. A retry finishes those artifacts even when the Dashboard record is
already gone. Both sides verify, and a failure keeps the claim and Cleanup
pending. While the Dashboard cannot be read, cleanup still restores each child
whose connection is recorded, and retires that Dashboard record for a later pass
to remove once the Dashboard answers. A child with an unconfirmed enrollment
waits for the Dashboard, since only it can name the record that may exist. Cleanup journals removal intent by clearing `seen` before deleting a
plugin the addon installed, so automation may install it again after a completed
cleanup, even if cleanup needed retries. One already removed by the operator
stays seen.

For a Dashboard on another server the addon never contacts a Dashboard or
registers anything. Automation installs MainWP Child on an unseen site and
leaves it inactive: MainWP Child deactivates itself on an admin page load once
it has been unconnected for `mainwp_child_ttl_active_unconnected_site` minutes
(20 by default), so a Child activated in advance would be off by the time the
operator connects it. The row action installs a missing Child and activates it,
after clearing `mainwp_child_lasttime_not_connected` so that timeout starts
afresh, and the operator adds the site from their Dashboard with the
administrator's own login. Neither path sets a Security ID or changes the
password requirement, so the Child is no easier to claim than the site's admin
account. A Child with a public key is reported connected, to whichever
Dashboard holds it. The install is journaled as phase `child`, which needs no
authentication recovery: a failed attempt that changed nothing is retried on
the next pass, and an interrupted one needs Retry, as an enrollment's do.
Cleanup uses the same snapshot rules, so it deletes a Child it installed and
restores the activation of one it found, unless a Dashboard has connected it
since. Moving to a Dashboard elsewhere requires cleaning up the connections the
addon made; moving back does not, since an installed Child belongs to no
Dashboard.

MainWP has its own lock, separate from Varnish and sign-in. While enforcing,
the queued pass looks at every site, least recently checked first; otherwise
only at unseen sites, unfinished phases, guards to remove, pending cleanup and
retired records. It starts sites for 25 seconds; Check now, connections and cleanup
run as background jobs. An enrollment that has started gets up to a minute, so
the budget never stops registration part-way. A pass asks the Dashboard about
at most 64 sites, least recently checked first; a job plans every due site up
front and runs them in passes of 64, so a large fleet takes several passes
without visiting a site twice. A deleted site's owned Dashboard record is retired and
removed on a later pass; a deleted Dashboard took its records with it, and
cleanup then finishes on the children.

Connecting several sites is one job over the chosen domains, or over every
site the page counts as unconnected: not the Dashboard, not connected, not a
multisite network. A site that turns out to be connected to this Dashboard
already is recorded and left alone. Each site is still its own enrollment with its own claim and
recovery, so one failure does not stop the rest. Batch connection is offered
only for a Dashboard on this server: one elsewhere has to add each site itself
within the Child's connection timeout, so activating many at once would only
start their timers together.

The switch only pauses automation. Disabling or uninstalling leaves the
connections, as it leaves the Varnish plugin, removes the guards, and refuses
only while an enrollment stopped before its temporary setting was restored. `--purge`
forgets which connections the addon made.

## Background jobs

Check now for either policy, a row's Install, Activate or Connect, a batch
connection and MainWP cleanup each start a job rather than holding the request:
on a box with many sites a check takes minutes, which a request cannot hold and
a reload must not lose. The job store is the one Stager, Git
Deploy and Instatic use. `start --task=<task>` records the job and hands it to a
transient systemd unit, `clp-addons action wp-tools run --job <id>`, with an
hour's `RuntimeMaxSec`; the pass inside stops starting sites five minutes
before that and reports the rest as pending. `run` is not in the gateway's verb
table, so only that unit runs a job, and `start` accepts only its fixed tasks,
domains for the tasks that take them (a check may name the sites it covers, as
a new site's does), and the same confirmations the routes require.

Each policy runs one job at a time: `start` refuses a second while one is
queued or running, under a lock of its own. The runner takes the policy's lock,
waiting up to four minutes for a timer pass to finish, and holds it for the
whole job, so nothing else changes that policy's state meanwhile. While a
policy's job runs the page disables that policy's buttons, switch and Dashboard
picker; sign-in and the other policy stay usable. New sites' plugin jobs are not one at a time:
each waits for its own site and takes neither policy's lock.

The runner writes how many sites it has done, of how many, and which one it is
on before each site, through the shared per-site progress (see
[Platform integration](platform.md)). `sites` returns each policy's running job, so the page
draws a progress bar for it under the table on every load and repaint and
follows it through the shared job event stream, polling where the stream drops,
and marks the row being worked on. When it ends the page repaints and says what
it did, from the result the job saved. A job record is kept for seven days;
repair's maintenance prunes older ones and marks failed a job whose unit is
gone, as the other addons' upkeep does.

## Plugins for a new site

CloudPanel's New WordPress Site form gets a Plugins row: search WordPress.org
and pick, or upload a zip, and choose for each whether it is activated. It is
an administrator's, and a site manager's for WordPress.org plugins while an
administrator allows it; see Who may choose. It is
WordPress Tools' rather than Panel Tweaks' or DNS's because it puts code into a
customer's site, which is what this addon exists to keep separate, and it is
built from this addon's parts: the site discovery and account refusals, the
WP-CLI runner and the job store. It is a choice per site, made where the site
is made; a set every new site gets would be a policy on this page instead.

CLP Varnish Cache and MainWP Child are not offered while their automation is
on: search lists them as installed automatically, and root refuses a choice that
names either, by slug, when it is recorded. Each then has one owner, so the
form's job and the policy's check never install it at once, MainWP's cleanup
still finds the Child its own, and a Varnish plugin chosen inactive is not left
so by a policy that only installs. MainWP counts as on outside cleanup. Turned
on after a choice is recorded, a policy finds its plugin already there and
treats it as it would one installed by hand.

### Recorded before the site exists

The row is injected before the form's Back and Create buttons, beside Panel
Tweaks' certificate option, and its inputs have no names, since Symfony refuses
a field its form does not declare. Its script takes the form's submit ahead of
CloudPanel's own handler, records the choice with `POST /api/new-site`, and then
submits the form as it would have gone. A choice that cannot be recorded stops
the submission and says why, so a site is never created without the plugins it
was promised silently.

The choice is a background job recorded before CloudPanel has created anything,
because CloudPanel creates the site and installs WordPress inside that one
request. The job waits up to ten minutes for a site of that name to appear in
the panel's database, then up to ten more for `wp-includes`, `wp-content` and
`wp core is-installed`, polling every three seconds. It never needs the site to
answer over HTTPS: everything it does is WP-CLI, and downloads are root's.
Waiting in the job rather than in the landing page means a browser that closes
during creation still gets its plugins; waiting in the job rather than in the
shared new-site watcher means it does not depend on when the vhost appears,
which is before WordPress is installed. It polls rather than following New
sites' wakes, which only queue jobs and do not hand a running one its site.

This is no way into an existing site. `new-site` refuses a domain CloudPanel
already has, and the job refuses a site whose `created_at` is more than two
minutes older than the choice, in case an older site was restored under the
name meanwhile, or that has no `created_at` to compare.

CloudPanel sends a form back with an error without creating anything, so the
choice is kept in the tab's session storage and the row comes back filled in.
Submitting again records a new job, and any job still waiting for the same
domain is superseded and hands its uploads to the new one -- but only once the
new choice has passed every check, so a refused resubmission (a plugin chosen
twice, or one automation took over in the meantime) leaves the earlier job
waiting with its uploads. Submitting it with
every plugin removed still tells WordPress Tools, with an empty choice that only
supersedes, so plugins taken off the form are not installed after all; their
uploads are deleted. A job for another domain is never touched: one still
waiting may be for a site CloudPanel is creating in another request.
Superseding and a job's switch from waiting to installing take the same lock,
so exactly one of them installs. A job whose site never appears
ends as `not-created`, which is what an abandoned form leaves; it installs
nothing, deletes its uploads, and is not listed.

### Installing

Each plugin in turn, WordPress.org ones first so an uploaded add-on finds the
plugin it extends already active. A fixed `wp eval` lists the installed plugin
folders and their activation on a marked line. One already there, such as the
Akismet WordPress ships, is left as it is and activated if asked. Otherwise root
has the zip in memory -- the staged upload, or WordPress.org's download -- and
inspects it again. The site's user writes it from stdin into a fresh `mktemp -d`
directory, WP-CLI installs it from there with `--activate`, or
`--activate-network` on a multisite network, and the directory is removed as
that user. The list is read again to confirm the plugin is there, and active if
it should be. One failing does not stop the rest; its saved error is a
500-character summary, as Varnish's is.

A WordPress.org plugin is fetched by root from `api.wordpress.org`'s
`plugin_information` for its slug, and its `download_link` must be
`https://downloads.wordpress.org/plugin/<name>.zip`; no redirect is followed,
the download is bounded at 64 MiB, and the zip must unpack into the folder the
slug names. Slugs match `^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$` everywhere they
are accepted. Searching is the manager's: a public read-only call to
`query_plugins`, whose reply is cut to the slug, name, version, author, install
count and summary, as bounded text. Icons are left out, since loading them would
tell WordPress.org each administrator's address.

### Uploads

A zip goes from the browser to the manager in one request, bounded at 32 MiB
before it is read, and on to root in parts of 704 KiB as base64, each one
gateway request under the gateway's 1 MiB limit. Root picks a random 128-bit id
with the first part, takes the rest in order only, and inspects the zip with the
last: one that is not a plugin is deleted at once. Uploads live in root-only
`/var/lib/clp-addons/wp-tools/uploads/<id>/`, at most twenty at a time. Removing
one from the form discards it; one no job claimed goes after six hours, and a
claimed one after two days if its job never deleted it, both in repair's upkeep.
A job deletes the uploads it was given when it ends.

A zip is read without extracting it. Its central directory is checked whole:
no ZIP64, split or encrypted archive, only stored or deflated entries, no
absolute, drive-letter, backslash, control-character, `.` or `..` path, no name
twice, no symlink or special file, a local header naming the same file as the
directory, at most 30,000 entries and 256 MiB unpacked. Every entry but macOS's
`__MACOSX` must be inside one folder whose name is plain
(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`), and a PHP file directly in it must carry
a `Plugin Name:` header in its first 8 KiB, which is inflated in memory. That
folder becomes the plugin's slug. WordPress extracts the zip later as the site's
user, and refuses traversal itself as well.

### Where the result shows

The job's result names each plugin and whether it was activated, installed,
already there or failed. The landing page, `wordpress-installed.html.twig`,
follows the job whose id the form left in session storage, if it is for the
domain the page shows, through `new-site-status`, and says how it ended in a box shaped like the panel's
flash messages. The WordPress Tools page's **Plugins on new sites** card shows
every running job with the shared progress bar and the ten most recent results,
failures included, for the seven days a job record is kept.

At most twenty plugins a site. The gateway allows `plugin-upload`,
`plugin-discard`, `new-site`, `new-site-status`, `new-site-access` and
`new-site-settings`; `start` does not accept the `new-site-plugins` task, so a
job can only be recorded with the plan `new-site` validated.

### Who may choose

Administrators, and site managers while an administrator allows it.
CloudPanel has three roles (`lib/panel-users.ts`). `ROLE_ADMIN` and
`ROLE_SITE_MANAGER` see every site and create sites on this very form, so the
picker is offered to a site manager where they already work, without any of the
Addons area. Both can already write PHP into any site through CloudPanel's File
Manager, so which plugins a site manager may pick is the operator's offer to
clients rather than a boundary between users; it is still enforced as root.

**Site managers choose plugins for new sites**, under **CloudPanel's pages** on
this page, is off by default and kept in root-only
`/var/lib/clp-addons/wp-tools/new-site-access.json`; an unreadable file reads as
off and the page says so. It is markup: the Twig blocks test `ROLE_ADMIN`, and
`ROLE_SITE_MANAGER` as well while it is on, so it is read when the templates are
rendered and saving it renders them again through the manager's `reconcile`, as
the domain link does. The upload control and its note are drawn for
`ROLE_ADMIN` only, whatever the switch says: a zip is code nobody has reviewed,
from anywhere.

The picker's three routes are named in WP Tools' `selfScopedRoutes`:
`GET /api/plugin-search`, `POST /api/new-site` and `GET /api/new-site-status`.
WP Tools' whole mount must not become `siteManager`, since its page signs in to
and installs into every site. The handler turns away anyone but an administrator
or a site manager, and names a site manager to root with `--as-user`, as DNS's
provision route does. Root then reads the switch, and the account's role and
status from CloudPanel's database rather than its session, refusing anything
but an active site manager. A site manager's `new-site` names no uploads, gets
the same refusal of a domain CloudPanel already has and of a site older than the
choice, and replaces or clears only choices that account made; the job records
it as `chosenBy`, which the WordPress Tools page shows. Its plugins go only into
a site that account created: the name may have been free when they chose, and
taken by someone else since. CloudPanel keeps no creator on the site, so the
job waits, with WordPress, for the `SITE_WORDPRESS_CREATE` entry CloudPanel's
event log writes for that domain, and installs nothing if it names another
account or never comes. Only an entry after the newest one when the choice was
saved counts: the log's ids are `AUTOINCREMENT`, where whole-second times could
not tell an entry from just before the choice from one just after it. An administrator's choice is not held to
this. The search asks root
`new-site-access` before it runs, since only root can read the switch and the
automation policies; an administrator's search asks too, for the policies.
Uploading, discarding an upload, the switch and every other WP Tools route stay
behind the gate.

The landing page follows its job through `new-site-status`, which tells a site
manager only about a job that account recorded, which is the site it just
created; any other id reads as one that does not exist. Its reply is the job's
state, step, progress and result, without the plan's upload ids or the log, for
administrators too. Only an administrator's landing page links to WordPress
Tools when something failed; a site manager's says to ask one.

`ROLE_USER` stays out: the handler refuses it and root would too. Such an
account cannot create a site in CloudPanel at all, so for that role plugins would
mean installing on an existing site of its own, a different feature with its
own refusals: root checking `user_sites` as sign-in does, and never this
form's "a site that does not exist yet".

## New sites

A new site is checked as soon as it is ready, rather than at the next 15-minute
pass. WP Tools hears four things:

1. **The site exists.** The new-site watcher runs `newSites` when CloudPanel
   commits the site's row (see [Platform](platform.md#new-sites)). WordPress
   is not installed yet, so the site goes onto the pending list.
2. **WordPress is installed.** CloudPanel installs it later in the same
   request, as root, so nothing about the installation wakes anything. The
   hook's `waiting` keeps the watcher waking on the panel's database writes
   while a pending site is still being installed. Each wake checks only those
   sites. The request ends with a write, the creation event and the PHP
   worker closing the database, and that happens even when the browser was
   closed after submitting.
3. **The certificate is installed.** CloudPanel writes
   `/etc/nginx/ssl-certificates/<domain>.crt`, which wakes the certificate
   watcher (see [Platform](platform.md#new-sites)). Connecting to MainWP needs
   that HTTPS.
4. **A WordPress Tools job ends.** Its runner looks again, so a site that waited
   for a running job of its policy is not left behind.

A site's WordPress is installed once its `wp-config.php` belongs to the site
user: one `stat`, compared with the account's uid. The installer writes
`wp-config.php` as root about 1.5 s before `wp core install` ends, so the file
existing proves nothing. After every `wp` call it runs `chown -R` over the
site's directory, and the last `wp config set` is followed by that hand-over
within 30 ms. An installation that failed is never handed over, so its site
waits out the hour. A site whose account cannot be read yet keeps waiting, up
to the same hour. Once it can, only a PHP site whose CloudPanel application is
WordPress keeps waiting; any other site leaves the list.

Root-owned `/var/lib/clp-addons/wp-tools/new-sites.json` (`0600`) holds every
domain the panel had at the last look and the sites still pending. A new site
is a domain missing from that list. The first look, and repair's upkeep
whenever the file is missing or unreadable, only records the domains there are,
so enabling or upgrading the addon does not take every site for a new one. A
panel that lists no site is taken for a bad read and changes nothing.

Each wake re-checks the pending sites and queues the checks that have become
possible, for those sites only, as background jobs: the same `varnish-check`
and `mainwp-check` the page starts, limited to them with `--domains`. Those
jobs decide as the 15-minute pass would, so locks, HTTPS readiness, WordPress
detection and enrollment are unchanged, and no wake runs site code itself.

- Varnish's check is owed while its automation is on, the site has CloudPanel's
  Varnish flag and no plugin has been seen there. MainWP's is owed while its
  automation is on, outside cleanup, for a site that is not the Dashboard, not
  one a check found to be a multisite network and not yet connected (with a
  Dashboard on another server, whose Child has not been seen yet).
- A check is possible once the site's WordPress is installed, and while the
  site still has its vhost and certificate. A site without them is being
  deleted, since CloudPanel removes both before the row.
- Each check records the readiness it was queued at: WordPress installed, and
  for MainWP the site's certificate, by its file's time and size. A check is
  queued again only when that changes. So MainWP runs again when the real
  certificate replaces the self-signed one, and a wake that changes nothing
  for a site does nothing.
- A policy that already has a job queued or running gets no second one, and
  the site is not marked as tried; that job's end looks again.

MainWP is tried once on the self-signed certificate a site starts with. Behind
Cloudflare's proxy that can already be the HTTPS the Dashboard sees, so such a
site needs no certificate. A site leaves the list when automation owes it
nothing, when it cannot be a WordPress, when neither policy is on, or an hour
after it appeared. Anything none of these reports, such as a Dashboard that was
down or WordPress installed by hand later, is the 15-minute pass's.

When no pending site is being installed, a wake costs one read of the state
file, as do a certificate renewal and a job's end with nothing pending. The
watchers, job ends and repair's upkeep take one lock of their own, so they never
interleave. The jobs they queue still wait for their policy's lock, which keeps
them from running alongside a 15-minute pass.

## Direction

A later change may let the operator choose plugins every new site gets, with
setup options for predefined ones such as CLP Varnish Cache and MainWP Child,
or per-plugin setup.
