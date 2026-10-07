# Terminal

## Shape

One shell per site, as that site's Linux user, starting in its site root, in a
browser window of its own. It opens from a Sites row, from the right end of a
site's tab strip, and from Addons → Terminal. The window is named after the
site, so a second click focuses the shell already open; Shift-click opens
another. On a phone it is a tab.

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

Administrators only, and never root. A shell as a site's user is what SSH
already gives anyone with that user's key; it is offered to the people who can
already create one.

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
Keystrokes go one request at a time, in order. A popup that falls more than
2 MiB behind is dropped and replays from the ring when it reconnects.

A session belongs to one panel user and one CloudPanel session cookie; anything
else is told it does not exist. The manager checks the session every 15 seconds
while a window is attached, and so does the gateway, independently.

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
with no login shell, and a site root that resolves outside the home. Its
`runuser` argv is fixed; the site directory and size travel in environment
variables `runuser` is told to keep. `runuser`'s stderr is discarded, so a site
cannot write into the gateway's journal; the journal has only the worker's
"opened" and "closed" lines, and refusals with control characters replaced.
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
logind session, as it would over SSH. Disabling or uninstalling the addon stops
every worker, which hangs up every shell.

## xterm.js

`@xterm/xterm` and `@xterm/addon-fit` are vendored unmodified under
`addons/terminal/app/vendor/` with their licence and the tarball's integrity
hash, and served from versioned paths with a year-long cache. The popup is the
one page whose content security policy allows `'self'` scripts and styles.
