# WordPress Tools

Enable **WordPress Tools** in Addons. Its command-line name remains `wp-login`.

## Sign in

Click **Sign in** beside a WordPress site to open its first administrator's
account in a new tab. Allow pop-ups for CloudPanel. The **WP Login** shortcut
on CloudPanel's Sites page is also available to panel users for their own sites.
To clean up helpers, expand **Sign-in helpers** in the sign-in section and
choose **Remove helpers**. The next sign-in installs the helper again.

## CLP Varnish Cache

Enable Varnish for a site in CloudPanel, then open WordPress Tools. Turn on
**CLP Varnish Cache** to automatically install and activate the
[official CLP Varnish Cache plugin](https://www.cloudpanel.io/docs/v2/frontend-area/varnish-cache/wordpress/plugin/)
on applicable WordPress sites. Automation starts off. Only actual WordPress
installations with Varnish enabled qualify; multisite networks are left alone.

Sites are checked by the normal repair timer every 15 minutes. **Check sites
now** applies the policy immediately and reports failures. Large fleets or
slow downloads may leave sites pending; check again to continue. Plugin status
on the page reflects the last check, with its time available on the status badge.

Switch **Varnish tools** to **Excluded** on any site you want to manage
yourself. That keeps its existing plugin unchanged and hides installation
actions for that site. **Install Varnish** also
works for an included site while automation is off.

An existing inactive plugin is never activated automatically. A plugin removed
after a check is never installed again automatically. Use **Activate Varnish**,
**Install Varnish**, or **Retry Varnish** to make that choice explicitly. A
failed installation attempt may require Retry, even if no files were installed.

WP-CLI and the site's matching PHP command must already be installed on the
server. Use WordPress to configure the plugin and manage its updates. The addon
does not change CloudPanel's Varnish setting or the plugin's cache settings.

Turning off automatic installation stops future changes. Disabling or
uninstalling WordPress Tools removes its sign-in helper and stops automation;
the CLP plugin remains available in WordPress, where you can deactivate or
delete it. Kept addon data retains automation settings and exclusions for the
next enable.
