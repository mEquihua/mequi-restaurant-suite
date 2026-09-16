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

describeIntegration('orders API against PostgreSQL', () => {
  const db = createDatabase({ databaseUrl });
  const app = Fastify({ logger: false });
  installDatabase(app, { databaseUrl });
  app.register(identityModule);
  app.register(menuModule);
  app.register(floorModule);
  app.register(ordersModule);
  let org = '';
  let location = '';
  let otherLocation = '';
  let staff = '';
  let token = '';
  let product = '';
  let visit = '';
  let account = '';
  let order = '';
  let line = '';
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
      'order_fulfillments', 'order_line_modifiers',
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
        .values({ name: 'Orders Integration' })
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
          'orders.visits.create',
          'orders.visits.close',
          'orders.visits.transfer',
          'orders.orders.create',
          'orders.lines.add',
          'orders.lines.hold',
          'orders.lines.send',
          'orders.lines.void',
          'orders.lines.void_override',
          'orders.orders.cancel',
          'orders.orders.cancel_override',
          'accounts.accounts.create',
          'accounts.accounts.split',
          'accounts.accounts.reopen',
          'accounts.discounts.apply',
          'accounts.discounts.apply_override',
          'payments.payments.create',
          'payments.refunds.create',
          'kitchen.tickets.update_status',
        ].map((permission_name) => ({ role_id: role.id, permission_name, scope: 'organization' })),
      )
      .execute();
    staff = (
      await db
        .insertInto('staff')
        .values({
          organization_id: org,
          first_name: 'Order',
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
    const terminalId = crypto.randomUUID();
    const terminalCredential = credential(location, terminalId);
    await db
      .insertInto('terminals')
      .values({
        id: terminalId,
        location_id: location,
        name: 'POS',
        credential_hash: hash(terminalCredential),
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
    product = (
      await db
        .insertInto('products')
        .values({ organization_id: org, name: 'Odd Burger', base_price: 1001 })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  });
  afterAll(async () => {
    await app.close();
    await db.destroy();
  });
  it('runs the multi-round happy path, keeps outbox transactional, and idempotently records payment', async () => {
    const opened = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/visits`,
      headers: auth(),
      payload: { guest_count: 2 },
    });
    expect(opened.statusCode).toBe(201);
    visit = opened.json().id;
    const createdAccount = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/visits/${visit}/accounts`,
      headers: auth(),
      payload: {},
    });
    expect(createdAccount.statusCode).toBe(201);
    account = createdAccount.json().id;
    const createdOrder = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/visits/${visit}/orders`,
      headers: { ...auth(), 'if-match': '1' },
      payload: { order_type: 'DINE_IN' },
    });
    expect(createdOrder.statusCode).toBe(201);
    order = createdOrder.json().id;
    const added = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/orders/${order}/lines`,
      headers: { ...auth(), 'if-match': '1' },
      payload: {
        lines: [{ account_id: account, product_id: product, quantity: 1, seat_number: 1 }],
      },
    });
    expect(added.statusCode).toBe(201);
    line = added.json().lines[0].id;
    expect(added.json().lines[0].unit_price).toBe(1001);
    const sent = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/orders/${order}/send`,
      headers: {
        ...auth(),
        'if-match': String(added.json().order.version),
        'idempotency-key': 'fire-one',
      },
      payload: { line_ids: [line] },
    });
    expect(sent.statusCode).toBe(200);
    expect(
      (
        await app.withLocationTransaction(location, (trx) =>
          trx.selectFrom('outbox_events').selectAll().execute(),
        )
      ).length,
    ).toBe(1);
    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/orders/${order}/send`,
      headers: { ...auth(), 'if-match': '1', 'idempotency-key': 'fire-one' },
      payload: { line_ids: [line] },
    });
    expect(replay.statusCode).toBe(200);
    expect(
      (
        await app.withLocationTransaction(location, (trx) =>
          trx.selectFrom('outbox_events').selectAll().execute(),
        )
      ).length,
    ).toBe(1);
    let lineVersion = 2;
    for (const command of ['mark-preparing', 'mark-ready', 'mark-fulfilled']) {
      const result = await app.inject({
        method: 'POST',
        url: `/api/v1/locations/${location}/order-lines/${line}/${command}`,
        headers: { ...auth(), 'if-match': String(lineVersion) },
        payload: {},
      });
      expect(result.statusCode).toBe(200);
      lineVersion = result.json().version;
    }
    const secondRound = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/orders/${order}/lines`,
      headers: { ...auth(), 'if-match': String(sent.json().order.version) },
      payload: {
        lines: [{ account_id: account, product_id: product, quantity: 1, seat_number: 2 }],
      },
    });
    expect(secondRound.statusCode).toBe(201);
    const line2 = secondRound.json().lines[0].id;
    const secondSend = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/orders/${order}/send`,
      headers: {
        ...auth(),
        'if-match': String(secondRound.json().order.version),
        'idempotency-key': 'fire-two',
      },
      payload: { line_ids: [line2] },
    });
    expect(secondSend.statusCode).toBe(200);
    lineVersion = 2;
    for (const command of ['mark-preparing', 'mark-ready', 'mark-fulfilled']) {
      const result = await app.inject({
        method: 'POST',
        url: `/api/v1/locations/${location}/order-lines/${line2}/${command}`,
        headers: { ...auth(), 'if-match': String(lineVersion) },
        payload: {},
      });
      expect(result.statusCode).toBe(200);
      lineVersion = result.json().version;
    }
    const payment = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/accounts/${account}/payments`,
      headers: { ...auth(), 'if-match': '3', 'idempotency-key': 'pay-once' },
      payload: { method: 'CASH', amount: 2002 },
    });
    expect(payment.statusCode).toBe(201);
    expect(payment.json().account.status).toBe('PAID');
    const paymentReplay = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/accounts/${account}/payments`,
      headers: { ...auth(), 'if-match': '1', 'idempotency-key': 'pay-once' },
      payload: { method: 'CASH', amount: 2002 },
    });
    expect(paymentReplay.statusCode).toBe(201);
    expect(
      (
        await app.withLocationTransaction(location, (trx) =>
          trx.selectFrom('payments').selectAll().execute(),
        )
      ).length,
    ).toBe(1);
    const closed = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/visits/${visit}/close`,
      headers: { ...auth(), 'if-match': '2' },
      payload: {},
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().status).toBe('COMPLETED');
  });
  it('splits an odd-cent total equally without moving lines and RLS hides another location', async () => {
    const newVisit = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/visits`,
      headers: auth(),
      payload: {},
    });
    const v = newVisit.json().id;
    const a = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/locations/${location}/visits/${v}/accounts`,
        headers: auth(),
        payload: {},
      })
    ).json().id;
    const splitOrder = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/visits/${v}/orders`,
      headers: { ...auth(), 'if-match': '1' },
      payload: { order_type: 'DINE_IN' },
    });
    const added = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/orders/${splitOrder.json().id}/lines`,
      headers: { ...auth(), 'if-match': '1' },
      payload: { lines: [{ account_id: a, product_id: product, quantity: 1 }] },
    });
    expect(added.statusCode).toBe(201);
    const split = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${location}/accounts/${a}/split`,
      headers: { ...auth(), 'if-match': '2' },
      payload: { method: 'EQUALLY', count: 3 },
    });
    expect(split.statusCode).toBe(201);
    expect(split.json().accounts.map((row: { total: number }) => row.total)).toEqual([
      335, 333, 333,
    ]);
    const other = await db
      .insertInto('visits')
      .values({ location_id: otherLocation, status: 'OPEN' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const hidden = await app.withLocationTransaction(location, (trx) =>
      trx.selectFrom('visits').selectAll().where('id', '=', other.id).execute(),
    );
    expect(hidden).toEqual([]);
  });
});
