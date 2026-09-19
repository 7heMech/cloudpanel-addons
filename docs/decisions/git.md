# Git Deploy

## What it deploys

One repository per CloudPanel site: a remote URL, a branch, a subdirectory of
the site's own directory and an optional post-deploy command, saved in this
addon's state directory as a root-owned `0600` record per site. CloudPanel is
the source of truth for the site user and for whether the site exists at all;
the record holds only what the panel has no column for.

A deployment fetches the configured branch and moves the working tree onto
`FETCH_HEAD` with `reset --hard`. It does not `git clean`: what the repository
carries is replaced, and what the site wrote for itself -- uploads, a `.env`, a
cache directory -- is left where it is. A deployment that swept untracked files
would take the site's own data with it, and a hosting panel is the wrong place
to learn that. The first deployment into a directory that already holds files
therefore adopts it rather than refusing it: only paths the repository has are
replaced.

The post-deploy command runs last, in the deployed directory, and its failure
fails the job with the files already in place. There is no rollback: the way
back is the previous commit, deployed the same way.

## Privileges

Every command runs as the site's own user through `runuser`: `git`,
`ssh-keygen`, and the operator's post-deploy command. Root reads CloudPanel's
database to learn which user that is, writes this addon's own records and
starts the job; it never runs the repository's code. The site user's name comes
out of the panel database and is checked against the shape an account name can
have before it reaches a `runuser -u` argument.

The deploy key is generated as the site user, into that account's own `.ssh`
directory, and only its public half is ever reported. A key is never accepted
from the browser: what the panel can send is "generate one" and "replace the
one you have". Reading the public half back is root reading a file inside a
directory the site user controls, so it is opened with `O_NOFOLLOW`, checked on
the descriptor to be that user's own regular file, bounded, and required to
look like the ed25519 public key it claims to be.

Remotes are HTTPS and SSH only. A `file://`, `ext::` or bare local path would
make a deployment read whatever the site user can reach on the host, and plain
HTTP would carry the fetch in the clear. Userinfo in an HTTPS URL is refused
too: a token pasted into the form would be stored in this addon's record and
printed back into the page, and the site's own deploy key is what a private
repository is for. The stored record is validated again when the job runs, so a
record written by an older release cannot reach a command line unchecked.

Host keys are accepted on first use (`StrictHostKeyChecking=accept-new`) and
`BatchMode` and `GIT_TERMINAL_PROMPT=0` are set, because nobody is at a
terminal to confirm a host key or type a password; a remote that wants one
fails instead of hanging until the job's ten-minute timeout.

## Jobs

A deployment is a job in a transient systemd unit, through `cli/job-store.ts`,
so it survives a manager restart, and it is watched through `lib/job-stream.ts`
like every other job on the platform. One site has at most one deployment
running: the create path holds the site's lock, refuses a second while one is
queued or running, and releases the lock before the unit starts so the runner
does not wait on the process that started it. Records expire after 14 days and
the repair pass marks a deployment whose runner died as failed.

## Surfaces

The site-scoped page is a tab in CloudPanel's own site page, mounted through
`lib/shadow-embed.ts` beside Maintenance and Staging: it shows the commit that
is deployed, the configuration form, the deploy key and the last deployment's
log. A deployment started there is watched in the card it was started from
rather than on a page of its own, because navigating away would leave the
panel's page behind to show a log.

`/addons/git/` is the fleet view: every configured site, its branch, what it
last deployed and when, with per-row and multi-select deploy. That is the
altitude the list exists for -- deploying ten sites after one merge is the case
a per-site form cannot answer.

## Push-to-deploy

Not in this version, and not as an addon decision. Every route the manager
serves is behind the administrator gate in `lib/sso-auth.ts`, which is
deliberately the first thing a request meets, before the URL is taken apart and
before any route is chosen, so that there is no exception list to keep correct.
A webhook needs an unauthenticated route, which is a change to that decision
rather than a feature of this addon; adding one quietly would put the first
hole in the property the gate exists to have. Deployments are started from the
panel until that decision is made on its own.
