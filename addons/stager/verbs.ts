// Every verb `clp-addons action stager` takes, and who may ask root for it from the web.
export const STAGER_VERBS = {
  sites: { web: "admin" },
  clone: { web: "admin" },
  promote: { web: "admin" },
  describe: { web: "admin" },
  jobs: { web: "admin" },
  prune: { web: "admin" },
  job: { web: "admin" },
  "watch-job": { web: "admin", stream: "one-way" },
  run: { web: false, why: "the job runner, started only by the transient unit the create path launches" },
} as const;
