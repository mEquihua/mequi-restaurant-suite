import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import Fastify from 'fastify';

import { identityModule } from '../identity/index.js';
import { createDatabase, installDatabase } from '../../shared/index.js';
import { reservationsModule } from './index.js';
import { ordersModule } from '../orders/index.js';
import { customersModule } from '../customers/index.js';

const databaseUrl = process.env.DATABASE_URL;
const db = createDatabase({ databaseUrl });
const describeIntegration = databaseUrl ? describe : describe.skip;

function terminalCredential(locationId: string, terminalId: string) {
  return `${locationId}.${terminalId}.${randomBytes(32).toString('base64url')}`;
}
function credentialHash(credential: string) {
  return createHash('sha256').update(credential).digest('hex');
}

describeIntegration('reservations module', () => {
  const app = Fastify();
  installDatabase(app, { databaseUrl });
  app.register(identityModule, {});
  app.register(ordersModule, {});
  app.register(reservationsModule, {});
  app.register(customersModule, {});

  let organizationId: string;
  let locationId: string;
  let ownerId: string;
  let staffSession: string;
  let customerSession: string;

  beforeAll(async () => {
    for (const table of [
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
      'locations',
      'organizations'] as const) {
      await db.deleteFrom(table).execute();
    }

    const organization = await db.insertInto('organizations').values({ name: 'Reservations Integration' }).returning('id').executeTakeFirstOrThrow();
    organizationId = organization.id;

    const location = await db.insertInto('locations').values({ organization_id: organizationId,
      name: 'Downtown' }).returning('id').executeTakeFirstOrThrow();
    locationId = location.id;

    const role = await db.insertInto('roles').values({ organization_id: organizationId,
      name: 'Owner' }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('role_permissions').values([
      'reservations.reservations.read',
      'reservations.reservations.write',
      'reservations.reservations.update_status',
      'reservations.reservations.seat',
      'reservations.reservations.cancel',
      'reservations.settings.read',
      'reservations.settings.write',
      'orders.visits.close',
      'orders.visits.create'
    ].map(p => ({ role_id: role.id,
      permission_name: p,
      scope: 'organization' }))).execute();

    const owner = await db.insertInto('staff').values({ organization_id: organizationId,
      first_name: 'Res',
      last_name: 'Owner',
      pin_hash: await argon2.hash('1234') }).returning('id').executeTakeFirstOrThrow();
    ownerId = owner.id;
    await db.insertInto('staff_roles').values({ staff_id: ownerId,
      role_id: role.id,
      location_id: null }).execute();

    const terminalId = crypto.randomUUID();
    const credential = terminalCredential(locationId,
      terminalId);
    await db.insertInto('terminals').values({ id: terminalId,
      location_id: locationId,
      name: 'T1',
      credential_hash: credentialHash(credential) }).execute();
    const unlock = await app.inject({ method: 'POST',
      url: '/api/v1/auth/pin-unlock',
      headers: { 'x-terminal-credential': credential },
      payload: { staff_id: ownerId,
      pin: '1234' } });
    staffSession = unlock.json().token;

    const area = await db.insertInto('areas').values({ location_id: locationId,
      name: 'Main' }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('tables').values({ location_id: locationId,
      area_id: area.id,
      name: 'T1',
      max_capacity: 4 }).execute();

    const reg = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/customers`,
      payload: { email: 'res@example.com',
      password: 'secure123',
      name: 'Test Customer',
      phone: '555-1234' }
    });
    if (reg.statusCode >= 300) throw new Error(`customer registration failed: ${reg.statusCode} ${reg.body}`);

    const login = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/customer-sessions`,
      payload: { email: 'res@example.com',
      password: 'secure123' }
    });
    customerSession = login.json().token;
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('can set reservation settings',
      async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/locations/${locationId}/reservation-settings`,
      headers: { authorization: `Bearer ${staffSession}` },
      payload: {
        accepts_reservations: true,
      operating_hours: [{ day_of_week: 1,
      open_time: '00:00',
      close_time: '23:59' },
      { day_of_week: 2,
      open_time: '00:00',
      close_time: '23:59' },
      { day_of_week: 3,
      open_time: '00:00',
      close_time: '23:59' },
      { day_of_week: 4,
      open_time: '00:00',
      close_time: '23:59' },
      { day_of_week: 5,
      open_time: '00:00',
      close_time: '23:59' },
      { day_of_week: 6,
      open_time: '00:00',
      close_time: '23:59' },
      { day_of_week: 7,
      open_time: '00:00',
      close_time: '23:59' }],
      estimated_visit_duration_minutes: 90,
      minimum_lead_time_minutes: 0,
      maximum_party_size: 10,
      auto_confirm: false,
      version: 1
      }
    });
    expect(res.statusCode).toBe(200);
  });
  
  it('validations and happy path state machine',
      async () => {
    // 1. request
    const future = new Date(Date.now() + 86400000).toISOString();
    const req1 = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/reservations/request`,
      payload: { party_size: 4,
      reservation_time: future,
      customer_name: 'Guest 1' }
    });
    expect(req1.statusCode).toBe(201);
    const { reservation_id,
      guest_token } = req1.json();
    expect(guest_token).toBeTruthy();

    // 2. confirm
    const get1 = await app.inject({ method: 'GET',
      url: `/api/v1/locations/${locationId}/reservations/${reservation_id}`,
      headers: { authorization: `Bearer ${staffSession}` } });
    const v1 = get1.json().version;
    const conf = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/reservations/${reservation_id}/confirm`,
      headers: { authorization: `Bearer ${staffSession}`,
      'if-match': `"${v1}"` }
    });
    expect(conf.statusCode).toBe(200);

    // 3. arrive
    const v2 = conf.json().version;
    const arrive = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/reservations/${reservation_id}/arrive`,
      headers: { authorization: `Bearer ${staffSession}`,
      'if-match': `"${v2}"` }
    });
    expect(arrive.statusCode).toBe(200);

    // 4. seat
    const v3 = arrive.json().version;
    const table = await db.selectFrom('tables').select('id').where('name',
      '=',
      'T1').executeTakeFirstOrThrow();
    const seat = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/reservations/${reservation_id}/seat`,
      headers: { authorization: `Bearer ${staffSession}`,
      'if-match': `"${v3}"` },
      payload: { table_id: table.id }
    });
    expect(seat.statusCode).toBe(200);
    const visitId = seat.json().visit_id;
    expect(visitId).toBeTruthy();

    // 5. check table occupied
    const tableRow = await db.selectFrom('tables').selectAll().where('id',
      '=',
      table.id).executeTakeFirstOrThrow();
    expect(tableRow.status).toBe('OCCUPIED');

    // 6. close visit should auto-complete reservation
    const visitRow = await db.selectFrom('visits').selectAll().where('id',
      '=',
      visitId).executeTakeFirstOrThrow();
    const closeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationId}/visits/${visitId}/close`,
      headers: { authorization: `Bearer ${staffSession}`,
      'if-match': `"${visitRow.version}"` },
      payload: {}
    });
    expect(closeRes.statusCode).toBe(200);

    const check = await db.selectFrom('reservations').select('status').where('id',
      '=',
      reservation_id).executeTakeFirstOrThrow();
    expect(check.status).toBe('COMPLETED');
  });

  it('rejects requests with validation errors',
      async () => {
    const loc2 = await db.insertInto('locations').values({ organization_id: organizationId,
      name: 'NoRes' }).returning('id').executeTakeFirstOrThrow();
    const future = new Date(Date.now() + 86400000).toISOString();
    
    // 1. RESERVATIONS_NOT_ACCEPTED
    let res = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${loc2.id}/reservations/request`,
      payload: { party_size: 2,
      reservation_time: future,
      customer_name: 'Test' }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('RESERVATIONS_NOT_ACCEPTED');

    await db.insertInto('reservation_settings').values({
      location_id: loc2.id,
      accepts_reservations: true,
      operating_hours: JSON.stringify([{ day_of_week: new Date(future).getDay() || 7,
      open_time: '00:00',
      close_time: '23:59' }
    ]),
      estimated_visit_duration_minutes: 90,
      minimum_lead_time_minutes: 60,
      maximum_party_size: 4,
      auto_confirm: false,
      version: 1
    }).execute();

    // 2. PARTY_SIZE_TOO_LARGE
    res = await app.inject({
      method: 'POST', url: `/api/v1/locations/${loc2.id}/reservations/request`,
      payload: { party_size: 5, reservation_time: future, customer_name: 'Test' }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PARTY_SIZE_TOO_LARGE');

    // 3. LEAD_TIME_TOO_SHORT
    const soon = new Date(Date.now() + 30 * 60000).toISOString();
    res = await app.inject({
      method: 'POST', url: `/api/v1/locations/${loc2.id}/reservations/request`,
      payload: { party_size: 2, reservation_time: soon, customer_name: 'Test' }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('LEAD_TIME_TOO_SHORT');

    // 4. OUTSIDE_OPERATING_HOURS
    await db.updateTable('reservation_settings').set({ operating_hours: JSON.stringify([]) }).where('location_id', '=', loc2.id).execute();
    res = await app.inject({
      method: 'POST', url: `/api/v1/locations/${loc2.id}/reservations/request`,
      payload: { party_size: 2, reservation_time: future, customer_name: 'Test' }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('OUTSIDE_OPERATING_HOURS');
  });

  it('illegal state transitions', async () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const req = await app.inject({
      method: 'POST', url: `/api/v1/locations/${locationId}/reservations/request`,
      payload: { party_size: 2, reservation_time: future, customer_name: 'Test' }
    });
    const { reservation_id } = req.json();

    const get1 = await app.inject({ method: 'GET', url: `/api/v1/locations/${locationId}/reservations/${reservation_id}`, headers: { authorization: `Bearer ${staffSession}` } });
    const v1 = get1.json().version;

    const table = await db.selectFrom('tables').select('id').where('name', '=', 'T1').executeTakeFirstOrThrow();
    
    // seat while REQUESTED -> fails
    const seat = await app.inject({
      method: 'POST', url: `/api/v1/locations/${locationId}/reservations/${reservation_id}/seat`,
      headers: { authorization: `Bearer ${staffSession}`, 'if-match': `"${v1}"` },
      payload: { table_id: table.id }
    });
    expect(seat.statusCode).toBe(409);
    expect(seat.json().error.code).toBe('ILLEGAL_RESERVATION_STATUS_TRANSITION');

    // arrive while REQUESTED -> fails
    const arrive = await app.inject({
      method: 'POST', url: `/api/v1/locations/${locationId}/reservations/${reservation_id}/arrive`,
      headers: { authorization: `Bearer ${staffSession}`, 'if-match': `"${v1}"` }
    });
    expect(arrive.statusCode).toBe(409);
    expect(arrive.json().error.code).toBe('ILLEGAL_RESERVATION_STATUS_TRANSITION');
  });

  it('guest-token flow works and protects against wrong tokens', async () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const req = await app.inject({
      method: 'POST', url: `/api/v1/locations/${locationId}/reservations/request`,
      payload: { party_size: 2, reservation_time: future, customer_name: 'Guest 2' }
    });
    expect(req.statusCode).toBe(201);
    const { reservation_id, guest_token } = req.json();

    const getOk = await app.inject({
      method: 'GET', url: `/api/v1/locations/${locationId}/reservations/${reservation_id}?guest_token=${guest_token}`
    });
    expect(getOk.statusCode).toBe(200);

    const getWrong = await app.inject({
      method: 'GET', url: `/api/v1/locations/${locationId}/reservations/${reservation_id}?guest_token=wrong_token`
    });
    expect(getWrong.statusCode).toBe(403);

    const getIdAsToken = await app.inject({
      method: 'GET', url: `/api/v1/locations/${locationId}/reservations/${reservation_id}?guest_token=${reservation_id}`
    });
    expect(getIdAsToken.statusCode).toBe(403);
  });

  it('GET /:id and POST /:id/cancel support staff, authenticated customer, and guest', async () => {
    const future = new Date(Date.now() + 86400000).toISOString();

    // STAFF
    const r1 = await app.inject({
      method: 'POST', url: `/api/v1/locations/${locationId}/reservations/request`,
      payload: { party_size: 2, reservation_time: future, customer_name: 'Staff Test' }
    });
    const id1 = r1.json().reservation_id;
    const g1 = await app.inject({ method: 'GET', url: `/api/v1/locations/${locationId}/reservations/${id1}`, headers: { authorization: `Bearer ${staffSession}` } });
    expect(g1.statusCode).toBe(200);
    const c1 = await app.inject({
      method: 'POST', url: `/api/v1/locations/${locationId}/reservations/${id1}/cancel`,
      headers: { authorization: `Bearer ${staffSession}`, 'if-match': `"${g1.json().version}"` }
    });
    expect(c1.statusCode).toBe(200);

    // AUTHENTICATED CUSTOMER
    const r2 = await app.inject({
      method: 'POST', url: `/api/v1/locations/${locationId}/reservations/request`,
      headers: { authorization: `Bearer ${customerSession}` },
      payload: { party_size: 2, reservation_time: future, customer_name: 'Auth Cust' }
    });
    const id2 = r2.json().reservation_id;
    const g2 = await app.inject({ method: 'GET', url: `/api/v1/locations/${locationId}/reservations/${id2}`, headers: { authorization: `Bearer ${customerSession}` } });
    expect(g2.statusCode).toBe(200);
    const c2 = await app.inject({
      method: 'POST', url: `/api/v1/locations/${locationId}/reservations/${id2}/cancel`,
      headers: { authorization: `Bearer ${customerSession}`, 'if-match': `"${g2.json().version}"` }
    });
    expect(c2.statusCode).toBe(200);

    // GUEST
    const r3 = await app.inject({
      method: 'POST', url: `/api/v1/locations/${locationId}/reservations/request`,
      payload: { party_size: 2, reservation_time: future, customer_name: 'Guest' }
    });
    const id3 = r3.json().reservation_id;
    const token3 = r3.json().guest_token;
    const g3 = await app.inject({ method: 'GET', url: `/api/v1/locations/${locationId}/reservations/${id3}?guest_token=${token3}` });
    expect(g3.statusCode).toBe(200);
    const c3 = await app.inject({
      method: 'POST', url: `/api/v1/locations/${locationId}/reservations/${id3}/cancel`,
      headers: { 'if-match': `"${g3.json().version}"` },
      payload: { guest_token: token3 }
    });
    expect(c3.statusCode).toBe(200);
  });

  it('enforces permissions on staff endpoints', async () => {
    const role2 = await db.insertInto('roles').values({ organization_id: organizationId, name: 'NoWrite' }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('role_permissions').values([
      { role_id: role2.id, permission_name: 'reservations.reservations.read', scope: 'organization' }
    ]).execute();
    
    const staff2 = await db.insertInto('staff').values({ organization_id: organizationId, first_name: 'No', last_name: 'Write', pin_hash: await argon2.hash('5678') }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('staff_roles').values({ staff_id: staff2.id, role_id: role2.id, location_id: null }).execute();
    
    const terminalId2 = crypto.randomUUID();
    const credential2 = terminalCredential(locationId, terminalId2);
    await db.insertInto('terminals').values({ id: terminalId2, location_id: locationId, name: 'T2', credential_hash: credentialHash(credential2) }).execute();
    
    const unlock2 = await app.inject({ method: 'POST', url: '/api/v1/auth/pin-unlock', headers: { 'x-terminal-credential': credential2 }, payload: { staff_id: staff2.id, pin: '5678' } });
    const staffSession2 = unlock2.json().token;

    const future = new Date(Date.now() + 86400000).toISOString();
    const req = await app.inject({
      method: 'POST', url: `/api/v1/locations/${locationId}/reservations/request`,
      payload: { party_size: 2, reservation_time: future, customer_name: 'Test' }
    });
    const id = req.json().reservation_id;
    const g = await app.inject({ method: 'GET', url: `/api/v1/locations/${locationId}/reservations/${id}`, headers: { authorization: `Bearer ${staffSession2}` } });
    const v = g.json().version;

    const conf = await app.inject({
      method: 'POST', url: `/api/v1/locations/${locationId}/reservations/${id}/confirm`,
      headers: { authorization: `Bearer ${staffSession2}`, 'if-match': `"${v}"` }
    });
    expect(conf.statusCode).toBe(403);
  });

});

