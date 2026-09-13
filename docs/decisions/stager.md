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

## Jobs and cleanup

Clones run in transient systemd units so they survive a manager restart. A job
records progress, logs, generated database credentials, and any action the
operator still needs to take. Records expire after 14 days. Source Instatic
credentials are kept only until authentication and are removed on success or
rollback.

On failure, Stager removes the site, database, temporary vhost template, and
Instatic instance it created. The maintenance pass marks interrupted jobs as
failed, restores an interrupted vhost change, and removes expired records.

Stager does not delete completed staging sites. Delete them from CloudPanel's
site settings when they are no longer needed.
