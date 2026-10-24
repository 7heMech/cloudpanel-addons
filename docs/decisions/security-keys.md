# Security Keys

## Shape

A "Sign in with a security key" button under CloudPanel's login form, and a
Security Keys card under Two-Factor Authentication on Account → Security, where
every panel user adds, lists and removes their own keys. Administrators see
everyone's keys on Addons → Security Keys, can remove any of them, and set the
panel-wide settings below. Nobody else can change those.

That list groups keys under the user they belong to, with the role only while
the CloudPanel account is still the one the keys were made for. Search and a
filter for keys unused in 90 days, synced passkeys, and accounts that no longer
sign in hide rows in the browser; every key is already on the page. A key works
only at the address it was added on, so on a phone that address shows only when
it differs from the one the panel is open on.

It is passwordless sign-in, not a second factor. The password and CloudPanel's
own TOTP still work exactly as before; a key is another way in. Requiring a key
on top of the password would need a gate in front of every panel request, which
this does not add.

## Settings

Two, in root-owned `settings.json`, changed only through the administrator's
page and checked by root on every registration and sign-in:

- Which CloudPanel roles may use keys: administrators, site managers and users,
  all on by default. An account whose role is off cannot add a key or sign in
  with one; its keys are kept, it can still remove them, and its password works.
- Whether synced passkeys are accepted, on by default. A synced passkey is one
  whose authenticator reports it backup-eligible (Bitwarden, iCloud Keychain,
  Google Password Manager). Off, such keys are refused at registration and
  sign-in, and the account card asks the browser for a hardware key first.

The account card asks root what the account may do with every list, so it
follows a change without the page being told.

## Sign-in

The login page asks the manager for a challenge, the browser asks the key, and
the manager hands the answer to the root action. Root checks the signature,
writes CloudPanel's own one-time token to `var/.token_<64 hex>` as the panel's
user, and the browser is sent to `/autologin?token=…`. CloudPanel's
`AutoLoginAuthenticator` reads the file, deletes it and starts the session; the
addon never builds a session itself. The token lasts 60 seconds. Expired tokens
of that shape are removed on the next sign-in.

Every key must verify its user (PIN, biometric or device unlock), so a key on
its own is still two factors. Keys are discoverable credentials: the login page
asks for no username, and the key says whose it is. A sign-in through a key
does not prompt for CloudPanel's TOTP, because `/autologin` does not run the
listener that asks for it; see [Security](security.md#cloudpanel-authentication).

## Verification

`webauthn.ts` accepts "none" attestation and ES256, EdDSA and RS256 keys; it
decodes the CBOR it needs and nothing else (no indefinite lengths, tags or
floats), and verifies with `node:crypto`. Attestation statements are not read,
so no make of key is preferred or refused.

Each key is stored with the origin it was registered on. Sign-in requires the
same origin in the client data and the SHA-256 of its hostname as the RP ID
hash, so a key added on `panel.example.com:8443` does not work on another
address of the same panel. Browsers refuse WebAuthn on an IP address and on a
certificate error, and the action refuses to store an IP origin, so the panel
needs a hostname with a valid certificate; both injected blocks say so instead
of offering a button that cannot work.

A signature counter that goes backwards is refused as a cloned key. Synced
passkeys report 0 every time, which is accepted.

## State and trust

Keys live in `/var/lib/clp-addons/security-keys/credentials.json`, root-owned
`0600`, keyed by panel user name and pinned to CloudPanel's `user.id`. A name
that is deleted and created again does not inherit the old keys, and a
deactivated account cannot sign in with one. The administrator page marks
both.

Challenges are root's too, and cost nothing to issue: a challenge is an HMAC,
under a root-only `secret`, of an id carrying its own five-minute expiry, bound
for registration to the account, its `user.id` and its handle. Asking for one
writes nothing, so the pre-session route's cost does not grow with how often it
is asked. A challenge is spent under the store lock only after a key has
answered it, in `spent.json`, which therefore grows with real sign-ins. User
handles for new accounts are derived from the same secret and `user.id`. The
manager never decides what was signed.

Expired sign-in tokens are swept from the panel's `var`, which its user owns,
by opening each candidate without following a link or blocking, and reading it
only when it is a small regular file of that user's.

`login-options` and `sign-in` are answered ahead of the session gate, because
there is no session yet. They are matched before the gate only while the addon
is installed, require the panel's own Origin, and carry the challenge id in an
`HttpOnly` `SameSite=Strict` cookie scoped to `/addons/security-keys/login`, so
another site can neither start nor finish a sign-in in the visitor's browser.

`keys`, `register-options`, `register` and `remove` act on the caller's own
account. The manager sends them with the CloudPanel session id, and the gateway
checks that session itself and appends `--panel-user`; see
[Security](security.md#privileged-actions). `users`, `revoke` and
`settings` are administrator verbs behind the usual gate.
