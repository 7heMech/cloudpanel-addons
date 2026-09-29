# SMTP Relay

SMTP Relay sends mail from CloudPanel PHP sites through the server's Postfix
queue and an authenticated SMTP server. WordPress uses PHPMailer by default,
which submits through PHP `mail()` unless the site changes its mailer. The addon
works with that default and with other PHP applications that call `mail()`;
there is no WordPress plugin to install.

## Set up

1. Enable **SMTP Relay** in Addons. The installer starts Postfix if needed and
   checks SMTP authentication modules even when Postfix is already active.
   An existing Postfix must be version 3.6 or newer with Cyrus SASL client
   support.
2. Open **SMTP Relay** and enter the SMTP hostname, STARTTLS submission port
   (normally 587), username, and password. Choose the default From in the same
   form, then save both together. In the From template, `{site}` is the site's
   domain, and `{from.local}` and `{from.domain}` are the name and domain of the
   From the application asked for:

   | From template | WordPress asks for `wordpress@example.com` | A form asks for `jane@gmail.com` |
   |---|---|---|
   | `noreply@{site}` | `noreply@example.com` | `noreply@example.com` |
   | `{from.local}@{site}` | `wordpress@example.com` | `jane@example.com` |
   | `{from.local}@{from.domain}` | `wordpress@example.com` | `jane@example.com` |

   `{from.domain}` keeps only the site's own domain and any domains granted in
   the site's editor. When the requested address is on another domain, it is
   added as `Reply-To` so replies still reach it. When the application asks
   for no From, `{from.local}` is `noreply`.
   If saving reports a Postfix routing conflict, resolve the named
   `transport_maps`, `sender_dependent_default_transport_maps`,
   `default_transport`, or `relay_transport` setting first. Those settings can
   route mail around the selected SMTP relay; the addon leaves them untouched.
3. For a sending domain that needs its own SMTP account, add a **Sending domain
   relay**. All other senders use the global account. The relay's SMTP provider
   must allow the resulting From address; configuring the addon does not create
   mailboxes, authorize senders at the provider, or set DNS records.
4. Send a test to an inbox you control. The test sends as the site's own
   account through the same path as PHP `mail()`, with `wordpress@` the site's
   domain as the requested From unless you enter another. The page shows the
   From it was sent as and confirms that Postfix queued it; check the inbox
   and, if needed, `/var/log/mail.log` and `postqueue -p` for the delivery
   result.

For Mailcow, one mailbox credential can be used as the global relay when that
mailbox is explicitly permitted to send as all intended domains. Otherwise use
separate SMTP credentials as sending domain relays. Keep ordinary mailboxes that
receive mail; the addon does not replace them.

## Behavior and limits

The From template applies to PHP `mail()` in CloudPanel's PHP-FPM site pools
and sets both the visible From and the envelope sender. Only CloudPanel
administrators can grant a site additional domains. A site cannot use another
site's domain through this PHP mail path unless an administrator grants it.

The addon does not alter applications that open their own SMTP connection. It
also does not filter arbitrary mail submitted directly to Postfix or another
local SMTP listener. Postfix restricts local envelope senders for known site
Unix accounts, but that check does not validate the message's visible From
header. Treat the site's From template as a policy for PHP `mail()` and configure
untrusted shell or SMTP access separately. Local submissions from other Unix
accounts are restricted, except for Postfix, root, and CloudPanel's `clp`
account.

New PHP sites and pool changes are picked up by `clp-addons repair` and the
regular reconciliation timer (every 15 minutes). If a site has a conflicting
`sendmail_path` in its PHP-FPM pool, saving or repairing the relay reports the
conflict rather than replacing it. Disabling the addon restores the prior
Postfix settings and removes its PHP-FPM pool directives; saved relay settings
remain available when it is enabled again.
