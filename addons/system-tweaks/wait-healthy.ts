export interface HealthWait<P> {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  /** Between one ask and the next. */
  intervalMs: number;
  /** A problem waiting cannot fix, which ends the wait at once. */
  final?: (problem: P) => boolean;
}

/**
 * Ask `unhealthy` until it finds nothing wrong, the problem is final, or the
 * timeout passes. Returns the last problem, or null once there is none.
 */
export async function waitHealthy<P>(unhealthy: () => Promise<P | null>, wait: HealthWait<P>): Promise<P | null> {
  const deadline = wait.now() + wait.timeoutMs;
  let problem = await unhealthy();
  while (problem && !wait.final?.(problem) && wait.now() < deadline) {
    await wait.sleep(wait.intervalMs);
    problem = await unhealthy();
  }
  return problem;
}
