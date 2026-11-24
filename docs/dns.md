# DNS

DNS keeps each site's Cloudflare records to a profile, and can set the site's
domain up in Mailcow. It also serves redirect domains. Enable **DNS** under
Addons, or run `clp-addons enable dns`.

## Set up

Until Cloudflare is connected, the DNS page opens with a first-run setup card.
Once connected, the page splits into **Sites**, **Redirects**, **Profiles**,
**Settings**, and **Activity**.

1. **Connect Cloudflare.** Open DNS and choose **Connect Cloudflare**. **Create
   token in Cloudflare** opens Cloudflare's token form. Check the permissions
   listed beside the link are there. Pick the accounts and zones there, limit
   it to the server addresses shown under Client IP Address Filtering using the
   clipboard icon, create the token, and paste it back. DNS finds the accounts
   and zones it reaches by itself. Add more connections under **Settings** for
   other Cloudflare logins.
2. **Mailcow, if you use it.** Open **Mailcow** under **Settings** and set
   Mailcow's hostname, such as `mail.example.com`, a read-write API key limited
   to this server's IP in Mailcow, how new domains get a DKIM key, and
   optionally a shared mailbox. If SMTP Relay already sends through Mailcow,
   **Fill from SMTP Relay** takes its hostname and mailbox; with one SMTP Relay
   profile and Mailcow not yet set up, they are filled in already. **Remove**
   deletes the API key from this server; sites whose profile sets up Mailcow
   then wait until it is set up again, and nothing in Cloudflare or Mailcow is
   deleted.
3. **Profiles.** Open **Profiles** to edit **Web** or **Web and Mailcow**, or
   create your own from the presets. Each row is a record every site in the
   profile gets; **TTL and apex only** shows the less common columns, and
   **Cloudflare zone** opens the zone-wide settings. By default **Web** writes
   `*.{domain}` on apex domains, so subdomain sites in the same zone inherit
   the wildcard and need no `A` or `AAAA` records of their own unless another
   record at or below the subdomain blocks the wildcard. To keep a subdomain
   free of mail records, assign it to **Web** and send its transactional mail
   as the apex domain in SMTP Relay.
4. **Assign sites** under **Sites**, in bulk if you like. DNS starts in **Ask
   first**: **Check now** shows what differs and changes nothing.
5. **Turn on Automatic.** Choose **Review and turn on Automatic**, read the
   plan, and confirm it. From then on every site's records are kept to its
   profile, conflicting records at the names a profile writes are deleted, and a
   site whose domain is not in Cloudflare gets a new zone. Other names are never
   touched. Once Automatic is on, you can switch back to **Ask first** under
   **Settings**.
6. **New sites.** Under **Profiles**, choose the profile for **New sites
   join**. Until DNS is Automatic, new sites get no records.

A new zone goes into the only Cloudflare account your connections reach. With
more than one, choose it under **Settings**, **New zones**.

Under **Settings**, each connection says which permissions its token is
missing for what your profiles use; **Permissions** lists them with what uses
each. If you later turn on a feature that needs another permission, such as
skipping the firewall, **Edit in Cloudflare** opens your API tokens there; add
it to this token. A token made before 2.0.0-rc.10 needs **API Tokens: Read**,
or Account API Tokens: Read for an account-owned token, before DNS can show
this; until then the row lists only what Cloudflare has refused it. While a
token lacks a permission DNS needs, **Setup** shows it under **Action needed**.

## Everyday use

With Panel Tweaks' automatic SSL on, create a site as usual. DNS writes its
records within seconds, and the certificate is requested once they are in
place. If the zone is new, the page says which nameservers to set at the
registrar; the certificate is requested automatically once the zone is active.
Until then the site's **SSL/TLS** tab shows the nameservers too, to anyone who
can open the site, site managers and the site's own users included. Click a
nameserver or its clipboard icon in either message to copy that one. In the
site's **Details**, use the clipboard icon beside it.

**Details** on a site shows its zone and every pending change. Drift is
corrected every 15 minutes, or at once with **Check now**. **Activity** lists
every record, zone and Mailcow change DNS made, newest first, and what made it.
When a site is deleted from CloudPanel while DNS manages it, its records stay in
Cloudflare until you choose **Remove records** or **Keep**; if its zone is deleted
in Cloudflare, they leave the list on their own. A Mailcow domain is never deleted.

## Redirect domains

A redirect domain sends every request for a domain, and its `www`, or for one
host such as `tv.example.com`, to another URL. Open **Redirects** and choose
**Add redirect**. **Keep path** sends `/about` on to `/about` at the target;
turn it off for a target that is one page.

With Cloudflare connected, Cloudflare answers the redirect and this server is
never reached. Give the domain a profile to keep its mail: every row of the
profile applies except the domain's own address records. Without a connection,
a static site on this server answers it instead, with a Let's Encrypt
certificate once the domain points here. Connecting Cloudflare later moves it
there after you review it, and deletes that site.

**Find redirects in Cloudflare** lists the whole-domain redirect rules your
connections reach that DNS does not manage yet, such as Terraform's. Tick the
ones to take over, check **Keep path** for each, choose a profile for their
mail, and confirm the review. Each rule is updated in place; DNS never adds a
second one beside it.

Deleting a redirect domain once DNS is Automatic deletes its rule after a
review; its records stay until a site's profile replaces them. If it also has
a stand-in site on this server, that site stays until you confirm the review,
then is deleted too. To turn a site into a redirect, delete it in CloudPanel
first.

## Panel hostname

To reach CloudPanel at a name that is not easy to guess, such as
`k7m2p9x4.example.com`, through Cloudflare, connect Cloudflare first and then:

1. Under **Settings**, **Panel hostname**, enter a name, choose **Random** to
   generate an eight-character label on one of your connected zones, or adopt
   CloudPanel's existing custom domain, and save. DNS points it at this server
   without Cloudflare's proxy.
2. Enter the same name in CloudPanel under **Admin → Settings → Custom Domain**.
   CloudPanel gets its Let's Encrypt certificate straight from this server.
3. Seconds after the certificate is issued, DNS proxies the name through
   Cloudflare, or deletes the temporary records if a proxied wildcard in the
   zone already covers it.

Let's Encrypt publishes issued certificate names in public Certificate
Transparency logs, so a random name avoids casual guessing rather than hiding
the panel on its own. Turn on Firewall's **Panel gate** to block requests that
have not passed Cloudflare Access.

The proxy waits for the certificate because CloudPanel asks Let's Encrypt the
moment you save, and a check sent through Cloudflare can fail on the zone's SSL
settings. The zone also gets the Full SSL rule for Let's Encrypt checks, so
CloudPanel's renewals still reach this server once the name is proxied.
Removing the panel hostname leaves any explicit records it still has in
Cloudflare, listed with the records of deleted sites.

## Leaving Terraform

DNS replaces Terraform or OpenTofu for the records its profiles write. Retire
the old tooling without letting it destroy anything:

1. Turn off its scheduled applies and drift checks.
2. Take the records out of its state without deleting them, with
   `tofu state rm` (or `terraform state rm`) or `removed` blocks with
   `lifecycle { destroy = false }`, and delete their declarations. Never run
   `destroy`, and check that the plan deletes nothing remotely.
3. Assign the sites while DNS asks first, and check. Take over its redirects
   with **Find redirects in Cloudflare**. One-off records at other names stay
   untouched.
4. Turn on Automatic once the plans look right.
