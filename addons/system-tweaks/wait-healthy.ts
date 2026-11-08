interface HealthWait<P> {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  intervalMs: number;
  /** A problem waiting cannot fix, which ends the wait at once. */
  final?: (problem: P) => boolean;
}

export async function waitHealthy<P>(unhealthy: () => Promise<P | null>, wait: HealthWait<P>): Promise<P | null> {
  const deadline = wait.now() + wait.timeoutMs;
  let problem = await unhealthy();
  while (problem && !wait.final?.(problem) && wait.now() < deadline) {
    await wait.sleep(wait.intervalMs);
    problem = await unhealthy();
  }
  return problem;
}
