import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';

import { createDatabase, installDatabase } from '../../shared/index.js';
import { identityModule } from '../identity/index.js';
import { menuModule } from '../menu/index.js';
import { floorModule } from '../floor/index.js';
import { ordersModule } from './index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

describeIntegration('scheduled orders API integration tests', () => {
  const db = createDatabase({ databaseUrl });
  const app = Fastify({ logger: false });
  installDatabase(app, { databaseUrl });
  app.register(identityModule);
  app.register(menuModule);
  app.register(floorModule);
  app.register(ordersModule);

  
  let locationId = '';
  let productId = '';
  let staffSessionToken = '';

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

    const org = await db.insertInto('organizations').values({ name: 'Org' }).returning('id').executeTakeFirstOrThrow();

    const loc = await db.insertInto('locations').values({ organization_id: org.id, name: 'Main Loc' }).returning('id').executeTakeFirstOrThrow();
    locationId = loc.id;

    const prod = await db.insertInto('products').values({ organization_id: org.id, name: 'Test Product', is_active: true, base_price: 100 }).returning('id').executeTakeFirstOrThrow();
    productId = prod.id;
    await db.insertInto('product_variants').values({ product_id: prod.id, name: 'Default', price_adjustment: 0, display_order: 1 }).execute();

    const staffId = randomUUID();
    await db.insertInto('staff').values({
      id: staffId,
      organization_id: org.id,
      first_name: 'Staff',
      last_name: 'Member',
      pin_hash: 'ignored',
    }).execute();

    const role = await db.insertInto('roles').values({
      organization_id: org.id,
      name: 'Manager',
    }).returning('id').executeTakeFirstOrThrow();

    await db.insertInto('staff_roles').values({
      staff_id: staffId,
      role_id: role.id,
    }).execute();

    for (const perm of [
      'online_ordering.settings.read',
      'online_ordering.settings.write',
      'kitchen.tickets.read',
    ]) {
      await db.insertInto('role_permissions').values({
        role_id: role.id,
        permission_name: perm, scope: 'GLOBAL',
      }).execute();
    }

    const terminalId = randomUUID();
    const termCred = randomBytes(32).toString('base64url');
    await db.insertInto('terminals').values({ id: terminalId, location_id: locationId, name: 'Main', credential_hash: hash(termCred) }).execute();

    const rawToken = randomBytes(32).toString('base64url');
    staffSessionToken = `${locationId}.${rawToken}`;
    await db.insertInto('staff_sessions').values({
      location_id: locationId,
      terminal_id: terminalId,
      staff_id: staffId,
      token_hash: hash(rawToken),
      expires_at: new Date(Date.now() + 1000 * 60 * 60 * 24),
    }).execute();

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('gets default settings when no row exists', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${locationId}/scheduled-order-settings`,
      headers: { authorization: `Bearer ${staffSessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accepts_scheduled_orders).toBe(false);
    expect(body.minimum_lead_time_minutes).toBe(60);
    expect(body.version).toBe(1);
  });

  it('updates settings (and handles optimistic concurrency)', async () => {
    const putRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/locations/${locationId}/scheduled-order-settings`,
      headers: { authorization: `Bearer ${staffSessionToken}` },
      payload: {
        accepts_scheduled_orders: true,
        minimum_lead_time_minutes: 120,
        maximum_lead_time_days: 14,
        operating_hours: [{ day_of_week: 1, open_time: '08:00', close_time: '22:00' }],
        version: 1,
      },
    });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.json().version).toBe(2);

    const conflictRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/locations/${locationId}/scheduled-order-settings`,
      headers: { authorization: `Bearer ${staffSessionToken}` },
      payload: {
        accepts_scheduled_orders: true,
        minimum_lead_time_minutes: 120,
        maximum_lead_time_days: 14,
        operating_hours: [],
        version: 1, // Conflict
      },
    });
    expect(conflictRes.statusCode).toBe(409);
  });

  const getCheckoutPayload = (scheduledFor?: Date) => ({
    fulfillment_type: 'PICKUP',
    customer_name: 'Test Customer',
    customer_email: 'test@example.com',
    customer_phone: '1234567890',
    items: [{ product_id: productId, quantity: 1 }],
    scheduled_for: scheduledFor ? scheduledFor.toISOString() : undefined,
  });

  it('validates checkout: accepts_scheduled_orders', async () => {
    // Disable scheduled orders
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${locationId}/scheduled-order-settings`,
      headers: { authorization: `Bearer ${staffSessionToken}` },
    });
    const currentVersion = getRes.json().version;

    await app.inject({
      method: 'PUT',
      url: `/api/v1/locations/${locationId}/scheduled-order-settings`,
      headers: { authorization: `Bearer ${staffSessionToken}` },
      payload: {
        accepts_scheduled_orders: false,
        minimum_lead_time_minutes: 60,
        maximum_lead_time_days: 7,
        operating_hours: [],
        version: currentVersion,
      },
    });

    const scheduledDate = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const checkoutRes = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/online-orders/checkout`,
      payload: getCheckoutPayload(scheduledDate),
    });
    expect(checkoutRes.statusCode).toBe(400);
    expect(checkoutRes.json().error.code).toBe('SCHEDULED_ORDERS_NOT_ACCEPTED');
  });

  it('validates checkout: in the past', async () => {
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${locationId}/scheduled-order-settings`,
      headers: { authorization: `Bearer ${staffSessionToken}` },
    });
    
    await app.inject({
      method: 'PUT',
      url: `/api/v1/locations/${locationId}/scheduled-order-settings`,
      headers: { authorization: `Bearer ${staffSessionToken}` },
      payload: {
        accepts_scheduled_orders: true,
        minimum_lead_time_minutes: 60,
        maximum_lead_time_days: 7,
        operating_hours: [
          { day_of_week: 1, open_time: '00:00', close_time: '23:59' },
          { day_of_week: 2, open_time: '00:00', close_time: '23:59' },
          { day_of_week: 3, open_time: '00:00', close_time: '23:59' },
          { day_of_week: 4, open_time: '00:00', close_time: '23:59' },
          { day_of_week: 5, open_time: '00:00', close_time: '23:59' },
          { day_of_week: 6, open_time: '00:00', close_time: '23:59' },
          { day_of_week: 7, open_time: '00:00', close_time: '23:59' },
        ],
        version: getRes.json().version,
      },
    });

    const pastDate = new Date(Date.now() - 10000);
    const checkoutRes = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/online-orders/checkout`,
      payload: getCheckoutPayload(pastDate),
    });
    expect(checkoutRes.statusCode).toBe(400);
    expect(checkoutRes.json().error.code).toBe('TIME_IN_PAST');
  });

  it('validates checkout: below minimum lead time', async () => {
    const soonDate = new Date(Date.now() + 30 * 60 * 1000); // 30 mins
    const checkoutRes = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/online-orders/checkout`,
      payload: getCheckoutPayload(soonDate),
    });
    expect(checkoutRes.statusCode).toBe(400);
    expect(checkoutRes.json().error.code).toBe('LEAD_TIME_TOO_SHORT');
  });

  it('validates checkout: past maximum lead time', async () => {
    const farDate = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000); // 8 days
    const checkoutRes = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/online-orders/checkout`,
      payload: getCheckoutPayload(farDate),
    });
    expect(checkoutRes.statusCode).toBe(400);
    expect(checkoutRes.json().error.code).toBe('LEAD_TIME_TOO_LONG');
  });

  it('validates checkout: outside operating hours', async () => {
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${locationId}/scheduled-order-settings`,
      headers: { authorization: `Bearer ${staffSessionToken}` },
    });
    
    await app.inject({
      method: 'PUT',
      url: `/api/v1/locations/${locationId}/scheduled-order-settings`,
      headers: { authorization: `Bearer ${staffSessionToken}` },
      payload: {
        accepts_scheduled_orders: true,
        minimum_lead_time_minutes: 60,
        maximum_lead_time_days: 7,
        operating_hours: [], // No operating hours
        version: getRes.json().version,
      },
    });

    const validDate = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const checkoutRes = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/online-orders/checkout`,
      payload: getCheckoutPayload(validDate),
    });
    expect(checkoutRes.statusCode).toBe(400);
    expect(checkoutRes.json().error.code).toBe('OUTSIDE_OPERATING_HOURS');
  });

  it('processes a successful scheduled checkout when settings allow it, and kitchen-display filters it', async () => {
    // Restore permissive operating hours
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${locationId}/scheduled-order-settings`,
      headers: { authorization: `Bearer ${staffSessionToken}` },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/locations/${locationId}/scheduled-order-settings`,
      headers: { authorization: `Bearer ${staffSessionToken}` },
      payload: {
        accepts_scheduled_orders: true,
        minimum_lead_time_minutes: 60,
        maximum_lead_time_days: 7,
        operating_hours: [
          { day_of_week: 1, open_time: '00:00', close_time: '23:59' },
          { day_of_week: 2, open_time: '00:00', close_time: '23:59' },
          { day_of_week: 3, open_time: '00:00', close_time: '23:59' },
          { day_of_week: 4, open_time: '00:00', close_time: '23:59' },
          { day_of_week: 5, open_time: '00:00', close_time: '23:59' },
          { day_of_week: 6, open_time: '00:00', close_time: '23:59' },
          { day_of_week: 7, open_time: '00:00', close_time: '23:59' },
        ],
        version: getRes.json().version,
      },
    });

    // 1. ASAP order
    const asapRes = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/online-orders/checkout`,
      payload: getCheckoutPayload(),
    });
    expect(asapRes.statusCode).toBe(201);
    const asapOrderId = asapRes.json().order_id;

    // 2. Scheduled order within threshold (1.5 hrs is not within 60 mins... wait, let's just make one far-future)
    const farFutureDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000); // 5 days
    const farRes = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/online-orders/checkout`,
      payload: getCheckoutPayload(farFutureDate),
    });
    expect(farRes.statusCode).toBe(201);
    const farOrderId = farRes.json().order_id;

    // We can manually update the scheduled_for of one to be within 60 minutes for the test
    const soonOrderId = (await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/online-orders/checkout`,
      payload: getCheckoutPayload(new Date(Date.now() + 120 * 60 * 1000)), // 2 hours
    })).json().order_id;

    await db.updateTable('order_fulfillments').set({ scheduled_for: new Date(Date.now() + 30 * 60 * 1000) }).where('order_id', '=', soonOrderId).execute();

    // Check kitchen display endpoint
    const kdsRes = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${locationId}/order-lines?exclude_future_scheduled=true`,
      headers: { authorization: `Bearer ${staffSessionToken}` },
    });
    expect(kdsRes.statusCode).toBe(200);
    const lines = kdsRes.json().data;
    
    const includedOrderIds = lines.map((l: { order_id: string }) => l.order_id);
    
    // ASAP order should be included
    expect(includedOrderIds).toContain(asapOrderId);
    // Soon order should be included
    expect(includedOrderIds).toContain(soonOrderId);
    // Far order should NOT be included
    expect(includedOrderIds).not.toContain(farOrderId);
  });
});
