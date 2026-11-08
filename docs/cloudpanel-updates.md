# When CloudPanel updates

The addons add small marked blocks to a few of CloudPanel's own files:

- page templates, for the **Addons** tab and the buttons addons put on CloudPanel's pages;
- the panel's Nginx vhost, for the `/addons/` page itself;
- `/etc/nginx/global_settings`, for Maintenance Mode's check.

A CloudPanel update, or an Nginx update for `global_settings`, can replace
these files. Update CloudPanel as usual; the addons never hold it back.

## What happens on its own

- **A file the update did not change** gets its blocks back within seconds, or
  at the next repair.
- **A file the update changed** is checked. If every line the addons attach
  to is still there exactly once, the new file is recorded and patched again,
  and the journal says so (`journalctl -u 'clp-addons-*'`).
- **Otherwise the file is left exactly as CloudPanel shipped it.** CloudPanel
  keeps working; only the affected addon's buttons or links are missing. The
  Addons page shows **Paused until checked** with what to do, and so does
  `clp-addons status`.

Nothing is decided while the update is still running. The first repair after
it finishes does that, within 15 minutes; run `clp-addons repair` to do it
straight away.

System Tweaks' fixes that replace CloudPanel code, such as the `clpctl`
wrapper and remote backup compression, are applied only to the exact CloudPanel
code they were checked against. If an update puts back code they do not know,
they leave it alone and System Tweaks shows them as paused until a release
supports that version. A hardened `clpctl` wrapper that is already in place
stays in place.

## What to run

| The Addons page or `status` says | Do this |
| --- | --- |
| a line the addons attach to is gone, appears more than once, or would clash | Nothing for now. That part stays off until a CloudPanel Addons release supports this CloudPanel version; run `clp-addons update` once one is out. |
| the file changed, but CloudPanel was not updated | Someone edited the file. If the edit is wanted, run `clp-addons repair --rebaseline`; otherwise put the file back. |
| there is no record of the version it was patched under | The file was patched before this check existed. Look at the change, then run `clp-addons repair --rebaseline`. |
| part of an addon block is left in it | Remove the leftover `clp-addons` lines from the file, then run `clp-addons repair`. |
| CloudPanel is being updated | Nothing. |

`clp-addons repair --rebaseline` accepts a changed file only if every block
still fits it. It never changes System Tweaks' pinned fixes.

## Supported CloudPanel versions

Each release states which CloudPanel versions it supports; `clp-addons status`
shows the range next to the installed version.

- `clp-addons update` refuses a release that needs a newer CloudPanel than the
  one installed. Update CloudPanel first with `clp-update`, then run
  `clp-addons update` again.
- On a CloudPanel newer than the release was checked against, installs and
  updates go ahead with a warning. The checks above keep the addons off any
  page that changed.
