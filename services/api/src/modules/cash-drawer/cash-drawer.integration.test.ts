import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import Fastify from 'fastify';

import { identityModule } from '../identity/index.js';
import { menuModule } from '../menu/index.js';
import { floorModule } from '../floor/index.js';
import { createDatabase, installDatabase } from '../../shared/index.js';
import { cashDrawerModule } from './index.js';
import { ordersModule } from '../orders/index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const credential = (locationId: string, terminalId: string) =>
  `${locationId}.${terminalId}.${randomBytes(32).toString('base64url')}`;

describeIntegration('cash drawer API against PostgreSQL', () => {
  const db = createDatabase({ databaseUrl });
  const app = Fastify({ logger: false });
  installDatabase(app, { databaseUrl });
  app.register(identityModule);
  app.register(menuModule);
  app.register(floorModule);
  app.register(ordersModule);
  app.register(cashDrawerModule);

  let org = '';
  let location = '';
  let otherLocation = '';
  let staff = '';
  let token = '';
  let terminal = '';
  let otherTerminal = '';
  let account = '';
  let visit = '';
  
  const auth = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    for (const table of [
      'cash_drawer_movements',
      'cash_drawer_sessions',
      'command_idempotency',
      'audit_events',
      'account_discounts',
      'outbox_events',
      'refunds',
      'cancellations_and_voids',
      'payments',
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
      'staff',
      'roles',
      'locations',
      'organizations',
    ] as const)
      await db.deleteFrom(table).execute();

    org = (
      await db
        .insertInto('organizations')
        .values({ name: 'Cash Drawer Integration' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    [location, otherLocation] = (
      await db
        .insertInto('locations')
        .values([
          { organization_id: org, name: 'A' },
          { organization_id: org, name: 'B' },
        ])
        .returning('id')
        .execute()
    ).map((row) => row.id);
    const role = await db
      .insertInto('roles')
      .values({ organization_id: org, name: 'Owner' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('role_permissions')
      .values(
        [
          'payments.cash.open_drawer',
          'payments.cash.reconcile',
          'orders.visits.create',
          'accounts.accounts.create',
          'payments.payments.create'
        ].map((permission_name) => ({ role_id: role.id, permission_name, scope: 'organization' })),
      )
      .execute();
    staff = (
      await db
        .insertInto('staff')
        .values({
          organization_id: org,
          first_name: 'Cash',
          last_name: 'Owner',
          pin_hash: await argon2.hash('2468'),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto('staff_roles')
      .values({ staff_id: staff, role_id: role.id, location_id: null })
      .execute();
      
    terminal = crypto.randomUUID();
    const terminalCredential = credential(location, terminal);
    await db
      .insertInto('terminals')
      .values({
        id: terminal,
        location_id: location,
        name: 'POS',
        credential_hash: hash(terminalCredential),
      })
      .execute();

    otherTerminal = crypto.randomUUID();
    const otherTerminalCredential = credential(otherLocation, otherTerminal);
    await db
      .insertInto('terminals')
      .values({
        id: otherTerminal,
        location_id: otherLocation,
        name: 'Other POS',
        credential_hash: hash(otherTerminalCredential),
      })
      .execute();

    const unlock = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/pin-unlock',
      headers: { 'x-terminal-credential': terminalCredential },
      payload: { staff_id: staff, pin: '2468' },
    });
    expect(unlock.statusCode).toBe(201);
    token = unlock.json().token;
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('rejects movements or closing if no open session exists', async () => {
    const fakeSessionId = crypto.randomUUID();
    
    let res = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/cash-drawer-sessions/${fakeSessionId}/movements`,
      headers: auth(),
      payload: { movement_type: 'CASH_IN', amount: 500, reason: 'Test' },
    });
    expect(res.statusCode).toBe(404);

    res = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/cash-drawer-sessions/${fakeSessionId}/close`,
      headers: { ...auth(), 'if-match': '1' },
      payload: { counted_amount: 100 },
    });
    expect(res.statusCode).toBe(404);
  });

  let sessionId = '';
  let sessionVersion = 0;

  it('opens a cash drawer session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/terminals/${terminal}/cash-drawer/open`,
      headers: auth(),
      payload: { opening_float: 10000 },
    });
    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.status).toBe('OPEN');
    expect(json.opening_float).toBe(10000);
    expect(json.terminal_id).toBe(terminal);
    sessionId = json.id;
    sessionVersion = json.version;
  });

  it('rejects a second open on the same terminal', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/terminals/${terminal}/cash-drawer/open`,
      headers: auth(),
      payload: { opening_float: 5000 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DRAWER_ALREADY_OPEN');
  });

  it('records cash-in and cash-out movements', async () => {
    let res = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/cash-drawer-sessions/${sessionId}/movements`,
      headers: auth(),
      payload: { movement_type: 'CASH_IN', amount: 5000, reason: 'Top-up' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().amount).toBe(5000);
    expect(res.json().movement_type).toBe('CASH_IN');

    res = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/cash-drawer-sessions/${sessionId}/movements`,
      headers: auth(),
      payload: { movement_type: 'CASH_OUT', amount: 2000, reason: 'Paid out' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().amount).toBe(2000);
  });

  it('simulates a cash payment (implicitly via manual insert for test speed, or using real endpoints if available)', async () => {
    // create a visit, account and payment
    visit = (await db.insertInto('visits').values({ location_id: location }).returning('id').executeTakeFirstOrThrow()).id;
    account = (await db.insertInto('accounts').values({ location_id: location, visit_id: visit }).returning('id').executeTakeFirstOrThrow()).id;
    
    await db.insertInto('payments').values({
      location_id: location,
      account_id: account,
      method: 'CASH',
      amount: 15000,
      status: 'CAPTURED',
    }).execute();
  });

  it('closes the drawer with a matching count (variance 0)', async () => {
    // Expected: 10000 (float) + 15000 (sales) + 5000 (in) - 2000 (out) = 28000
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/cash-drawer-sessions/${sessionId}/close`,
      headers: { ...auth(), 'if-match': sessionVersion.toString() },
      payload: { counted_amount: 28000 },
    });
    
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.status).toBe('CLOSED');
    expect(json.expected_amount).toBe(28000);
    expect(json.variance).toBe(0);
  });

  it('opens a new drawer and closes with a mismatched count', async () => {
    const openRes = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/terminals/${terminal}/cash-drawer/open`,
      headers: auth(),
      payload: { opening_float: 5000 },
    });
    expect(openRes.statusCode).toBe(201);
    const newSessionId = openRes.json().id;
    const newVersion = openRes.json().version;

    // Expected: 5000 + 0 (sales since open) + 0 - 0 = 5000
    // We count 4500 (short by 500)
    const closeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/cash-drawer-sessions/${newSessionId}/close`,
      headers: { ...auth(), 'if-match': newVersion.toString() },
      payload: { counted_amount: 4500 },
    });
    expect(closeRes.statusCode).toBe(200);
    const json = closeRes.json();
    expect(json.expected_amount).toBe(5000);
    expect(json.variance).toBe(-500); // counted - expected
  });

  it('enforces RLS cross-location isolation', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${otherLocation}/cash-drawer-sessions`,
      headers: auth(),
    });
    // Actor is scoped to `location`, not `otherLocation`.
    expect(res.statusCode).toBe(403);
    
    // Test that fetching from db using a transaction with wrong location returns empty
    const hidden = await app.withLocationTransaction(location, async (trx) => 
      trx.selectFrom('cash_drawer_sessions').selectAll().where('location_id', '=', otherLocation).execute()
    );
    expect(hidden).toEqual([]);
  });
});
