// Comparing one secret with another, without telling the caller how much of it
// was right.

import { timingSafeEqual } from "node:crypto";

export function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // Length first; timingSafeEqual throws on a mismatch.
  return left.length === right.length && timingSafeEqual(left, right);
}
