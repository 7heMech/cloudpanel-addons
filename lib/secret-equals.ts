// Comparing one secret with another, without telling the caller how much of it
// was right. Its own module because both halves of the project need it: the
// CSRF guard in the manager and the webhook token in the Git addon's action.

import { timingSafeEqual } from "node:crypto";

export function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // Length first; timingSafeEqual throws on a mismatch.
  return left.length === right.length && timingSafeEqual(left, right);
}
