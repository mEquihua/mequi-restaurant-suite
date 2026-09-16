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
    for (const name of ['table_service_requests', 'guest_sessions', 'cash_drawer_movements', 'cash_drawer_sessions', 'module_activations', 'command_idempotency', 'audit_events', 'account_discounts', 'outbox_events', 'refunds', 'cancellations_and_voids', 'payments', 'order_line_modifiers', 'order_lines', 'orders', 'accounts', 'visits', 'table_sections', 'sections', 'tables', 'areas', 'availability_rules', 'location_price_overrides', 'product_combo_items', 'product_combo_groups', 'product_modifier_groups', 'modifiers', 'modifier_groups', 'product_variants', 'products', 'categories', 'terminal_pin_attempts', 'staff_sessions', 'staff_roles', 'role_permissions', 'terminals', 'staff', 'roles', 'locations', 'organizations'] as const) await db.deleteFrom(name).execute();
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
    expect((await app.inject({ method: 'GET', url: '/api/v1/categories' })).statusCode).toBe(401);
    await db.updateTable('order_lines').set({ status: 'FULFILLED' }).where('order_id', '=', (await db.selectFrom('orders').select('id').where('visit_id', '=', session.visit_id).executeTakeFirstOrThrow()).id).execute();
    await db.updateTable('accounts').set({ status: 'PAID' }).where('visit_id', '=', session.visit_id).execute();
    const visit = await db.selectFrom('visits').select('version').where('id', '=', session.visit_id).executeTakeFirstOrThrow();
    const close = await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/visits/${session.visit_id}/close`, headers: { ...staffAuth(), 'if-match': String(visit.version) }, payload: {} });
    expect(close.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/v1/locations/${location}/guest-sessions/current`, headers: guestAuth(session.token) })).statusCode).toBe(401);
  });
});
