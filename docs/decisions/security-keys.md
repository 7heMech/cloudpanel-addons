# Security Keys

## Shape

A "Sign in with a security key" button under CloudPanel's login form, and a
Security Keys card under Two-Factor Authentication on Account → Security, where
every panel user adds, lists and removes their own keys. Administrators see
everyone's keys on Addons → Security Keys and can remove any of them.

It is passwordless sign-in, not a second factor. The password and CloudPanel's
own TOTP still work exactly as before; a key is another way in. Requiring a key
on top of the password would need a gate in front of every panel request, which
this does not add.

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

Challenges are root's too: one file each under `challenges/`, single use
(whoever unlinks it wins), five minutes long, and swept when the next is
issued. The manager never decides what was signed.

`login-options` and `sign-in` are answered ahead of the session gate, because
there is no session yet. They are matched before the gate only while the addon
is installed, require the panel's own Origin, and carry the challenge id in an
`HttpOnly` `SameSite=Strict` cookie scoped to `/addons/security-keys/login`, so
another site can neither start nor finish a sign-in in the visitor's browser.

`keys`, `register-options`, `register` and `remove` act on the caller's own
account. The manager sends them with the CloudPanel session id, and the gateway
checks that session itself and appends `--panel-user`; see
[Security](security.md#privileged-actions). `users` and `revoke` are
administrator verbs behind the usual gate.
