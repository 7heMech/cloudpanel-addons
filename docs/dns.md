# DNS

DNS keeps each site's Cloudflare records to a profile, and can set the site's
domain up in Mailcow. Enable **DNS** under Addons, or run
`clp-addons install dns`.

## Set up

Until Cloudflare is connected, the DNS page opens with these steps as a
checklist.

1. **Connect Cloudflare.** Open DNS and choose **Connect Cloudflare**. **Create
   token in Cloudflare** opens Cloudflare's token form. Check the permissions
   listed beside the link are there. Pick the accounts and zones there (All zones
   also covers zones you add later), limit it to the server addresses shown
   under Client IP Address Filtering (the clipboard icon copies them
   space-separated, as that field takes them), create the token, and paste it back. DNS
   finds the accounts and zones it reaches by itself. Add more connections for
   other Cloudflare logins.
2. **Mailcow, if you use it.** Under **Settings**, set Mailcow's hostname,
   such as `mail.example.com` (it is also the MX target), a read-write API key
   (limit it to this server's IP in Mailcow), how new domains get a DKIM key, and
   optionally a shared mailbox. If SMTP Relay already sends through Mailcow,
   **Fill from SMTP Relay** takes its hostname and mailbox; with one SMTP Relay
   profile and Mailcow not yet set up, they are filled in already. **Remove**
   deletes the API key from this server; sites whose profile sets up Mailcow
   then wait until it is set up again, and nothing in Cloudflare or Mailcow is
   deleted.
3. **Profiles.** Edit **Web** or **Web and Mailcow**, or create your own from the
   presets. Each row is a record every site in the profile gets; **TTL and apex
   only** shows the less common columns, and **Cloudflare zone** opens the
   zone-wide settings.
4. **Assign sites** in the table, in bulk if you like. DNS starts in **Ask
   first**: **Check now** shows what differs and changes nothing.
5. **Turn on Automatic.** Choose **Review and turn on Automatic**, read the
   plan, and confirm it. From then on every site's records are kept to its
   profile, conflicting records at the names a profile writes are deleted, and a
   site whose domain is not in Cloudflare gets a new zone. Other names are never
   touched. **Ask first instead** stops all writing again.
6. **New sites.** Choose the profile under **New sites join**. Until DNS is
   Automatic, new sites get no records.

A new zone goes into the only Cloudflare account your connections reach. With
more than one, choose it under **Settings**, **New zones**.

If you later turn on a feature that needs another permission, such as skipping
the firewall, edit the token in Cloudflare to add it.

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
corrected every 15 minutes, or at once with **Check now**. **Change log** lists
every record, zone and Mailcow change DNS made, newest first, and what made it.
When a site is deleted from CloudPanel while DNS manages it, its records stay in
Cloudflare until you choose **Remove records** or **Keep**. A Mailcow domain is never deleted.

## Leaving Terraform

DNS replaces Terraform or OpenTofu for the records its profiles write. Retire
the old tooling without letting it destroy anything:

1. Turn off its scheduled applies and drift checks.
2. Take the records out of its state without deleting them, with
   `tofu state rm` (or `terraform state rm`) or `removed` blocks with
   `lifecycle { destroy = false }`, and delete their declarations. Never run
   `destroy`, and check that the plan deletes nothing remotely.
3. Assign the sites while DNS asks first, and check. Records it should not
   manage, such as redirects or one-off records at other names, stay untouched.
4. Turn on Automatic once the plans look right.
