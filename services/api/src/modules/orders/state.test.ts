import { describe, expect, it } from 'vitest';
import { canTransitionLineStatus, resolveLinePrice, splitEqually } from './state.js';

describe('orders pure rules', () => {
  it('allows only the independent line lifecycle transitions', () => {
    expect(canTransitionLineStatus('SENT', 'PREPARING')).toBe(true);
    expect(canTransitionLineStatus('READY', 'FULFILLED')).toBe(true);
    expect(canTransitionLineStatus('SENT', 'READY')).toBe(false);
    expect(canTransitionLineStatus('FULFILLED', 'VOIDED')).toBe(true);
  });
  it('keeps every cent in the first equal-split sibling', () => {
    expect(splitEqually(1001, 3)).toEqual([335, 333, 333]);
    expect(splitEqually(1, 3)).toEqual([1, 0, 0]);
  });
  it('resolves stored unit price from catalog components, never a client price', () => {
    expect(
      resolveLinePrice({
        basePrice: 1000,
        overridePrice: 1100,
        variantAdjustment: 100,
        modifierAdjustments: [25, -10],
        quantity: 2,
      }),
    ).toBe(1215);
  });
});
