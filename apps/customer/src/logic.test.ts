import { describe, expect, it } from 'vitest';
import { cartTotal, requiresDeliveryAddress, type CartItem } from './logic.js';

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
