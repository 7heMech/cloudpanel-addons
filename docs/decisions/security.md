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
The token cookie is scoped to the whole panel rather than to `/addons`, because
an addon page mounted into one of CloudPanel's own site pages runs at that
page's path and has to read it. Path is not what protects it: the panel is a
single origin, so any panel page could read the cookie at any path, and the
same-origin check and `SameSite=Strict` are what refuse a forged request. Every
response that sets it also expires the `/addons`-scoped cookie an earlier
release set, which it does not otherwise replace: a browser holding both sends
both, and the two ends of the check would read different values.

## One response and one body policy

`lib/app-http.ts` builds every HTML and JSON response an addon or the manager
sends: content type, `Cache-Control: no-store` and the security headers,
applied before the caller's own headers so a deliberate override -- Maintenance
Mode's preview CSP, the year-long cache on the editor mode asset -- is the only
way to differ from the default. Caller headers are merged through `Headers`
rather than spread, because spreading a `Headers` instance yields nothing and
silently drops what the caller asked for. The CSRF cookie is attached by the
same builder, so no response can set it without the rest of the policy, and
`guardMutation`'s own refusals go out through it too.

Request bodies are read by one bounded reader. It refuses a declared
`Content-Length` over the limit before reading anything, and counts the stream
as it arrives so a chunked body with no declared length -- or a declared length
that lies -- is abandoned at the limit rather than buffered whole. Invalid JSON,
JSON that is not an object, and a malformed `Content-Length` each have their own
message and status. What the fields mean stays with the handler that owns them:
the reader does not pretend a type parameter validates anything.

Percent-decoding of path segments goes through one helper that returns null on
malformed encoding, so a stray `%` is a 400 rather than a URIError escaping to
the socket boundary as a 500.

## Files and secrets

Addon metadata and job records are root-owned. Local snapshots, deletion
archives, recovery archives, and job results containing generated credentials
are mode `0600` below non-public directories. Instatic credentials used by a
Stager clone travel to the action over stdin and are removed from the job after
source authentication.
