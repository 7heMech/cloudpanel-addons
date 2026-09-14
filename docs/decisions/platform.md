# Platform integration

## One manager process

The compiled `clp-addons` binary contains the CLI, manager, and all addon code.
`clp-addons serve` runs as the locked `clp-addons` account and serves enabled
addons from `/run/clp-addons/manager.sock`. A config file under
`/etc/clp-addons/` enables an addon; disabling it keeps the addon's state.

CloudPanel's master Nginx vhost proxies `/addons/` to the manager socket. The
manager uses the existing `cloudpanel` session and does not create a separate
site, hostname, or login.

## Managed CloudPanel changes

Nginx and Twig changes are marked and regenerated from a saved pristine copy.
Before changing Nginx, the reconciler validates the complete configuration and
restores the original vhost if validation or reload fails. If CloudPanel changes
the surrounding file, reconciliation stops instead of applying a patch against
unknown markup.

Maintenance Mode also owns a marked block in `/etc/nginx/global_settings`.
That block is reconciled from a hashed pristine copy and validated with the
customer-site Nginx configuration before reload. Runtime site toggles only
create or remove flag files, so they do not reload Nginx.

A path unit repairs managed blocks after CloudPanel rewrites watched files. A
15-minute timer repairs service, socket, permissions, and integration drift.
CloudPanel's legacy distro Nginx layout and its separate panel Nginx layout are
detected from their files and services rather than a version string.

When Cloudflare IP Access is enabled, a separate one-minute timer applies its
new-site policy. Disabling the addon removes that timer while keeping the policy
state for a later re-enable.

## Shared interface

Every addon renders into one shell in `lib/app-ui.ts`: palette, cards, tables,
badges, switches, toolbars, one confirmation dialog and one inline notice per
page. An addon supplies its brand, its own tabs, its script and any rule only it
draws.

A page reached from a site's tab strip is drawn in site mode instead: the shell
shows CloudPanel's site information and the applicable site tabs with the addon's
tab active, and the page belongs to Sites rather than to Addons. `lib/site-context.ts`
is the only description of that strip -- order, per-type conditions and routes
mirror `Frontend/Site/Partial/tab-container.html.twig` -- and both the shell and
the injected Twig snippet read it, so a tab cannot be labelled two ways.

CloudPanel sizes that strip for the tabs it ships, so an addon's tab wrapped it
onto a second row. The manager injects one rule making the strip a single
scrollable row and letting the site-information blocks wrap, rather than
widening the panel's limited-width container, which would only postpone the
break until the next addon. The rule is injected once, and only while an
installed addon patches that partial.

## Live panel data

The manager requests current site and port information from the root gateway.
The gateway reads a consistent copy of CloudPanel's SQLite database and adds
ports recorded by addons or active listeners. Domain, site user, site type,
Varnish capability, and allocated ports cross the socket; no panel database
snapshot is stored on disk.

A site-scoped page also shows the instance address CloudPanel shows. There is no
column for it: the panel asks an external service and caches the answer for an
hour, so the gateway reads that cached value and reports nothing when it is
absent or expired. The addon then leaves the field out rather than print an
address the panel itself would not.
