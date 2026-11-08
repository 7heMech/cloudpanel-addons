# Terminal

## Shape

One shell per site, as that site's Linux user, starting in its site root, in a
browser window of its own. It opens from a Sites row, from the right end of a
site's tab strip, and from Addons → Terminal. The window is named after the
site using a lossless encoding of its lowercase domain, so a second click
focuses the shell already open without confusing dots with hyphens; Shift-click
opens another. On a phone it is a tab.

Addons → Terminal lists each site with its user under the domain, and counts
them beside the title the way Panel Tweaks counts the Sites page. From six
sites a search appears, focused on a desktop, and Enter opens the only match.
A worker refusal (see below) shows as "Couldn't open a terminal" with Try
again, not as a session that ended.

The text-size buttons stay together on every screen, with a gap before reset
beside the theme switch to reduce accidental resets.

On a touch screen the window follows the part the keyboard leaves visible and
adds the keys a phone keyboard lacks: Esc, Tab, a sticky Ctrl and arrows. They
act on touch-down without taking focus, so they leave the keyboard as it was,
and the arrows repeat while held. A swipe scrolls the history with momentum, or
sends arrow keys in a full-screen program. xterm's selection needs a mouse, so
holding a finger on the terminal lays a plain-text copy of it exactly over the
top -- same font, cell size and scroll position -- for the phone's own
long-press selection and menu. The copy is editable with `inputmode="none"`, so
that menu still offers Paste, which goes to the shell; no other edit is
accepted. Copying, pasting or a tap that clears the selection removes it.

Administrators only. A shell as a site's user is what SSH already gives anyone
with that user's key; it is offered to the people who can already create one.
A root shell is offered only to the administrators root names; see Root.

## Root

Root names who may open a root shell with `clp-addons terminal root allow
<user>` from a shell; `deny` takes it back and `clp-addons terminal root` lists
them. Nothing in the panel can change the list. An allowed administrator gets a
`>_ Root terminal` control in both of CloudPanel's headers and in the addons'
copy of it, just before the account menu, and a Root terminal button on
Addons → Terminal. `>_` is the mark a site's own Terminal tab has, so every way
into a shell looks alike. Below 760px the header has no room for a fourth tool
beside the logo, so the control becomes `>_ Root` at the end of the row under
it -- the navigation, or the Admin Area's instance details -- pinned there
when the row scrolls, with a divider so it does not read as another page. The
addons' pages always draw that row on a phone; CloudPanel's draw it only with
Panel Tweaks' phone layout, so without it the control is a Root terminal item
in the account menu, above Logout. The others get none of these; their button
shows a notice naming the command, so they know whom to ask. The controls stay
hidden until the page has asked
`/addons/terminal/api/root-access`. Every panel page asks, so the manager
keeps root's answer a minute per user instead of starting a root process for
each page; the Terminal page asks afresh, and the worker always checks.

Any administrator can reset another's password in CloudPanel and sign in as
them, so a grant to a name alone would be a root shell for every
administrator. A grant therefore holds the account's two-factor setup:
`allow` refuses an account with 2FA off, and records a digest of its 2FA
secret. CloudPanel's user form has no two-factor field: only the account turns
its own on or off, and only root (`clpctl user:disable:mfa`) turns it off for
someone else, so a reset password gets no further than the code. But with 2FA
off, whoever is signed in can set it up with their own phone, so 2FA switched
off and set up again is a new secret, and the grant needs root again. The
account's setting is not enough on its own either: a session signed in
before two-factor was turned on stays signed in, and never passed the code.
So the gateway tells every session verb's worker, in
`CLP_ADDONS_SESSION_2FA`, how that session signed in, and a root shell needs
one of two answers. Either it carries CloudPanel's own "two-factor passed"
marker, or Security Keys opened it. A passkey sign-in goes through
CloudPanel's `/autologin`, which writes no marker, so Security Keys records
each sign-in's user, key and time, and the gateway matches a session without
the marker to one whose 60-second token was valid when CloudPanel created the
session; CloudPanel stamps that time again at every sign-in. Security Keys
also records a digest of the account's 2FA secret, and the sign-in counts only
while the account still has that secret: with 2FA on, a password sign-in in
the same minute carries the marker, so the unmarked session is the passkey's.
A password session from while 2FA was off never counts. `allow` pins the
passkeys the account has then and lists them by name, since an administrator
signed in as the account could have added one: a key added later does not
open a root shell until root allows the account again. A key removed or revoked
since opens nothing more, even from the session it signed in, as 2FA set up
again does for the code.

Each grant is also pinned to CloudPanel's `user.id`, so a name deleted and
created again is not the account root allowed. A deactivation, a demotion or
2FA switched off refuses it while it lasts, and the button's notice says which;
2FA set up again needs root to allow the account again. A password change does
not touch it. Opening a new shell also requires a fresh authenticator or trusted
passkey check; a session cookie alone cannot start one. An existing shell can
be reattached by the session that opened it.

The grants are `/etc/clp-addons/terminal-root.json`, root's alone, `0600`, read
through one descriptor opened without following links. Only a missing file
means nobody. One that is not root's alone, a link, or one that does not parse
refuses everyone, and `terminal root` then tells root to remove it and allow
again. The manager learns whether its user is allowed only through the
own-account `root-access` verb, which root answers from the file; the session
worker checks again before it starts `runuser --login root` and every 15
seconds while the shell runs, ending it when the grant stops holding. A check
that cannot read the list or CloudPanel's database refuses a new shell, but an
open one gets three such checks in a row before it ends, so CloudPanel holding
its database for a moment does not cut it off. A shell that has not hung up
five seconds after it is told to is killed. The helper runs as root only with
`CLP_ROOT_SHELL=1`, which the worker passes for a root shell alone. The
journal gets "opened a root shell" and "closed a root shell" lines like a
site's. A ready line naming root is accepted only for a root shell, and one
naming anyone else only for a site.

## Transport

Output reaches the window as server-sent events and keystrokes go back as
POSTs, through the same `/addons/` proxy, CSRF guard and session gate as every
other page. A WebSocket would have needed a change to the panel's nginx and a
listening port; this needs neither.

The manager keeps each session in memory with the last 256 KiB of output and a
running byte offset. Every event carries the offset as its id, so the browser's
own reconnect resumes where it stopped, and a reconnect from further back than
the ring gets the whole ring instead. The window keeps its session id in
`sessionStorage`, so a reload reattaches. A session nobody is attached to ends
after 60 seconds; a window that says it is closing gets 5, which a reload beats.
A second window on the same session, such as a duplicated tab, takes it over,
and the first says so instead of reconnecting. Keystrokes go one request at a
time, in order, each batch numbered so a retry after a network error is not
typed twice. A popup that falls more than 2 MiB behind is dropped and replays
from the ring when it reconnects.

A session belongs to one panel user and one CloudPanel session cookie; anything
else is told it does not exist. The manager checks the session every 15 seconds
while a window is attached, and so does the gateway, independently. Each looks
again a second after a failure before ending the shell, because PHP can
truncate a session file while rewriting it.

## Who reads what

The root side is small enough to read in one sitting, and no root process reads
what the browser typed.

| Layer | Runs as | What it does with terminal data |
| --- | --- | --- |
| Browser (xterm.js) | the operator's browser | Renders output. No title, link or clipboard handling is wired to it. |
| Manager | `clp-addons` | Holds sessions; parses every line from below as hostile. |
| Gateway | root | Checks the panel session itself, then copies bytes without reading them. |
| Worker (`action terminal session`) | root | Validates, writes two audit lines, starts one fixed `runuser` with its pipes, waits. |
| `runuser --login` | root, then the site user | Opens the PAM/logind session and drops privileges. |
| `clp-addons terminal-pty` | the site user | Owns the PTY, decodes input and resizes, runs the shell. |

The worker runs only when started by the gateway's checked stream. It refuses a
site the panel user does not own, a user that is root, `clp`, `postfix` or below
uid or gid 1000, one whose uid another site shares, one
whose login shell is `nologin` or `false`, and a site root that resolves
outside the home. Its `runuser` argv is fixed; the site directory and size
travel in environment variables `runuser` is told to keep. Besides the worker's
"opened" and "closed" lines and its refusals, the journal gets the first 4 KiB
of what `runuser` and the login wrote to stderr, which is where a failed start
says why. Every such line is labelled with the site and has its control
characters replaced, so a site cannot forge a journal line.
Ending a stream closes the helper's stdin as well as signalling the worker, and
a worker that leaves its stdin full for 30 seconds ends the stream.

The helper runs as the site user through that user's login shell, so a site can
replace it with anything. That is why the manager accepts only the exact
messages the helper sends -- `ready`, base64 output, `exit`, and the worker's
own refusal -- and ends the session on anything else after `ready`. Before
`ready` it skips up to 64 KiB of lines, for login files that print. Nothing a
site sends reaches a root process.

Closing the PTY hangs the shell up, as a dropped SSH connection does. What a
user deliberately detached, such as `nohup`, outlives the window under their
logind session, as it would over SSH. Disabling the addon stops
every worker, which hangs up every shell, once its config is gone, so no worker
can start after.

## xterm.js

`@xterm/xterm` and `@xterm/addon-fit` are vendored unmodified under
`addons/terminal/app/vendor/` with their licence and the tarball's integrity
hash, and served from versioned paths with a year-long cache; the build
minifies `xterm.css` like every other stylesheet. The popup is the
one page whose content security policy allows `'self'` scripts and styles.

### Verification when opening root

Each new root shell requires a fresh six-digit authenticator code or a passkey
pinned in the root grant. Reconnecting to an existing shell does not prompt.
The popup offers both methods before creating the shell; site shells are unchanged.
Root issues a random five-minute challenge bound to the gateway-verified session
hash. Verification consumes the challenge, checks the current grant, and returns
a one-use ticket valid for sixty seconds, bound to that session and grant.
The popup sends the ticket with the shell request, the gateway hands it to the
root worker in its environment rather than on its command line, and the worker
consumes it before starting the shell. The journal's open line says which code
or passkey earned it, and each failed verification is journaled with the
account and the reason. An unexpected error while a code or signature is checked,
such as CloudPanel holding its database, reaches the popup as a generic message
and stays in the journal.

Root serializes challenges, attempts, used TOTP steps and tickets in root-only
state under `/var/lib/clp-addons/terminal/root-auth`. A code that matches no
current step, and any passkey response Security Keys rejects (a bad signature,
wrong origin, no user verification, a counter that went back, or data it cannot
parse), counts against the account: five in a rolling five minutes, or twenty
in a day, stop further prompts until the oldest ages out, so a stolen session
cannot keep guessing unattended. The budget is the account's, so someone
holding its session can spend it and keep its owner out; root ends that with
`clp-addons terminal root allow <user>` (or `deny`), which clears the account's
verification state. Successes, codes that are not six digits, codes refused for
their step (below) and errors on root's side spend nothing.
Codes use SHA-1 TOTP with thirty-second steps. Root's check allows one step of
clock tolerance either side, and a step can succeed only once. CloudPanel keeps no record of the code it
took at sign-in, and stamps the session when the password is accepted rather
than when the code is (measured on 2.5.4-3), so neither tells a relayed
sign-in code apart, and a phishing proxy holding the session holds that code.
The gateway, which every panel page asks within moments of loading, therefore
remembers when it first saw each signed-in session, keyed by the session's
digest and CloudPanel's sign-in stamp, and tells a session verb's worker in
`CLP_ADDONS_SESSION_SEEN`. CloudPanel takes a code up to two steps either side
of its clock, so the sign-in code is from no later than two steps after the
sighting's step, and only a code from a step after that counts. The code the app shows
works at once, except in the minute and a half after signing in, when the
prompt asks for the next one. The memory is the gateway's alone: after it
restarts, a session's next sighting stands in, which is later and so only
makes the wait longer, and with no sighting the prompt's own opening does.
Passkeys do not wait. Passkeys count only while Security Keys is
on, as at sign-in, and only pinned keys the account still has are offered, only
where the browser can use one, so not on an IP address. Passkey verification reuses Security Keys'
signature, origin, user verification, account and policy checks and updates its
signature counter. The existing grant and session rechecks remain in force.
