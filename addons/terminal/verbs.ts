// Every verb `clp-addons action terminal` takes, and who may ask root for it from the web.
// The gateway checks the session behind `session` itself, rather than trusting
// the manager; see docs/decisions/terminal.md.
export const TERMINAL_VERBS = {
  session: { web: "admin", stream: "duplex" },
} as const;
