import { expect, it, beforeAll, afterAll, describe } from 'vitest';
import crypto from 'node:crypto';
import argon2 from 'argon2';
import Fastify from 'fastify';
import { createDatabase, installDatabase } from '../../shared/index.js';
import { identityModule } from '../identity/index.js';
import { ordersModule } from '../orders/index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration('Delivery Zones & Checkout Enforcement', () => {
  const db = createDatabase({ databaseUrl });
  const app = Fastify({ logger: false });
  installDatabase(app, { databaseUrl });
  app.register(identityModule);
  app.register(ordersModule);

  let organizationId: string;
  let locationId: string;
  let ownerId: string;
  let sessionToken: string;
    let productId: string;
  
  function terminalCredential(locationId: string, terminalId: string): string {
    return `${locationId}.${terminalId}.${crypto.randomBytes(32).toString('base64url')}`;
  }
  function credentialHash(credential: string): string {
    return crypto.createHash('sha256').update(credential).digest('hex');
  }
  function auth(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  beforeAll(async () => {
    
    // Exact cleanup list with delivery_zones added
    for (const table of [
      'stock_adjustments',
      'ingredient_stock',
      'recipe_lines',
      'ingredients',
      'cash_drawer_movements',
      'cash_drawer_sessions',
      'module_activations',
      'command_idempotency',
      'audit_events',
      'reservations',
      'reservation_settings',
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

    const organization = await db.insertInto('organizations').values({ name: 'Delivery Integration Restaurant' }).returning('id').executeTakeFirstOrThrow();
    organizationId = organization.id;
    
    const location = await db.insertInto('locations').values({ organization_id: organizationId, name: 'Main St' }).returning('id').executeTakeFirstOrThrow();
    locationId = location.id;

    const role = await db.insertInto('roles').values({ organization_id: organizationId, name: 'Owner' }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('role_permissions').values(['delivery.zones.read', 'delivery.zones.write'].map((permission_name) => ({ role_id: role.id, permission_name, scope: 'organization' }))).execute();
    
    const owner = await db.insertInto('staff').values({ organization_id: organizationId, first_name: 'Delivery', last_name: 'Owner', pin_hash: await argon2.hash('2468') }).returning('id').executeTakeFirstOrThrow();
    ownerId = owner.id;
    await db.insertInto('staff_roles').values({ staff_id: ownerId, role_id: role.id, location_id: null }).execute();

    const terminalId = crypto.randomUUID(); 
    const credential = terminalCredential(locationId, terminalId);
    await db.insertInto('terminals').values({ id: terminalId, location_id: locationId, name: 'Test terminal', credential_hash: credentialHash(credential) }).execute();
    
    const unlock = await app.inject({ method: 'POST', url: '/api/v1/auth/pin-unlock', headers: { 'x-terminal-credential': credential }, payload: { staff_id: ownerId, pin: '2468' } });
    sessionToken = unlock.json().token;

    const category = await db.insertInto('categories').values({ organization_id: organizationId, name: 'Food', is_active: true }).returning('id').executeTakeFirstOrThrow();
    const product = await db.insertInto('products').values({ organization_id: organizationId, category_id: category.id, name: 'Burger', base_price: 1500, is_active: true }).returning('id').executeTakeFirstOrThrow();
    productId = product.id;
    
    const customer = await db.insertInto('customers').values({ organization_id: organizationId, email: 'test@example.com', password_hash: 'ignored', name: 'Test Customer' }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('customer_sessions').values({ organization_id: organizationId, customer_id: customer.id, token_hash: 'ignored', expires_at: new Date(Date.now() + 1000000) }).returning('id').executeTakeFirstOrThrow();
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  let zone1: string;
  let version: number;

  it('rejects admin writes without permission', async () => {
    // create a role without permission and staff
    const roleNoPerm = await db.insertInto('roles').values({ organization_id: organizationId, name: 'Nobody' }).returning('id').executeTakeFirstOrThrow();
    const noPermUser = await db.insertInto('staff').values({ organization_id: organizationId, first_name: 'No', last_name: 'Perm', pin_hash: await argon2.hash('2468') }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('staff_roles').values({ staff_id: noPermUser.id, role_id: roleNoPerm.id, location_id: null }).execute();
    
    const terminalId = crypto.randomUUID(); 
    const credential = terminalCredential(locationId, terminalId);
    await db.insertInto('terminals').values({ id: terminalId, location_id: locationId, name: 'Terminal 2', credential_hash: credentialHash(credential) }).execute();
    const unlock = await app.inject({ method: 'POST', url: '/api/v1/auth/pin-unlock', headers: { 'x-terminal-credential': credential }, payload: { staff_id: noPermUser.id, pin: '2468' } });
    const noPermToken = unlock.json().token;

    const res = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationId}/delivery-zones`, headers: auth(noPermToken), payload: { name: 'Zone 1', fee: 500 } });
    expect(res.statusCode).toBe(403);
    
    const res2 = await app.inject({ method: 'GET', url: `/api/v1/locations/${locationId}/delivery-zones/admin`, headers: auth(noPermToken) });
    expect(res2.statusCode).toBe(403);
  });

  it('rejects admin writes and reads scoped to a different location than the session', async () => {
    // A staff session enrolled at locationId must not be able to manage or read
    // delivery zones at a sibling location, even with delivery.zones.write/read
    // granted at organization scope — the session's own location is the boundary.
    const otherLocation = await db.insertInto('locations').values({ organization_id: organizationId, name: 'Other Location' }).returning('id').executeTakeFirstOrThrow();

    const createRes = await app.inject({ method: 'POST', url: `/api/v1/locations/${otherLocation.id}/delivery-zones`, headers: auth(sessionToken), payload: { name: 'Cross-location zone', fee: 100 } });
    expect(createRes.statusCode).toBe(403);
    expect(createRes.json().error.code).toBe('LOCATION_SCOPE_DENIED');

    const readRes = await app.inject({ method: 'GET', url: `/api/v1/locations/${otherLocation.id}/delivery-zones/admin`, headers: auth(sessionToken) });
    expect(readRes.statusCode).toBe(403);
    expect(readRes.json().error.code).toBe('LOCATION_SCOPE_DENIED');
  });

  it('creates and lists delivery zones', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationId}/delivery-zones`, headers: auth(sessionToken), payload: { name: 'Zone 1', fee: 500, minimum_order_amount: 2000 } });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('Zone 1');
    expect(res.json().fee).toBe(500);
    zone1 = res.json().id;
    version = res.json().version;

    // create inactive zone
    const res2 = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationId}/delivery-zones`, headers: auth(sessionToken), payload: { name: 'Zone 2', fee: 800 } });
    const zone2 = res2.json().id;
    await app.inject({ method: 'PATCH', url: `/api/v1/locations/${locationId}/delivery-zones/${zone2}`, headers: auth(sessionToken), payload: { version: res2.json().version, active: false } });

    const adminList = await app.inject({ method: 'GET', url: `/api/v1/locations/${locationId}/delivery-zones/admin`, headers: auth(sessionToken) });
    expect(adminList.statusCode).toBe(200);
    expect(adminList.json().data).toHaveLength(2);

    const publicList = await app.inject({ method: 'GET', url: `/api/v1/locations/${locationId}/delivery-zones` });
    expect(publicList.statusCode).toBe(200);
    expect(publicList.json().data).toHaveLength(1);
    expect(publicList.json().data[0].id).toBe(zone1);
    expect(publicList.json().data[0].version).toBeUndefined(); // no leak
  });

  it('enforces optimistic concurrency on patch', async () => {
    const patch = await app.inject({ method: 'PATCH', url: `/api/v1/locations/${locationId}/delivery-zones/${zone1}`, headers: auth(sessionToken), payload: { version: version, fee: 600 } });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().fee).toBe(600);
    version = patch.json().version;

    const stalePatch = await app.inject({ method: 'PATCH', url: `/api/v1/locations/${locationId}/delivery-zones/${zone1}`, headers: auth(sessionToken), payload: { version: version - 1, fee: 700 } });
    expect(stalePatch.statusCode).toBe(409);
  });

  it('checkout requires delivery_zone_id for DELIVERY', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationId}/online-orders/checkout`, payload: {
      items: [{ product_id: productId, quantity: 1 }],
      fulfillment_type: 'DELIVERY',
      customer_name: 'Test',
      customer_email: 'test@example.com',
      customer_phone: '123'
    }});
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('checkout rejects inactive or foreign zone', async () => {
    const inactiveZone = await db.insertInto('delivery_zones').values({ location_id: locationId, name: 'Inactive', fee: 0, active: false }).returning('id').executeTakeFirstOrThrow();
    const res = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationId}/online-orders/checkout`, payload: {
      items: [{ product_id: productId, quantity: 1 }],
      fulfillment_type: 'DELIVERY',
      delivery_zone_id: inactiveZone.id,
      customer_name: 'Test',
      customer_email: 'test@example.com',
      customer_phone: '123'
    }});
    expect(res.statusCode).toBe(404);
  });

  it('checkout enforces minimum order amount', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationId}/online-orders/checkout`, payload: {
      items: [{ product_id: productId, quantity: 1 }], // 1500 < 2000 minimum
      fulfillment_type: 'DELIVERY',
      delivery_zone_id: zone1,
      customer_name: 'Test',
      customer_email: 'test@example.com',
      customer_phone: '123'
    }});
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('DELIVERY_MINIMUM_NOT_MET');

    // verify nothing committed
    const fulfillments = await db.selectFrom('order_fulfillments').selectAll().execute();
    expect(fulfillments).toHaveLength(0);
  });

  it('checkout succeeds when minimum is met', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationId}/online-orders/checkout`, payload: {
      items: [{ product_id: productId, quantity: 2 }], // 3000 > 2000 minimum
      fulfillment_type: 'DELIVERY',
      delivery_zone_id: zone1,
      customer_name: 'Test',
      customer_email: 'test@example.com',
      customer_phone: '123'
    }});
    expect(res.statusCode).toBe(201);
    const { order_id, order_token } = res.json();

    // total includes delivery fee
    const getRes = await app.inject({ method: 'GET', url: `/api/v1/locations/${locationId}/online-orders/${order_id}?order_token=${order_token}` });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().order.totals.delivery_fee).toBe(600); // from our patch above
    expect(getRes.json().order.totals.total).toBe(3600); // 3000 + 600
  });

  it('checkout rejects delivery_zone_id on PICKUP', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationId}/online-orders/checkout`, payload: {
      items: [{ product_id: productId, quantity: 1 }],
      fulfillment_type: 'PICKUP',
      delivery_zone_id: zone1,
      customer_name: 'Test',
      customer_email: 'test@example.com',
      customer_phone: '123'
    }});
    expect(res.statusCode).toBe(400);
  });
});
