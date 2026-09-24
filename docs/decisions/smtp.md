# SMTP Relay

## Scope

The addon provides one server-level submission path for CloudPanel PHP sites.
It uses each site's PHP-FPM `sendmail_path` to call the installed
`clp-addons smtp-submit` command. That command reads a root-owned, world-readable
sender policy, identifies the site by the process's Unix UID, checks or rewrites
the message's From, and invokes Postfix's `/usr/sbin/sendmail` with the same
envelope sender. This covers default WordPress PHPMailer behavior and other PHP
`mail()` callers without changing application files. Applications with their
own SMTP transports remain outside this path.

The default rule forces `noreply@{domain}`. A site may instead allow senders on
its own domain, additional administrator-approved domains, or exact addresses.
Forcing an address supports a relay account allowed to send as many domains;
allowing senders supports applications that need their own From identities.
The global SMTP credential is the fallback. Optional relay overrides are keyed
by *sending* domain, so a site can use a separate provider for mail it is
authorized to send from that domain.

## Postfix and state

Enabling requires a Postfix SMTP client with Cyrus SASL support and the
`libsasl2-modules` package. Provisioning checks active and inactive existing
Postfix installs as well as new installs, and installs missing modules. It
requires `smtp_sasl_type=cyrus`. A newly installed Postfix is bound
to loopback for inbound SMTP; an existing Postfix installation keeps its
existing listener configuration. The addon sets `relayhost`, sender-dependent
relay routing, sender-dependent SASL authentication, authenticated SMTP client
settings and mandatory verified TLS. `local_login_sender_maps` limits envelope
senders from known site Unix accounts even if they invoke Postfix's sendmail
command directly. A generated TLS policy map puts `secure match=nexthop` first
for the global and domain relay destinations, ahead of existing operator TLS
maps, which are restored on
disable. A nonempty TLS policy map also supersedes the legacy
`smtp_tls_per_site` parameter. The selected credential still has to be
authorized by its upstream provider.

The global and per-domain credentials are stored in
`/var/lib/clp-addons/smtp/config.json` at mode `0600`. Postfix reads generated
`regexp:` credential and route maps under `/etc/postfix`; the credential map is
`0600`. Local Unix sender restrictions use a `hash:` map. The trusted `root`,
`postfix`, and CloudPanel `clp` accounts retain unrestricted local envelope
senders; site accounts get only their configured senders. Other local Unix
accounts are not granted Postfix sendmail access by this addon. The public
submission policy lives at `/etc/clp-addons/smtp-submission.json` and contains
no SMTP passwords. The manager receives only relay host, port, username, and a
has-password flag, never the saved password.

Before changing Postfix, the action captures its explicit values for every key
it owns. Updates replace managed files atomically, run `postfix check`, then
reload Postfix. A failed update restores the prior managed files and settings.
Before changing PHP-FPM pools, it rejects conflicting sendmail settings, then
tests each affected PHP-FPM version and reloads it. The pool directive and
Postfix settings are withdrawn when the addon is disabled or uninstalled. The
saved addon policy remains for a later enable.

## Security boundary and constraints

The root gateway accepts only named SMTP verbs. The action validates a sending
domain against CloudPanel's PHP sites before changing a site rule, and validates
every relay host, address, template, and allowlist entry. It rejects multiple
sites sharing one Unix UID because their submissions could not be distinguished.
The submission command accepts only sendmail flags needed by PHP mail, ignores
an untrusted `-f` request, and stops reading stdin when a message exceeds
25 MiB. It also requires a bounded header.

This sender policy is enforced on PHP `mail()` submissions through the managed
pool. Direct Postfix submission from a site account is restricted at the
envelope only; a process with shell access can still write an arbitrary From
header, and another local SMTP listener can bypass the Unix account check.
This addon does not promise isolation against a hostile tenant with direct
process or network access. The test-mail action queues a message through
Postfix as root to test relay delivery; it does not exercise the PHP wrapper.

The regular repair timer reapplies the policy to new or recreated PHP pools
every 15 minutes. Until then, a new site's mail may fail the Postfix local
sender check. Disabling removes the managed pool directives, submission policy,
Postfix settings, and generated maps. It does not remove Postfix itself.
