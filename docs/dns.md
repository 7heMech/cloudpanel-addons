# DNS

DNS keeps each site's Cloudflare records to a profile, and can set the site's
domain up in Mailcow. Enable **DNS** under Addons, or run
`clp-addons install dns`.

## Set up

1. **Connect Cloudflare.** Open DNS and choose **Connect Cloudflare**. **Create
   token in Cloudflare** opens Cloudflare's token form. Check the permissions
   listed beside the link, adding **Config Rules: Edit** and **Zone WAF: Edit**
   manually when listed. Pick the accounts and zones there (All zones
   also covers zones you add later), create the token, and paste it back. DNS
   finds the accounts and zones it reaches by itself. Add more connections for
   other Cloudflare logins.
2. **Mailcow, if you use it.** Under **Server and Mailcow**, set Mailcow's
   address, a read-write API key (limit it to this server's IP in Mailcow), the
   mail hostname, how new domains get a DKIM key, and optionally a shared
   mailbox, such as the one SMTP Relay sends through.
3. **Profiles.** Edit **Web** or **Web and Mailcow**, or create your own from the
   presets. Each row is a record every site in the profile gets.
4. **Assign sites** in the table, in bulk if you like. Profiles start in
   **Report only**: **Check now** shows what differs and changes nothing.
5. **Enforce.** Turn on Enforce for a profile, read the plan, and confirm it.
   From then on its records are kept as they are, and conflicting records at the
   names it writes are deleted. Other names are never touched.
6. **New sites.** Choose the profile new sites join.

If you later turn on a feature that needs another permission, such as creating
zones or skipping the firewall, edit the token in Cloudflare to add it.

## Everyday use

With Panel Tweaks' automatic SSL on, create a site as usual. DNS writes its
records within seconds, and the certificate is requested once they are in
place. If the zone is new, the page says which nameservers to set at the
registrar; the certificate is requested automatically once the zone is active.

**Details** on a site shows its zone and every pending change. Drift is
corrected every 15 minutes, or at once with **Check now**. When a site is
deleted from CloudPanel, its records stay in Cloudflare until you choose
**Remove records** or **Keep**. A Mailcow domain is never deleted.

## Leaving Terraform

DNS replaces Terraform or OpenTofu for the records its profiles write. Retire
the old tooling without letting it destroy anything:

1. Turn off its scheduled applies and drift checks.
2. Take the records out of its state without deleting them, with
   `tofu state rm` (or `terraform state rm`) or `removed` blocks with
   `lifecycle { destroy = false }`, and delete their declarations. Never run
   `destroy`, and check that the plan deletes nothing remotely.
3. Assign the sites in Report only and check. Records it should not manage,
   such as redirects or one-off records at other names, stay untouched.
4. Turn on Enforce once the plans look right.
