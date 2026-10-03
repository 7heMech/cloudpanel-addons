# SMTP Relay

SMTP Relay sends your sites' mail through SMTP accounts you choose, using the
Postfix that CloudPanel already installs. WordPress and other PHP apps need no
plugin: their `mail()` goes through the relay as it is.

## Set up

1. Enable **SMTP Relay** in Addons. Postfix must be 3.6 or newer with Cyrus SASL
   client support; the installer adds the SASL modules if they are missing.
2. Create a **profile** for each SMTP account: hostname, a STARTTLS port (587 or
   2525), username, password, and the From its sites send with. The built-in
   **Don't send** profile discards mail instead, for staging copies.
3. Assign sites to profiles, one at a time or in bulk, and choose the profile new
   sites join. A site in no profile is not relayed. A site marked **Blocked**
   could send as a domain another site sends through a different profile; put
   both in one profile or remove the domain from that site's **Domains**.
4. Send a test to an inbox you control. It runs as the site's own user, through
   PHP's `mail()` for a PHP site and sendmail for any other, and confirms that
   Postfix queued it. Delivery results are in `journalctl -u postfix@-`, or in
   `/var/log/mail.log` where rsyslog is installed.

The provider must accept the addresses a profile's sites send as. The addon does
not create mailboxes, verify domains at the provider, or set DNS records.

## The From address

| From template | WordPress asks for `wordpress@example.com` | A form asks for `jane@gmail.com` |
|---|---|---|
| `noreply@{site}` | `noreply@example.com` | `noreply@example.com` |
| `{from.local}@{site}` | `wordpress@example.com` | `noreply@example.com` |
| `alerts@agency.com` | `alerts@agency.com` | `alerts@agency.com` |

`{site}` is the site's domain without a leading `www.`. `{from.local}` and
`{from.domain}` keep the app's From only on the site's own domain or a domain
added under **Domains**. Whenever the address changes, the original moves to
`Reply-To`, and the display name is kept.

## Limits

- Postfix lets each site send only as its own domains and those added under
  Domains, so a site can only use its own profile. The From header is rewritten
  only for PHP `mail()`: code that calls sendmail directly can still put another
  domain in From. A shared account allowed to send as many domains, such as one
  Mailcow mailbox permitted to send as all of them, then lets any of its sites
  send signed mail as every one of those domains. Give sites that do not trust
  each other separate profiles.
- While any site is relayed, Postfix stops relaying unauthenticated SMTP from
  `localhost:25`. Point apps that used it at sendmail or PHP `mail()`.
- Apps with their own SMTP settings keep connecting to their provider directly.
- New sites are picked up seconds after CloudPanel creates them. Disabling the
  addon restores Postfix's previous settings and removes its PHP setting; the
  profiles are kept, and enabling it again applies them.
