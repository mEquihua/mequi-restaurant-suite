import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import Fastify from 'fastify';

import { identityModule } from '../identity/index.js';
import { menuModule } from '../menu/index.js';
import { floorModule } from '../floor/index.js';
import { createDatabase, installDatabase } from '../../shared/index.js';
import { ordersModule } from './index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const credential = (locationId: string, terminalId: string) =>
  `${locationId}.${terminalId}.${randomBytes(32).toString('base64url')}`;

describeIntegration('orders API security boundaries against PostgreSQL', () => {
  const db = createDatabase({ databaseUrl });
  const app = Fastify({ logger: false });
  installDatabase(app, { databaseUrl });
  app.register(identityModule);
  app.register(menuModule);
  app.register(floorModule);
  app.register(ordersModule);
  let org = '';
  let location = '';
  let staff = '';
  let manager = '';
  let token = '';
  let managerToken = '';
  let product = '';

  beforeAll(async () => {
    for (const table of [
      'command_idempotency', 'audit_events', 'outbox_events', 'refunds', 'cancellations_and_voids',
      'payments', 'order_line_modifiers', 'order_lines', 'orders', 'accounts', 'visits',
      'table_sections', 'sections', 'tables', 'areas', 'availability_rules', 'location_price_overrides',
      'product_combo_items', 'product_combo_groups', 'product_modifier_groups', 'modifiers', 'modifier_groups',
      'product_variants', 'products', 'categories', 'terminal_pin_attempts', 'staff_sessions',
      'staff_roles', 'role_permissions', 'terminals', 'staff', 'roles', 'locations', 'organizations',
    ] as const) await db.deleteFrom(table).execute();

    org = (await db.insertInto('organizations').values({ name: 'Security Org' }).returning('id').executeTakeFirstOrThrow()).id;
    location = (await db.insertInto('locations').values({ organization_id: org, name: 'A' }).returning('id').executeTakeFirstOrThrow()).id;

    const waiterRole = await db.insertInto('roles').values({ organization_id: org, name: 'Waiter' }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('role_permissions').values(
      ['orders.visits.create', 'orders.orders.create', 'orders.lines.add', 'orders.lines.send', 'orders.lines.void']
        .map((permission_name) => ({ role_id: waiterRole.id, permission_name, scope: 'organization' })),
    ).execute();

    const managerRole = await db.insertInto('roles').values({ organization_id: org, name: 'Manager' }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('role_permissions').values(
      ['orders.visits.create', 'orders.orders.create', 'orders.lines.add', 'orders.lines.send',
       'orders.lines.void', 'orders.lines.void_override', 'kitchen.tickets.update_status', 'accounts.accounts.create']
        .map((permission_name) => ({ role_id: managerRole.id, permission_name, scope: 'organization' })),
    ).execute();

    staff = (await db.insertInto('staff').values({ organization_id: org, first_name: 'Wendy', last_name: 'Waiter', pin_hash: await argon2.hash('1111') }).returning('id').executeTakeFirstOrThrow()).id;
    await db.insertInto('staff_roles').values({ staff_id: staff, role_id: waiterRole.id, location_id: null }).execute();

    manager = (await db.insertInto('staff').values({ organization_id: org, first_name: 'Mona', last_name: 'Manager', pin_hash: await argon2.hash('2222') }).returning('id').executeTakeFirstOrThrow()).id;
    await db.insertInto('staff_roles').values({ staff_id: manager, role_id: managerRole.id, location_id: null }).execute();

    const terminalId = crypto.randomUUID();
    const cred = credential(location, terminalId);
    await db.insertInto('terminals').values({ id: terminalId, location_id: location, name: 'POS', credential_hash: hash(cred) }).execute();

    const waiterUnlock = await app.inject({ method: 'POST', url: '/api/v1/auth/pin-unlock', headers: { 'x-terminal-credential': cred }, payload: { staff_id: staff, pin: '1111' } });
    expect(waiterUnlock.statusCode).toBe(201);
    token = waiterUnlock.json().token;

    const managerUnlock = await app.inject({ method: 'POST', url: '/api/v1/auth/pin-unlock', headers: { 'x-terminal-credential': cred }, payload: { staff_id: manager, pin: '2222' } });
    expect(managerUnlock.statusCode).toBe(201);
    managerToken = managerUnlock.json().token;

    product = (await db.insertInto('products').values({ organization_id: org, name: 'Steak', base_price: 2500 }).returning('id').executeTakeFirstOrThrow()).id;
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('rejects a waiter from both void paths on a preparing line, but a manager override succeeds and is audited', async () => {
    const visit = (await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/visits`, headers: { authorization: `Bearer ${token}` }, payload: { guest_count: 2 } })).json();
    const account = (await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/visits/${visit.id}/accounts`, headers: { authorization: `Bearer ${managerToken}` }, payload: {} })).json();
    const order = (await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/visits/${visit.id}/orders`, headers: { authorization: `Bearer ${token}`, 'if-match': String(visit.version) }, payload: { order_type: 'DINE_IN' } })).json();
    const addLines = (await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/orders/${order.id}/lines`, headers: { authorization: `Bearer ${token}`, 'if-match': String(order.version) }, payload: { lines: [{ account_id: account.id, product_id: product, quantity: 1 }] } })).json();
    const lineId = addLines.lines[0].id;

    await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/orders/${order.id}/send`, headers: { authorization: `Bearer ${token}`, 'if-match': String(addLines.order.version), 'idempotency-key': 'send-1' }, payload: { line_ids: [lineId] } });
    const afterSend = await db.selectFrom('order_lines').selectAll().where('id', '=', lineId).executeTakeFirstOrThrow();
    await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/order-lines/${lineId}/mark-preparing`, headers: { authorization: `Bearer ${managerToken}`, 'if-match': String(afterSend.version) }, payload: {} });
    const preparingLine = await db.selectFrom('order_lines').selectAll().where('id', '=', lineId).executeTakeFirstOrThrow();
    expect(preparingLine.status).toBe('PREPARING');

    // A waiter cannot call void-override at all (lacks the permission).
    const waiterOverrideAttempt = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/order-lines/${lineId}/void-override`,
      headers: { authorization: `Bearer ${token}`, 'if-match': String(preparingLine.version) },
      payload: { reason: 'burnt', authorized_by: manager },
    });
    expect(waiterOverrideAttempt.statusCode).toBe(403);

    // A waiter cannot use the routine void path either, once the line has entered preparation.
    const waiterRoutineAttempt = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/order-lines/${lineId}/void`,
      headers: { authorization: `Bearer ${token}`, 'if-match': String(preparingLine.version) },
      payload: { reason: 'changed mind' },
    });
    expect(waiterRoutineAttempt.statusCode).toBe(409);

    // A manager, who holds the override permission, can void the preparing line.
    const managerOverride = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/order-lines/${lineId}/void-override`,
      headers: { authorization: `Bearer ${managerToken}`, 'if-match': String(preparingLine.version) },
      payload: { reason: 'burnt', authorized_by: manager },
    });
    expect(managerOverride.statusCode).toBe(200);
    expect(managerOverride.json().status).toBe('VOIDED');

    // The void amount is server-computed from the line's own quantity/price, never client-supplied.
    const voidRows = await db.selectFrom('cancellations_and_voids').selectAll().where('order_line_id', '=', lineId).execute();
    expect(voidRows[0].operation_type).toBe('VOID');
    expect(voidRows[0].amount).toBe(2500);

    // The override is recorded in the immutable audit trail.
    const auditRows = await db.selectFrom('audit_events').selectAll().where('aggregate_id', '=', lineId).where('action', '=', 'orders.lines.void_override').execute();
    expect(auditRows).toHaveLength(1);
  });

  it('rejects an account_id that belongs to a different visit than the order', async () => {
    const visitOne = (await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/visits`, headers: { authorization: `Bearer ${token}` }, payload: { guest_count: 2 } })).json();
    const visitTwo = (await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/visits`, headers: { authorization: `Bearer ${token}` }, payload: { guest_count: 2 } })).json();
    const accountForVisitTwo = (await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/visits/${visitTwo.id}/accounts`, headers: { authorization: `Bearer ${managerToken}` }, payload: {} })).json();
    const orderForVisitOne = (await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/visits/${visitOne.id}/orders`, headers: { authorization: `Bearer ${token}`, 'if-match': String(visitOne.version) }, payload: { order_type: 'DINE_IN' } })).json();

    const crossVisitAttempt = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/orders/${orderForVisitOne.id}/lines`,
      headers: { authorization: `Bearer ${token}`, 'if-match': String(orderForVisitOne.version) },
      payload: { lines: [{ account_id: accountForVisitTwo.id, product_id: product, quantity: 1 }] },
    });
    expect(crossVisitAttempt.statusCode).toBe(400);
    expect(crossVisitAttempt.json().error.code).toBe('INVALID_ACCOUNT_FOR_VISIT');
  });
});
