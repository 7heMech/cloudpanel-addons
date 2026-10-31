// Every verb `clp-addons action panel-tweaks` takes, and who may ask root for it from the web.
export const PANEL_TWEAKS_VERBS = {
  // Read by the script on CloudPanel's own Sites page, which every panel user
  // sees; a non-administrator is named with --as-user and gets their own rows.
  state: { web: "panel-user" },
  "set-tweaks": { web: "admin" },
  // A size measurement, run as a background job that `job` and `watch-job` follow.
  measure: { web: "admin" },
  job: { web: "admin" },
  "watch-job": { web: "admin", stream: "one-way" },
  scan: { web: false, why: "the repair timer's sweep; the page starts a measure job instead" },
  run: { web: false, why: "the measurement runner, started only by the transient unit measure launches" },
} as const;
