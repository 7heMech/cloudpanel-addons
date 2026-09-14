# Repository guidance

- Keep `README.md` brief and user-facing: describe installation, everyday use,
  and links to the few operator guides users need.
- Record current architecture, security, constraints, and rationale in the
  matching `docs/decisions/*.md` file. Do not add history or superseded designs.
- Update or remove affected documentation in the same change as the code. Check
  every claim against the current implementation before keeping it.
- Keep operator procedures in their focused guide, such as
  `docs/instatic-backups.md`; keep implementation detail in Decisions.
- Add a Decisions category only when none of the existing files fits. Keep
  `docs/DECISIONS.md` as an index.

## Seeing the UI

- `bun run preview:ui` serves every addon page with fictional data on
  `http://127.0.0.1:4100/addons/`.
- `bun run preview:shot /addons/ /addons/stager/` writes PNGs of those pages to
  `/tmp/clp-addons-ui` (starts the preview and bootstraps a headless Chromium
  itself); read the files to review a change visually.
- `bun run deploy:stg` builds and installs the binary on the staging CloudPanel
  box, whose panel is at `https://46.225.93.37:8443/addons` (SSH as `root` with
  `~/.ssh/cloudpanel-addons-dev-0bad61aa9144`). Use it for anything the preview
  cannot show, such as real panel data or injection into CloudPanel's own pages.
