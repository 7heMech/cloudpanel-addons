# Redirects

## What a redirect site is

A redirect is a CloudPanel static site whose vhost answers every request with
one `return 301` or `return 302`. `redirects create` runs
`clpctl site:add:static` for it -- with the site user every addon derives from
the domain, and a generated password that is never reported, because nothing
signs in to a site that only redirects -- and then applies the redirect. No
`clpctl` command edits a vhost, so the addon does it.

Only a static site takes a redirect. Applying one replaces what the site
serves, and doing that to a PHP or reverse-proxy site would silently take an
application off the air.

## Both copies of the vhost

`site.vhost_template` in CloudPanel's SQLite database holds the text the panel
regenerates `/etc/nginx/sites-enabled/<domain>.conf` from, and its Vhost tab
edits that column. Writing only the file loses the redirect the next time
CloudPanel regenerates it -- a certificate install, a settings change -- and
writing only the column leaves Nginx serving the old text. The action writes
both inside one immediate SQLite transaction, runs `nginx -t`, reloads, and
commits only when the reload succeeds. A failure anywhere restores the file
from its in-memory backup, rolls the transaction back, revalidates and reloads,
and reports every recovery failure alongside the original error. The site
vhosts belong to the distro Nginx (`/etc/nginx`, `nginx.service`); the panel's
own instance under `/home/clp/services/nginx` does not read them, so they are
validated and reloaded with the plain `nginx -t` and `systemctl reload nginx`
that Cloudflare IP Access uses.

The vhost helpers both addons need -- the panel database handle, the trust check
that refuses a vhost which is not a root-owned unwritable regular file, the
owned atomic write, the restore and the recovery-failure wrapper -- are in
`cli/vhost-common.ts`. Two copies of "refuse an untrusted vhost" is how the two
ends of that rule drift apart.

## One marked block, after `.well-known`

The redirect is a block between `# clp-addons:redirects:start` and `:end`, so
`clear` removes exactly what `set` wrote and repair can compare the rendered
file against the column. It holds a regex location:

```
  location ~ ^/ {
    return 301 https://www.example.com$request_uri;
  }
```

Nginx tries regex locations in the order they are written and takes the first
match. The block goes directly after CloudPanel's own
`location ~ /.well-known`, which therefore still wins for ACME -- that block is
what renews the redirect site's own certificate -- while the addon's block wins
for everything else. A prefix `location /` would not have been enough: the
stock static vhost ends with a regex location for static assets, and that would
still have tried to serve `/style.css` from an empty directory. The panel's
`http` to `https` rewrite is left in place, and so is every other directive.

A vhost without that `.well-known` block is refused rather than patched: this
addon recognises CloudPanel's static template and nothing else. `clear` removes
the block, which leaves the stock static site behind, files and all.

`$request_uri` is what preserves the request path. Without it the target
receives every request at its own front page, which is why a target with a
query string is refused while the path is preserved -- the two would run
together.

## What a target may be

An absolute `http://` or `https://` URL, at most 512 characters, with no
credentials and no fragment. The serialized URL must match an allowlist that
excludes `$`, `;`, quotes, braces and whitespace: `$` is a variable to Nginx
and `;` ends the directive, so neither is escaped into a vhost -- the target is
refused instead. A target whose host is the site's own domain is refused too,
because it would redirect forever.

## Repair puts a redirect back

`/var/lib/clp-addons/redirects/redirects.json` records what the operator chose,
mode `0600` and root-owned like every other addon's state. It is written after
the site, so a site is never promised a redirect it did not get; if the record
cannot be written once the site already carries the change, the site is put back
to what the record still says, because a redirect nothing has recorded is one
`list` would not show, `clear` would refuse and repair would not keep.

One lock covers a whole operation, creation included -- the existence check, the
`clpctl` call, the vhost write and the rollback. Holding it only around the write
left the rest outside it, so a `set` arriving in between could configure the new
site and then have it deleted underneath by the create's rollback. That rollback
now stops where the record begins: once the redirect is recorded, deleting the
site would leave the record pointing at nothing. The vhost is where
that choice is applied, and CloudPanel rewrites a site's vhost whenever it
touches the site. Repair's upkeep compares the two every fifteen minutes and
re-applies a redirect that is no longer in both the column and the file, so a
certificate install does not quietly turn a redirect site into an empty one. It
reports only the sites it actually put back, and leaves a redirect whose site
has been deleted in CloudPanel alone. The addon's own page is therefore the
place a redirect is removed: an edit made in the panel's Vhost tab is drift, and
repair undoes it.

`reconcile` is not a gateway verb, for the same reason Cloudflare IP Access's is
not: it walks every redirect site and belongs to the repair path, not to a page.

## The page

One fleet page: a create form, and a table of the redirect sites with their
target, response code and whether the path is kept. A row is edited in place --
the cells swap their text for inputs, saving repaints the row from the server's
answer, and a save that changed nothing closes the row without a request. Clear
asks first, because it takes a live redirect away, and then reloads, because a
row leaves the table. The table's columns are fixed widths: sized to their text
they moved as soon as an input took one, and every domain re-wrapped around the
row being edited.

A read-only card on the panel's own site Settings tab says where that one site
sends its visitors, anchored after the Site User Settings card -- the one card
every site type has, where a static site's page would otherwise carry nothing.
The card fetches its own contents and stays hidden for a site with no redirect,
which is most of them.
