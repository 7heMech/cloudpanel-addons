# WordPress Tools

Enable **WordPress Tools** in Addons. Its command-line name is `wp-tools`.

## Sign in

Click **Sign in** beside a WordPress site to open its first administrator's
account in a new tab. Allow pop-ups for CloudPanel. The **WP Login** shortcut
on CloudPanel's Sites page is also available to panel users for their own sites.
To clean up helpers, choose **Remove** in the **Sign-in helper on N sites** line
under the table. The next sign-in installs the helper again.

## CLP Varnish Cache

Enable Varnish for a site in CloudPanel, then open WordPress Tools. Under
**Automation**, turn on **Install CLP Varnish Cache automatically** to install and activate the
[official CLP Varnish Cache plugin](https://www.cloudpanel.io/docs/v2/frontend-area/varnish-cache/wordpress/plugin/)
on applicable WordPress sites. Automation starts off. Only actual WordPress
installations with Varnish enabled qualify; multisite networks are left alone.

Every 15 minutes the repair timer queues a background pass to install the
plugin on sites that have not had it yet. **Check now** checks every site,
applies the policy immediately and refreshes the status shown. Large fleets or
slow downloads may leave sites pending; check again to continue. The status badge
shows when it was checked.

While automation is on, each site's Varnish cell has an **Automatic** switch;
turn it off to manage that site yourself. That keeps its existing plugin
unchanged and hides installation actions for that site. **Install** also works
while automation is off.

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

If the page reports that `/var/lib/clp-addons/wp-tools/varnish.json` cannot be
read, sign-in still works. Deleting that file turns automation off and forgets
exclusions and which plugins were removed on purpose.

## MainWP Child

Under **Automation**, choose a **MainWP Dashboard**, a WordPress site on this
server with MainWP active. The table then gets a MainWP column. Turn on
**Install and connect MainWP Child automatically** to connect new sites.

Every 15 minutes the repair timer queues a background pass to install,
activate and connect MainWP Child on new WordPress sites as each site's first
administrator. No user is created and no password is changed. A site the
Dashboard cannot reach over HTTPS with a valid certificate shows **Waiting for
HTTPS** and is tried again on the next pass. A firewall, Cloudflare-only rule or
maintenance page blocks it too; allow the server's own address. **Check now**
refreshes every included site and, with automation on, connects new ones at once.

A site that already has MainWP Child shows **Connect** instead; nothing connects
it automatically. A Child connected to another Dashboard must be disconnected in
MainWP first. A Child removed after a check is never installed again
automatically; **Connect** puts it back. **Retry** repeats a failed connection.
The Dashboard's own site, multisite networks and sites whose MainWP
**Automatic** switch is off are left alone.

Turning automation off leaves every connection in place. **Turn off and clean
up…** removes what WordPress Tools added: the Dashboard records it created, with
their keys and cookies; MainWP Child where it installed it, with its settings,
tables, scheduled events and an otherwise empty uploads folder; and, on a Child
you had installed, the connection, Security ID and activation it changed. That
plugin and its other settings stay. Connections you made, or anyone made since,
are left alone. **Cleanup pending** means a site or the Dashboard needs
attention; fix it and retry. Cleanup does not undo work done through MainWP or
end WordPress sessions it opened.

Disabling or uninstalling WordPress Tools leaves MainWP connections in place;
clean up first to remove them. Both refuse while an interrupted connection's
temporary authentication setting needs recovery. Run `clp-addons repair wp-tools`
and let its background pass finish before retrying. If the page reports that
`/var/lib/clp-addons/wp-tools/mainwp.json` cannot be read, sign-in and Varnish
still work. Deleting that file turns automation off and forgets which connections
WordPress Tools made, so cleanup can no longer remove them.
