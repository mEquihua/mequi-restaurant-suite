import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import Fastify from 'fastify';

import { identityModule } from '../identity/index.js';
import { createDatabase, installDatabase } from '../../shared/index.js';
import { reportsModule } from './index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const terminalCredential = (locationId: string, terminalId: string) =>
  `${locationId}.${terminalId}.${randomBytes(32).toString('base64url')}`;

describeIntegration('reports API against PostgreSQL', () => {
  const db = createDatabase({ databaseUrl });
  const app = Fastify({ logger: false });
  installDatabase(app, { databaseUrl });
  app.register(identityModule); app.register(reportsModule);
  let location = ''; let staff = ''; let salesToken = ''; let auditToken = ''; let noSalesToken = '';
  const range = 'from=2026-09-15T00%3A00%3A00.000Z&to=2026-09-16T00%3A00%3A00.000Z';
  const auth = (token = salesToken) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    for (const table of ['stock_adjustments', 'ingredient_stock', 'recipe_lines', 'ingredients', 'cash_drawer_movements', 'cash_drawer_sessions', 'command_idempotency', 'audit_events', 'account_discounts', 'outbox_events', 'refunds', 'cancellations_and_voids', 'payments', 'order_fulfillments', 'order_line_modifiers', 'order_lines', 'orders', 'accounts', 'visits', 'table_sections', 'sections', 'tables', 'areas', 'availability_rules', 'location_price_overrides', 'product_combo_items', 'product_combo_groups', 'product_modifier_groups', 'modifiers', 'modifier_groups', 'product_variants', 'products', 'categories', 'terminal_pin_attempts', 'staff_sessions', 'staff_roles', 'role_permissions', 'terminals', 'staff', 'roles', 'customer_sessions', 'customers', 'delivery_zones', 'locations', 'organizations'] as const)
      await db.deleteFrom(table).execute();
    const org = (await db.insertInto('organizations').values({ name: 'Reports Integration' }).returning('id').executeTakeFirstOrThrow()).id;
    location = (await db.insertInto('locations').values({ organization_id: org, name: 'Centro', timezone: 'America/Mexico_City' }).returning('id').executeTakeFirstOrThrow()).id;
    const [salesRole, auditRole, noReportsRole] = await db.insertInto('roles').values([{ organization_id: org, name: 'Sales reporter' }, { organization_id: org, name: 'Audit reporter' }, { organization_id: org, name: 'No reports' }]).returning('id').execute();
    await db.insertInto('role_permissions').values([{ role_id: salesRole.id, permission_name: 'reports.sales.read', scope: 'location' }, { role_id: auditRole.id, permission_name: 'reports.audit.read', scope: 'location' }]).execute();
    const pinHash = await argon2.hash('2468');
    [staff] = (await db.insertInto('staff').values([{ organization_id: org, first_name: 'Ada', last_name: 'Sales', pin_hash: pinHash }, { organization_id: org, first_name: 'Aria', last_name: 'Audit', pin_hash: pinHash }, { organization_id: org, first_name: 'Nora', last_name: 'None', pin_hash: pinHash }]).returning('id').execute()).map(({ id }) => id);
    const auditStaff = (await db.selectFrom('staff').select('id').where('first_name', '=', 'Aria').executeTakeFirstOrThrow()).id;
    const noReportsStaff = (await db.selectFrom('staff').select('id').where('first_name', '=', 'Nora').executeTakeFirstOrThrow()).id;
    await db.insertInto('staff_roles').values([{ staff_id: staff, role_id: salesRole.id, location_id: location }, { staff_id: auditStaff, role_id: auditRole.id, location_id: location }, { staff_id: noReportsStaff, role_id: noReportsRole.id, location_id: location }]).execute();
    async function unlock(staffId: string) {
      const terminalId = crypto.randomUUID(); const credential = terminalCredential(location, terminalId);
      await db.insertInto('terminals').values({ id: terminalId, location_id: location, name: `POS ${staffId}`, credential_hash: hash(credential) }).execute();
      const response = await app.inject({ method: 'POST', url: '/api/v1/auth/pin-unlock', headers: { 'x-terminal-credential': credential }, payload: { staff_id: staffId, pin: '2468' } });
      expect(response.statusCode).toBe(201); return response.json().token as string;
    }
    salesToken = await unlock(staff); auditToken = await unlock(auditStaff); noSalesToken = await unlock(noReportsStaff);
    const [food, drinks] = await db.insertInto('categories').values([{ organization_id: org, name: 'Food' }, { organization_id: org, name: 'Drinks' }]).returning('id').execute();
    const [burger, soda] = await db.insertInto('products').values([{ organization_id: org, category_id: food.id, name: 'Burger', base_price: 1_000 }, { organization_id: org, category_id: drinks.id, name: 'Soda', base_price: 300 }]).returning('id').execute();
    const [visitOne, visitTwo] = await db.insertInto('visits').values([{ location_id: location, staff_id: staff, opened_at: new Date('2026-09-15T05:00:00.000Z') }, { location_id: location, staff_id: staff, opened_at: new Date('2026-09-15T06:00:00.000Z') }]).returning('id').execute();
    const [accountOne, accountTwo] = await db.insertInto('accounts').values([{ location_id: location, visit_id: visitOne.id, subtotal: 1_000, tax: 100, discount: 100, total: 1_000, paid_amount: 1_000, status: 'PAID' }, { location_id: location, visit_id: visitTwo.id, subtotal: 500, tax: 50, total: 550, paid_amount: 550, status: 'PAID' }]).returning('id').execute();
    const [orderOne, orderTwo] = await db.insertInto('orders').values([{ location_id: location, visit_id: visitOne.id, order_type: 'DINE_IN', status: 'COMPLETED', created_at: new Date('2026-09-15T05:15:00.000Z') }, { location_id: location, visit_id: visitTwo.id, order_type: 'DINE_IN', status: 'COMPLETED', created_at: new Date('2026-09-15T06:15:00.000Z') }]).returning('id').execute();
    const [soldLine, voidedLine] = await db.insertInto('order_lines').values([{ location_id: location, order_id: orderOne.id, account_id: accountOne.id, product_id: burger.id, quantity: 1, unit_price: 1_000, status: 'FULFILLED' }, { location_id: location, order_id: orderOne.id, account_id: accountOne.id, product_id: soda.id, quantity: 1, unit_price: 300, status: 'VOIDED' }, { location_id: location, order_id: orderTwo.id, account_id: accountTwo.id, product_id: burger.id, quantity: 1, unit_price: 500, status: 'FULFILLED' }]).returning('id').execute();
    const [cashPayment] = await db.insertInto('payments').values([{ location_id: location, account_id: accountOne.id, method: 'CASH', amount: 1_000, tip_amount: 100, status: 'COMPLETED', created_at: new Date('2026-09-15T06:30:00.000Z') }, { location_id: location, account_id: accountTwo.id, method: 'CARD', amount: 550, status: 'COMPLETED', created_at: new Date('2026-09-15T07:00:00.000Z') }]).returning('id').execute();
    await db.insertInto('account_discounts').values({ location_id: location, account_id: accountOne.id, discount_type: 'PERCENTAGE', value: 10, computed_amount: 100, reason: 'Lunch special', applied_by: staff, is_override: false, created_at: new Date('2026-09-15T06:00:00.000Z') }).execute();
    await db.insertInto('cancellations_and_voids').values({ location_id: location, order_line_id: voidedLine.id, operation_type: 'VOID', amount: 300, reason: 'Guest changed mind', authorized_by: staff, created_at: new Date('2026-09-15T06:05:00.000Z') }).execute();
    await db.insertInto('refunds').values({ location_id: location, payment_id: cashPayment.id, amount: 200, reason: 'Service recovery', authorized_by: staff, created_at: new Date('2026-09-15T08:00:00.000Z') }).execute();
    void soldLine;
  });
  afterAll(async () => { await app.close(); await db.destroy(); });

  it('uses payment settlement time in the location timezone and excludes voided line value', async () => {
    const byDay = await app.inject({ method: 'GET', url: `/api/v1/locations/${location}/reports/sales/by-day?${range}`, headers: auth() });
    expect(byDay.statusCode).toBe(200); expect(byDay.json().data).toEqual([{ day: '2026-09-15', gross_sales: 1_650, discounts: 100, refunds: 200, net_sales: 1_350 }]);
    const byHour = await app.inject({ method: 'GET', url: `/api/v1/locations/${location}/reports/sales/by-hour?${range}`, headers: auth() });
    expect(byHour.statusCode).toBe(200); expect(byHour.json().data).toEqual([
      { hour: 0, gross_sales: 1_100, discounts: 100, refunds: 0, net_sales: 1_000 },
      { hour: 1, gross_sales: 550, discounts: 0, refunds: 0, net_sales: 550 },
      { hour: 2, gross_sales: 0, discounts: 0, refunds: 200, net_sales: -200 },
    ]);
    const products = await app.inject({ method: 'GET', url: `/api/v1/locations/${location}/reports/sales/by-product?${range}&limit=10`, headers: auth() });
    expect(products.json().data).toEqual([{ product_id: expect.any(String), product_name: 'Burger', quantity_sold: 2, gross_sales: 1_500 }]);
  });

  it('keeps original payments while reporting refunds and discounts, with matching CSV', async () => {
    const refunds = await app.inject({ method: 'GET', url: `/api/v1/locations/${location}/reports/refunds?${range}`, headers: auth(auditToken) });
    expect(refunds.statusCode).toBe(200); expect(refunds.json().data).toEqual([{ reason: 'Service recovery', count: 1, value: 200 }]);
    const payments = await app.inject({ method: 'GET', url: `/api/v1/locations/${location}/reports/payments/by-method?${range}`, headers: auth() });
    expect(payments.json().data).toEqual([{ method: 'CARD', total_collected: 550 }, { method: 'CASH', total_collected: 1_000 }]);
    const discounts = await app.inject({ method: 'GET', url: `/api/v1/locations/${location}/reports/discounts?${range}`, headers: auth() });
    expect(discounts.json().data).toEqual([{ discount_type: 'PERCENTAGE', reason: 'Lunch special', count: 1, total_discount: 100 }]);
    const json = await app.inject({ method: 'GET', url: `/api/v1/locations/${location}/reports/sales/by-day?${range}`, headers: auth() });
    const csv = await app.inject({ method: 'GET', url: `/api/v1/locations/${location}/reports/sales/by-day?${range}&format=csv`, headers: auth() });
    expect(csv.statusCode).toBe(200); expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.trim().split('\n')).toHaveLength(json.json().data.length + 1);
    expect(csv.body).toContain('1650'); expect(csv.body).toContain('1350');
  });

  it('rejects missing sales and audit permissions', async () => {
    const sales = await app.inject({ method: 'GET', url: `/api/v1/locations/${location}/reports/sales/by-day?${range}`, headers: auth(noSalesToken) });
    expect(sales.statusCode).toBe(403); expect(sales.json().error.code).toBe('FORBIDDEN');
    const audit = await app.inject({ method: 'GET', url: `/api/v1/locations/${location}/reports/voids-and-cancellations?${range}`, headers: auth() });
    expect(audit.statusCode).toBe(403); expect(audit.json().error.code).toBe('FORBIDDEN');
  });

  it('multi-location org reports', async () => {
    const org = await db.selectFrom('organizations').select('id').executeTakeFirstOrThrow();
    // This codebase enforces a hard single-organization-per-install constraint
    // (organizations.unq_is_single_org), so a genuinely separate organization
    // row cannot exist alongside this test's own. A location id that simply
    // doesn't exist exercises the exact same "not in this org's location set"
    // path the handler filters on, without violating that constraint.
    const otherLocationId = crypto.randomUUID();

    // Test all=true returns every location in the org
    const all = await app.inject({ method: 'GET', url: `/api/v1/organizations/${org.id}/reports/sales/by-day?${range}&all=true`, headers: auth() });
    expect(all.statusCode).toBe(200);
    const dataAll = all.json().data;
    expect(dataAll).toHaveLength(1);
    expect(dataAll[0].location_name).toBe('Centro');
    expect(dataAll[0].data).toEqual([{ day: '2026-09-15', gross_sales: 1_650, discounts: 100, refunds: 200, net_sales: 1_350 }]);

    // Test explicit location_ids returns only those, silently dropping ones not in this org
    const some = await app.inject({ method: 'GET', url: `/api/v1/organizations/${org.id}/reports/sales/by-day?${range}&location_ids=${location},${otherLocationId}`, headers: auth() });
    expect(some.statusCode).toBe(200);
    const dataSome = some.json().data;
    expect(dataSome).toHaveLength(1);
    expect(dataSome[0].location_id).toBe(location);

    // Permission enforcement
    const forbidden = await app.inject({ method: 'GET', url: `/api/v1/organizations/${org.id}/reports/sales/by-day?${range}&all=true`, headers: auth(noSalesToken) });
    expect(forbidden.statusCode).toBe(403);
  });
});
