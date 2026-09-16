import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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

describeIntegration('orders API reads and table side effects against PostgreSQL', () => {
  const db = createDatabase({ databaseUrl });
  const app = Fastify({ logger: false });
  installDatabase(app, { databaseUrl });
  app.register(identityModule);
  app.register(menuModule);
  app.register(floorModule);
  app.register(ordersModule);

  let org = '';
  let locationA = '';
  let locationB = '';
  let staffA = '';
  let tokenA = '';
  let tokenB = '';
  let areaA = '';
  let tableA1 = '';
  let tableA2 = '';
  let areaB = '';
  let productA = '';

  const authA = () => ({ authorization: `Bearer ${tokenA}` });
  const authB = () => ({ authorization: `Bearer ${tokenB}` });

  beforeAll(async () => {
    for (const table of [
      'cash_drawer_movements', 'cash_drawer_sessions', 'command_idempotency', 'audit_events',
      'account_discounts', 'outbox_events', 'refunds', 'cancellations_and_voids', 'payments',
      'order_fulfillments', 'order_line_modifiers', 'order_lines', 'orders', 'accounts', 'visits', 'table_sections',
      'sections', 'tables', 'areas', 'availability_rules', 'location_price_overrides',
      'product_combo_items', 'product_combo_groups', 'product_modifier_groups', 'modifiers',
      'modifier_groups', 'product_variants', 'products', 'categories', 'terminal_pin_attempts',
      'staff_sessions', 'staff_roles', 'role_permissions', 'terminals', 'staff', 'roles',
      'customer_sessions', 'customers', 'locations', 'organizations',
    ] as const)
      await db.deleteFrom(table).execute();

    org = (await db.insertInto('organizations').values({ name: 'Org' }).returning('id').executeTakeFirstOrThrow()).id;
    locationA = (await db.insertInto('locations').values({ organization_id: org, name: 'Loc A' }).returning('id').executeTakeFirstOrThrow()).id;
    locationB = (await db.insertInto('locations').values({ organization_id: org, name: 'Loc B' }).returning('id').executeTakeFirstOrThrow()).id;
    
    staffA = (await db.insertInto('staff').values({ organization_id: org, first_name: 'A', last_name: 'A', pin_hash: await argon2.hash('1234') }).returning('id').executeTakeFirstOrThrow()).id;
    const staffB = (await db.insertInto('staff').values({ organization_id: org, first_name: 'B', last_name: 'B', pin_hash: await argon2.hash('1234') }).returning('id').executeTakeFirstOrThrow()).id;
    
    const role = (await db.insertInto('roles').values({ organization_id: org, name: 'Manager' }).returning('id').executeTakeFirstOrThrow()).id;
    await db.insertInto('role_permissions').values([
      'orders.visits.create', 'orders.visits.read_all', 'orders.visits.close', 'orders.orders.create', 'accounts.accounts.create',
      'orders.lines.add', 'orders.lines.send', 'kitchen.tickets.read',
    ].map(p => ({ role_id: role, permission_name: p, scope: 'organization' as const }))).execute();
    
    await db.insertInto('staff_roles').values([{ location_id: locationA, staff_id: staffA, role_id: role }, { location_id: locationB, staff_id: staffB, role_id: role }]).execute();

    const termA = (await db.insertInto('terminals').values({ location_id: locationA, name: 'Term A', credential_hash: 'hash' }).returning('id').executeTakeFirstOrThrow()).id;
    const termB = (await db.insertInto('terminals').values({ location_id: locationB, name: 'Term B', credential_hash: 'hash' }).returning('id').executeTakeFirstOrThrow()).id;
    
    const credA = `${locationA}.${randomBytes(32).toString('base64url')}`;
    const credB = `${locationB}.${randomBytes(32).toString('base64url')}`;
    const expires_at = new Date(Date.now() + 1000000);
    await db.insertInto('staff_sessions').values([
      { location_id: locationA, staff_id: staffA, terminal_id: termA, token_hash: hash(credA), expires_at },
      { location_id: locationB, staff_id: staffB, terminal_id: termB, token_hash: hash(credB), expires_at }
    ]).execute();
    tokenA = credA;
    tokenB = credB;

    areaA = (await db.insertInto('areas').values({ location_id: locationA, name: 'Main' }).returning('id').executeTakeFirstOrThrow()).id;
    tableA1 = (await db.insertInto('tables').values({ location_id: locationA, area_id: areaA, name: 'T1', min_capacity: 1, max_capacity: 4, pos_x: 0, pos_y: 0 }).returning('id').executeTakeFirstOrThrow()).id;
    tableA2 = (await db.insertInto('tables').values({ location_id: locationA, area_id: areaA, name: 'T2', min_capacity: 1, max_capacity: 4, pos_x: 0, pos_y: 0 }).returning('id').executeTakeFirstOrThrow()).id;
    
    areaB = (await db.insertInto('areas').values({ location_id: locationB, name: 'Main' }).returning('id').executeTakeFirstOrThrow()).id;
    await db.insertInto('tables').values({ location_id: locationB, area_id: areaB, name: 'T1', min_capacity: 1, max_capacity: 4, pos_x: 0, pos_y: 0 }).execute();

    productA = (await db.insertInto('products').values({ organization_id: org, name: 'Burger', base_price: 1000 }).returning('id').executeTakeFirstOrThrow()).id;
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('opening a visit on an AVAILABLE table transitions it to OCCUPIED', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationA}/visits`, headers: authA(), payload: { table_id: tableA1 } });
    expect(res.statusCode).toBe(201);
    
    const table = await db.selectFrom('tables').selectAll().where('id', '=', tableA1).executeTakeFirst();
    expect(table?.status).toBe('OCCUPIED');
  });

  it('opening a second visit on an already-OCCUPIED table is rejected with a 409', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationA}/visits`, headers: authA(), payload: { table_id: tableA1 } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('TABLE_NOT_AVAILABLE');
  });

  it('closing a settled visit transitions its table to NEEDS_CLEANING, not directly to AVAILABLE', async () => {
    // Open a visit on tableA2
    const visitRes = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationA}/visits`, headers: authA(), payload: { table_id: tableA2 } });
    const visit = visitRes.json();
    
    const tableOccupied = await db.selectFrom('tables').selectAll().where('id', '=', tableA2).executeTakeFirst();
    expect(tableOccupied?.status).toBe('OCCUPIED');

    // Close the visit directly (no orders/accounts to settle in this case)
    const closeRes = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationA}/visits/${visit.id}/close`, headers: { ...authA(), 'if-match': visit.version.toString() }, payload: {} });
    expect(closeRes.statusCode).toBe(200);

    const tableNeedsCleaning = await db.selectFrom('tables').selectAll().where('id', '=', tableA2).executeTakeFirst();
    expect(tableNeedsCleaning?.status).toBe('NEEDS_CLEANING');
  });

  it('GET endpoints return expected shape and enforce location scoping', async () => {
    const visitRes = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationA}/visits`, headers: authA(), payload: {} });
    const visit = visitRes.json();
    const orderRes = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationA}/visits/${visit.id}/orders`, headers: { ...authA(), 'if-match': visit.version.toString() }, payload: { order_type: 'DINE_IN' } });
    const order = orderRes.json();
    const accountRes = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationA}/visits/${visit.id}/accounts`, headers: authA(), payload: { name: 'Main' } });
    const account = accountRes.json();

    // GET /visits
    const listA = await app.inject({ method: 'GET', url: `/api/v1/locations/${locationA}/visits`, headers: authA() });
    expect(listA.statusCode).toBe(200);
    expect(listA.json().data.length).toBeGreaterThan(0);

    const listB = await app.inject({ method: 'GET', url: `/api/v1/locations/${locationB}/visits`, headers: authB() });
    expect(listB.statusCode).toBe(200);
    expect(listB.json().data.find((v: { id: string }) => v.id === visit.id)).toBeUndefined();

    // Cannot read locationA visits from locationB
    const deniedList = await app.inject({ method: 'GET', url: `/api/v1/locations/${locationA}/visits`, headers: authB() });
    expect(deniedList.statusCode).toBe(403);

    // GET /visits/:id
    const singleVisit = await app.inject({ method: 'GET', url: `/api/v1/locations/${locationA}/visits/${visit.id}`, headers: authA() });
    expect(singleVisit.statusCode).toBe(200);
    expect(singleVisit.json().id).toBe(visit.id);
    expect(singleVisit.json().orders[0].id).toBe(order.id);
    expect(singleVisit.json().accounts[0].id).toBe(account.id);

    const singleVisitDenied = await app.inject({ method: 'GET', url: `/api/v1/locations/${locationA}/visits/${visit.id}`, headers: authB() });
    expect(singleVisitDenied.statusCode).toBe(403);

    // GET /orders/:id
    const singleOrder = await app.inject({ method: 'GET', url: `/api/v1/locations/${locationA}/orders/${order.id}`, headers: authA() });
    expect(singleOrder.statusCode).toBe(200);
    expect(singleOrder.json().id).toBe(order.id);
    expect(singleOrder.json().order_lines).toBeDefined();

    // GET /accounts/:id
    const singleAccount = await app.inject({ method: 'GET', url: `/api/v1/locations/${locationA}/accounts/${account.id}`, headers: authA() });
    expect(singleAccount.statusCode).toBe(200);
    expect(singleAccount.json().id).toBe(account.id);
    expect(singleAccount.json().payments).toBeDefined();
    expect(singleAccount.json().cancellations_and_voids).toBeDefined();
  });

  it('GET /order-lines lists sent kitchen tickets, filters by status, and enforces location scoping', async () => {
    const visitRes = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationA}/visits`, headers: authA(), payload: {} });
    const visit = visitRes.json();
    const orderRes = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationA}/visits/${visit.id}/orders`, headers: { ...authA(), 'if-match': visit.version.toString() }, payload: { order_type: 'DINE_IN' } });
    const order = orderRes.json();
    const accountRes = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationA}/visits/${visit.id}/accounts`, headers: authA(), payload: { name: 'Main' } });
    const account = accountRes.json();

    const addLinesRes = await app.inject({
      method: 'POST', url: `/api/v1/locations/${locationA}/orders/${order.id}/lines`,
      headers: { ...authA(), 'if-match': order.version.toString() },
      payload: { lines: [{ product_id: productA, quantity: 2, account_id: account.id }] },
    });
    const created = addLinesRes.json();
    const lineId = created.lines[0].id;

    await app.inject({
      method: 'POST', url: `/api/v1/locations/${locationA}/orders/${order.id}/send`,
      headers: { ...authA(), 'if-match': created.order.version.toString(), 'idempotency-key': randomUUID() },
      payload: { line_ids: [lineId] },
    });

    const sentLines = await app.inject({ method: 'GET', url: `/api/v1/locations/${locationA}/order-lines?status=SENT`, headers: authA() });
    expect(sentLines.statusCode).toBe(200);
    expect(sentLines.json().data.some((l: { id: string }) => l.id === lineId)).toBe(true);

    const readyLines = await app.inject({ method: 'GET', url: `/api/v1/locations/${locationA}/order-lines?status=READY`, headers: authA() });
    expect(readyLines.statusCode).toBe(200);
    expect(readyLines.json().data.some((l: { id: string }) => l.id === lineId)).toBe(false);

    const deniedFromB = await app.inject({ method: 'GET', url: `/api/v1/locations/${locationA}/order-lines`, headers: authB() });
    expect(deniedFromB.statusCode).toBe(403);

    const listB = await app.inject({ method: 'GET', url: `/api/v1/locations/${locationB}/order-lines`, headers: authB() });
    expect(listB.statusCode).toBe(200);
    expect(listB.json().data.some((l: { id: string }) => l.id === lineId)).toBe(false);
  });
});
