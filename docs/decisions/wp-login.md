# WordPress Tools

## Why it is an addon and not a tweak

WordPress Tools groups sign-in, optional Varnish installation and optional
MainWP Child enrollment.
[Panel Tweaks](panel-tweaks.md) changes what CloudPanel's own pages look like;
this addon writes into a customer's site. An operator who enables a filterable
site list does not thereby authorize those actions, and the gateway's fixed
addon-and-verb table refuses
`panel-tweaks sign-in` rather than allowing it and checking a stored switch.

The stable identifier, command-line name, config file and mount remain
`wp-login`, preserving installed sign-in behavior and injected links. Sign-in
is available whenever the addon is enabled. Automatic Varnish installation is
a separate opt-in policy, off when no settings exist.

Disabling or uninstalling removes the sign-in helper from every site it is in.
A site whose files cannot be deleted does not stop the ones after it; withdrawal
names it and the reason. A maintenance bypass an administrator accepted while
signing in belongs to Maintenance Mode: it stays in that site's bypass list
until removed there. The official CLP plugin is an ordinary WordPress
plugin and remains installed when automation or the addon stops. Its updates,
settings, deactivation and deletion belong to WordPress.

## Varnish installation

The policy, per-domain exclusions and last-check records live in root-owned
`/var/lib/clp-addons/wp-login/varnish.json`, written atomically with mode `0600`.
Disabling keeps this state. Entries for a domain the panel no longer has are
dropped, so a recreated site starts fresh. Missing state means automation off;
invalid state is an error rather than a reason to reinstall plugins. The page
then shows that error in place of the Varnish controls and still offers
sign-in.

The installed addon's maintenance hook runs on the normal 15-minute repair
timer, inside repair's operation lock, so it checks only sites automation can
still act on: no record yet, or a plugin not yet seen. It has a 30-second
budget. **Check now** checks every eligible site within 90 seconds and
refreshes what the page shows. An administrator can also request an
installation for one site. Automatic checks do nothing while the policy is off. A single-site
explicit installation can run while automation is off, but still honors
exclusions and eligibility. Only PHP sites with CloudPanel's `varnish_cache`
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
it. Multisite is
reported as unsupported and never installed or activated.

Automation installs the fixed WordPress.org slug `clp-varnish-cache` with
`--activate` only when absent and never previously observed or attempted.
Existing active and inactive installations are left unchanged. A persistent
`seen` bit prevents reinstallation after manual removal. Installation intent
is saved before execution so interruption cannot erase that protection; an
interrupted run therefore needs an explicit Retry. A command that fails
outright put nothing there, so its intent is undone and the next pass retries.
Explicit installation can reinstall an absent plugin or activate an inactive
one. There is no force overwrite, plugin update or network activation.

Policy changes and each check hold a dedicated Varnish lock, so a download
does not block sign-in or helper removal. Each pass processes the least
recently checked sites first within its budget. Each WP-CLI command
runs under `timeout` for at most 60 seconds, and root kills it and stops
reading a few seconds later whatever is left: `wp-config.php` is the site's
code, and a process it detaches could otherwise hold the pipes, the Varnish
lock and the repair run open. Output is bounded to 64 KiB per stream, and saved
error text is a 500-character summary with control characters removed.
Per-site failures are saved and do not stop subsequent sites. The page
reads saved status without bootstrapping WordPress; it exposes the last-check
time and bounded error text. Pending sites are handled on subsequent passes.
Every Varnish route remains administrator-only; the sign-in route's role
exception does not grant plugin-management access.

The page follows the Cloudflare IPs layout: a policy card for automatic
installation, the fleet table, then a helper card when any site has the helper.
Per-site inclusion is a switch and does not imply that the global policy is on.
Sign-in is the primary row action. After any change the page fetches
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
from the action, so both pages that sign in say the same thing. On the panel's
Sites page it is shown in CloudPanel's own Bootstrap modal, as are failures.

A browser that reaches the panel over IPv4 and the site over IPv6 is still
turned away after the bypass, as it would be after adding the address by hand.
The panel's Nginx takes forwarded addresses from any peer, so the address is
the one the browser claims; a browser that forges it only misleads itself,
since anything it could add is a bypass an administrator could add by hand.

## Two answers to "which sites are WordPress"

The addon's own page asks the disk: a site is WordPress when its root holds
`wp-includes` and `wp-content`. That is what the sign-in itself checks, so the
list and what will actually work are the same set, and a WordPress installed
under the Generic vhost template is in it.

The link on CloudPanel's Sites page cannot ask the disk. It is inside the
template's site loop, so its condition has to be Twig, and what Twig has is the
`application` column -- which for a PHP site is the vhost template the site was
created from. So the link appears for the WordPress-family templates the panel
ships and the action refuses anything that turns out not to be one, the same
bargain the Stager addon's own site-list condition made. The complete list is
the addon's page; the link is the shortcut for the common case.

## Every role that can see the site

The link is not administrator-only. CloudPanel lists a `ROLE_USER` only the
sites `user_sites` maps to their account, and that account already has the site
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

Two things follow from the link living on a page this addon did not render. The
manager's blanket administrator gate has to name the sign-in route as an
exception, which `docs/decisions/security.md` describes; and the browser may
hold no CSRF cookie, because the only responses that set one are addon pages a
non-administrator cannot open. So the script fetches `/api/session` -- which
reads nothing and answers with the cookie and its token -- but only when there
is no token to send.

## Two blocks, neither required

The link and the script are separate injections into the same template because
the page has two places for them: anything put in the action cell is emitted
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

Neither is `required`, so a CloudPanel release that renames the sites card or
the Manage link costs the shortcut rather than stopping the addon from being
enabled. The addon's own page signs in to the same sites either way.

## MainWP enrollment

MainWP shares the hardened site-user WP-CLI runner with Varnish. Its fixed PHP
adapter receives bounded JSON over stdin, explicitly loads only the MainWP code
needed after privileges have been dropped, and emits a marked JSON reply.
Secret-bearing commands never preserve raw PHP or WP-CLI error output. The
browser receives a projected view containing status and ownership booleans,
never baseline settings, Security IDs or connection keys. Listing the page
never boots WordPress. Sign-in is independent of MainWP state and locks.

A single existing local Dashboard is selected by domain from the same safe site
discovery. Its MainWP plugin must be active; the adapter runs as its Unix user
and uses its first WordPress administrator. Child sites use their first
administrator too. No accounts or passwords are created or changed. The native
Dashboard PHP handler initiates registration and generates/stores the keys.
HTTPS verification is enabled for registration and explicitly persisted for the
new Dashboard record. Existing foreign connections and inconsistent Dashboard
records are refusals, not takeover requests. External Dashboards are excluded.

The root-only atomic `mainwp.json` stores policy, exclusions, `seen`, separate
plugin and connection ownership, and enrollment/cleanup recovery. Automatic
installation applies to missing, never-seen Child plugins on existing or new
WordPress sites. Installed plugins require a confirmed row Connect. Matching
public-key fingerprints on the child and selected Dashboard mean Connected;
without an enrollment journal these are operator-owned. The Dashboard itself,
multisite, exclusions and manually removed plugins are not automated.

Before any installation the journal records the original activation, Child
options, relevant administrator metadata, cron events and activity-table
presence. Installation of an absent plugin owns that plugin. Connecting an
existing plugin owns only the new connection and the changes needed to create
it; cleanup restores its original activation and connection settings. Existing
connections are never adopted. An existing plugin and its unrelated options,
cron work and tables are never deleted. Root records are the ownership authority;
site data can only confirm or contradict them. A changed connection fingerprint
stops cleanup rather than removing the replacement.

A strong per-site Security ID is provisioned before activation. Password-based
bootstrap is temporarily disabled for the chosen administrator, with the original
setting journaled before the change. Restoration runs in finally and before
recovering an interrupted operation, even when automation is off. An enrollment
interrupted after registration can recognize its own Security ID and matching
key pair without adding another Dashboard record. An orphaned registration with
no Dashboard record can be reset only from that enrollment's journal on explicit
Retry. Failures preserve intent and require row Retry; repair restores temporary
authentication settings without repeatedly attempting enrollment.

The MainWP lock is independent of Varnish and sign-in. Repair checks only unseen
eligible sites, interrupted authentication restoration and pending cleanup, with
a 25-second work budget plus at most a 10-second authentication-restoration
command. Check now and explicit actions have a 90-second work budget. At most 64 site statuses are requested per pass to keep the Dashboard reply
bounded; unfinished sites rotate by last-check time. Deleted panel domains are pruned from the fleet
and exclusions; owned Dashboard connections enter a small retirement queue until
they can be removed, without retaining site paths or secrets.

The global switch pauses enrollment without removing anything. Confirmed
cleanup first disables enrollment, withdraws local access and restores owned
site artifacts, then removes the owned Dashboard record through MainWP's native
removal path, including its key file, session-cookie jar and site-related records. An empty
Child uploads directory created during enrollment is removed. The child path
verifies settings, plugin presence, cron and table restoration; the Dashboard
path verifies record absence. Failed cleanup keeps its journal and remains
pending. Lifecycle removal holds the MainWP lock and refuses while ownership or
cleanup remains, before changing units/configuration or purging state. Operator
connections and the existing Dashboard plugin and shared cron remain. Cleanup
is withdrawal, not a rollback of management actions or existing WP sessions.
