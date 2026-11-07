# Terminal

## Shape

One shell per site, as that site's Linux user, starting in its site root, in a
browser window of its own. It opens from a Sites row, from the right end of a
site's tab strip, and from Addons → Terminal. The window is named after the
site using a lossless encoding of its lowercase domain, so a second click
focuses the shell already open without confusing dots with hyphens; Shift-click
opens another. On a phone it is a tab.

Addons → Terminal lists each site with its user under the domain. From six
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
terminal icon in both of CloudPanel's headers and in the addons' copy of it,
just before the account menu, and a Root terminal button on Addons → Terminal.
The others get no icon; their button shows a notice naming the command, so
they know whom to ask. The icon stays hidden until the page has asked
`/addons/terminal/api/root-access`. Every panel page asks, so the manager
keeps root's answer a minute per user instead of starting a root process for
each page; the Terminal page asks afresh, and the worker always checks.

Any administrator can reset another's password in CloudPanel and sign in as
them, so a grant to a name alone would be a root shell for every
administrator. A grant therefore needs the account's two-factor
authentication on. CloudPanel's user form has no two-factor field: only the
account turns its own on or off, and only root (`clpctl user:disable:mfa`)
turns it off for someone else, so a reset password gets no further than the
code. The account's setting is not enough on its own: a session signed in
before two-factor was turned on stays signed in, and never passed the code.
So the gateway tells every session verb's worker, in
`CLP_ADDONS_SESSION_2FA`, whether that session carries CloudPanel's own
"two-factor passed" marker, and a root shell needs it. A passkey sign-in
through Security Keys is two factors itself but goes through CloudPanel's
`/autologin`, which writes no marker and looks the same as such an old
session, so it does not open a root shell; that administrator signs in with
the code for one.

Each grant is also pinned to CloudPanel's `user.id`, so a name deleted and
created again is not the account root allowed. A deactivation, a demotion or
two-factor switched off refuses it while it lasts and the button's notice says which;
switched back on, it works again without root. A password change does not
touch it. A stolen session of the allowed administrator itself still gets a
root shell for as long as that session lasts.

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
