# Maintenance Mode

## Panel surfaces

Maintenance Mode is available from the Addons overview and from an
administrator-only tab in every CloudPanel site view. The overview reads the
live CloudPanel site inventory and shows each site's effective status, saved
setting, template choice, and bypass count. At phone widths it omits the
template-choice and bypass-count fields; both remain available on the site's
detail page and in the desktop overview. Effective status and the saved
per-site setting share one row in each mobile site card.

The global override is a card of its own labelled "Global maintenance", not a
switch in the table header: it decides what visitors get for every site at once
and changes nothing a site has saved. Its confirmation names the site count and
how many have maintenance saved off. While it is on, sites covered by the Nginx
check serve 503 and a
site whose own setting is off, or could not be read, shows a "Maintenance
(Global)" badge and is counted as in maintenance; turning it off returns each
site to its saved setting. Turning it on or off purges Varnish
cache across the fleet. A card below it saves up to 64 global IP bypasses. Each
one applies to every site, including sites with their own maintenance setting
on, and remains saved when the global override is off. Site bypasses continue
to apply to their own site. Both bypass lists keep Save off until the list
differs from the saved one.

A domain query opens the focused editor for that site. That page is drawn in the
shell's site mode, so CloudPanel's site information and site tabs stay above it
and Settings remains one click away; it says explicitly when the global override
is what is serving the maintenance page, because changing the saved setting
there does not lift it.

The template opens read-only. An Edit switch above the editor turns editing on
and nothing else: turning it off restores what is saved, asking first only when
there is an unsaved change, and never removes a saved template. Removing one is
the reset button alone.

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
includes `global_settings` gets no additional include. A vhost that mentions
`global_settings` without including it has opted out on purpose and is left
alone. A site whose vhost is untrusted or has no single serving server is
skipped, so it cannot block the others, and `clp-addons status` names it. Older
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
CloudPanel's own real-IP setting makes it. This map leaves CloudPanel's
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
WordPress Sign-In adds one address to a site's list through the same locked
writer, when an administrator agrees; see [WordPress Sign-In](wp-login.md).

The state root, global directory, and per-domain directories are mode `0711`,
which lets Nginx traverse a known path without listing domains or bypasses.
Per-site toggle and all bypass files are mode `0600`; the global toggle and
public HTML files are mode `0644`. Disabling or
uninstalling the addon removes the marked includes from templates and rendered
vhosts, the standalone check, the global Nginx block and the client-IP map. Site
state remains unless purge was requested.

## Reconciliation

The global-settings reconciler records the pristine file and its SHA-256 hash
and renders only when the unmarked content matches that baseline. Site edits
use the same transaction helpers as Cloudflare IPs: an immediate SQLite
transaction, edits to trusted regular vhosts with preserved ownership and
permissions, then `nginx -t` and a distro Nginx reload before commit. Failure rolls back the
site rows and changed Nginx files; a failed reload also attempts to reload the
restored configuration. Missing or ambiguous serving blocks leave that site
unchanged and are reported as uncovered by status.

Install, enable, repair and the periodic repair timer reconcile these files.
The existing path watcher also watches the site vhost directory and standalone
include. Its two-second delay lets CloudPanel commit a new site's row after
writing its vhost; periodic repair is the fallback. The database is not watched:
even a no-op write transaction emits close-write events and would retrigger
repair. Unchanged runs do not reload Nginx. Status checks both the persisted templates and rendered vhosts and reports the domains
without the check rather than claiming verification from `global_settings`
alone.
