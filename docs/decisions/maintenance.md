# Maintenance Mode

## Panel surfaces

Maintenance Mode is available from the Addons overview and from an
administrator-only tab in every CloudPanel site view. The overview reads every
site's saved setting, template, bypasses and Nginx coverage, and the global
state, in one `sites` action call, which reads the panel database and the state
directory once. The sites table comes first, with "N of M in maintenance" in its
header counting what visitors get. A site's custom page and bypass count are a
note under its name. Rows are selected by click or checkbox and "Turn on
selected" or "Turn off selected" switch them through one bulk route and one
`enable-many` or `disable-many` action, which reads the panel database once, so most of
the fleet can go into maintenance without the global switch; turning sites on
asks first, with their names. From six sites a search and a filter (in
maintenance, live, not covered) sit above the table. Every fleet change answers
with the redrawn fleet, which the page repaints.

Below the table one card holds the global override: a switch that decides what
visitors get for every site at once and changes nothing a site has saved, and
the global IP bypasses behind a summary that counts them. Its confirmation names
the site count and how many have maintenance saved off. While it is on, a banner
above the table says every site serves the maintenance page, and a site whose own
setting is off, or could not be read, shows a "Maintenance (Global)" badge;
turning it off returns each site to its saved setting. Turning it on or off
purges Varnish cache across the fleet. Global bypasses (up to 64) apply to every
site, including sites with their own maintenance setting on, and remain saved
when the override is off. Both bypass lists keep Save off until the list
differs from the saved one.

A site Nginx runs no check for (see Request handling) is called out rather than
drawn as in maintenance: its badge reads "Not covered" whenever its setting or
the override would put it in maintenance, the note under its name says why, the
site page carries a warning, and `clp-addons maintenance <domain> on` warns.

A domain query opens the focused page for that site, drawn in the shell's site
mode, so CloudPanel's site information and site tabs stay above it. The status
badge and the site's switch sit in the heading. It says when the global override
is what is serving the maintenance page, because changing the saved setting
there does not lift it. The badge, switch and All sites link stay together in
one row; on a narrow screen the whole row moves below the title, while a phone's
desktop view lets the description wrap beside it. IP bypasses and the maintenance
page fold into summaries ("1 bypass", "Default" or "Custom").

The maintenance page section opens on a preview. An Edit switch turns editing
on and nothing else, showing the HTML with a Preview tab beside it: turning it
off restores what is saved, asking first only when there is an unsaved change,
and never removes a saved template. Reset to default exists only while a custom
template is saved, and is the only way to remove one. A save whose HTML the
sanitizer changed says "Saved; some tags were removed".

The custom template is edited with CloudPanel's own Ace build, the editor the
panel uses for a vhost, loaded from the panel at `/assets/js/ace.min.js`. That
copy is the 1.4.2 core with no modes and only the light theme, so the addon
serves `ace/mode/html` itself from `ace/mode-html.js`, vendored unmodified from
the same 1.4.2 release and self-contained, and recolours the theme for dark mode
rather than fetch one the panel does not have. The editor is put in text mode
before the HTML mode is requested, so a mode that will not load leaves a working
editor. The textarea underneath stays the value every other path reads, and
stays the editor if a panel release stops serving Ace.

## Request handling

The addon keeps a marked check in `/etc/nginx/global_settings` for sites whose
serving server includes it (CloudPanel's http3 templates). Other sites get a
marked include of `/etc/nginx/clp-addons-maintenance.conf`, containing the same
check, in both their database `site.vhost_template` and rendered vhost. The
include goes at the start of the canonical site's port-8080 backend when present,
otherwise its main server, never the www redirect. A serving server that already
includes `global_settings` gets no additional include. `global_settings` is
optional: when it does not exist the addon neither creates it nor records a
baseline for it, still stages the includes and client-IP map, and reports a vhost
that includes the missing file as uncovered. Nginx rejects such a rendered vhost,
so with validation on the run fails with Nginx's error and rolls back. A
`global_settings` that exists but cannot be read fails validation rather than
counting as missing. A vhost that mentions `global_settings` without including it has opted out on purpose and is left
alone. A site whose vhost is untrusted or has no single serving server is
skipped, so it cannot block the others, and `clp-addons status` names it. The
same check gives the pages and the CLI their coverage: no vhost yet, a vhost that
opted out, one without the check, or one with no single serving server. Older
templates retain their existing header settings. Nginx checks
`/var/lib/clp-addons/maintenance/_global/on` and
`/var/lib/clp-addons/maintenance/$server_name/on` on requests reaching that server
block and clears
the maintenance decision when a matching `bypass_$clp_maintenance_ip` file
exists in either the global or site's directory.
CloudPanel writes the database domain first in `server_name`, so aliases share
the canonical site's state and template. Turning a site on or off is an atomic
file operation and needs no Nginx reload.

A managed HTTP-level map in `/etc/nginx/sites-enabled/00-clp-addons-maintenance-client-ip.conf`
uses CloudPanel's `/etc/nginx/cloudflare/ips` ranges to recognize the actual
connection peer. Only a request from one of those peers can use
`CF-Connecting-IP` as its bypass address. Other requests use the connection
peer, even if CloudPanel's broad real-IP setting changed `$remote_addr` from a
client-supplied header. A site CloudPanel proxies to a local backend, such as
WordPress, runs the check in that backend, whose peer is CloudPanel's own front
server; there the map takes the client from the `X-Real-IP` that server sets
from its `$remote_addr`, so on those sites a bypass is only as hard to forge as
the global real-IP trust makes it (see [System Tweaks](system-tweaks.md#forged-visitor-ips)). This map leaves CloudPanel's
`$remote_addr` and Cloudflare-only access rules untouched. Reconciliation updates the map when
CloudPanel's Cloudflare range file changes, after validating and reloading
Nginx. The path watcher monitors the range file and its directory so both
in-place writes and atomic replacements trigger reconciliation; the periodic
repair timer is a fallback. If CloudPanel has no range file, the map trusts no
proxy headers and direct connections still use their peer address.

The check returns an internal 418 sentinel and maps only that sentinel to the
public 503 maintenance response. An application's own 503 response therefore
keeps its own error handling. `/.well-known/acme-challenge/` is exempted before
the return so certificate issuance and renewal remain available.

The internal maintenance location serves a site's `maintenance.html` when present
and otherwise serves the managed `default.html`. Responses include
`Retry-After: 300`, disable caching, and apply a content security policy that
blocks scripts, forms, frames, and cross-origin assets.

The shared default is an unbranded, responsive page with neutral colors and
automatic light and dark themes. It uses system fonts, inline CSS, and a static
decorative SVG, so it needs no scripts or external assets and works under the
maintenance response's content security policy. Its copy describes maintenance
without assuming it was scheduled or promising a recovery time.

## State and privileges

The shared HTTP request IP reader converts IPv4-mapped IPv6 hosts to dotted
IPv4, so the page's current-IP shortcut and a bypass accepted during WordPress
sign-in save the IPv4 address used by the site's connection.

Only the root gateway changes maintenance state. It accepts a fixed verb set,
normalizes domains and IP addresses, checks that site-scoped domains are current
CloudPanel sites, and bounds a custom template at 256 KiB. Each bypass update
replaces the complete list for its scope and allows at most 64 addresses.
WordPress Tools adds one address to a site's list through the same locked
writer, when an administrator agrees; see [WordPress Tools](wp-tools.md).

The state root, global directory, and per-domain directories are mode `0711`,
which lets Nginx traverse a known path without listing domains or bypasses.
Per-site toggle and all bypass files are mode `0600`; the global toggle and
public HTML files are mode `0644`. Disabling or
uninstalling the addon removes the marked includes from templates and rendered
vhosts, the standalone check, the global Nginx block and the client-IP map. Site
state remains unless purge was requested.

Repair's upkeep removes the state directory of a domain CloudPanel no longer
has, so a site created again under that name starts live, with no bypasses or
template. It leaves `_global` and anything that is not a hostname's directory,
and removes nothing when the panel database cannot be read or lists no site.

## Reconciliation

The global-settings reconciler records the pristine file and its SHA-256 hash
and renders only when the unmarked content matches that baseline. Site edits
use the same transaction helpers as Cloudflare IPs: an immediate SQLite
transaction, edits to trusted regular vhosts with preserved ownership and
permissions, then `nginx -t` and a distro Nginx reload before commit. Failure rolls back the
site rows and changed Nginx files; a failed reload also attempts to reload the
restored configuration. Missing or ambiguous serving blocks leave that site
unchanged and are reported as uncovered by status. The transaction refuses a
`global_settings` or vhost that is a symlink, not a regular file or group- or
world-writable, and a vhost owned by the wrong user, without changing mode or
owner (a writable Nginx config may already be tampered with). For
`global_settings` the error names the file, the reason and the `chown` or `chmod`
that fixes it, and repair and status print it. A refused site vhost is skipped
and status lists only its domain.

Install, enable, repair and the periodic repair timer reconcile these files.
The existing path watcher also watches the site vhost directory and standalone
include. Its two-second delay lets CloudPanel commit a new site's row after
writing its vhost; periodic repair is the fallback. The database is not watched:
even a no-op write transaction emits close-write events and would retrigger
repair. Unchanged runs do not reload Nginx. Status checks both the persisted templates and rendered vhosts and reports the domains
without the check rather than claiming verification from `global_settings`
alone.
