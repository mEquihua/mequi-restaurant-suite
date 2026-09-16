import { describe, expect, it } from 'vitest';

import { canPauseModule } from './status.js';

describe('Module Center state transitions', () => {
  it('allows pausing only an active module', () => {
    expect(canPauseModule('ACTIVE')).toBe(true);
    expect(canPauseModule('DISABLED')).toBe(false);
    expect(canPauseModule('PENDING_CONFIGURATION')).toBe(false);
    expect(canPauseModule('READY')).toBe(false);
    expect(canPauseModule('PAUSED')).toBe(false);
    expect(canPauseModule('NEEDS_ATTENTION')).toBe(false);
  });
});
