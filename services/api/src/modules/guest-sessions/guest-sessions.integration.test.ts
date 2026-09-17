import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import Fastify from 'fastify';

import { createDatabase, installDatabase } from '../../shared/index.js';
import { identityModule } from '../identity/index.js';
import { menuModule } from '../menu/index.js';
import { floorModule } from '../floor/index.js';
import { ordersModule } from '../orders/index.js';
import { guestSessionsModule } from './index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const credential = (locationId: string, terminalId: string) => `${locationId}.${terminalId}.${randomBytes(32).toString('base64url')}`;

describeIntegration('guest table sessions against PostgreSQL', () => {
  const db = createDatabase({ databaseUrl });
  const app = Fastify({ logger: false });
  installDatabase(app, { databaseUrl });
  app.register(identityModule); app.register(menuModule); app.register(floorModule); app.register(ordersModule); app.register(guestSessionsModule);
  let organization = ''; let location = ''; let otherLocation = ''; let table = ''; let otherTable = ''; let product = ''; let staffToken = '';
  const staffAuth = () => ({ authorization: `Bearer ${staffToken}` });
  const mint = (tableId = table) => app.inject({ method: 'POST', url: `/api/v1/locations/${location}/tables/${tableId}/guest-session`, payload: {} });
  const guestAuth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    for (const name of [
      'stock_adjustments',
      'ingredient_stock',
      'recipe_lines',
      'ingredients',
      'table_service_requests',
      'guest_sessions',
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
    ] as const) await db.deleteFrom(name).execute();
    organization = (await db.insertInto('organizations').values({ name: 'Guest sessions' }).returning('id').executeTakeFirstOrThrow()).id;
    [location, otherLocation] = (await db.insertInto('locations').values([{ organization_id: organization, name: 'Main' }, { organization_id: organization, name: 'Other' }]).returning('id').execute()).map((row) => row.id);
    const [area, otherArea] = (await db.insertInto('areas').values([{ location_id: location, name: 'Dining' }, { location_id: otherLocation, name: 'Other' }]).returning('id').execute()).map((row) => row.id);
    [table, otherTable] = (await db.insertInto('tables').values([{ location_id: location, area_id: area, name: 'A1', max_capacity: 4 }, { location_id: otherLocation, area_id: otherArea, name: 'B1', max_capacity: 4 }]).returning('id').execute()).map((row) => row.id);
    product = (await db.insertInto('products').values({ organization_id: organization, name: 'Taco', base_price: 2500 }).returning('id').executeTakeFirstOrThrow()).id;
    const role = await db.insertInto('roles').values({ organization_id: organization, name: 'Owner' }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('role_permissions').values(['menu.catalog.read', 'orders.visits.close'].map((permission_name) => ({ role_id: role.id, permission_name, scope: 'organization' }))).execute();
    const staff = await db.insertInto('staff').values({ organization_id: organization, first_name: 'Guest', last_name: 'Tester', pin_hash: await argon2.hash('1234') }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('staff_roles').values({ staff_id: staff.id, role_id: role.id, location_id: null }).execute();
    const terminalId = crypto.randomUUID(); const terminal = credential(location, terminalId);
    await db.insertInto('terminals').values({ id: terminalId, location_id: location, name: 'POS', credential_hash: hash(terminal) }).execute();
    const unlock = await app.inject({ method: 'POST', url: '/api/v1/auth/pin-unlock', headers: { 'x-terminal-credential': terminal }, payload: { staff_id: staff.id, pin: '1234' } });
    staffToken = unlock.json().token;
  });
  afterAll(async () => { await db.deleteFrom('table_service_requests').execute(); await db.deleteFrom('guest_sessions').execute(); await app.close(); await db.destroy(); });

  it('mints concurrent sessions for one automatically opened table visit and rejects not-ready tables', async () => {
    const [one, two] = await Promise.all([mint(), mint()]);
    expect(one.statusCode).toBe(201); expect(two.statusCode).toBe(201);
    expect(one.json().visit_id).toBe(two.json().visit_id);
    expect((await db.selectFrom('tables').select('status').where('id', '=', table).executeTakeFirstOrThrow()).status).toBe('OCCUPIED');
    await db.updateTable('tables').set({ status: 'NEEDS_CLEANING' }).where('id', '=', otherTable).execute();
    const rejected = await mint(otherTable);
    expect(rejected.statusCode).toBe(404); // a cross-location table is never exposed through the QR endpoint
    const blocked = await app.inject({ method: 'POST', url: `/api/v1/locations/${otherLocation}/tables/${otherTable}/guest-session`, payload: {} });
    expect(blocked.statusCode).toBe(409); expect(blocked.json().error.code).toBe('TABLE_NOT_READY');
    await db.updateTable('tables').set({ status: 'OUT_OF_ORDER' }).where('id', '=', otherTable).execute();
    const outOfOrder = await app.inject({ method: 'POST', url: `/api/v1/locations/${otherLocation}/tables/${otherTable}/guest-session`, payload: {} });
    expect(outOfOrder.statusCode).toBe(409); expect(outOfOrder.json().error.code).toBe('TABLE_NOT_READY');
  });

  it('allows shared-order add/read but rejects a different location and a staff token', async () => {
    const session = (await mint()).json();
    const add = await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/guest-sessions/current/lines`, headers: guestAuth(session.token), payload: { lines: [{ product_id: product, quantity: 2 }] } });
    expect(add.statusCode).toBe(201);
    const order = await app.inject({ method: 'GET', url: `/api/v1/locations/${location}/guest-sessions/current/order`, headers: guestAuth(session.token) });
    expect(order.statusCode).toBe(200); expect(order.json().order.lines).toHaveLength(1);
    const other = await app.inject({ method: 'GET', url: `/api/v1/locations/${otherLocation}/guest-sessions/current/order`, headers: guestAuth(session.token) });
    expect(other.statusCode).toBe(403);
    const staffAsGuest = await app.inject({ method: 'GET', url: `/api/v1/locations/${location}/guest-sessions/current`, headers: staffAuth() });
    expect(staffAsGuest.statusCode).toBe(401);
  });

  it('supports menu dual auth and revokes every guest token after staff closes its visit', async () => {
    const session = (await mint()).json();
    expect((await app.inject({ method: 'GET', url: '/api/v1/categories', headers: guestAuth(session.token) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/categories', headers: staffAuth() })).statusCode).toBe(200);
    // No token at all is no longer an automatic 401: anonymous menu reads
    // are intentionally supported (idea.md 68 — a Customer-app visitor
    // browses before any login/checkout step), gated only by requiring a
    // location_id rather than requiring any session.
    expect((await app.inject({ method: 'GET', url: '/api/v1/categories' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/v1/categories?location_id=${location}` })).statusCode).toBe(200);
    await db.updateTable('order_lines').set({ status: 'FULFILLED' }).where('order_id', '=', (await db.selectFrom('orders').select('id').where('visit_id', '=', session.visit_id).executeTakeFirstOrThrow()).id).execute();
    await db.updateTable('accounts').set({ status: 'PAID' }).where('visit_id', '=', session.visit_id).execute();
    const visit = await db.selectFrom('visits').select('version').where('id', '=', session.visit_id).executeTakeFirstOrThrow();
    const close = await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/visits/${session.visit_id}/close`, headers: { ...staffAuth(), 'if-match': String(visit.version) }, payload: {} });
    expect(close.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/v1/locations/${location}/guest-sessions/current`, headers: guestAuth(session.token) })).statusCode).toBe(401);
  });

  it('creates distinct tableless sessions for counter orders with correct order_type and rejects service requests', async () => {
    const session1 = await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/counter-sessions`, payload: { order_type: 'TAKEOUT' } });
    const session2 = await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/counter-sessions`, payload: { order_type: 'DINE_IN' } });
    
    expect(session1.statusCode).toBe(201);
    expect(session2.statusCode).toBe(201);
    
    const token1 = session1.json().token;
    const token2 = session2.json().token;
    
    expect(session1.json().visit_id).not.toBe(session2.json().visit_id);
    expect(session1.json().table_id).toBeNull();
    
    const order1 = await app.inject({ method: 'GET', url: `/api/v1/locations/${location}/guest-sessions/current/order`, headers: guestAuth(token1) });
    const order2 = await app.inject({ method: 'GET', url: `/api/v1/locations/${location}/guest-sessions/current/order`, headers: guestAuth(token2) });
    
    expect(order1.statusCode).toBe(200);
    expect(order2.statusCode).toBe(200);
    
    const dbOrder1 = await db.selectFrom('orders').select('order_type').where('id', '=', order1.json().order.id).executeTakeFirstOrThrow();
    const dbOrder2 = await db.selectFrom('orders').select('order_type').where('id', '=', order2.json().order.id).executeTakeFirstOrThrow();
    
    expect(dbOrder1.order_type).toBe('TAKEOUT');
    expect(dbOrder2.order_type).toBe('DINE_IN');

    const sessionDefault = await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/counter-sessions`, payload: {} });
    expect(sessionDefault.statusCode).toBe(201);
    const orderDefault = await app.inject({ method: 'GET', url: `/api/v1/locations/${location}/guest-sessions/current/order`, headers: guestAuth(sessionDefault.json().token) });
    const dbOrderDefault = await db.selectFrom('orders').select('order_type').where('id', '=', orderDefault.json().order.id).executeTakeFirstOrThrow();
    expect(dbOrderDefault.order_type).toBe('TAKEOUT');

    const current = await app.inject({ method: 'GET', url: `/api/v1/locations/${location}/guest-sessions/current`, headers: guestAuth(token1) });
    expect(current.statusCode).toBe(200);
    expect(current.json().table).toBeNull();
    
    const serviceRequest = await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/guest-sessions/current/service-requests`, headers: guestAuth(token1), payload: { request_type: 'CALL_WAITER' } });
    expect(serviceRequest.statusCode).toBe(400);
    expect(serviceRequest.json().error.code).toBe('TABLE_REQUIRED');
  });
});
