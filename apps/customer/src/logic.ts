import type { Product } from './api.js';

export type CartItem = {
  product: Product;
  quantity: number;
  modifierIds: string[];
};

export function cartItemPrice(item: CartItem) {
  const modifiers = item.product.modifier_groups.flatMap((group) => group.modifiers);
  return (
    item.product.price +
    item.modifierIds.reduce(
      (total, id) =>
        total + (modifiers.find((modifier) => modifier.id === id)?.price_adjustment ?? 0),
      0,
    )
  );
}

export function cartTotal(items: CartItem[]) {
  return items.reduce((total, item) => total + cartItemPrice(item) * item.quantity, 0);
}

export function requiresDeliveryAddress(fulfillmentType: 'PICKUP' | 'DELIVERY') {
  return fulfillmentType === 'DELIVERY';
}

export function meetsDeliveryMinimum(cartTotalCents: number, zone?: { minimum_order_amount: number }) {
  if (!zone) return true;
  return cartTotalCents >= zone.minimum_order_amount;
}
