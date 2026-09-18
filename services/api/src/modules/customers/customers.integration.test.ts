import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import Fastify from 'fastify';

import { createDatabase, installDatabase } from '../../shared/index.js';
import { identityModule } from '../identity/index.js';
import { menuModule } from '../menu/index.js';
import { floorModule } from '../floor/index.js';
import { ordersModule } from '../orders/index.js';
import { customersModule } from './index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration('customer accounts and online ordering against PostgreSQL', () => {
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
  let customerToken = '';
  let customerId = '';
  let staffToken = '';
  let deliveryZoneId = '';
  const customerAuth = () => ({ authorization: `Bearer ${customerToken}` });

  beforeAll(async () => {
    // Clear relevant tables
    for (const name of [
      'stock_adjustments',
      'ingredient_stock',
      'recipe_lines',
      'ingredients',
      'reservations',
      'reservation_settings',
      'order_fulfillments',
      'customer_sessions',
      'loyalty_transactions',
      'loyalty_redemptions',
      'loyalty_accounts',
      'loyalty_rewards',
      'loyalty_coupons',
      'loyalty_settings',
      'customers',
      'order_fulfillments',
      'order_line_modifiers',
      'order_line_promotions',
      'order_lines',
      'orders',
      'accounts',
      'guest_sessions',
      'visits',
      'product_variants',
      'promotions',
      'products',
      'categories',
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

    let orgRow = await db.selectFrom('organizations').select('id').executeTakeFirst();
    if (!orgRow) { orgRow = await db.insertInto('organizations').values({ name: 'Customer Test Org' }).returning('id').executeTakeFirstOrThrow(); }
    organization = orgRow.id;
    location = (await db.insertInto('locations').values({ organization_id: organization, name: 'Main' }).returning('id').executeTakeFirstOrThrow()).id;
    
    product = (await db.insertInto('products').values({ organization_id: organization, name: 'Burger', base_price: 1500 }).returning('id').executeTakeFirstOrThrow()).id;
    deliveryZoneId = (await db.insertInto('delivery_zones').values({ location_id: location, name: 'Test Zone', fee: 0, minimum_order_amount: 0, active: true }).returning('id').executeTakeFirstOrThrow()).id;

    // We don't strictly need staff for all tests, but for dispatch/deliver we do.
    const role = await db.insertInto('roles').values({ organization_id: organization, name: 'Manager' }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('role_permissions').values([
      'orders.fulfillment.dispatch', 'orders.fulfillment.deliver', 'menu.catalog.read'
    ].map((permission_name) => ({ role_id: role.id, permission_name, scope: 'organization' }))).execute();
    
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const credential = (locationId: string, terminalId: string) => `${locationId}.${terminalId}.${randomBytes(32).toString('base64url')}`;
    const staff = await db.insertInto('staff').values({ organization_id: organization, first_name: 'Staff', last_name: 'Tester', pin_hash: await import('argon2').then(a => a.hash('1234')) }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('staff_roles').values({ staff_id: staff.id, role_id: role.id, location_id: null }).execute();
    const terminalId = crypto.randomUUID(); const terminal = credential(location, terminalId);
    await db.insertInto('terminals').values({ id: terminalId, location_id: location, name: 'POS', credential_hash: hash(terminal) }).execute();
    
    const unlock = await app.inject({ method: 'POST', url: '/api/v1/auth/pin-unlock', headers: { 'x-terminal-credential': terminal }, payload: { staff_id: staff.id, pin: '1234' } });
    // pin-unlock returns 201 on success, not 200 — a prior version of this
    // check compared against the wrong status code, which silently skipped
    // the entire dispatch/deliver test below via the `if (staffToken)` guard
    // it was gated on, with no failure ever surfacing. Fail loudly instead.
    expect(unlock.statusCode).toBe(201);
    staffToken = unlock.json().token;
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('lists an organization\'s locations with no auth required', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/organizations/${organization}/locations` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.some((loc: { id: string }) => loc.id === location)).toBe(true);
  });

  it('registers a customer and logs in', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organization}/customers`,
      payload: {
        email: 'test@example.com',
        password: 'secure123',
        name: 'Test Customer',
        phone: '555-1234'
      }
    });
    expect(reg.statusCode).toBe(201);
    customerId = reg.json().id;

    const loginFail = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organization}/customer-sessions`,
      payload: {
        email: 'test@example.com',
        password: 'wrong'
      }
    });
    expect(loginFail.statusCode).toBe(401);

    const login = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organization}/customer-sessions`,
      payload: {
        email: 'test@example.com',
        password: 'secure123'
      }
    });
    expect(login.statusCode).toBe(200);
    customerToken = login.json().token;
  });

  it('fetches customer profile and menu using dual-auth', async () => {
    const profile = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organization}/customer-sessions/current`,
      headers: customerAuth()
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.json().id).toBe(customerId);

    // Menu reads
    const products = await app.inject({
      method: 'GET',
      url: `/api/v1/products?location_id=${location}`,
      headers: customerAuth()
    });
    expect(products.statusCode).toBe(200);
    expect(products.json().data.length).toBeGreaterThan(0);
  });

  it('places a guest order', async () => {
    const checkout = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/online-orders/checkout`,
      payload: {
        fulfillment_type: 'PICKUP',
        customer_name: 'Guest User',
        customer_email: 'guest@example.com',
        customer_phone: '111-2222',
        items: [{ product_id: product, quantity: 2 }]
      }
    });
    expect(checkout.statusCode).toBe(201);
    const { order_id, order_token } = checkout.json();
    expect(order_token).toBeDefined();

    // Guest can fetch order detail
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${location}/online-orders/${order_id}?order_token=${order_token}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().order.order_type).toBe('PICKUP');
  });

  it('places an authenticated customer order and verifies lifecycle', async () => {
    const checkout = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/online-orders/checkout`,
      headers: customerAuth(),
      payload: {
        fulfillment_type: 'DELIVERY',
        customer_name: 'Test Customer',
        customer_email: 'test@example.com',
        customer_phone: '555-1234',
        delivery_address: { street: '123 Main St' },
        delivery_zone_id: deliveryZoneId,
        items: [{ product_id: product, quantity: 1 }]
      }
    });
    expect(checkout.statusCode).toBe(201);
    const { order_id } = checkout.json();

    // Customer can fetch their own order without a guest token
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${location}/online-orders/${order_id}`,
      headers: customerAuth(),
    });
    expect(detail.statusCode).toBe(200);
    
    // Verify lines are HELD
    const lineId = detail.json().lines[0].id;
    expect(detail.json().lines[0].status).toBe('HELD');

    // Simulate Kitchen picking up (requires staff token for standard order/send)
    // Actually, sending is just order lines send command. We can test fulfillment transitions directly.
    
    // Fulfillments dispatch should reject because line is not READY
    const dispatchFail = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/orders/${order_id}/fulfillment/dispatch`,
      headers: { authorization: `Bearer ${staffToken}` },
      payload: { version: 1 }
    });
    expect(dispatchFail.statusCode).toBe(409); // Not ready

    // Update line status manually in DB for test speed
    await db.updateTable('order_lines').set({ status: 'READY' }).where('id', '=', lineId).execute();

    const dispatch = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/orders/${order_id}/fulfillment/dispatch`,
      headers: { authorization: `Bearer ${staffToken}` },
      payload: { version: 1 }
    });
    expect(dispatch.statusCode).toBe(200);
    expect(dispatch.json().status).toBe('OUT_FOR_DELIVERY');
    expect(dispatch.json().version).toBe(2);

    const deliver = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/orders/${order_id}/fulfillment/deliver`,
      headers: { authorization: `Bearer ${staffToken}` },
      payload: { version: 2 }
    });
    expect(deliver.statusCode).toBe(200);
    expect(deliver.json().status).toBe('DELIVERED');

    // Regression check for the missing version-bump bug found during review:
    // the HELD transition after checkout must bump both the order's and each
    // line's own version, not just leave them at their post-insert value.
    const heldLine = await db.selectFrom('order_lines').selectAll().where('id', '=', lineId).executeTakeFirstOrThrow();
    expect(heldLine.version).toBeGreaterThan(1);
  });

  it('rejects a guest order poll with a missing or wrong order_token', async () => {
    const checkout = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/online-orders/checkout`,
      payload: {
        fulfillment_type: 'PICKUP',
        customer_name: 'Another Guest',
        customer_email: 'another-guest@example.com',
        customer_phone: '333-4444',
        items: [{ product_id: product, quantity: 1 }],
      },
    });
    expect(checkout.statusCode).toBe(201);
    const { order_id } = checkout.json();

    const noToken = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${location}/online-orders/${order_id}`,
    });
    expect(noToken.statusCode).toBe(403);

    const wrongToken = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${location}/online-orders/${order_id}?order_token=not-the-real-token`,
    });
    expect(wrongToken.statusCode).toBe(403);

    // Regression check for the order-id-as-its-own-token bug found during
    // review: the order's own id must not work as a substitute order_token.
    const idAsToken = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${location}/online-orders/${order_id}?order_token=${order_id}`,
    });
    expect(idAsToken.statusCode).toBe(403);
  });
});
