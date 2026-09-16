import { describe, expect, it } from 'vitest';

import { normalizeQuantity } from './index.js';

describe('normalizeQuantity', () => {
  it('does not return negative quantities', () => {
    expect(normalizeQuantity(-3)).toBe(0);
    expect(normalizeQuantity(4)).toBe(4);
  });
});
