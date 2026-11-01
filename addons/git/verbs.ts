// Every verb `clp-addons action git` takes, and who may ask root for it from the web.
export const GIT_VERBS = {
  sites: { web: "site-manager" },
  domains: { web: "site-manager" },
  status: { web: "site-manager" },
  configure: { web: "site-manager" },
  forget: { web: "site-manager" },
  keygen: { web: "site-manager" },
  "webhook-enable": { web: "site-manager" },
  "webhook-disable": { web: "site-manager" },
  // A push-to-deploy delivery, before any session: the token in its URL is
  // the credential, and only root can read the token.
  hook: { web: "pre-gate" },
  deploy: { web: "site-manager" },
  job: { web: "site-manager" },
  jobs: { web: "site-manager" },
  "watch-job": { web: "site-manager", stream: "one-way" },
  run: { web: false, why: "the deployment runner, started only by the transient unit the deploy path launches" },
  prune: { web: false, why: "retention sweeping, run by the reconcile timer" },
} as const;
