import { describe, expect, it } from 'vitest';

import { canTransitionTableStatus } from './status.js';

describe('administrative table status transitions', () => {
  it('requires cleaning before an occupied table becomes available', () => {
    expect(canTransitionTableStatus('OCCUPIED', 'AVAILABLE')).toBe(false);
    expect(canTransitionTableStatus('OCCUPIED', 'NEEDS_CLEANING')).toBe(true);
    expect(canTransitionTableStatus('NEEDS_CLEANING', 'AVAILABLE')).toBe(true);
  });

  it('requires deliberate reactivation through cleaning for out-of-order tables', () => {
    expect(canTransitionTableStatus('AVAILABLE', 'OUT_OF_ORDER')).toBe(true);
    expect(canTransitionTableStatus('OUT_OF_ORDER', 'AVAILABLE')).toBe(false);
    expect(canTransitionTableStatus('OUT_OF_ORDER', 'NEEDS_CLEANING')).toBe(true);
  });
});
