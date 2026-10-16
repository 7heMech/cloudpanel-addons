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
