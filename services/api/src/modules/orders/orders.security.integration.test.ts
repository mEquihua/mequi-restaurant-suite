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
    for (const table of ['stock_adjustments', 'ingredient_stock', 'recipe_lines', 'ingredients', 
      'cash_drawer_movements', 'cash_drawer_sessions', 'command_idempotency', 'audit_events', 'account_discounts', 'outbox_events', 'refunds', 'cancellations_and_voids',
      'payments', 'order_fulfillments', 'order_line_modifiers', 'order_lines', 'orders', 'accounts', 'reservations', 'reservation_settings', 'visits',
      'table_sections', 'sections', 'tables', 'areas', 'availability_rules', 'location_price_overrides',
      'product_combo_items', 'product_combo_groups', 'product_modifier_groups', 'modifiers', 'modifier_groups',
      'product_variants', 'products', 'categories', 'terminal_pin_attempts', 'staff_sessions',
      'staff_roles', 'role_permissions', 'terminals', 'staff', 'roles', 'customer_sessions', 'customers', 'delivery_zones', 'locations', 'organizations',
    ] as const) await db.deleteFrom(table).execute();

    org = (await db.insertInto('organizations').values({ name: 'Security Org' }).returning('id').executeTakeFirstOrThrow()).id;
    location = (await db.insertInto('locations').values({ organization_id: org, name: 'A' }).returning('id').executeTakeFirstOrThrow()).id;

    const waiterRole = await db.insertInto('roles').values({ organization_id: org, name: 'Waiter' }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('role_permissions').values(
      ['orders.visits.create', 'orders.orders.create', 'orders.lines.add', 'orders.lines.send', 'orders.lines.void', 'accounts.discounts.apply']
        .map((permission_name) => ({ role_id: waiterRole.id, permission_name, scope: 'organization' })),
    ).execute();

    const managerRole = await db.insertInto('roles').values({ organization_id: org, name: 'Manager' }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('role_permissions').values(
      ['orders.visits.create', 'orders.orders.create', 'orders.lines.add', 'orders.lines.send',
       'orders.lines.void', 'orders.lines.void_override', 'kitchen.tickets.update_status', 'accounts.accounts.create',
       'accounts.discounts.apply', 'accounts.discounts.apply_override']
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

  it('applies server-computed account and line discounts, gates larger ones behind override, and audits overrides', async () => {
    const waiterAuth = { authorization: `Bearer ${token}` };
    const managerAuth = { authorization: `Bearer ${managerToken}` };
    const visit = (await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/visits`, headers: waiterAuth, payload: {} })).json();
    const account = (await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/visits/${visit.id}/accounts`, headers: managerAuth, payload: {} })).json();
    const order = (await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/visits/${visit.id}/orders`, headers: { ...waiterAuth, 'if-match': String(visit.version) }, payload: { order_type: 'DINE_IN' } })).json();
    const added = (await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/orders/${order.id}/lines`, headers: { ...waiterAuth, 'if-match': String(order.version) }, payload: { lines: [{ account_id: account.id, product_id: product, quantity: 1 }, { account_id: account.id, product_id: product, quantity: 1 }] } })).json();
    expect(added.lines).toHaveLength(2);
    const accountId = added.lines[0].account_id;
    // The two authoritative line inserts each increment the account version from its initial 1.
    const accountVersionAfterLines = 3;

    const routine = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/accounts/${accountId}/discounts`,
      headers: { ...waiterAuth, 'if-match': String(accountVersionAfterLines) },
      payload: { discount_type: 'PERCENTAGE', value: 10, reason: 'service recovery' },
    });
    expect(routine.statusCode).toBe(201);
    expect(routine.json().discount.computed_amount).toBe(500);
    expect(routine.json().account.discount).toBe(500);
    expect(routine.json().account.total).toBe(4500);

    const aboveCap = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/accounts/${accountId}/discounts`,
      headers: { ...waiterAuth, 'if-match': String(routine.json().account.version) },
      payload: { discount_type: 'PERCENTAGE', value: 21, reason: 'too generous' },
    });
    expect(aboveCap.statusCode).toBe(409);
    expect(aboveCap.json().error.code).toBe('DISCOUNT_OVERRIDE_REQUIRED');
    expect(aboveCap.json().error.message).toContain('override endpoint');

    const override = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/accounts/${accountId}/discounts/override`,
      headers: { ...managerAuth, 'if-match': String(routine.json().account.version) },
      payload: { discount_type: 'PERCENTAGE', value: 25, reason: 'manager approval', authorized_by: manager },
    });
    expect(override.statusCode).toBe(201);
    expect(override.json().discount.computed_amount).toBe(1250);
    // Fastify may flush the response immediately before the surrounding transaction commits.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const discounts = await db.selectFrom('account_discounts').selectAll().where('account_id', '=', accountId).orderBy('created_at').execute();
    expect(discounts).toHaveLength(2);
    expect(discounts[1].is_override).toBe(true);
    const audits = await db.selectFrom('audit_events').selectAll().where('aggregate_id', '=', accountId).where('action', '=', 'accounts.discounts.apply_override').execute();
    expect(audits).toHaveLength(1);

    const perLine = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/accounts/${accountId}/discounts`,
      headers: { ...waiterAuth, 'if-match': String(override.json().account.version) },
      payload: { discount_type: 'PERCENTAGE', value: 10, order_line_id: added.lines[0].id, reason: 'item issue' },
    });
    expect(perLine.statusCode).toBe(201);
    expect(perLine.json().discount.computed_amount).toBe(250);
    expect(perLine.json().discount.order_line_id).toBe(added.lines[0].id);
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
  it('requires PIN re-authentication when authorizing as a different manager', async () => {
    const visit = (await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/visits`, headers: { authorization: `Bearer ${token}` }, payload: { guest_count: 2 } })).json();
    const account = (await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/visits/${visit.id}/accounts`, headers: { authorization: `Bearer ${managerToken}` }, payload: {} })).json();
    const order = (await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/visits/${visit.id}/orders`, headers: { authorization: `Bearer ${token}`, 'if-match': String(visit.version) }, payload: { order_type: 'DINE_IN' } })).json();
    const addLines = (await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/orders/${order.id}/lines`, headers: { authorization: `Bearer ${token}`, 'if-match': String(order.version) }, payload: { lines: [{ account_id: account.id, product_id: product, quantity: 1 }] } })).json();
    const lineId = addLines.lines[0].id;
    await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/orders/${order.id}/send`, headers: { authorization: `Bearer ${token}`, 'if-match': String(addLines.order.version), 'idempotency-key': 'reauth-send-1' }, payload: { line_ids: [lineId] } });
    const afterSend = await db.selectFrom('order_lines').selectAll().where('id', '=', lineId).executeTakeFirstOrThrow();
    await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/order-lines/${lineId}/mark-preparing`, headers: { authorization: `Bearer ${managerToken}`, 'if-match': String(afterSend.version) }, payload: {} });
    const preparingLine = await db.selectFrom('order_lines').selectAll().where('id', '=', lineId).executeTakeFirstOrThrow();

    // 1. Missing PIN fails with 400
    const missingPin = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/order-lines/${lineId}/void-override`,
      headers: { authorization: `Bearer ${managerToken}`, 'if-match': String(preparingLine.version) },
      payload: { reason: 'burnt', authorized_by: staff },
    });
    expect(missingPin.statusCode).toBe(400);
    
    // 2. Wrong PIN fails with 401
    const wrongPin = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/order-lines/${lineId}/void-override`,
      headers: { authorization: `Bearer ${managerToken}`, 'if-match': String(preparingLine.version) },
      payload: { reason: 'burnt', authorized_by: staff, authorized_by_pin: '9999' },
    });
    expect(wrongPin.statusCode).toBe(401);

    // 3. An immediate retry, even with the correct PIN, must be blocked by the
    // backoff the wrong attempt just started — this is the actual anti-brute-force
    // property this whole feature exists for, not just "a row got written".
    const immediateRetry = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/order-lines/${lineId}/void-override`,
      headers: { authorization: `Bearer ${managerToken}`, 'if-match': String(preparingLine.version) },
      payload: { reason: 'burnt', authorized_by: staff, authorized_by_pin: '1111' },
    });
    expect(immediateRetry.statusCode).toBe(429);
    expect(immediateRetry.headers['retry-after']).toBeDefined();

    // 4. Wait for backoff to expire, then correct PIN succeeds
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const correctPin = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/order-lines/${lineId}/void-override`,
      headers: { authorization: `Bearer ${managerToken}`, 'if-match': String(preparingLine.version) },
      payload: { reason: 'burnt', authorized_by: staff, authorized_by_pin: '1111' },
    });
    expect(correctPin.statusCode).toBe(200);
  });

  it('skips PIN re-authentication entirely when a manager authorizes their own override', async () => {
    const visit = (await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/visits`, headers: { authorization: `Bearer ${managerToken}` }, payload: { guest_count: 1 } })).json();
    const account = (await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/visits/${visit.id}/accounts`, headers: { authorization: `Bearer ${managerToken}` }, payload: {} })).json();
    const order = (await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/visits/${visit.id}/orders`, headers: { authorization: `Bearer ${managerToken}`, 'if-match': String(visit.version) }, payload: { order_type: 'DINE_IN' } })).json();
    const addLines = (await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/orders/${order.id}/lines`, headers: { authorization: `Bearer ${managerToken}`, 'if-match': String(order.version) }, payload: { lines: [{ account_id: account.id, product_id: product, quantity: 1 }] } })).json();
    const lineId = addLines.lines[0].id;
    await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/orders/${order.id}/send`, headers: { authorization: `Bearer ${managerToken}`, 'if-match': String(addLines.order.version), 'idempotency-key': 'reauth-self-1' }, payload: { line_ids: [lineId] } });
    const afterSend = await db.selectFrom('order_lines').selectAll().where('id', '=', lineId).executeTakeFirstOrThrow();
    await app.inject({ method: 'POST', url: `/api/v1/locations/${location}/order-lines/${lineId}/mark-preparing`, headers: { authorization: `Bearer ${managerToken}`, 'if-match': String(afterSend.version) }, payload: {} });
    const preparingLine = await db.selectFrom('order_lines').selectAll().where('id', '=', lineId).executeTakeFirstOrThrow();

    const selfOverride = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/order-lines/${lineId}/void-override`,
      headers: { authorization: `Bearer ${managerToken}`, 'if-match': String(preparingLine.version) },
      payload: { reason: 'burnt', authorized_by: manager },
    });
    expect(selfOverride.statusCode).toBe(200);
  });
});
