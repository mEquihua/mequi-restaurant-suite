export const lineStatuses = [
  'DRAFT',
  'HELD',
  'SENT',
  'PREPARING',
  'READY',
  'FULFILLED',
  'CANCELLED',
  'VOIDED',
] as const;
export type LineStatus = (typeof lineStatuses)[number];

const transitions: Readonly<Record<LineStatus, readonly LineStatus[]>> = {
  DRAFT: ['HELD', 'SENT', 'CANCELLED', 'VOIDED'],
  HELD: ['SENT', 'CANCELLED', 'VOIDED'],
  SENT: ['PREPARING', 'CANCELLED', 'VOIDED'],
  PREPARING: ['READY', 'VOIDED'],
  READY: ['FULFILLED', 'VOIDED'],
  FULFILLED: ['VOIDED'],
  CANCELLED: [],
  VOIDED: [],
};
export function canTransitionLineStatus(from: LineStatus, to: LineStatus): boolean {
  return transitions[from].includes(to);
}
export function splitEqually(total: number, count: number): number[] {
  if (!Number.isSafeInteger(total) || total < 0 || !Number.isInteger(count) || count < 2)
    throw new Error('Invalid equal split.');
  const base = Math.floor(total / count);
  const result = Array.from({ length: count }, () => base);
  result[0] += total % count;
  return result;
}
export function resolveLinePrice(input: {
  basePrice: number;
  overridePrice?: number | null;
  variantAdjustment?: number;
  modifierAdjustments: readonly number[];
  quantity: number;
}): number {
  if (!Number.isInteger(input.quantity) || input.quantity < 1)
    throw new Error('Quantity must be positive.');
  const unit =
    (input.overridePrice ?? input.basePrice) +
    (input.variantAdjustment ?? 0) +
    input.modifierAdjustments.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(unit) || unit < 0) throw new Error('Invalid resolved price.');
  return unit;
}
export function lineAmount(line: { quantity: number; unit_price: number }): number {
  return line.quantity * line.unit_price;
}
