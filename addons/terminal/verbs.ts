// Every verb `clp-addons action terminal` takes, and who may ask root for it from the web.
// The gateway checks the session behind `session` itself, rather than trusting
// the manager; see docs/decisions/terminal.md.
export const TERMINAL_VERBS = {
  "root-auth-options": { web: "own-account" },
  "root-auth-verify": { web: "own-account" },
  session: { web: "admin", stream: "duplex" },
  "root-access": { web: "own-account" },
} as const;
