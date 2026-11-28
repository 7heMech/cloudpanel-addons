# Instatic CMS

## Panel access

Administrators and site managers can create and manage Instatic sites. The addon
declares `siteManager` in its catalog definition, admitting that role to its
whole mount, including lifecycle actions and job pages. CloudPanel gives site
managers access to every site, so the instance list is not scoped per account.
Ordinary users cannot enter the addon, and its New Site tile names only the two
allowed roles in Twig. The addon header omits Addons and Admin Area links for a
site manager; the dashboard and its New site button stay available.

Job streams recheck the same roles against the active CloudPanel account every
15 seconds. Expiry, deactivation, or demotion to an ordinary user closes the
stream. Installation and addon settings remain on the administrator's manager
pages. Image selection is limited to exact versions of the fixed Instatic
registry image; callers cannot supply container commands or mount paths.

Lifecycle actions and deletion return dashboard HTML from the same renderer as
the first load, and the page repaints in place and reports the outcome. An
update is a job, like a creation: one update opens its job page, which streams
the log, including a rolled-back update's container output. Sites can be
selected and updated to the latest version or restarted together; each update
is its own job. While any job runs, the dashboard fetches itself again every
four seconds, and an updating row shows its step and cannot be selected. A
failed update is named on its row until another replaces it. From six sites
the shared search has filters for update available, not running and version,
and every heading sorts. A finished job
repaints its result view. A site's name is plain text, so clicking it selects
the row like the rest of it; Manage starts with Open admin and Visit site and
opens a menu. A phone has no menu: Update, Stop or Start, Snapshot, Logs and
Delete sit in the row, with Recreate for a site not yet on the mail network,
and the rest stay on a wide screen.

The dashboard reads instances, jobs and registry tags in parallel. A
creation that is queued, running, or failed with no instance to show for it is a
row at the top, linking to its job page. An instance is deleted from the panel
when the action's `list` says `panelSite: false`; such a row offers only Logs and
Delete. Update appears only when the registry has a newer version and offers only
newer versions. When ghcr.io cannot be reached, Update is disabled and no tag is
called the latest; the failure is remembered for a minute, so repaints do not each
wait out the 8 s timeout. Delete asks for the domain to be typed, and removes the
CloudPanel site only when the addon created it. The New site form reads only the
tag list: the port is chosen when the site is created. Its Back link returns to
CloudPanel's site chooser (`/site/new`) when entered through the New Site tile,
which adds `?from=new-site` to the form URL. Otherwise it returns to the Instatic
dashboard. The query selects between these two fixed destinations and survives
a reload.

A creation job records `certificate` (`issued`, `failed` or `none`), and a failed
request is a warning on the job page; records from 1.5.x, without it, keep the
old wording. The creation log lives with the job record and expires with it.

## Instance model

Each site is a CloudPanel reverse proxy backed by a Docker container bound to
`127.0.0.1`. The action accepts exact image versions and records the domain,
port, version, site user, and ownership of the CloudPanel site under
`/var/lib/clp-addons/instatic/`.

An existing CloudPanel site is adopted only when it is already a reverse proxy
to the requested local port. The panel hostname itself is always rejected.

A site the addon creates gets the site user CloudPanel's own New Site page
would have suggested: the registrable label, then any subdomain labels in the
order they are written, so `the.staging.example.com` becomes
`example-the-staging`. The panel reads the registrable label off the public
suffix list and ignores a bare `www`, so `www.example.co.uk` is `example`.
Hyphens within domain labels are preserved, so `example-blog.com` is
`example-blog`. Recognizable names make sites easy to identify beside sites
the panel named itself. CloudPanel allows one site per site
user, so where two domains want the same name -- they differ only in their TLD
-- the next free `-2`, `-3` is taken instead.

The addon resolves suffixes with the pinned `tldts` package, including private
suffixes, wildcard rules and exceptions. Its list is bundled into the binary;
site creation needs no network lookup. Updating `tldts` updates that snapshot.
An unlisted suffix uses the final domain label, and all preceding subdomain
labels are retained. Names are limited to 32 characters and prefixed with `s`
when they do not start with a letter.

## Docker dependency

Instatic declares `requiresUnits: ["docker"]` (`addons/instatic/addon.ts`).
`clp-addons enable instatic` -- whether run from the CLI, the menu or the
Addons UI -- provisions Docker itself when it is missing: download
`get.docker.com` and run it, then `systemctl enable --now docker`
(`ensureRequiredUnits` in `cli/provision.ts`). Enabling instatic
never fails just because Docker was never installed; it only fails if that
provisioning itself does not bring the unit up.

Upstream publishes `ghcr.io/corebunch/instatic` for `linux/amd64` only, so
Instatic declares `supportedArches: ["x64"]`: an arm64 box cannot enable it and
does not list it.

## Email

Instatic's SMTP connector takes a host, port and optional login. SMTP Relay
knows a site by the Unix login postdrop records, which a container's SMTP
connection does not carry, so the addon bridges the two
(`addons/instatic/mail-bridge.ts`, `addons/instatic/mail.ts`):

- Containers run on the `clp-instatic` Docker network, whose bridge interface
  has the same name and which keeps containers from reaching each other, with `--add-host smtp-relay:<gateway>` and
  `MAIL_ALLOW_PRIVATE_HOSTS=1`, which lets Instatic use a private address,
  without a login or STARTTLS. Instatic still refuses an IP literal without
  it. Containers started before the network existed join it when they are
  updated or recreated; the dashboard names them.
- `clp-addons-instatic-mail.socket` listens on the gateway's port 2525 (Postfix
  holds 25 on every address) with `Accept=yes`, and each connection runs
  `clp-addons instatic-mail` as root, for at most ten minutes. The listener knows the container by its
  source address on that network, and accepts it only when it is an
  `instatic-<domain>` container with an instance record, labelled
  `clp-addon=instatic`, and running as that domain's site user now. Any
  other address is refused at the greeting. A host process cannot borrow a
  container's address: the replies go to the container.
- Each message goes to `/usr/sbin/sendmail -i -f <sender> -- <recipients>`
  through `runuser` as the site user (`deliverAsSite` in
  `addons/smtp/submit.ts`), so Postfix holds it to the site's senders and
  routes it like the site's PHP mail. When SMTP Relay has a From rule for the
  site, the From is rewritten as `smtp-submit` would. A site whose rule has no
  From, one SMTP Relay does not relay, loses an envelope sender outside its
  domains. With no rule, as with SMTP Relay off, the sender is passed as given
  and the mail is ordinary local Postfix mail. Sendmail's temporary failure (75) answers
  451; any other failure 554.
- ufw drops container traffic to the host, and CloudPanel's Firewall page
  rebuilds ufw, so the `firewall` hook adds
  `allow in on clp-instatic to <gateway> port 2525 proto tcp` again after each
  rebuild. Repair and enabling restore the units and the rule once the network
  exists; disabling removes them and leaves the network to its containers.

After a create, update or recreate passes its health check, `docker exec`
runs a script in the container, as the site user, against Instatic's SQLite
database. If Instatic has mail tables and neither a connector nor mail
defaults, the script adds a login-free SMTP connector for `smtp-relay:2525`,
the row Instatic's own form writes, and makes it the default sender as
`noreply@<domain>`. The instance record then keeps `mailConnected`, set too
when the mail setup was already there, so a connector the admin removes is not
added again. An Instatic without mail tables is tried again at the next
update. A restore from backup brings its own mail setup.

`MAIL_ALLOW_PRIVATE_HOSTS` also lets an Instatic admin point a connector at
other private addresses: the server's own services that ufw lets the network
reach, and the rest of the server's private networks. A connector only speaks
SMTP, so that is a port probe, not a way in.

## Storage and replacement

The live SQLite database and environment file are outside the document root at
`/home/<site-user>/instatic/<domain>/`; uploads stay under the site's `htdocs`
directory. This lets CloudPanel back up the complete application while keeping
private files out of the web root.

The site's user owns every directory above that storage and can swap any of
them for a link, so root never acts on it by path. `lib/no-follow.ts` opens
each directory one component at a time without following links, and root then
copies, removes, `chmod`s and `chown`s through the open descriptor
(`/proc/<pid>/fd/<n>`). SQLite opens the database, its WAL and its shared
memory by name, so a backup checks that every file SQLite opened is one of
those three in the held data directory before copying anything. Snapshots are
assembled in the instance's root-owned state directory and only the finished
archive is moved into the site's `backups` directory.

Update and recreate take a clean local snapshot before replacing the container.
The recorded data and encryption key are retained, and a failed health check
restores the previous version. The check needs a 2xx or 3xx from the container
itself, then a 2xx, 3xx, 401, 403 or 503 through Nginx: a site that
allows Cloudflare only refuses the server's own address with 403, and maintenance
mode answers 503, before the request is proxied. User-created snapshots are a five-file rolling
window. Deletion writes a separate final archive and does not prune earlier
deletion archives.

## CloudPanel Remote Backups

A scheduled recovery archive combines a consistent SQLite copy, the encryption
key, and instance metadata. It is written atomically into the site user's home
so CloudPanel Remote Backups can capture it with uploads. Recovery is explicit
through `recreate --from-backup`; ordinary recreate always uses live data.

Database and uploads are captured at different times, so the Remote Backup is
not a single point-in-time application snapshot. See the operator steps in
[Back up and restore Instatic](../instatic-backups.md).
