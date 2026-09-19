export type TerminalProfileLookup = {
  terminal_id: string;
  location_id: string;
  app_target: 'KITCHEN' | 'SELF_SERVICE' | 'STAFF' | null;
  profile_config: unknown | null;
};

/** Returns the sole permitted dedicated-device route, or null for a mismatch. */
export function resolveSelfServiceTerminalRoute(profile: TerminalProfileLookup): string | null {
  if (profile.app_target !== 'SELF_SERVICE' || !profile.profile_config) return null;
  const config = profile.profile_config as Record<string, unknown>;
  if (config.mode === 'KIOSK' && Object.keys(config).length === 1)
    return `/${profile.location_id}/kiosk`;
  if (
    config.mode === 'TABLE' &&
    typeof config.table_id === 'string' &&
    Object.keys(config).length === 2
  )
    return `/${profile.location_id}/table/${config.table_id}`;
  if (config.mode === 'ORDER_STATUS' && Object.keys(config).length === 1)
    return `/${profile.location_id}/status-board`;
  return null;
}
