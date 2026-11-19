// Every verb `clp-addons action manager` takes. The manager is not an addon,
// but enabling one and replacing the binary are root work an administrator
// asks for from the web, so they go through the same gateway.
export const MANAGER_VERBS = {
  enable: { web: "admin" },
  disable: { web: "admin" },
  update: { web: "admin" },
  job: { web: "admin" },
  "watch-job": { web: "admin", stream: "one-way" },
  // Which New and Changed badges an administrator has opened, keyed by addon name.
  "news-seen": { web: "admin" },
  "mark-news-seen": { web: "admin" },
  // The CloudPanel files the addons are leaving alone after a change they cannot prove fits.
  holds: { web: "admin" },
  // Renders every addon's block in the panel's shared templates again; an
  // addon that reconciled only its own would strip the others.
  reconcile: { web: "admin" },
  // The Setup checklist for the administrator --user names, and their skips and Hide.
  setup: { web: "admin" },
  "setup-pref": { web: "admin" },
  run: { web: false, why: "the job runner, started only by the transient unit enable, disable and update launch" },
} as const;
