/**
 * What a job id looks like, in one place.
 *
 * The syntax was written out three times: once in `cli/job-store.ts`, which
 * creates the ids, and once in each of the Stager and Instatic app services,
 * which check them. The app copies could not import the first without pulling
 * the CLI's job orchestration -- directory layout, systemd unit naming, pruning
 * -- into a module that only wanted to know whether a string was a job id. So
 * the syntax lives here, where both sides can have it, and `cli/job-store.ts`
 * re-exports it for everything that already names it there.
 *
 * A job id is the UTC timestamp of its creation and six hex characters. It is
 * also a directory name, which is why nothing outside this shape is ever
 * accepted: the id reaches a path join.
 */
export const JOB_ID_RE = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$/;

/** The id when `value` is one, or null. Never throws, never rewrites. */
export function validateJobId(value: unknown): string | null {
  return typeof value === "string" && JOB_ID_RE.test(value) ? value : null;
}

/** A job in one of these states will never change again. */
export function isTerminalJobState(state: string): boolean {
  return state === "done" || state === "failed";
}
