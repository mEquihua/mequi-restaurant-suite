import { describe, expect, it } from 'vitest';
import { computeExpectedAmount, computeVariance } from './state.js';

describe('cash drawer state', () => {
  describe('computeExpectedAmount', () => {
    it('computes correctly with all parameters', () => {
      const opening = 10000; // $100.00
      const sales = 50000;   // $500.00
      const ins = 5000;      // $50.00
      const outs = 10000;    // $100.00
      
      const expected = computeExpectedAmount(opening, sales, ins, outs);
      expect(expected).toBe(55000); // 100 + 500 + 50 - 100 = 550
    });

    it('handles zero sales, ins, and outs', () => {
      expect(computeExpectedAmount(10000, 0, 0, 0)).toBe(10000);
    });
  });

  describe('computeVariance', () => {
    it('returns zero for exact match', () => {
      expect(computeVariance(55000, 55000)).toBe(0);
    });

    it('returns positive variance when over', () => {
      expect(computeVariance(60000, 55000)).toBe(5000);
    });

    it('returns negative variance when short', () => {
      expect(computeVariance(50000, 55000)).toBe(-5000);
    });
  });
});
