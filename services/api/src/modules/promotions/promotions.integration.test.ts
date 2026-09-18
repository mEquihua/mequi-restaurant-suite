import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
import argon2 from 'argon2';
import Fastify from 'fastify';

import { identityModule } from '../identity/index.js';
import { createDatabase, installDatabase } from '../../shared/index.js';
import { promotionsModule } from './index.js';
import { ordersModule } from '../orders/index.js';
import { menuModule } from '../menu/index.js';

const databaseUrl = process.env.DATABASE_URL;
const db = createDatabase({ databaseUrl });
const describeIntegration = databaseUrl ? describe : describe.skip;

function terminalCredential(locationId: string, terminalId: string) {
  return `${locationId}.${terminalId}.${randomBytes(32).toString('base64url')}`;
}
function credentialHash(credential: string) {
  return createHash('sha256').update(credential).digest('hex');
}

describeIntegration('promotions module', () => {
  const app = Fastify();
  installDatabase(app, { databaseUrl });
  app.register(identityModule, {});
  app.register(ordersModule, {});
  app.register(promotionsModule, {});
  app.register(menuModule, {});

  let organizationId: string;
  let locationId: string;
    let staffSession: string;

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
      'organizations',
    ])
      await db.deleteFrom(table as never).execute();

    const org = await db.insertInto('organizations').values({ name: 'Promo Org' }).returning('id').executeTakeFirstOrThrow();
    organizationId = org.id;

    const loc = await db.insertInto('locations').values({ organization_id: organizationId, name: 'Main', timezone: 'UTC' }).returning('id').executeTakeFirstOrThrow();
    locationId = loc.id;
    
    const owner = await db.insertInto('staff').values({ organization_id: organizationId, first_name: 'O', last_name: 'W', pin_hash: await argon2.hash('1234') }).returning('id').executeTakeFirstOrThrow();
        
    const role = await db.insertInto('roles').values({ organization_id: organizationId, name: 'Admin' }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('role_permissions').values([
      { role_id: role.id, permission_name: 'promotions.promotions.read', scope: 'organization' },
      { role_id: role.id, permission_name: 'promotions.promotions.write', scope: 'organization' },
      { role_id: role.id, permission_name: 'orders.visits.create', scope: 'location' },
      { role_id: role.id, permission_name: 'orders.orders.create', scope: 'location' },
      { role_id: role.id, permission_name: 'accounts.accounts.create', scope: 'location' },
      { role_id: role.id, permission_name: 'orders.lines.add', scope: 'location' }
    ]).execute();

    await db.insertInto('staff_roles').values({ staff_id: owner.id, role_id: role.id }).execute();

    const terminalId = crypto.randomUUID();
    const credential = terminalCredential(locationId, terminalId);
    await db.insertInto('terminals').values({ id: terminalId, location_id: locationId, name: 'Reg', credential_hash: credentialHash(credential) }).execute();

    const unlock = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/pin-unlock',
      headers: { 'X-Terminal-Credential': credential },
      payload: { staff_id: owner.id, pin: '1234' },
    });
    staffSession = unlock.json().token;
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('crud promotions', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/promotions',
      headers: { authorization: `Bearer ${staffSession}` },
      body: {
        name: 'Happy Hour',
        discount_type: 'PERCENTAGE',
        discount_value: 20,
        is_active: true,
      },
    });
    expect(createRes.statusCode).toBe(201);
    const promoId = createRes.json().id;
    const version = createRes.json().version;

    const getRes = await app.inject({
      method: 'GET',
      url: '/api/v1/promotions',
      headers: { authorization: `Bearer ${staffSession}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().data.length).toBe(1);

    const updateRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/promotions/${promoId}`,
      headers: { authorization: `Bearer ${staffSession}`, 'if-match': `"${version}"` },
      body: {
        name: 'Happy Hour (Updated)',
        discount_type: 'PERCENTAGE',
        discount_value: 25,
        is_active: false,
      },
    });
    expect(updateRes.statusCode).toBe(200);
    
    // Test optimistic concurrency
    const badUpdateRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/promotions/${promoId}`,
      headers: { authorization: `Bearer ${staffSession}`, 'if-match': `"${version}"` },
      body: {
        name: 'Conflict',
        discount_type: 'PERCENTAGE',
        discount_value: 10,
        is_active: true,
      },
    });
    expect(badUpdateRes.statusCode).toBe(409);
  });
  
  it('adds order lines and computes promotion best match', async () => {
    // We will create some products and active promotions to test.
    const cat = await db.insertInto('categories').values({ organization_id: organizationId, name: 'Drinks' }).returning('id').executeTakeFirstOrThrow();
    const p1 = await db.insertInto('products').values({ organization_id: organizationId, category_id: cat.id, name: 'Coke', base_price: 300 }).returning('id').executeTakeFirstOrThrow();
    const p2 = await db.insertInto('products').values({ organization_id: organizationId, category_id: cat.id, name: 'Beer', base_price: 500 }).returning('id').executeTakeFirstOrThrow();
    
    // Create an order
    const visitRes = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/visits`,
      headers: { authorization: `Bearer ${staffSession}` },
      body: { source: 'WALK_IN', guests: 2 }
    });
    const visitId = visitRes.json().id;
    const visitVersion = visitRes.json().version;

    const accountRes = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/visits/${visitId}/accounts`,
      headers: { authorization: `Bearer ${staffSession}` },
      body: {}
    });
    const accountId = accountRes.json().id;

    const orderRes = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/visits/${visitId}/orders`,
      headers: { authorization: `Bearer ${staffSession}`, 'if-match': String(visitVersion) },
      body: { order_type: 'DINE_IN' }
    });
    const orderId = orderRes.json().id;
    let orderVersion = orderRes.json().version;

    // 1. No promotions active -> normal price
    const noPromoRes = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/orders/${orderId}/lines`,
      headers: { authorization: `Bearer ${staffSession}`, 'if-match': String(orderVersion) },
      body: {
        lines: [{ account_id: accountId, product_id: p1.id, quantity: 1 }]
      }
    });
    expect(noPromoRes.statusCode).toBe(201);
    orderVersion = noPromoRes.json().order.version;
    let account = await db.selectFrom('accounts').select('subtotal').where('id', '=', accountId).executeTakeFirst();
    expect(account?.subtotal).toBe(300);

    // 2. Active promotion (global) 10%
    await db.insertInto('promotions').values({
      organization_id: organizationId,
      name: 'Global 10%',
      discount_type: 'PERCENTAGE',
      discount_value: 10,
      is_active: true
    }).execute();

    const globalPromoRes = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/orders/${orderId}/lines`,
      headers: { authorization: `Bearer ${staffSession}`, 'if-match': String(orderVersion) },
      body: {
        lines: [{ account_id: accountId, product_id: p1.id, quantity: 1 }]
      }
    });
    expect(globalPromoRes.statusCode).toBe(201);
    orderVersion = globalPromoRes.json().order.version;
    // previous subtotal (300) + Coke(300) - 10%(30) = 570
    account = await db.selectFrom('accounts').select('subtotal').where('id', '=', accountId).executeTakeFirst();
    expect(account?.subtotal).toBe(570);

    // 3. Stacking (best wins): Global 10%, Category Drinks 20%
    await db.insertInto('promotions').values({
      organization_id: organizationId,
      name: 'Drinks 20%',
      discount_type: 'PERCENTAGE',
      discount_value: 20,
      category_id: cat.id,
      is_active: true
    }).execute();

    const stackingRes = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/orders/${orderId}/lines`,
      headers: { authorization: `Bearer ${staffSession}`, 'if-match': String(orderVersion) },
      body: {
        lines: [{ account_id: accountId, product_id: p2.id, quantity: 1 }] // Beer (500)
      }
    });
    expect(stackingRes.statusCode).toBe(201);
    orderVersion = stackingRes.json().order.version;
    const addedLine = stackingRes.json().lines[0];
    
    // Best is 20% of 500 = 100 (beats the 10% global rule). Previous subtotal 570 + 500 - 100 = 970.
    account = await db.selectFrom('accounts').select('subtotal').where('id', '=', accountId).executeTakeFirst();
    expect(account?.subtotal).toBe(970);
    
    // Check order_line_promotions has exactly one row for this line
    const ops = await db.selectFrom('order_line_promotions').selectAll().where('order_line_id', '=', addedLine.id).execute();
    expect(ops.length).toBe(1);
    expect(ops[0].computed_amount).toBe(100);

    // 4. Inactive or wrong day
    await db.insertInto('promotions').values({
      organization_id: organizationId,
      name: 'Wrong Day 100%',
      discount_type: 'PERCENTAGE',
      discount_value: 100,
      days_of_week: [8], // impossible day
      is_active: true
    }).execute();

    const noMatchRes = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/orders/${orderId}/lines`,
      headers: { authorization: `Bearer ${staffSession}`, 'if-match': String(orderVersion) },
      body: {
        lines: [{ account_id: accountId, product_id: p2.id, quantity: 1 }] // Beer (500)
      }
    });
    expect(noMatchRes.statusCode).toBe(201);
    orderVersion = noMatchRes.json().order.version;
    // Drinks 20% still applies (100). Subtotal = 970 + 500 - 100 = 1370. The 100% does not apply.
    account = await db.selectFrom('accounts').select('subtotal').where('id', '=', accountId).executeTakeFirst();
    expect(account?.subtotal).toBe(1370);
  });
});
