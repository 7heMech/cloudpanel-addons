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

The gateway's streaming mode is restricted to `watch-job`: it starts one worker,
pipes its output without interpreting addon data, and kills the worker when the
manager socket closes. Session re-authorization remains in the manager that
owns the stream.

Maintenance actions also require the normalized domain to exist in
CloudPanel's site database. The public maintenance directories allow traversal
without directory listing; flag files remain root-only and HTML files are
readable by Nginx. Custom pages are size-bounded, stripped of active markup,
and served with a restrictive content security policy.

Panel Tweaks is the only addon that writes into a site's own tree. Its
WordPress sign-in installs a must-use plugin and a one-time secret as the site's
user, refuses a domain the panel does not have, one that is not WordPress, and
any request at all while the operator has not switched the sign-in on. The
secret is a SHA-256 of a token that lives for a minute, is removed before it is
compared, and travels in a POST body rather than a URL. Switching the tweak off
removes the plugin from every site. See
[Panel Tweaks](panel-tweaks.md).

## CloudPanel authentication

The gateway reads the bounded `cloudpanel` session file without following
symlinks, verifies its owner and size, and parses only the expected Symfony
token shape with depth and item limits. It checks expiry and MFA state. On a
normal CloudPanel installation it also rechecks the user's active status and
role in CloudPanel's database for every request.

Expiry is the session's own `u + l` metadata. CloudPanel leaves
`session.cookie_lifetime` at 0, so `l` is 0 and the bound is whenever PHP's
garbage collector would drop the file: the gateway reads
`session.gc_maxlifetime` from the panel's own php.ini rather than assume PHP's
documented 1440 seconds, which had been logging operators out of the addon
pages twenty-four minutes after their last panel page -- a wait a job watched
over SSE reaches on its own.

The manager requires `ROLE_ADMIN`. Invalid sessions return to CloudPanel's
login page, and authentication failures do not fall back to anonymous access.

The gate is the first thing a request meets, before the URL is taken apart and
before any route is chosen, so there is no list of exceptions to keep correct.
The liveness probe the update page polls is inside it, and nothing reads it
without a session: the page that polls it has one.

What a stranger gets back is the redirect Symfony sends for any path CloudPanel
will not serve them, reproduced byte for byte: same status, same headers, same
body, and no `Content-Length`, which means streaming the body rather than
handing Bun one whose length it can count. The project's own header policy used
to go over the top of it, and that was the one thing that told `/addons` apart
from the rest of the panel. It still applies to everything behind the gate.

A response can outlive the request that authorized it. The job event stream
rechecks the session as it polls and closes when it is no longer an
administrator's, because a clone's job record carries the database and Instatic
passwords it generated.

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
silently drops what the caller asked for, and `Set-Cookie` is taken from the
accessor that keeps repeated cookies apart rather than by name. The CSRF cookie
is attached by the same builder, so no response can set it without the rest of
the policy, and `guardMutation`'s own refusals go out through it too.

Request bodies are read by one bounded reader. It refuses a declared
`Content-Length` over the limit before reading anything, and counts the stream
as it arrives so a chunked body with no declared length -- or a declared length
that lies -- is abandoned at the limit rather than buffered whole. Invalid JSON,
JSON that is not an object, and a `Content-Length` that is not the run of digits
RFC 9110 defines each have their own message and status. What the fields mean
stays with the handler that owns them: the reader does not pretend a type
parameter validates anything.

Percent-decoding of path segments goes through one helper that returns null on
malformed encoding, so a stray `%` is a 400 rather than a URIError escaping to
the socket boundary as a 500.

A fault that escapes a handler is answered by the same JSON shape with the
detail left in the journal. `Bun.serve` renders its own error page, stack trace
included, whenever `NODE_ENV` is not `production`, and the unit sets no such
variable, so the server states `development: false` rather than depending on an
environment an operator could change.

## One atomic replacement

`lib/atomic-write.ts` is how a managed file is replaced: written to an
unpredictable name in the target's own directory with `O_EXCL`, chmodded, given
its ownership, then renamed. The rename is last, so the target is either the old
file or the new one, and a failure at any step removes the temporary file and
leaves the target alone.

Ownership is passed explicitly or not at all. Most writes want the installing
process to own the result; the Cloudflare policy and the vhosts it stages must
keep the panel's ownership, and a default for either would be wrong somewhere.
Whether the existing target is one this project is willing to replace stays with
the caller too -- the Cloudflare action refuses a policy file that is not a
root-owned regular file before it writes.

Secrets follow the same path. `writeFileSync`'s mode argument applies only when
it creates the file, so writing a credential over an existing path left that
path's old permissions in place until a later `chmod` caught up, with the
credential already on disk. A file a command is about to write a secret into is
created with `O_EXCL` rather than truncated, so nothing can leave a symlink at
that name first.

## Files and secrets

Addon metadata and job records are root-owned. Local snapshots, deletion
archives, recovery archives, and job results containing generated credentials
are mode `0600` below non-public directories. Instatic credentials used by a
Stager clone travel to the action over stdin and are removed from the job after
source authentication.
