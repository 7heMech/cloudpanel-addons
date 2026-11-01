// Every verb `clp-addons action security-keys` takes, and who may ask root for it from the web.
export const SECURITY_KEYS_VERBS = {
  // Asked by the login page before there is a session; the key's signature,
  // checked as root, is the credential.
  "login-options": { web: "pre-gate" },
  "sign-in": { web: "pre-gate" },
  keys: { web: "own-account" },
  "register-options": { web: "own-account" },
  register: { web: "own-account" },
  remove: { web: "own-account" },
  users: { web: "admin" },
  revoke: { web: "admin" },
  settings: { web: "admin" },
} as const;
