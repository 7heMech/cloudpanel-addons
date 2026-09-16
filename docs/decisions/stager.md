# Stager

## Supported sites

Stager clones CloudPanel PHP and static sites. It also clones reverse proxy
sites when the backend is an Instatic instance managed by this installation.
Node.js, Python, and other reverse proxy backends are excluded.

For PHP sites, Stager copies the document root, exports and imports the first
CloudPanel database, carries the source Nginx configuration when it can be
validated, and writes the new database credentials into supported application
configuration. WordPress URLs are rewritten when WP-CLI is available. Other
applications may retain absolute source URLs in their database.

For Instatic sites, Stager creates a separate container, key, owner, and port,
then transfers pages and media through Instatic's export and import APIs. The
operator must publish the clone once to build its runtime assets. Exported
content is limited to what the supplied Instatic account can access.

## Promote

Promote is the return leg of a clone: it puts a staging site back onto the live
site it was cloned from. It is started from a finished clone record, so the two
sites are always the pair that clone produced rather than two hostnames from the
request.

A promote never overwrites the live database. The live database holds what the
site's own visitors created since the clone was taken -- orders, form entries,
comments, accounts -- and nothing in a promote can tell those apart from stale
rows. No host or staging plugin surveyed solves this by merging: they all
overwrite, whole tables at a time at best. So Stager moves files and, for an
Instatic site, content, and refuses the database outright rather than offering a
table selection that is only safe if the operator already knows the answer.

For PHP and static sites the new document root is assembled beside the live one
and put in place with a rename, so the site is never serving a half-copied tree.
The live site keeps its own `wp-config.php`, `.env` and `wp-content/uploads`:
the staging copy's are dropped before the switch, because the staging
`wp-config.php` names the staging database and pointing the live site at it
would be worse than any missed edit. Those paths are moved onto the new root
after the switch rather than copied, so a large uploads directory costs a rename
and the retained copy holds the replaced code rather than a second copy of the
user data. The live database is dumped first even though it is not written to,
because promoted code can migrate it on its first request.

For Instatic sites the staging instance's content replaces the live instance's
through Instatic's export and import APIs. The live instance's own content is
exported first and kept with the job. It keeps its container, port, key, users
and integration secrets; the operator must publish it once afterwards.

The replaced document root, the database dump and the content export are kept
with the job record and expire with it. A promote that dies between the two
renames is put back by the maintenance pass, which is also what removes the
retained roots once their records expire.

## Jobs and cleanup

Clones and promotes run in transient systemd units so they survive a manager
restart. A job records progress, logs, generated database credentials, and any
action the operator still needs to take. Records expire after 14 days. Instatic
credentials are kept only until authentication and are removed on success or
rollback.

On failure, a clone removes the site, database, temporary vhost template, and
Instatic instance it created, and a promote puts the live document root back.
The maintenance pass marks interrupted jobs as failed, restores an interrupted
vhost change or an interrupted promote, and removes expired records and the
document roots a promote replaced.

Stager does not delete completed staging sites. Delete them from CloudPanel's
site settings when they are no longer needed.
