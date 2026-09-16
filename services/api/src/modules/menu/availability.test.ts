import { describe, expect, it } from 'vitest';

import { effectivePrice, resolveAvailability } from './availability.js';

describe('catalog price and availability resolution', () => {
  it('uses a location override when one exists', () => {
    expect(effectivePrice(1250, 1400)).toBe(1400);
    expect(effectivePrice(1250, null)).toBe(1250);
  });

  it('does not let a channel-specific exhaustion affect another channel', () => {
    const rules = [{ status: 'EXHAUSTED' as const, channel_scope: 'DELIVERY', service_type_scope: null, days_of_week: null, start_time: null, end_time: null }];
    expect(resolveAvailability(rules, { channel: 'DELIVERY', now: new Date('2026-09-15T12:00:00Z') })).toEqual({ status: 'EXHAUSTED', available: false });
    expect(resolveAvailability(rules, { channel: 'DINE_IN', now: new Date('2026-09-15T12:00:00Z') })).toEqual({ status: 'AVAILABLE', available: true });
  });

  it('honors scheduled day and time windows', () => {
    const rules = [{ status: 'HIDDEN' as const, channel_scope: null, service_type_scope: null, days_of_week: [2], start_time: new Date('2026-09-14T00:00:00Z'), end_time: new Date('2026-09-15T23:59:59Z') }];
    expect(resolveAvailability(rules, { now: new Date('2026-09-15T12:00:00Z') })).toEqual({ status: 'HIDDEN', available: false });
    expect(resolveAvailability(rules, { now: new Date('2026-09-16T12:00:00Z') })).toEqual({ status: 'AVAILABLE', available: true });
  });
});
