# WordPress Sign-In

## Why it is an addon and not a tweak

It shipped as a fourth switch on [Panel Tweaks](panel-tweaks.md) and was moved
out. Everything that addon does changes what CloudPanel's own pages look like;
this writes a file into a customer's site. An operator who installed the one for
a filterable site list should not thereby have the code that can do the other on
their box, and the gateway's fixed addon-and-verb table then refuses
`panel-tweaks sign-in` rather than allowing it and checking a stored switch.

Being installed is the whole decision. There is no switch, and no state
directory: the only trace this addon leaves anywhere is a file inside a site,
and disabling or uninstalling it takes that file back out of every site it is
in. An addon that left files behind in somebody else's site would be one an
operator cannot fully withdraw.

## What is in the site

A must-use plugin and a one-time secret, both written as the site's own user.

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

The token reaches the site in a POST body, not a query string: a single-use
secret in a URL is still a secret in the site's access log and in the browser's
history. The window is opened inside the click that starts it, before anything
is awaited, because a window opened after a fetch resolves is a popup the
browser blocks.

Directories are created one level at a time and handed to the site user. A
recursive create runs as root and left a site with a `wp-content` it could no
longer write to, so a missing `wp-includes` or `wp-content` is a refusal rather
than something to invent.

The sign-in is for the site's first administrator by user id. Which
administrator an operator becomes is not a choice this offers, because the
operator is already root on the box that serves the site.

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

## Two blocks, neither required

The link and the script are separate injections into the same template because
the page has two places for them: anything put in the action cell is emitted
once per row, which suits a Twig condition and not a script. The script goes
above the table, where it is emitted once, and binds one listener to the
document rather than one per row -- the rows belong to CloudPanel, and the Panel
Tweaks filter moves them around.

Neither is `required`, so a CloudPanel release that renames the sites card or
the Manage link costs the shortcut rather than stopping the addon from being
enabled. The addon's own page signs in to the same sites either way.
