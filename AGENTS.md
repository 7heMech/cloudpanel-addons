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
