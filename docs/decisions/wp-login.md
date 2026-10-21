# WordPress Sign-In

## Why it is an addon and not a tweak

[Panel Tweaks](panel-tweaks.md) changes how CloudPanel's own pages look; this
addon writes a file into a customer's site. Installing the one should not
authorize the other. WordPress Sign-In therefore has its own installation
choice and fixed gateway addon-and-verb entry.

Being installed is the whole decision. There is no switch, and no state
directory: the only trace this addon leaves of its own is a file inside a site,
and disabling or uninstalling it takes that file back out of every site it is
in. An addon that left files behind in somebody else's site would be one an
operator cannot fully withdraw. A site whose files cannot be deleted does not
stop the ones after it; the withdrawal names it and the reason. A maintenance
bypass an administrator accepted while signing in belongs to Maintenance Mode:
it stays in that site's bypass list until removed there. A basic-auth IP bypass
belongs to CloudPanel's Security settings and stays there until removed.

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
into it once it has loaded. A policy on the addon's page listing every site
would outgrow the 4 KiB response header the panel's Nginx buffers at about a
hundred sites. CloudPanel's Sites page sets no policy, so its link opens a
blank window.

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

## A site protected by basic authentication

CloudPanel links `site.basic_auth_id` to `basic_auth`. Its `is_active` and
comma-separated `whitelisted_ips` fields decide whether the browser needs a
bypass; the sign-in never reads the basic-auth username or password. Existing
IP addresses and CIDR networks are honored, including IPv6. Request addresses, including CLI input, normalize mapped IPv4 to dotted IPv4
before either sign-in gate sees them, so Basic Authentication and Maintenance Mode save the
same IPv4 address. Native allowlist updates also convert mapped single-host
entries, preserving CIDRs and matching the original vhost block before rewriting
it. Mapped IPv6 hosts and networks do not count as effective IPv4 allowances until
an administrator approves an IPv4 entry; duplicate normalized hosts are saved
once.
This gate is in Nginx, before WordPress: without a bypass the browser must answer its HTTP
basic-auth challenge, and the one-minute token can expire while it does so.

An administrator whose address is not allowed receives a separate confirmation
before any token is minted. It explains that allowing the address bypasses basic
authentication for the whole site and everyone sharing that address, until
removed in Security → Basic Authentication. The exemption includes both
`/wp-login.php` and `/wp-admin/`, so it also covers the redirect after sign-in.
CloudPanel's `/.well-known` location already disables basic auth. A password
prompt cannot deliver the expected password-free panel sign-in; credentials in
URLs, HTML or process arguments would expose the site's reusable password.

Acceptance updates CloudPanel's existing `whitelisted_ips` list and its rendered
vhost with the native `satisfy any`, `allow` and `deny all` directives. There is
no separate bypass rule, credential store or public sign-in endpoint. The
remaining vhost is preserved. A customized or ambiguous basic-auth block is
refused with a pointer to the native Security page rather than rewritten.
Only a regular, root-owned vhost that is not writable by other users can be
replaced; symlinks are refused. Ownership and mode survive atomic replacement.

Under the sign-in lock, the action first mints as the site user, without holding
CloudPanel's database write lock. The database write transaction covers only the
allowlist and vhost update, Nginx validation and reload.
The trusted-vhost checks, owned atomic replacement, restoration, Nginx recovery
and error collection are shared with Cloudflare IP Access in `cli/nginx-transaction.ts`.
A reload only signals the master, so the action waits up to five seconds for
active workers from the new generation and for the old workers to stop accepting
requests, reading `/run/nginx.pid` and `/proc`. Only then is the token returned to
the browser. Validation or reload failures restore the database and vhost;
reload failures also reload the restored configuration. Recovery failures are
reported. A token written before a later failure expires after its normal
minute. Maintenance bypasses are added after the basic-auth transaction commits,
so they do not extend its database lock. If that later operation fails, the
accepted basic-auth allowance remains in CloudPanel's Security settings.
When both gates block the browser, each needs its own confirmation, and neither
changes during preflight.

`--allow-basic-auth` is distinct from `--add-bypass`, so consenting to lift
maintenance does not also lift basic auth. Both flags require a known request
address and reject `--as-user` root-side, including site managers. Other panel
users receive an explanation and may sign in once their address is already
allowed; site ownership checks still apply. The address has the same forwarded
address and IPv4/IPv6 limitations described above for maintenance. No background
probe adds the server's own address to an allowlist.

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
