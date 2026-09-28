# CloudPanel Addons

Extra features for [CloudPanel](https://www.cloudpanel.io/): staging copies,
maintenance pages, Git deploys, one-click WordPress sign-in, and more. You sign
in with your existing CloudPanel login.

## Install

Log in to your server as **root** and run:

```bash
curl -fsSL https://github.com/7heMech/cloudpanel-addons/releases/latest/download/install.sh | bash
```

The installer asks which addons you want, checks that the download is genuine,
and installs Docker or Postfix when a selected addon needs it. Requires an
x86-64 CloudPanel host.

When it finishes, open the new **Addons** tab in CloudPanel.

![CloudPanel Addons Manager](docs/screenshots/addons.png)

## Addons

| Addon | Description |
| --- | --- |
| Cloudflare IP Access | Allow traffic from Cloudflare only, across all sites and for new ones. |
| [Instatic CMS](https://github.com/CoreBunch/Instatic) | Instatic CMS sites on CloudPanel. |
| Stager | Staging copies of WordPress, PHP, static and Instatic sites, and promotion back to live. Based on [clp-stager](https://github.com/7heMech/clp-stager). |
| Maintenance Mode | A customizable 503 page per site, with instant toggles and IP bypasses. |
| PHP Resources | Categories of PHP-FPM worker limits, assigned in bulk and to new sites. |
| [SMTP Relay](docs/smtp-relay.md) | Send PHP and WordPress mail through a shared or per-domain SMTP relay. |
| Git Deploy | Deploys from a Git remote, from the panel or from a push. |
| Panel Tweaks | Site search and columns, mobile layouts and theme improvements. |
| WordPress Sign-In | One-click sign-in to any WordPress on the server, no password needed. |

Only CloudPanel administrators see the Addons tab, except that site managers
also reach Git Deploy. Other panel users get the WordPress Sign-In link on the
Sites page for their own sites, and nothing else.

## Manage

| Command | Purpose |
| --- | --- |
| `clp-addons status` | Check services and CloudPanel integration. |
| `clp-addons install <addon>` | Enable an addon, installing Docker if it needs it. |
| `clp-addons update` | Install the latest verified release. |
| `clp-addons repair` | Restore managed services and CloudPanel integration. |
| `clp-addons maintenance <domain> [on\|off\|status]` | Control or inspect maintenance mode for a site. |
| `clp-addons uninstall <addon> --yes` | Remove an addon and keep its data. |

Addon names are `cloudflare-ips`, `instatic`, `stager`, `maintenance`,
`php-resources`, `git`, `panel-tweaks`, `wp-login`, and `smtp`. Run
`clp-addons --help` for version selection and data removal options.

See [Instatic backup and restore](docs/instatic-backups.md) for CloudPanel Remote
Backups.

## Develop

Requires Bun and ShellCheck.

```bash
bun install
bun run typecheck
bun run test
bun run lint:install
bun run build
```

Run `bun run preview:ui` to preview the interface at
`http://localhost:4100/addons/` with sample data.

Pull requests target `dev`. A pull request and `dev` itself each deploy to the
staging CloudPanel box, so a change can be tried on a real panel; `main` is what
gets tagged and released.

Architecture and security choices are indexed in
[Decisions](docs/DECISIONS.md).

## Acknowledgments

Thanks to [@ccMatrix](https://github.com/ccMatrix) for the CloudPanel SSO and
Nginx reverse proxy integration concept.

## License

[Apache-2.0](LICENSE).
