import { sql } from 'kysely';
import type { DatabaseTransaction } from '../../shared/index.js';
import { IdentityHttpError } from '../identity/index.js';
import { findAccount, findOrder } from './persistence/repository.js';
import { lineAmount, resolveLinePrice } from './state.js';

export type GuestLineInput = { product_id: string; variant_id?: string; modifier_ids?: string[]; quantity: number };

async function updateAccountTotal(trx: DatabaseTransaction, locationId: string, accountId: string, delta: number) {
  const account = await findAccount(trx, locationId, accountId);
  if (!account) throw new IdentityHttpError(400, 'INVALID_ACCOUNT', 'Account was not found in this location.');
  const total = account.total + delta;
  if (total < 0) throw new IdentityHttpError(409, 'ACCOUNT_TOTAL_UNDERFLOW', 'The account total cannot become negative.');
  const updated = await trx.updateTable('accounts').set({ subtotal: account.subtotal + delta, total, version: sql<number>`version + 1` }).where('id', '=', accountId).where('version', '=', account.version).returningAll().executeTakeFirst();
  if (!updated) throw new IdentityHttpError(409, 'OPTIMISTIC_CONCURRENCY_CONFLICT', 'Account modified since it was read.');
  return updated;
}

/** Shared order-line command used by staff routes and the restricted guest facade. */
export async function addOrderLines(
  trx: DatabaseTransaction,
  input: { locationId: string; organizationId: string; orderId: string; expectedVersion: number; lines: Array<GuestLineInput & { account_id: string; seat_number?: number | null; course_name?: string | null }> },
) {
  const order = await findOrder(trx, input.locationId, input.orderId);
  if (!order) throw new IdentityHttpError(404, 'NOT_FOUND', 'Order was not found.');
  if (order.version !== input.expectedVersion) throw new IdentityHttpError(409, 'OPTIMISTIC_CONCURRENCY_CONFLICT', 'Resource modified since it was read.', { current_version: order.version, current_state: order });
  if (!['DRAFT', 'HELD', 'SENT'].includes(order.status)) throw new IdentityHttpError(409, 'ORDER_NOT_MUTABLE', 'Lines cannot be added to this order.');
  const created = [];
  for (const lineInput of input.lines) {
    const account = await findAccount(trx, input.locationId, lineInput.account_id);
    if (!account || account.visit_id !== order.visit_id) throw new IdentityHttpError(400, 'INVALID_ACCOUNT_FOR_VISIT', 'account_id must belong to the same visit as the order.');
    if (!['OPEN', 'PARTIALLY_PAID'].includes(account.status)) throw new IdentityHttpError(409, 'ACCOUNT_NOT_OPEN', 'Lines require an open account.');
    const product = await trx.selectFrom('products').selectAll().where('id', '=', lineInput.product_id).where('organization_id', '=', input.organizationId).where('is_active', '=', true).executeTakeFirst();
    if (!product) throw new IdentityHttpError(400, 'INVALID_PRODUCT', 'Product is unavailable.');
    const override = await trx.selectFrom('location_price_overrides').select('override_price').where('location_id', '=', input.locationId).where('product_id', '=', product.id).executeTakeFirst();
    let variantAdjustment = 0;
    if (lineInput.variant_id) {
      const variant = await trx.selectFrom('product_variants').selectAll().where('id', '=', lineInput.variant_id).where('product_id', '=', product.id).executeTakeFirst();
      if (!variant) throw new IdentityHttpError(400, 'INVALID_VARIANT', 'Variant does not belong to product.');
      variantAdjustment = variant.price_adjustment;
    }
    const modifierIds = lineInput.modifier_ids ?? [];
    const modifiers = modifierIds.length ? await trx.selectFrom('modifiers as m').innerJoin('product_modifier_groups as pmg', 'pmg.modifier_group_id', 'm.modifier_group_id').select(['m.id', 'm.price_adjustment', 'm.is_active']).where('pmg.product_id', '=', product.id).where('m.id', 'in', modifierIds).execute() : [];
    if (modifiers.length !== modifierIds.length || modifiers.some((modifier) => !modifier.is_active)) throw new IdentityHttpError(400, 'INVALID_MODIFIER', 'Modifier is not available for this product.');
    const line = await trx.insertInto('order_lines').values({ location_id: input.locationId, order_id: input.orderId, account_id: account.id, product_id: product.id, variant_id: lineInput.variant_id ?? null, seat_number: lineInput.seat_number ?? null, course_name: lineInput.course_name?.trim() ?? null, quantity: lineInput.quantity, unit_price: resolveLinePrice({ basePrice: product.base_price, overridePrice: override?.override_price, variantAdjustment, modifierAdjustments: modifiers.map((modifier) => modifier.price_adjustment), quantity: lineInput.quantity }) }).returningAll().executeTakeFirstOrThrow();
    if (modifiers.length) await trx.insertInto('order_line_modifiers').values(modifiers.map((modifier) => ({ location_id: input.locationId, order_line_id: line.id, modifier_id: modifier.id, unit_price: modifier.price_adjustment }))).execute();
    await updateAccountTotal(trx, input.locationId, account.id, lineAmount(line));
    created.push(line);
  }
  const updated = await trx.updateTable('orders').set({ version: sql<number>`version + 1` }).where('id', '=', input.orderId).where('version', '=', input.expectedVersion).returningAll().executeTakeFirst();
  if (!updated) throw new IdentityHttpError(409, 'OPTIMISTIC_CONCURRENCY_CONFLICT', 'Resource modified since it was read.', { current_version: order.version, current_state: order });
  return { order: updated, lines: created };
}
