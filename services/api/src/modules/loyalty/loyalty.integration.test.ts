import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import Fastify from 'fastify';

import { identityModule } from '../identity/index.js';
import { createDatabase, installDatabase } from '../../shared/index.js';
import { loyaltyModule } from './index.js';
import { ordersModule } from '../orders/index.js';
import { customersModule } from '../customers/index.js';

const databaseUrl = process.env.DATABASE_URL;
const db = createDatabase({ databaseUrl });
const describeIntegration = databaseUrl ? describe : describe.skip;

function terminalCredential(locationId: string, terminalId: string) {
  return `${locationId}.${terminalId}.${randomBytes(32).toString('base64url')}`;
}
function credentialHash(credential: string) {
  return createHash('sha256').update(credential).digest('hex');
}

describeIntegration('loyalty module', () => {
  const app = Fastify();
  installDatabase(app, { databaseUrl });
  app.register(identityModule, {});
  app.register(ordersModule, {});
  app.register(loyaltyModule, {});
  app.register(customersModule, {});

  let organizationId: string;
  let locationId: string;
  let ownerId: string;
  let staffSession: string;
  let customerSession: string;
  let customerId: string;

  beforeAll(async () => {
    for (const table of [
      'loyalty_transactions',
      'loyalty_redemptions',
      'loyalty_accounts',
      'loyalty_rewards',
      'loyalty_coupons',
      'loyalty_settings',
      'reservations',
      'reservation_settings',
      'stock_adjustments',
      'ingredient_stock',
      'recipe_lines',
      'ingredients',
      'cash_drawer_movements',
      'cash_drawer_sessions',
      'module_activations',
      'command_idempotency',
      'audit_events',
      'account_discounts',
      'outbox_events',
      'refunds',
      'cancellations_and_voids',
      'payments',
      'order_fulfillments',
      'order_line_modifiers',
      'order_line_promotions',
      'order_lines',
      'orders',
      'accounts',
      'guest_sessions',
      'visits',
      'table_sections',
      'sections',
      'tables',
      'areas',
      'availability_rules',
      'location_price_overrides',
      'product_combo_items',
      'product_combo_groups',
      'product_modifier_groups',
      'modifiers',
      'modifier_groups',
      'product_variants',
      'promotions',
      'products',
      'categories',
      'terminal_pin_attempts',
      'staff_sessions',
      'staff_roles',
      'role_permissions',
      'terminals',
      'timeclock_shifts',
      'staff',
      'roles',
      'customer_sessions',
      'customers',
      'delivery_zones',
      'scheduled_order_settings',
      'locations',
      'organizations'
    ] as const) {
      await db.deleteFrom(table).execute();
    }

    const organization = await db
      .insertInto('organizations')
      .values({ name: 'Loyalty Test' })
      .returning('id')
      .executeTakeFirstOrThrow();
    organizationId = organization.id;

    const location = await db
      .insertInto('locations')
      .values({ organization_id: organizationId, name: 'Main' })
      .returning('id')
      .executeTakeFirstOrThrow();
    locationId = location.id;

    const ownerRole = await db
      .insertInto('roles')
      .values({ organization_id: organizationId, name: 'Owner' })
      .returning('id')
      .executeTakeFirstOrThrow();
    
    await db.insertInto('role_permissions').values([
      { role_id: ownerRole.id, permission_name: 'loyalty.settings.read', scope: 'organization' },
      { role_id: ownerRole.id, permission_name: 'loyalty.settings.write', scope: 'organization' },
      { role_id: ownerRole.id, permission_name: 'loyalty.rewards.read', scope: 'organization' },
      { role_id: ownerRole.id, permission_name: 'loyalty.rewards.write', scope: 'organization' },
      { role_id: ownerRole.id, permission_name: 'loyalty.accounts.read', scope: 'organization' },
      { role_id: ownerRole.id, permission_name: 'loyalty.accounts.adjust', scope: 'organization' },
      { role_id: ownerRole.id, permission_name: 'orders.visits.create', scope: 'location' },
      { role_id: ownerRole.id, permission_name: 'orders.visits.close', scope: 'location' },
      { role_id: ownerRole.id, permission_name: 'orders.orders.create', scope: 'location' },
      { role_id: ownerRole.id, permission_name: 'accounts.accounts.create', scope: 'location' }
    ]).execute();

    const owner = await db
      .insertInto('staff')
      .values({ organization_id: organizationId, first_name: 'Owner', last_name: 'User', pin_hash: await argon2.hash('1234') })
      .returning('id')
      .executeTakeFirstOrThrow();
    ownerId = owner.id;

    await db.insertInto('staff_roles').values({ staff_id: ownerId, role_id: ownerRole.id }).execute();

    const terminalId = crypto.randomUUID();
    const credential = terminalCredential(locationId, terminalId);
    await db
      .insertInto('terminals')
      .values({ id: terminalId, location_id: locationId, credential_hash: credentialHash(credential), name: 'Terminal' })
      .execute();

    const unlock = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/pin-unlock',
      headers: { 'X-Terminal-Credential': credential },
      payload: { staff_id: ownerId, pin: '1234' },
    });
    staffSession = unlock.json().token;

    const customer = await db.insertInto('customers').values({
      organization_id: organizationId, email: 'loyalty@example.com', password_hash: 'abc', name: 'Test', phone: '+123456'
    }).returning('id').executeTakeFirstOrThrow();
    customerId = customer.id;

    // Mint a customer session directly rather than going through login, since this
    // module doesn't need to exercise the login flow itself.
    const custToken = 'customer.' + organizationId + '.' + '1'.repeat(32);
    await db.insertInto('customer_sessions').values({
      organization_id: organizationId, customer_id: customerId, token_hash: createHash('sha256').update(custToken).digest('hex'), expires_at: new Date(Date.now() + 100000)
    }).execute();
    customerSession = custToken;
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('sets up loyalty settings', async () => {
    const getRes = await app.inject({ method: 'GET', url: '/api/v1/loyalty-settings', headers: { authorization: `Bearer ${staffSession}` } });
    expect(getRes.statusCode).toBe(200);
    
    const putRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/loyalty-settings',
      headers: { authorization: `Bearer ${staffSession}` },
      payload: { spend_amount_for_one_point: 500 } // $5 = 1 point
    });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.json().spend_amount_for_one_point).toBe(500);
  });

  it('kiosk guest attach customer flow and point accrual on visit close', async () => {
    // create a visit
    const visitRes = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationId}/visits`, headers: { authorization: `Bearer ${staffSession}` }, payload: {} });
    const visitId = visitRes.json().id;

    // create guest session
    const guestToken = `guest.${locationId}.${'1'.repeat(32)}`;
    await db.insertInto('guest_sessions').values({
      location_id: locationId, visit_id: visitId, token_hash: createHash('sha256').update(guestToken).digest('hex'), expires_at: new Date(Date.now() + 100000)
    }).execute();

    // attach customer via guest session
    const attachRes = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/visits/${visitId}/attach-customer`,
      headers: { authorization: `Bearer ${guestToken}` },
      payload: { phone: '+123456' } // matches existing customer
    });
    expect(attachRes.statusCode).toBe(200);
    expect(attachRes.json().customer_id).toBe(customerId);

    // create an order and account, simulate paid status manually via DB.
    // attach-customer above already bumped the visit's version, so read the
    // real current version from the DB rather than assuming it's still 1.
    const visitAfterAttach = await db.selectFrom('visits').select('version').where('id', '=', visitId).executeTakeFirstOrThrow();
    const orderRes = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationId}/visits/${visitId}/orders`, headers: { 'If-Match': `"${visitAfterAttach.version}"`, authorization: `Bearer ${staffSession}` }, payload: { order_type: 'DINE_IN' } });
    expect(orderRes.statusCode).toBe(201);
    const accountRes = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationId}/visits/${visitId}/accounts`, headers: { authorization: `Bearer ${staffSession}` }, payload: {} });
    const accountId = accountRes.json().id;

    await db.updateTable('accounts').set({ subtotal: 1200, status: 'PAID' }).where('id', '=', accountId).execute();
    await db.updateTable('orders').set({ status: 'SENT' }).where('visit_id', '=', visitId).execute();

    // close visit
    const visitBeforeClose = await db.selectFrom('visits').select('version').where('id', '=', visitId).executeTakeFirstOrThrow();
    const closeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/visits/${visitId}/close`,
      headers: { 'If-Match': `"${visitBeforeClose.version}"`, authorization: `Bearer ${staffSession}` },
      payload: {}
    });
    expect(closeRes.statusCode).toBe(200);

    // check points
    const acc = await db.selectFrom('loyalty_accounts').selectAll().where('customer_id', '=', customerId).executeTakeFirst();
    expect(acc?.points_balance).toBe(2); // 1200 / 500 = 2
    expect(acc?.total_visits).toBe(1);
  });

  it('creates and redeems a reward', async () => {
    const rewardRes = await app.inject({
      method: 'POST',
      url: '/api/v1/loyalty-rewards',
      headers: { authorization: `Bearer ${staffSession}` },
      payload: { name: 'Free Drink', discount_type: 'PERCENTAGE', discount_value: 10, cost_in_points: 2 }
    });
    expect(rewardRes.statusCode).toBe(201);
    const rewardId = rewardRes.json().id;

    // create a new visit
    const visitRes = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationId}/visits`, headers: { authorization: `Bearer ${staffSession}` }, payload: {} });
    const visitId = visitRes.json().id;

    await db.updateTable('visits').set({ customer_id: customerId }).where('id', '=', visitId).execute();

    const accountRes = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationId}/visits/${visitId}/accounts`, headers: { authorization: `Bearer ${staffSession}` }, payload: {} });
    const accountId = accountRes.json().id;
    await db.updateTable('accounts').set({ subtotal: 1000, total: 1000 }).where('id', '=', accountId).execute();

    const redeemRes = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/visits/${visitId}/redeem-reward`,
      headers: { authorization: `Bearer ${staffSession}` },
      payload: { reward_id: rewardId }
    });
    expect(redeemRes.statusCode).toBe(200);
    const discountId = redeemRes.json().discount_id;

    const discount = await db.selectFrom('account_discounts').selectAll().where('id', '=', discountId).executeTakeFirst();
    expect(discount?.discount_type).toBe('PERCENTAGE');
    expect(discount?.value).toBe(10);
    expect(discount?.computed_amount).toBe(100);

    const acc = await db.selectFrom('loyalty_accounts').selectAll().where('customer_id', '=', customerId).executeTakeFirst();
    expect(acc?.points_balance).toBe(0); // 2 - 2
  });

  it('rejects redemption for insufficient balance', async () => {
    const rewardRes = await app.inject({
      method: 'POST',
      url: '/api/v1/loyalty-rewards',
      headers: { authorization: `Bearer ${staffSession}` },
      payload: { name: 'Expensive', discount_type: 'AMOUNT', discount_value: 1000, cost_in_points: 100 }
    });
    const rewardId = rewardRes.json().id;

    const visitRes = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationId}/visits`, headers: { authorization: `Bearer ${staffSession}` }, payload: {} });
    const visitId = visitRes.json().id;
    await db.updateTable('visits').set({ customer_id: customerId }).where('id', '=', visitId).execute();
    const accountRes = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationId}/visits/${visitId}/accounts`, headers: { authorization: `Bearer ${staffSession}` }, payload: {} });
    await db.updateTable('accounts').set({ subtotal: 1000, total: 1000 }).where('id', '=', accountRes.json().id).execute();

    const redeemRes = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/visits/${visitId}/redeem-reward`,
      headers: { authorization: `Bearer ${staffSession}` },
      payload: { reward_id: rewardId }
    });
    expect(redeemRes.statusCode).toBe(409);
    expect(redeemRes.json().error.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('staff manual point adjustment', async () => {
    const adjustRes = await app.inject({
      method: 'POST',
      url: `/api/v1/customers/${customerId}/loyalty/adjust`,
      headers: { authorization: `Bearer ${staffSession}` },
      payload: { points_delta: 5, reason: 'Customer service' }
    });
    expect(adjustRes.statusCode).toBe(200);

    const acc = await db.selectFrom('loyalty_accounts').selectAll().where('customer_id', '=', customerId).executeTakeFirst();
    expect(acc?.points_balance).toBe(5);
  });

  it('customer can view their own balance and history', async () => {
    const meRes = await app.inject({
      method: 'GET',
      url: '/api/v1/customers/me/loyalty',
      headers: { authorization: `Bearer ${customerSession}` }
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().points_balance).toBe(5);

    const historyRes = await app.inject({
      method: 'GET',
      url: '/api/v1/customers/me/loyalty/history',
      headers: { authorization: `Bearer ${customerSession}` }
    });
    expect(historyRes.statusCode).toBe(200);
    expect(historyRes.json().data.length).toBeGreaterThan(0);
  });
});
