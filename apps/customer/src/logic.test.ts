import { describe, expect, it } from 'vitest';
import { cartTotal, meetsDeliveryMinimum, requiresDeliveryAddress, type CartItem } from './logic.js';

const item: CartItem = {
  quantity: 2,
  modifierIds: ['extra'],
  product: {
    id: 'product',
    category_id: null,
    name: 'Burger',
    internal_name: null,
    description: null,
    photo_url: null,
    notes: null,
    allergens: [],
    tags: [],
    is_active: true,
    version: 1,
    price: 1000,
    variants: [],
    combo_groups: [],
    availability: { status: 'AVAILABLE', available: true },
    modifier_groups: [
      {
        id: 'group',
        name: 'Extras',
        min_selections: 0,
        max_selections: null,
        is_active: true,
        display_order: 0,
        modifiers: [
          { id: 'extra', name: 'Cheese', price_adjustment: 200, display_order: 0, is_active: true },
        ],
      },
    ],
  },
};

describe('cart totals', () => {
  it('includes selected modifiers for every quantity', () => expect(cartTotal([item])).toBe(2400));
});

describe('fulfillment form rules', () => {
  it('requires an address only for delivery', () => {
    expect(requiresDeliveryAddress('DELIVERY')).toBe(true);
    expect(requiresDeliveryAddress('PICKUP')).toBe(false);
  });
});

describe('meetsDeliveryMinimum', () => {
  it('returns true when there is no zone', () => {
    expect(meetsDeliveryMinimum(1000)).toBe(true);
  });
  it('returns true when cart total meets minimum', () => {
    expect(meetsDeliveryMinimum(2000, { minimum_order_amount: 1500 })).toBe(true);
    expect(meetsDeliveryMinimum(1500, { minimum_order_amount: 1500 })).toBe(true);
  });
  it('returns false when cart total is below minimum', () => {
    expect(meetsDeliveryMinimum(1499, { minimum_order_amount: 1500 })).toBe(false);
  });
});
