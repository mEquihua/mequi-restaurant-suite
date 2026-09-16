export const moduleStatuses = ['DISABLED', 'PENDING_CONFIGURATION', 'READY', 'ACTIVE', 'PAUSED', 'NEEDS_ATTENTION'] as const;
export type ModuleStatus = (typeof moduleStatuses)[number];

/** Module Center records owner-facing state; it deliberately does not resolve dependencies. */
export function canPauseModule(status: ModuleStatus): boolean {
  return status === 'ACTIVE';
}
