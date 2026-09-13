# Security

## Privileged actions

The web manager has no sudo or Docker access. Privileged requests go to the
root gateway on `/run/clp-addons/auth.sock`, which is available only to root and
the `clp-addons` group. In production the gateway also checks that the peer is
the `clp-addons` account running the root-owned installed binary.

The gateway accepts only fixed addon and verb combinations and starts
`/usr/local/bin/clp-addons` with an argument array. Each action validates all
arguments again before deriving paths, locking, or changing the host. Unknown
addons, verbs, free-form paths, and malformed action replies are rejected.

Maintenance actions also require the normalized domain to exist in
CloudPanel's site database. The public maintenance directories allow traversal
without directory listing; flag files remain root-only and HTML files are
readable by Nginx. Custom pages are size-bounded, stripped of active markup,
and served with a restrictive content security policy.

## CloudPanel authentication

The gateway reads the bounded `cloudpanel` session file without following
symlinks, verifies its owner and size, and parses only the expected Symfony
token shape with depth and item limits. It checks expiry and MFA state. On a
normal CloudPanel installation it also rechecks the user's active status and
role in CloudPanel's database for every request.

The manager requires `ROLE_ADMIN`. Invalid sessions return to CloudPanel's
login page, and authentication failures do not fall back to anonymous access.
State-changing HTTP requests also require the expected origin and a CSRF token.

## Files and secrets

Addon metadata and job records are root-owned. Local snapshots, deletion
archives, recovery archives, and job results containing generated credentials
are mode `0600` below non-public directories. Instatic credentials used by a
Stager clone travel to the action over stdin and are removed from the job after
source authentication.
