// Every verb `clp-addons action wp-tools` takes, and who may ask root for it from the web.
//
// Checks, installations, MainWP connections and cleanup are `start`ed as jobs
// of a fixed task list; no verb accepts a path or a command. Plugins for a new
// site are named only by a WordPress.org slug of a strict pattern or by the id
// root gave an upload. A site manager's `new-site*` calls carry --as-user, and
// root holds them to the administrator's `new-site-settings` switch and to
// directory plugins.
export const WP_TOOLS_VERBS = {
  sites: { web: "admin" },
  // From CloudPanel's own site pages, for anyone who can open them; a
  // non-administrator is named with --as-user and held to their own sites.
  "sign-in": { web: "panel-user" },
  "site-kind": { web: "panel-user" },
  remove: { web: "admin" },
  "varnish-settings": { web: "admin" },
  "mainwp-settings": { web: "admin" },
  "domain-link-settings": { web: "admin" },
  start: { web: "admin" },
  job: { web: "admin" },
  "watch-job": { web: "admin", stream: "one-way" },
  "plugin-upload": { web: "admin" },
  "plugin-discard": { web: "admin" },
  "new-site": { web: "site-manager" },
  "new-site-status": { web: "site-manager" },
  "new-site-access": { web: "site-manager" },
  "new-site-settings": { web: "admin" },
  run: { web: false, why: "the job runner, started only by the transient unit start launches" },
  sync: { web: false, why: "the policy pass repair queues every 15 minutes" },
  "varnish-install": { web: false, why: "run by hand; the page installs through a start job" },
  "varnish-sync": { web: false, why: "run by hand; the page checks through a start job" },
  "mainwp-sync": { web: false, why: "run by hand; the page checks through a start job" },
  "mainwp-connect": { web: false, why: "run by hand; the page connects through a start job" },
  "mainwp-cleanup": { web: false, why: "run by hand; the page cleans up through a start job" },
} as const;
