# SMTP Relay

## Scope

Postfix, which CloudPanel's installer always installs, is the relay client. A
named profile holds one SMTP account and a From template. Sites are assigned to
profiles in bulk, and one profile can be the default for new sites, as in PHP
Resources. A site in no profile is not relayed. The seeded "Don't send" profile
routes its sites' mail to Postfix's `discard` transport, so it is logged and
never delivered.

## Postfix enforces

Every local submission passes through `postdrop`, which knows the submitting
Unix login, so a site's identity does not depend on PHP.

- `local_login_sender_maps` lets each CloudPanel site user, of any site type,
  use only its bare login and its own domains as the envelope sender: the site's
  domain, the bare domain of a `www.` site, granted domains, and whatever its
  From template produces. `root`, `postfix` and `clp` keep `*`. Any other login
  falls back to its bare name through a regexp table, so an account the
  reconcile has not seen yet is never refused outright. So does a site the
  addon cannot bind (a domain mail cannot use, a reserved user, a UID shared
  with another site), which the page lists instead of failing for every site.
- `sender_canonical_maps` rewrites a routed site's bare login (`user@$myorigin`,
  as cron and other callers without `-f` produce) to the site's default From.
- `sender_dependent_default_transport_maps` and sender-dependent
  `smtp_sasl_password_maps` pick the profile's relay and credential by envelope
  sender, exact addresses before whole domains. There is no global `relayhost`,
  so senders that are not routed leave as before. TLS to each relay is
  `secure match=nexthop`.
- Loopback SMTP carries no login. CloudPanel's stock Postfix listens on all
  interfaces and relays anything from 127.0.0.0/8, which would let any site
  process send through any profile by naming its domain. While any site is
  routed, `smtpd_relay_restrictions` loses `permit_mynetworks`.

A site whose envelope senders overlap another profile's, counting literal
template addresses and granted domains, is blocked: it is not relayed and its
login keeps only its bare name. Sites in a profile claim first, so a site in
none never displaces one that is. A save is refused if it blocks a site that was
not blocked before, so a block that arose without a save, such as a site created
on a domain another site was granted, does not stop other changes. A new site
joins the default profile only if that would block nothing. Port 465 is refused:
implicit TLS needs its own transport.

## The From header

Postfix cannot rewrite a From header per submitting user without a milter. PHP's
`sendmail_path` is therefore `clp-addons smtp-submit -t -i`, set by one
`99-clp-addons-smtp.ini` in every PHP version's `fpm/conf.d` and `cli/conf.d`,
except an `fpm/conf.d` whose `php-fpm` binary is gone.
That covers web requests, cron and WP-CLI, and survives CloudPanel rewriting a
pool when a site changes PHP version. A site cannot change it: `sendmail_path` is
`PHP_INI_SYSTEM`, and CloudPanel's PHP settings reach PHP as nginx `PHP_VALUE`,
which php-fpm applies in user mode. A pool's own
`php_admin_value[sendmail_path]` still wins.

The wrapper reads `/etc/clp-addons/smtp/<uid>.json`, root-owned and readable
only by that site's group. It keeps the requested From when the template uses it
and its domain is the site's own or granted, otherwise applies the template. It
keeps the display name, moves the requested address to `Reply-To` whenever the
address changes and the message has none, and replaces `-f` with the result. A
PHP site in no profile, or a blocked one, has a rule with no From: the wrapper
leaves its message alone and only drops an `-f` outside its domains, which
Postfix would refuse, so the mail still goes out under its login.
When it cannot apply a rule (no rule file, an untrusted one, unknown flags, or a
message it cannot parse), it passes the message to `/usr/sbin/sendmail` with the
original arguments, and Postfix still enforces the envelope. The panel's own
PHP-FPM reads the 8.1 conf.d and passes through this way. Laravel and Symfony
sendmail transports run `sendmail -bs` themselves and never reach the wrapper.

Other apps run sendmail themselves, often by name, as Nodemailer does. The
default PATH leaves out `/usr/sbin`, so while any site is routed,
`/usr/local/bin/sendmail` links to `/usr/sbin/sendmail`, unless something else
is already there.

## State and changes

Credentials live in `/var/lib/clp-addons/smtp/config.json` (0600). The manager
receives relay host, port and username, never the password. Before changing
Postfix, the action records the operator's value of every key it manages and
restores them once no site is routed or the addon is disabled. Its maps go ahead
of the operator's existing `smtp_sasl_password_maps`, `smtp_tls_policy_maps`,
`sender_dependent_default_transport_maps` and `sender_canonical_maps`; an
operator `transport_maps` is refused, because it overrides sender routing.

A save applies the new policy (`postfix check`, a Postfix reload, `php-fpm -t`
and a reload of each changed PHP version) and only then writes it. If any step
fails, the previous policy is applied again. Disabling withdraws everything and
keeps the policy; enabling applies it again.

## New sites

`clp-addons-smtp-reconcile.path` watches `/etc/nginx/sites-enabled`, where
CloudPanel writes every new site's vhost. Its service runs `sync-sites`, which
does nothing unless CloudPanel's sites have changed since the last run; then it
binds new site users, puts new sites in the default profile and drops deleted
sites. CloudPanel commits the site row about 200 ms after writing the vhost, so
the service runs it again 10 seconds later, even if the first run failed. Repair
runs the full reconcile, which also undoes drift, every 15 minutes.

## Limits

The From rewrite covers PHP `mail()` only; a site that calls sendmail directly
can put another domain in its From, and Postfix holds only its envelope. The
provider is the boundary for From, so sites that do not trust each other need
separate profiles rather than one account allowed to send as all of them. The
test reports that Postfix queued the message, not the relay's answer.
