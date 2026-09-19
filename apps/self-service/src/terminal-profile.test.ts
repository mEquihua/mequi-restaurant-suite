import { describe, expect, it } from 'vitest';

import { resolveSelfServiceTerminalRoute } from './terminal-profile.js';

const location_id = '00000000-0000-4000-8000-000000000001';

describe('resolveSelfServiceTerminalRoute', () => {
  it.each([
    [{ mode: 'KIOSK' }, `/${location_id}/kiosk`],
    [{ mode: 'TABLE', table_id: '00000000-0000-4000-8000-000000000002' }, `/${location_id}/table/00000000-0000-4000-8000-000000000002`],
    [{ mode: 'ORDER_STATUS' }, `/${location_id}/status-board`],
  ])('maps each supported Self-Service profile', (profile_config, expected) => {
    expect(
      resolveSelfServiceTerminalRoute({
        terminal_id: '00000000-0000-4000-8000-000000000003',
        location_id,
        app_target: 'SELF_SERVICE',
        profile_config,
      }),
    ).toBe(expected);
  });

  it('rejects missing, wrong-target, and malformed configurations', () => {
    expect(
      resolveSelfServiceTerminalRoute({ terminal_id: 't', location_id, app_target: null, profile_config: null }),
    ).toBeNull();
    expect(
      resolveSelfServiceTerminalRoute({ terminal_id: 't', location_id, app_target: 'KITCHEN', profile_config: { scope: 'ALL' } }),
    ).toBeNull();
    expect(
      resolveSelfServiceTerminalRoute({ terminal_id: 't', location_id, app_target: 'SELF_SERVICE', profile_config: { mode: 'KIOSK', extra: true } }),
    ).toBeNull();
  });
});
