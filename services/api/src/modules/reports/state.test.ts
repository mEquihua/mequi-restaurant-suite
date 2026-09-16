import { describe, expect, it } from 'vitest';

import { averageTicket, toCsv } from './state.js';

describe('reports state helpers', () => {
  it('returns zero for an empty order set and preserves fractional average tickets', () => {
    expect(averageTicket(0, 0)).toBe(0);
    expect(averageTicket(1_001, 2)).toBe(500.5);
  });

  it('serializes one flat result set with RFC-style escaping', () => {
    expect(toCsv([{ label: 'Lunch, patio', value: 100 }, { label: '"Special"', value: 0 }])).toBe(
      'label,value\n"Lunch, patio",100\n"""Special""",0',
    );
  });
});
