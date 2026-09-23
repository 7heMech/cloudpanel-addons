# SMTP Relay

SMTP Relay sends mail from CloudPanel PHP sites through the server's Postfix
queue and an authenticated SMTP server. WordPress uses PHPMailer by default,
which submits through PHP `mail()` unless the site changes its mailer. The addon
works with that default and with other PHP applications that call `mail()`;
there is no WordPress plugin to install.

## Set up

1. Enable **SMTP Relay** in Addons. The installer starts Postfix if needed.
   An existing Postfix must be version 3.6 or newer.
2. Open **SMTP Relay** and enter the SMTP hostname, STARTTLS submission port
   (normally 587), username, and password. Save the global relay.
3. Choose a default sender. `noreply@{domain}` becomes
   `noreply@example.com` for the `example.com` site. **Force one address**
   replaces an application's requested From address. **Allow site domains**
   preserves From addresses on that site's domain and on any domains or exact
   addresses explicitly granted in the site's editor.
4. For a sending domain that needs its own SMTP account, add a **Sending domain
   relay**. All other senders use the global account. The relay's SMTP provider
   must allow the resulting From address; configuring the addon does not create
   mailboxes, authorize senders at the provider, or set DNS records.
5. Send a test to an inbox you control. The page confirms that Postfix queued
   the message; check the inbox and, if needed, `/var/log/mail.log` and
   `postqueue -p` for the delivery result.

For Mailcow, one mailbox credential can be used as the global relay when that
mailbox is explicitly permitted to send as all intended domains. Otherwise use
separate SMTP credentials as sending domain relays. Keep ordinary mailboxes that
receive mail; the addon does not replace them.

## Behavior and limits

The sender rule applies to PHP `mail()` in CloudPanel's PHP-FPM site pools. In
force mode, the addon sets both the visible From and envelope sender to the
configured address. In allow mode, it rejects a requested From outside the
site's own domain and its approved senders. Only CloudPanel administrators can
grant additional domains or addresses. A site cannot use another site's domain
through this PHP mail path unless an administrator grants it.

The addon does not alter applications that open their own SMTP connection. It
also does not filter arbitrary mail submitted directly to Postfix or another
local SMTP listener. Postfix restricts local envelope senders for known site
Unix accounts, but that check does not validate the message's visible From
header. Treat the site sender rule as a policy for PHP `mail()` and configure
untrusted shell or SMTP access separately. Local submissions from other Unix
accounts are restricted, except for Postfix, root, and CloudPanel's `clp`
account.

New PHP sites and pool changes are picked up by `clp-addons repair` and the
regular reconciliation timer (every 15 minutes). If a site has a conflicting
`sendmail_path` in its PHP-FPM pool, saving or repairing the relay reports the
conflict rather than replacing it. Disabling the addon restores the prior
Postfix settings and removes its PHP-FPM pool directives; saved relay settings
remain available when it is enabled again.
