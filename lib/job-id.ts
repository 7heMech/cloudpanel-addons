// A job id is also a directory name, which is why nothing outside this shape is
// ever accepted: the id reaches a path join.
export const JOB_ID_RE = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$/;

export function validateJobId(value: unknown): string | null {
  return typeof value === "string" && JOB_ID_RE.test(value) ? value : null;
}

export function isTerminalJobState(state: string): boolean {
  return state === "done" || state === "failed";
}

export function isActiveJobState(state: string): boolean {
  return state === "queued" || state === "running";
}
