import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import Fastify from 'fastify';

import { identityModule } from '../identity/index.js';
import { createDatabase, installDatabase } from '../../shared/index.js';
import { timeclockModule } from './index.js';

const databaseUrl = process.env.DATABASE_URL;
const db = createDatabase({ databaseUrl });
const describeIntegration = databaseUrl ? describe : describe.skip;

function terminalCredential(locationId: string, terminalId: string) {
  return `${locationId}.${terminalId}.${randomBytes(32).toString('base64url')}`;
}
function credentialHash(credential: string) {
  return createHash('sha256').update(credential).digest('hex');
}

describeIntegration('timeclock module', () => {
  const app = Fastify();
  installDatabase(app, { databaseUrl });
  app.register(identityModule, {});
  app.register(timeclockModule, {});

  let organizationId: string;
  let locationId: string;
  let ownerId: string;
  let workerId: string;
  let ownerSession: string;
  let workerSession: string;

  beforeAll(async () => {
    for (const table of [
      'loyalty_transactions',
      'loyalty_redemptions',
      'loyalty_accounts',
      'loyalty_rewards',
      'loyalty_coupons',
      'loyalty_settings',
      'reservations',
      'reservation_settings',
      'stock_adjustments',
      'ingredient_stock',
      'recipe_lines',
      'ingredients',
      'cash_drawer_movements',
      'cash_drawer_sessions',
      'module_activations',
      'command_idempotency',
      'audit_events',
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
      'locations',
      'organizations'
    ] as const) {
      await db.deleteFrom(table).execute();
    }

    const organization = await db
      .insertInto('organizations')
      .values({ name: 'Timeclock Test' })
      .returning('id')
      .executeTakeFirstOrThrow();
    organizationId = organization.id;

    const location = await db
      .insertInto('locations')
      .values({ organization_id: organizationId, name: 'Main' })
      .returning('id')
      .executeTakeFirstOrThrow();
    locationId = location.id;

    const owner = await db
      .insertInto('staff')
      .values({ organization_id: organizationId, first_name: 'Owner', last_name: 'User', pin_hash: await argon2.hash('1234') })
      .returning('id')
      .executeTakeFirstOrThrow();
    ownerId = owner.id;

    const worker = await db
      .insertInto('staff')
      .values({ organization_id: organizationId, first_name: 'Worker', last_name: 'User', pin_hash: await argon2.hash('4321') })
      .returning('id')
      .executeTakeFirstOrThrow();
    workerId = worker.id;

    const terminalId = crypto.randomUUID();
    const termCred = terminalCredential(locationId, terminalId);
    await db
      .insertInto('terminals')
      .values({ id: terminalId, location_id: locationId, name: 'T1', credential_hash: credentialHash(termCred) })
      .execute();
    
    // Add all permissions to owner
    const role = await db.insertInto('roles').values({ organization_id: organizationId, name: 'Admin' }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('role_permissions').values([
      { role_id: role.id, permission_name: 'timeclock.shifts.read', scope: 'LOCATION' },
      { role_id: role.id, permission_name: 'timeclock.shifts.write', scope: 'LOCATION' },
      { role_id: role.id, permission_name: 'timeclock.shifts.clock', scope: 'LOCATION' }
    ]).execute();
    await db.insertInto('staff_roles').values({ staff_id: ownerId, role_id: role.id }).execute();

    // Add only clock permission to worker
    const workerRole = await db.insertInto('roles').values({ organization_id: organizationId, name: 'Worker' }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('role_permissions').values([
      { role_id: workerRole.id, permission_name: 'timeclock.shifts.clock', scope: 'LOCATION' }
    ]).execute();
    await db.insertInto('staff_roles').values({ staff_id: workerId, role_id: workerRole.id }).execute();

    let res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/pin-unlock',
      headers: { 'x-terminal-credential': termCred },
      payload: { staff_id: ownerId, pin: '1234' }
    });
    if (res.statusCode >= 300) throw new Error(`owner pin-unlock failed: ${res.statusCode} ${res.body}`);
    ownerSession = res.json().token;

    res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/pin-unlock',
      headers: { 'x-terminal-credential': termCred },
      payload: { staff_id: workerId, pin: '4321' }
    });
    if (res.statusCode >= 300) throw new Error(`worker pin-unlock failed: ${res.statusCode} ${res.body}`);
    workerSession = res.json().token;
  });

  afterAll(async () => {
    await db.destroy();
    await app.close();
  });

  it('allows clock-in and rejects second clock-in', async () => {
    let res = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/shifts/clock-in`,
      headers: { authorization: `Bearer ${workerSession}` }
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('OPEN');
    expect(res.json().staff_id).toBe(workerId);

    // Second clock-in should fail
    res = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/shifts/clock-in`,
      headers: { authorization: `Bearer ${workerSession}` }
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ALREADY_CLOCKED_IN');
  });

  it('allows clock-out (self) with only .clock permission', async () => {
    // Get shift
    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/staff/me/shifts`,
      headers: { authorization: `Bearer ${workerSession}` }
    });
    expect(get.statusCode).toBe(200);
    const shift = get.json().data[0];
    
    // Clock out self
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/shifts/${shift.id}/clock-out`,
      headers: { authorization: `Bearer ${workerSession}`, 'if-match': `"${shift.version}"` }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CLOSED');
    expect(res.json().clocked_out_by_staff_id).toBe(workerId);
  });

  it('manager can clock out a different staff member but worker cannot', async () => {
    // Worker clocks in
    const req = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/shifts/clock-in`,
      headers: { authorization: `Bearer ${workerSession}` }
    });
    const shift = req.json();

    // Owner (has .write) clocks them out
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/shifts/${shift.id}/clock-out`,
      headers: { authorization: `Bearer ${ownerSession}`, 'if-match': `"${shift.version}"` }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().clocked_out_by_staff_id).toBe(ownerId);
    
    // Test that worker cannot clock out owner
    const ownerReq = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/shifts/clock-in`,
      headers: { authorization: `Bearer ${ownerSession}` }
    });
    const ownerShift = ownerReq.json();

    const failRes = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/shifts/${ownerShift.id}/clock-out`,
      headers: { authorization: `Bearer ${workerSession}`, 'if-match': `"${ownerShift.version}"` }
    });
    expect(failRes.statusCode).toBe(403);
    
    // Owner closes their own
    await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/shifts/${ownerShift.id}/clock-out`,
      headers: { authorization: `Bearer ${ownerSession}`, 'if-match': `"${ownerShift.version}"` }
    });
  });

  it('manual shift creation and edit with optimistic concurrency', async () => {
    // Create shift manually
    const createRes = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/shifts`,
      headers: { authorization: `Bearer ${ownerSession}` },
      payload: {
        staff_id: workerId,
        status: 'OPEN',
        clocked_in_at: new Date().toISOString()
      }
    });
    expect(createRes.statusCode).toBe(201);
    const shift = createRes.json();

    // Edit shift
    const updateRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/locations/${locationId}/shifts/${shift.id}`,
      headers: { authorization: `Bearer ${ownerSession}`, 'if-match': `"${shift.version}"` },
      payload: {
        status: 'CLOSED',
        clocked_out_at: new Date().toISOString()
      }
    });
    expect(updateRes.statusCode).toBe(200);

    // Edit again with old version (Conflict)
    const conflictRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/locations/${locationId}/shifts/${shift.id}`,
      headers: { authorization: `Bearer ${ownerSession}`, 'if-match': `"${shift.version}"` },
      payload: {
        status: 'OPEN',
        clocked_out_at: null
      }
    });
    expect(conflictRes.statusCode).toBe(409);
    expect(conflictRes.json().error.code).toBe('OPTIMISTIC_CONCURRENCY_CONFLICT');
  });
});
