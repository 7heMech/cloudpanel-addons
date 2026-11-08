/**
 * What a job id and a job state look like, in one place.
 *
 * `lib/job-store.ts` creates the ids and the app services check them. The app
 * services must not pull in the job orchestration -- directory layout, systemd
 * unit naming, pruning -- to learn whether a string is a job id, so the syntax
 * lives here and `lib/job-store.ts` re-exports it.
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

/** A job in one of these states has, or is still waiting for, a runner. */
export function isActiveJobState(state: string): boolean {
  return state === "queued" || state === "running";
}
