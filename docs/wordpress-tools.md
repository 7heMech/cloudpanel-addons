# WordPress Tools

Enable **WordPress Tools** in Addons. Its command-line name remains `wp-login`.

## Sign in

Click **Sign in** beside a WordPress site to open its first administrator's
account in a new tab. Allow pop-ups for CloudPanel. The **WP Login** shortcut
on CloudPanel's Sites page is also available to panel users for their own sites.
To clean up helpers, choose **Remove from every site** under **Sign-in
helper**. The next sign-in installs the helper again.

## CLP Varnish Cache

Enable Varnish for a site in CloudPanel, then open WordPress Tools. Turn on
**Install CLP Varnish Cache automatically** to install and activate the
[official CLP Varnish Cache plugin](https://www.cloudpanel.io/docs/v2/frontend-area/varnish-cache/wordpress/plugin/)
on applicable WordPress sites. Automation starts off. Only actual WordPress
installations with Varnish enabled qualify; multisite networks are left alone.

Every 15 minutes the repair timer installs the plugin on sites that have not
had it yet. **Check now** checks every site, applies the policy immediately and
refreshes the status shown. Large fleets or slow downloads may leave sites
pending; check again to continue. The status badge shows when it was checked.

Turn off a site's **Automatic** switch to manage it yourself. That keeps its
existing plugin unchanged and hides installation actions for that site.
**Install** also works for an included site while automation is off.

An existing inactive plugin is never activated automatically. A plugin removed
after a check is never installed again automatically. Use **Activate**,
**Install**, or **Retry** to make that choice explicitly. A failed download is
tried again on the next pass.

WP-CLI and the site's matching PHP command must already be installed on the
server. Use WordPress to configure the plugin and manage its updates. The addon
does not change CloudPanel's Varnish setting or the plugin's cache settings.

Turning off automatic installation stops future changes. Disabling or
uninstalling WordPress Tools removes its sign-in helper and stops automation;
the CLP plugin remains available in WordPress, where you can deactivate or
delete it. Kept addon data retains automation settings and exclusions for the
next enable.

If the page reports that `/var/lib/clp-addons/wp-login/varnish.json` cannot be
read, sign-in still works. Deleting that file turns automation off and forgets
exclusions and which plugins were removed on purpose.

## MainWP Child

Choose an existing **MainWP Dashboard** WordPress on this server, then turn on
**Install and connect MainWP Child automatically**. The Dashboard plugin must
already be active. External Dashboards and multisite are unsupported. The
Dashboard must be able to reach each child's HTTPS URL with a valid certificate;
allow its address through any firewall or Cloudflare-only restriction yourself.
The addon never changes those restrictions.

Every 15 minutes, sites without a previously observed MainWP Child installation
receive the official `mainwp-child` plugin and connect to the selected Dashboard.
This includes existing WordPress sites that were never linked. **Check now**
refreshes the entire included fleet, even while automation is off. Large fleets
may need another check to finish. Sites already connected are left alone.

An existing Child plugin is never connected automatically. Use its confirmed
**Connect** button, or **Retry** after a failed or interrupted enrollment. An
existing connection to another Dashboard or an inconsistent Dashboard record
must first be resolved in MainWP. A Child removed after being seen is never
reinstalled automatically; Connect is an explicit choice to install it again.
Per-site **Automatic** switches exclude sites from enrollment without changing
existing connections. The Dashboard itself and multisite are skipped.

Connections reuse the first WordPress administrator, as sign-in does. No user
is created and no password is changed or requested. A temporary ID-based
connection setting is restored after enrollment, or on the next repair after
an interruption. A failed operation may need Retry.

The global switch only stops automation: MainWP connections remain active.
**Turn off and clean up…** stops automation and withdraws addon-owned changes.
An automatically installed Child is removed with its owned settings, reconnect
credentials, cron events and activity tables. If you explicitly connected an
existing plugin, that plugin stays and its original activation and connection
settings are restored. Its unrelated settings and scheduled work stay.
Dashboard site records, key material and stored session-cookie files created by
the addon are removed. An otherwise empty Child uploads directory created by
MainWP is removed too.
Connections that already existed before enrollment are operator-owned and
never removed. No administrator is deleted.

Cleanup is verified on both sides. **Cleanup pending** means something remains;
retry cleanup after fixing the named site or Dashboard. Repair also retries
pending cleanup. Finish cleanup before changing Dashboard or disabling or
uninstalling WordPress Tools; those operations refuse to discard managed
connections or their recovery state. Ordinary uninstall keeps non-secret policy
and `seen` records; `--purge` removes them after successful cleanup.

Cleanup cannot undo updates, content changes, backups or other work performed
through MainWP, erase historical server logs/backups, or revoke independently
issued WordPress administrator sessions. Manage those in WordPress/MainWP.
