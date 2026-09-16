export const tableStatuses = ['AVAILABLE', 'OCCUPIED', 'NEEDS_CLEANING', 'OUT_OF_ORDER'] as const;
export type TableStatus = (typeof tableStatuses)[number];

/**
 * Administrative commands intentionally do not set OCCUPIED; Orders owns that transition.
 * AVAILABLE -> OUT_OF_ORDER; OCCUPIED -> NEEDS_CLEANING or OUT_OF_ORDER;
 * NEEDS_CLEANING -> AVAILABLE or OUT_OF_ORDER; OUT_OF_ORDER -> NEEDS_CLEANING.
 * Re-activating an out-of-order table therefore deliberately routes it through cleaning.
 */
const transitions: Readonly<Record<TableStatus, readonly TableStatus[]>> = {
  AVAILABLE: ['OUT_OF_ORDER'],
  OCCUPIED: ['NEEDS_CLEANING', 'OUT_OF_ORDER'],
  NEEDS_CLEANING: ['AVAILABLE', 'OUT_OF_ORDER'],
  OUT_OF_ORDER: ['NEEDS_CLEANING'],
};

export function canTransitionTableStatus(from: TableStatus, to: TableStatus): boolean {
  return transitions[from].includes(to);
}
