# WordPress Tools

## Why it is an addon and not a tweak

WordPress Tools groups sign-in, optional Varnish installation and optional
MainWP Child enrollment.
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

The policy, per-domain exclusions and last-check records live in root-owned
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
eligible site within 90 seconds and refreshes what the page shows. An administrator can also request an
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
lock and the pass open. Output is bounded to 64 KiB per stream, and saved
error text is a 500-character summary with control characters removed.
Per-site failures are saved and do not stop subsequent sites. The page
reads saved status without bootstrapping WordPress; it exposes the last-check
time and bounded error text. Pending sites are handled on subsequent passes.
Every Varnish route remains administrator-only; the sign-in route's role
exception does not grant plugin-management access.

The page opens with one sites table -- Site, Varnish, MainWP, Sign in -- since
sign-in is the most-used action and the one the addon started with; each
status has its Install, Activate, Connect or Retry beside it. The two
automation policies are set once, so they share one card below the table. The
page draws only controls that do something: the MainWP column and switch
appear once a Dashboard is chosen, until then the card holds only the picker; a
site's Automatic switch appears only while its policy is on; a site without
Varnish has an empty cell. A muted line under the table offers to remove the
sign-in helper while any site has it, and the shared search appears from six
sites. After any change the page fetches
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
confirmation. It installs no trust rules of its own; [System Tweaks](system-tweaks.md#forged-visitor-ips)
narrows the global trust, by default, for every site. A native allowlist change
persists through CloudPanel's regeneration without separate addon state.

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

The Dashboard is one WordPress site on this server, chosen from the same
discovery as everything else; a Dashboard elsewhere would need credentials and
network policy the addon does not manage. Child steps run as the child's site
user and Dashboard steps as the Dashboard's, through the shared WP-CLI runner.
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
queued pass after a crash, even when automation is off or the site is excluded.
Interrupted children are recovered first, within the pass budget and before
querying the Dashboard. A successful recovery is journaled as `restored`, so an
unavailable Dashboard cannot prevent disable or uninstall once authentication
is safe.
MainWP stores "use the global setting" for a new record's certificate check, so
the adapter sets it to verify. It also cuts MainWP's request timeout to 20
seconds, so registration fails inside the addon's deadline instead of being
killed half-way.

Before any change, the Dashboard's user fetches the child's HTTPS URL with
certificate verification, no redirects, a five-second timeout and a 1 KiB limit.
Anything but 200–399 is Waiting for HTTPS: no `seen`, no claim, retried on every
pass. A maintenance page or a Cloudflare-only rule is not ready either.

Root-only `/var/lib/clp-addons/wp-tools/mainwp.json`, written atomically with
mode `0600`, holds the policy, exclusions and each site's status, `seen`, and
separate plugin and connection ownership. While it owns anything it also keeps
a snapshot of the settings it may change, the Security ID until the connection
is verified or cleaned up, the Dashboard record's id and key fingerprint, and a phase written
before each step that changes the site. The page gets a projection without
snapshots, IDs or keys. Connected means the child's and the Dashboard's
public-key fingerprints match; with no claim, that connection is the operator's.

Automation installs only a Child that is absent and never seen. An installed
Child is marked seen and needs Connect, as does a site whose existing
connection or Dashboard record needs the operator. An attempt whose readback
shows nothing changed and no Dashboard record gives up its claim and is retried
on the next pass, like a failed Varnish download. Otherwise the claim stays and
Retry resumes it, undoing first its own registration the Dashboard never
recorded. A phase left by a crash is reported as interrupted, after its setting
is restored.

Cleanup acts on a child only if its key is the recorded one, comes from the
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

MainWP has its own lock, separate from Varnish and sign-in. The queued pass
looks only at unseen sites, unfinished phases, pending cleanup and retired
records, and starts sites for 25 seconds; Check now and Connect get 90. An
enrollment that has started gets up to a minute, so the budget never stops
registration part-way. A pass asks the Dashboard about at most 64 sites, least
recently checked first. A deleted site's owned Dashboard record is retired and
removed on a later pass; a deleted Dashboard took its records with it, and
cleanup then finishes on the children.

The switch only pauses automation. Disabling or uninstalling leaves the
connections, as it leaves the Varnish plugin, and refuses only while an
enrollment stopped before its temporary setting was restored. `--purge`
forgets which connections the addon made.

## Direction

A later change may let the operator pick any plugins from the WordPress.org
registry to install automatically, with setup options for predefined ones such
as CLP Varnish Cache and MainWP Child, or per-plugin setup.
