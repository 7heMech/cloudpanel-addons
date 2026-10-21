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
into it once it has loaded. This keeps the response header size independent
of the site count and within the panel's proxy buffer. CloudPanel's Sites page
sets no policy, so its link opens a blank window.

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
This also refuses CloudPanel's Cloudflare IP range include in the same server:
otherwise every allowed edge could bypass basic auth. The parser is shared
with maintenance in `cli/nginx-config.ts`. Only a regular,
root-owned vhost that is not writable by other users can be replaced. Its mode
and ownership survive atomic replacement; credentials and other content remain.

The sign-in lock waits up to five seconds. Minting as the site user has ten
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
confirmation. It does not change global `nginx.conf` or install local trust
rules: those would also change CloudPanel's Cloudflare-only access checks and
need lifecycle handling to survive vhost regeneration and disappear when the
native allowance is removed. A native allowlist change persists through
CloudPanel's regeneration without separate addon state.

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
