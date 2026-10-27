# WordPress Tools

Enable **WordPress Tools** in Addons. Its command-line name is `wp-tools`.

## Sign in

Click **Sign in** beside a WordPress site to open its first administrator's
account in a new tab. Allow pop-ups for CloudPanel. The **WP Login** shortcut
on CloudPanel's Sites page and beside the domain at the top of each site's pages
is also available to panel users for their own sites.
To clean up helpers, choose **Remove** in the **Sign-in helper on N sites** line
under the table. The next sign-in installs the helper again.

## CLP Varnish Cache

Enable Varnish for a site in CloudPanel, then open WordPress Tools. Under
**Automation**, turn on **Install CLP Varnish Cache automatically** to install and activate the
[official CLP Varnish Cache plugin](https://www.cloudpanel.io/docs/v2/frontend-area/varnish-cache/wordpress/plugin/)
on applicable WordPress sites. Automation starts off. Only actual WordPress
installations with Varnish enabled qualify. On a multisite network the plugin
is network-activated, which covers every site in it.

Every 15 minutes the repair timer queues a background pass to install the
plugin on sites that have not had it yet. **Check now** checks every site and
refreshes the status shown; with automation on it also installs where the
policy says to, with it off it changes nothing. A site shows **Install** or
**Activate** only once a check has found the plugin missing or inactive. The
status badge shows when it was checked.

Checks, installs and MainWP connections run in the background with a progress
bar under the table. You can keep using the page, or leave and come back; the
progress is still there. When the job ends the table updates and a message
says what happened. A job stops starting sites after about an hour; check again
to continue.

An existing inactive plugin is never activated automatically. A plugin removed
after a check is never installed again automatically, so removing it in
WordPress keeps that site out. Use **Activate**, **Install**, or **Retry** to
make that choice explicitly; they also work while automation is off. A failed
download is tried again on the next pass.

WP-CLI and the site's matching PHP command must already be installed on the
server. Use WordPress to configure the plugin and manage its updates. The addon
does not change CloudPanel's Varnish setting or the plugin's cache settings.

Turning off automatic installation stops future changes. Disabling or
uninstalling WordPress Tools removes its sign-in helper and stops automation;
the CLP plugin remains available in WordPress, where you can deactivate or
delete it. Kept addon data retains automation settings for the next enable.

If the page reports that `/var/lib/clp-addons/wp-tools/varnish.json` cannot be
read, sign-in still works. Deleting that file turns automation off and forgets
which plugins were removed on purpose.

## MainWP Child

Under **Automation**, choose a **MainWP Dashboard**, a WordPress site on this
server with MainWP active. The table then gets a MainWP column. Turn on
**Keep every site connected to MainWP** to connect every WordPress site to it
and keep it connected. For a Dashboard on another server, see below.

Every 15 minutes the repair timer queues a background pass that installs,
activates and connects MainWP Child on each WordPress site as its first
administrator. No user is created and no password is changed. A Child connected
to another Dashboard is moved to this one, and one deactivated, disconnected or
deleted is put back; a site the Dashboard already lists keeps its record, groups
and notes. A must-use plugin, `clp-addons-mainwp.php`, hides MainWP Child from
the site's Plugins list and stops its administrators deactivating or
disconnecting it. A site the Dashboard cannot reach over HTTPS with a valid
certificate shows **Waiting for HTTPS** and is tried again on the next pass. A
firewall, Cloudflare-only rule or maintenance page blocks it too; allow the
server's own address. **Check now** refreshes every site and, with automation
on, connects them at once.

With automation off, a site is connected only when you choose it: **Connect** on
its row, or tick several and choose **Connect selected to MainWP**, or **Connect
all unconnected**. These also move a Child from another Dashboard. Sites already
connected are left as they are. **Retry** repeats a failed connection. The
Dashboard's own site and multisite networks are left alone.

Turning automation off leaves every connection in place, and the next passes
take the must-use plugin out. **Turn off and clean up…** removes what WordPress
Tools added: the Dashboard records it created, with their keys and cookies;
MainWP Child where it installed it, with its settings, tables, scheduled events
and an otherwise empty uploads folder; and, on a Child you had installed, the
connection, Security ID and activation it changed. That plugin and its other
settings stay; a Child taken from another Dashboard is left disconnected, not
handed back. Connections you made, including Dashboard records it reconnected,
or anyone made since, are left alone, though a Child it installed for one is
removed. **Cleanup pending** means a site or the
Dashboard needs attention; fix it and retry. Cleanup does not undo work done
through MainWP or end WordPress sessions it opened.

Disabling or uninstalling WordPress Tools leaves MainWP connections in place and
removes the must-use plugin; clean up first to remove the connections. Both refuse while an interrupted connection's
temporary authentication setting needs recovery. Run `clp-addons repair wp-tools`
and let its background pass finish before retrying. If the page reports that
`/var/lib/clp-addons/wp-tools/mainwp.json` cannot be read, sign-in and Varnish
still work. Deleting that file turns automation off and forgets which connections
WordPress Tools made, so cleanup can no longer remove them.

### A Dashboard on another server

Choose **On another server** as the **MainWP Dashboard**, then turn on **Install
MainWP Child automatically**. Every 15 minutes, sites that have never had MainWP
Child get it installed but left inactive: MainWP Child turns itself off when no
Dashboard connects within its connection timeout, 20 minutes unless changed in
its settings. To connect a site, click **Activate** (or **Install**) beside it,
then add it in your MainWP Dashboard with the site's administrator username and
password. **Check now** then shows it **Connected**. WordPress Tools never
contacts that Dashboard, so it must reach the site over HTTPS on its own; allow
it through any firewall or Cloudflare-only rule.

**Turn off and clean up…** deletes the MainWP Child plugins WordPress Tools
installed and deactivates any it activated, except on sites a Dashboard has
connected since.
