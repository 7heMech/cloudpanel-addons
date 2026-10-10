# WordPress Tools

## Why it is an addon and not a tweak

WordPress Tools groups sign-in and optional Varnish plugin installation.
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
names it and the reason. The official CLP plugin is an ordinary WordPress
plugin and remains installed when automation or the addon stops. Its updates,
settings, deactivation and deletion belong to WordPress.

## Varnish installation

The policy, per-domain exclusions and last-check records live in root-owned
`/var/lib/clp-addons/wp-login/varnish.json`, written atomically with mode `0600`.
Disabling keeps this state. Missing state means automation off; invalid state
is an error rather than a reason to reinstall plugins.

The installed addon's maintenance hook runs on the normal 15-minute repair
timer. An administrator can also request a check or an installation for one
site. Automatic checks do nothing while the policy is off. A single-site
explicit installation can run while automation is off, but still honors
exclusions and eligibility. Only PHP sites with CloudPanel's `varnish_cache`
flag and `wp-includes` plus `wp-content` on disk are eligible. The page and
installer share this discovery and eligibility calculation. A panel without
the Varnish column contributes no eligible sites. Varnish itself is never
enabled by the addon.

Fixed WP-CLI commands run through `runuser` as the resolved site account,
refusing uid 0 and reserved logins. They use the site's `php_settings.php_version`
to choose `/usr/bin/php<version>`, and the installed WP-CLI phar at `/usr/bin/wp`
or `/usr/local/bin/wp`. Neither dependency is downloaded by the addon.
Arguments never pass through a shell. The child receives only a fixed PATH,
its account's HOME and a disabled global WP-CLI config. Plugins, themes and
WP-CLI packages are skipped; WordPress still loads its config and must-use
plugins, all after dropping root. WordPress resolves the plugin directory and
activation status, supporting a customized plugin directory. Multisite is
reported as unsupported and never installed or activated.

Automation installs the fixed WordPress.org slug `clp-varnish-cache` with
`--activate` only when absent and never previously observed or attempted.
Existing active and inactive installations are left unchanged. A persistent
`seen` bit prevents reinstallation after manual removal. Installation intent
is saved before execution so interruption cannot erase that protection; an
interrupted or failed download may therefore need an explicit Retry.
Explicit installation can reinstall an absent plugin or activate an inactive
one. There is no force overwrite, plugin update or network activation.

Policy changes and each check hold a dedicated Varnish lock, so a download
does not block sign-in or helper removal. Each pass processes the least
recently checked sites first and has a 90-second budget. Each WP-CLI command
has an external timeout of at most 60 seconds and output bounded to 64 KiB per
stream. Per-site failures are saved and do not stop subsequent sites. The page
reads saved status without bootstrapping WordPress; it exposes the last-check
time and bounded error text. Pending sites are handled on subsequent passes.
Every Varnish route remains administrator-only; the sign-in route's role
exception does not grant plugin-management access.

The page groups sign-in and Varnish policy in one tools card, then lists sites.
Sign-in is the primary row action. Per-site Varnish inclusion uses the shared
switch control and does not imply that the global automation policy is on.
Helper cleanup is disclosed under sign-in rather than repeated in every row.
The fleet table uses the shared status colors and becomes labelled site cards
on narrow screens; installation confirmations match Install, Activate or Retry.

## What is in the site

A must-use plugin and a one-time secret, both owned by the site's own user.

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

The token reaches the site in a POST body, not a query string: a single-use
secret in a URL is still a secret in the site's access log and in the browser's
history. The window is opened inside the click that starts it, before anything
is awaited, because a window opened after a fetch resolves is a popup the
browser blocks.

Directories are created one level at a time and handed to the site user. A
recursive create runs as root and left a site with a `wp-content` it could no
longer write to, so a missing `wp-includes` or `wp-content` is a refusal rather
than something to invent.

The sign-in is for the site's first administrator by user id. Which
administrator an operator becomes is not a choice this offers, because the
operator is already root on the box that serves the site.

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
