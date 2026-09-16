/** Returns a non-negative quantity suitable for later domain commands. */
export function normalizeQuantity(quantity: number): number {
  return Math.max(0, quantity);
}
