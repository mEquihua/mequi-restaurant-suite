import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';

import { createDatabase, installDatabase } from '../../shared/index.js';
import { identityModule } from '../identity/index.js';
import { menuModule } from '../menu/index.js';
import { floorModule } from '../floor/index.js';
import { ordersModule } from '../orders/index.js';
import { customersModule } from '../customers/index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration('online ordering list endpoint integration tests against PostgreSQL', () => {
  const db = createDatabase({ databaseUrl });
  const app = Fastify({ logger: false });
  installDatabase(app, { databaseUrl });
  app.register(identityModule);
  app.register(menuModule);
  app.register(floorModule);
  app.register(ordersModule);
  app.register(customersModule);

  let organization = '';
  let location = '';
  let product = '';
  let deliveryZone = '';
  let customer1Token = '';
  let customer1Id = '';
  let customer2Token = '';

  const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    // Clear relevant tables
    for (const name of [
      'stock_adjustments',
      'ingredient_stock',
      'recipe_lines',
      'ingredients',
      'cash_drawer_movements',
      'cash_drawer_sessions',
      'module_activations',
      'command_idempotency',
      'audit_events',
      'loyalty_transactions',
      'loyalty_redemptions',
      'loyalty_accounts',
      'loyalty_rewards',
      'loyalty_coupons',
      'loyalty_settings',
      'account_discounts',
      'outbox_events',
      'refunds',
      'cancellations_and_voids',
      'payments',
      'order_fulfillments',
      'reservations',
      'reservation_settings',
      'customer_sessions',
      'customers',
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
      'delivery_zones',
      'scheduled_order_settings',
      'locations',
      'organizations'
    ] as const) {
      await db.deleteFrom(name).execute().catch(() => {});
    }

    const orgRow = await db
      .insertInto('organizations')
      .values({ name: 'Online List Test Org' })
      .returning('id')
      .executeTakeFirstOrThrow();
    organization = orgRow.id;
    location = (
      await db
        .insertInto('locations')
        .values({ organization_id: organization, name: 'Main Location' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    product = (
      await db
        .insertInto('products')
        .values({ organization_id: organization, name: 'Pizza', base_price: 1200 })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    deliveryZone = (
      await db
        .insertInto('delivery_zones')
        .values({ location_id: location, name: 'Test Zone', fee: 0, minimum_order_amount: 0, active: true })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;

    // Register customer 1
    const reg1 = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organization}/customers`,
      payload: { email: 'cust1@example.com', password: 'password123', name: 'Customer One' },
    });
    customer1Id = reg1.json().id;

    const login1 = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organization}/customer-sessions`,
      payload: { email: 'cust1@example.com', password: 'password123' },
    });
    customer1Token = login1.json().token;

    // Register customer 2
    await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organization}/customers`,
      payload: { email: 'cust2@example.com', password: 'password123', name: 'Customer Two' },
    });

    const login2 = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organization}/customer-sessions`,
      payload: { email: 'cust2@example.com', password: 'password123' },
    });
    customer2Token = login2.json().token;
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('returns 401 when requesting without a customer bearer token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${location}/online-orders`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('logged in customer sees only their online orders sorted newest first, excluding other customers and DINE_IN/TAKEOUT', async () => {
    // Customer 1 places 3 online orders (PICKUP / DELIVERY)
    const order1Res = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/online-orders/checkout`,
      headers: authHeader(customer1Token),
      payload: {
        fulfillment_type: 'PICKUP',
        customer_name: 'Customer One',
        customer_email: 'cust1@example.com',
        customer_phone: '555-0001',
        items: [{ product_id: product, quantity: 1 }],
      },
    });
    expect(order1Res.statusCode).toBe(201);
    const order1Id = order1Res.json().order_id;

    await new Promise((r) => setTimeout(r, 50));

    const order2Res = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/online-orders/checkout`,
      headers: authHeader(customer1Token),
      payload: {
        fulfillment_type: 'DELIVERY',
        customer_name: 'Customer One',
        customer_email: 'cust1@example.com',
        customer_phone: '555-0001',
        delivery_address: { street: '123 St' },
        delivery_zone_id: deliveryZone,
        items: [{ product_id: product, quantity: 2 }],
      },
    });
    expect(order2Res.statusCode).toBe(201);
    const order2Id = order2Res.json().order_id;

    await new Promise((r) => setTimeout(r, 50));

    const order3Res = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/online-orders/checkout`,
      headers: authHeader(customer1Token),
      payload: {
        fulfillment_type: 'PICKUP',
        customer_name: 'Customer One',
        customer_email: 'cust1@example.com',
        customer_phone: '555-0001',
        items: [{ product_id: product, quantity: 1 }],
      },
    });
    expect(order3Res.statusCode).toBe(201);
    const order3Id = order3Res.json().order_id;

    // Customer 2 places an online order
    const orderCust2 = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/online-orders/checkout`,
      headers: authHeader(customer2Token),
      payload: {
        fulfillment_type: 'PICKUP',
        customer_name: 'Customer Two',
        customer_email: 'cust2@example.com',
        customer_phone: '555-0002',
        items: [{ product_id: product, quantity: 1 }],
      },
    });
    expect(orderCust2.statusCode).toBe(201);
    const orderCust2Id = orderCust2.json().order_id;

    // Create a DINE_IN order directly under Customer 1's visit to test exclusion of non-online order_types
    await db.transaction().execute(async (trx) => {
      const visit = await trx
        .insertInto('visits')
        .values({ location_id: location, customer_id: customer1Id })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('orders')
        .values({ location_id: location, visit_id: visit.id, order_type: 'DINE_IN', status: 'SENT' })
        .execute();
    });

    // Customer 1 fetches their online orders list
    const listRes1 = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${location}/online-orders`,
      headers: authHeader(customer1Token),
    });
    expect(listRes1.statusCode).toBe(200);
    const body1 = listRes1.json();
    expect(body1.data.length).toBe(3);

    // Sorted newest first: order3, order2, order1
    expect(body1.data[0].order.id).toBe(order3Id);
    expect(body1.data[1].order.id).toBe(order2Id);
    expect(body1.data[2].order.id).toBe(order1Id);

    // Customer 2's order is NOT in Customer 1's list
    expect(body1.data.some((item: { order: { id: string } }) => item.order.id === orderCust2Id)).toBe(
      false,
    );

    // Customer 2 fetches their online orders list and sees only orderCust2
    const listRes2 = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${location}/online-orders`,
      headers: authHeader(customer2Token),
    });
    expect(listRes2.statusCode).toBe(200);
    const body2 = listRes2.json();
    expect(body2.data.length).toBe(1);
    expect(body2.data[0].order.id).toBe(orderCust2Id);
  });

  it('supports pagination limit and before cursor', async () => {
    // Customer 1 fetches with limit=2
    const page1 = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${location}/online-orders?limit=2`,
      headers: authHeader(customer1Token),
    });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json();
    expect(body1.data.length).toBe(2);
    expect(body1.next_before).not.toBeNull();

    // Page 2 using before cursor
    const page2 = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${location}/online-orders?limit=2&before=${encodeURIComponent(body1.next_before)}`,
      headers: authHeader(customer1Token),
    });
    expect(page2.statusCode).toBe(200);
    const body2 = page2.json();
    expect(body2.data.length).toBe(1);
    expect(body2.next_before).toBeNull();

    // Verify item in page 2 is different from page 1 items
    const page1Ids = body1.data.map((item: { order: { id: string } }) => item.order.id);
    expect(page1Ids).not.toContain(body2.data[0].order.id);
  });
});
