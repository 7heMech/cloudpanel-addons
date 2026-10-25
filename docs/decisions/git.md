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

Post-deploy commands use a login shell, so the site's configured PATH is loaded
from its normal login profile. This makes user-installed runtimes and custom
toolchains available without hard-coding one ecosystem's bin directory. The
command still runs as the site user, in the deployed directory, and within the
job timeout.

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
does not wait on the process that started it. The runner takes the lock in turn
and drops it as soon as the record says `running`, because from there the record
is what refuses a second deployment. Holding it for the whole deployment meant a
second deploy or delivery waited on the lock until the gateway's own timeout
expired, and an operator was told the gateway had failed where the answer was
that the site was already deploying. Records expire after 14 days and
the repair pass marks a deployment whose runner died as failed.

The same repair pass removes the record of a site CloudPanel no longer has, so a
domain created again does not inherit the old repository, post-deploy command
and live webhook URL. It removes nothing when the panel database cannot be read
or lists no site.

## Surfaces

The site-scoped page is a tab in CloudPanel's own site page, mounted through
`lib/shadow-embed.ts` beside Maintenance and Staging. A connected site leads
with one status card: the checked-out commit, the last deployment's state badge
with when and how it started ("4 minutes ago · push"), its error and output,
and Deploy now. A checkout is reported separately from job success because a
failed post-deploy command can leave the new files in place. Deploy is disabled
while a job is queued or running; a deployment started there is watched in the
same card, with failed output expanded.

Below it one Settings card holds three rows that open, each set once:
Repository settings (summarised as repository, branch and command), Deploy key
and Push to deploy. The deploy key row is open until a checkout exists, and
while an SSH remote has no key it moves to the top. HTTPS remotes have no key
row. The repository form puts the URL, branch and post-deploy command in one
row; Advanced holds the subdirectory and Stop deploying. Saving an SSH remote
generates the deploy key as part of the save, so the sequence is save, add the
key to the repository, deploy. Key replacement and webhook URL rotation sit
beside their Copy buttons and keep their confirmations.

The Push to deploy switch sits on its row, beside the last delivery's outcome.
While it is on the row opens to the webhook URL and GitHub's steps (behind a
GitHub summary for other remotes) and an Other providers & CI summary with the
generic POST. A site nobody has connected yet shows only the connection form.

`/addons/git/` is the fleet view: each configured site's branch, checkout and
latest deployment. A line above the table names the sites that need attention,
and why, only when some do: a site absent from CloudPanel or with unreadable
settings, a failed deployment, an SSH remote with no deploy key, or a last
delivery the token let in that deployed nothing for a reason other than another
branch. The fleet reply carries no webhook tokens and no keys; it reads a key
only for an SSH remote, to say whether one exists. Rows are selected by click
or checkbox for Deploy selected, which skips active jobs and unavailable sites;
from six sites a search and a filter (needs attention, deploying) sit above the
table. Connect a site links to CloudPanel's site list, where each site's Git tab
starts setup.

CloudPanel's own site list carries a "Deploy from Git" link, left of the
panel's own "Manage" and marked with `ROW_ACTION_CLASS` so Panel Tweaks' row
menu can collect it -- that list is the fleet page an operator is already on,
and a link on a site with no repository would be an invitation rather than an
action. Which sites those are is in this addon's own records, which Twig cannot
see, so the link is rendered hidden and one script after the table asks
`domains` -- the directory listing behind the fleet view, rather than the fleet
view, because the panel serves this page constantly. Rows that are not deploying
lose the link outright, and so do all of them when no answer arrives: hiding is
not enough once the menu has moved the link into a list that styles its links
back into view.

There is deliberately no card on the panel's Add Site page: it would have to
reproduce the panel's own site creation -- PHP version, vhost template, site
user, TLS -- and drift with every CloudPanel release. The link in the site list
is the panel-native answer to the same wish.

Settings mutations return the site renderer's HTML alongside their data. The
browser repaints in its document or shadow root and rebuilds webhook URLs from
its own origin. Deployment starts and completions read the view API; fleet
selections and named disclosures survive repainting.

## Who reaches it

Administrators, and CloudPanel's site managers. The addon declares
`siteManager` in its catalog definition and the manager's gate admits that role
to the whole mount, because CloudPanel does not narrow a site manager's site
list -- the fleet page is already the fleet that role manages. Nothing here is
scoped per caller as a result, and `ROLE_USER` stays behind the blanket gate:
scoping every verb to one account's sites is work this addon has not done.

Deploying hands a site manager no authority the panel has not: every command
runs as the site's own user, which is the account CloudPanel already gives that
role the file manager for. The injected Twig names both roles rather than
relying on CloudPanel's role hierarchy, which this project does not own, and
the addon's own reproduction of the site tab strip drops the tabs a
non-administrator cannot reach so it draws what the panel's strip draws.

## Push to deploy

`POST /addons/git/hook/<domain>/<token>` deploys a site. The token is 32 random
bytes this addon mints, kept in the site's own `0600` record, and it is the
whole authentication for the route: a repository sends no CSRF token and its
Origin is not the panel, so `guardMutation` cannot apply and the URL is the
credential. That is why it is minted rather than chosen, why the page says to
keep it private, and why rotating it is how a leaked one is revoked.

The route is decided in `handleRequest` before the session gate, and it returns
a response *only* when the root gateway confirmed the token. Everything else --
a stranger, a wrong token, a rotated one, a site with no webhook, a `GET` --
returns null and falls through to the gate, which answers with the same login
redirect any other path gives a stranger. So the manager gained a second
credential type rather than an exception list, and the URL is not an oracle for
which sites have a webhook. The manager cannot check the token itself: it runs
as `clp-addons` and cannot read the record, so `hook` both verifies the token
and queues the deployment in one round trip.

The manager half is transport and nothing else: it hands over the bytes the
repository sent and the `X-GitHub-Event` header, and reads nothing out of the
body. Which ref was pushed is decided by the action, where the token has just
been checked, so what is acted on is what was authenticated -- and the
unauthenticated half parses no attacker-supplied JSON at all.

There is no `X-Hub-Signature-256` check. A signature keyed with the URL's own
token is computable by anyone who can call the URL, so it proved nothing the
token had not already proved, and honouring it only when sent meant it could not
be relied on either. The URL is the one credential, and it is the one that is
rotated.

What happens after the token matches is reported rather than hidden, because a
refusal an operator cannot see is a webhook they cannot fix. The delivery's time
and outcome are recorded on the site and drawn on its page, and the reply says
`deployed: false` with the reason. Three things end there: a push for a ref that
is not the configured branch, the repository's first `ping`, and a delivery that
arrives while the last one is still deploying, which the duplicate-job guard
refuses. Nothing is remembered about a delivery once its deployment ends: a
redelivery after that deploys again, which fetches the same commit and runs the
post-deploy command a second time. Keeping delivery identifiers to refuse it
would be a store to write, bound and expire for a button a person presses by
hand. A delivery carrying no push payload at all deploys the configured branch,
so `curl -X POST` from a CI job works.

A delivery with a well-formed token that is wrong still costs one gateway round
trip and one action process, and a gateway that is down is answered exactly as a
wrong token is. Both are the price of having no oracle: the manager cannot tell
a wrong token from an unknown one, or from an unanswered question, without being
able to read the record itself. The action checks the token before it takes the
site's lock, and again once it holds it, so a delivery without the token never
keeps a real deployment waiting.
