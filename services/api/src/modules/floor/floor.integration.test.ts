import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import Fastify from 'fastify';

import { identityModule } from '../identity/index.js';
import { createDatabase, installDatabase } from '../../shared/index.js';
import { floorModule } from './index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;
const credentialHash = (value: string) => createHash('sha256').update(value).digest('hex');
const terminalCredential = (locationId: string, terminalId: string) =>
  `${locationId}.${terminalId}.${randomBytes(32).toString('base64url')}`;

describeIntegration('floor API against PostgreSQL', () => {
  const db = createDatabase({ databaseUrl });
  const app = Fastify({ logger: false });
  installDatabase(app, { databaseUrl });
  app.register(identityModule);
  app.register(floorModule);
  let organizationId = '';
  let locationA = '';
  let locationB = '';
  let ownerId = '';
  let sessionA = '';
  let sessionB = '';
  let tableA = '';
  let areaA = '';
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    await db.deleteFrom('cash_drawer_movements').execute();
    await db.deleteFrom('cash_drawer_sessions').execute();
    await db.deleteFrom('command_idempotency').execute();
    await db.deleteFrom('audit_events').execute();
    await db.deleteFrom('account_discounts').execute();
    await db.deleteFrom('outbox_events').execute();
    await db.deleteFrom('refunds').execute();
    await db.deleteFrom('cancellations_and_voids').execute();
    await db.deleteFrom('payments').execute();
    await db.deleteFrom('order_line_modifiers').execute(); await db.deleteFrom('order_fulfillments').execute();
    await db.deleteFrom('order_lines').execute();
    await db.deleteFrom('orders').execute();
    await db.deleteFrom('accounts').execute();
    await db.deleteFrom('visits').execute();
    await db.deleteFrom('table_sections').execute();
    await db.deleteFrom('sections').execute();
    await db.deleteFrom('tables').execute();
    await db.deleteFrom('areas').execute();
    await db.deleteFrom('availability_rules').execute();
    await db.deleteFrom('location_price_overrides').execute();
    await db.deleteFrom('product_combo_items').execute();
    await db.deleteFrom('product_combo_groups').execute();
    await db.deleteFrom('product_modifier_groups').execute();
    await db.deleteFrom('modifiers').execute();
    await db.deleteFrom('modifier_groups').execute();
    await db.deleteFrom('product_variants').execute();
    await db.deleteFrom('products').execute();
    await db.deleteFrom('categories').execute();
    await db.deleteFrom('terminal_pin_attempts').execute();
    await db.deleteFrom('staff_sessions').execute();
    await db.deleteFrom('staff_roles').execute();
    await db.deleteFrom('role_permissions').execute();
    await db.deleteFrom('terminals').execute();
    await db.deleteFrom('staff').execute();
    await db.deleteFrom('roles').execute();
    await db.deleteFrom('locations').execute();
    await db.deleteFrom('organizations').execute();
    const organization = await db
      .insertInto('organizations')
      .values({ name: 'Floor Integration Restaurant' })
      .returning('id')
      .executeTakeFirstOrThrow();
    organizationId = organization.id;
    const locations = await db
      .insertInto('locations')
      .values([
        { organization_id: organizationId, name: 'Downtown' },
        { organization_id: organizationId, name: 'Airport' },
      ])
      .returning('id')
      .execute();
    [locationA, locationB] = locations.map((location) => location.id);
    const role = await db
      .insertInto('roles')
      .values({ organization_id: organizationId, name: 'Owner' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('role_permissions')
      .values(
        [
          'floor.layout.read',
          'floor.layout.write',
          'floor.tables.update_status',
          'floor.sections.assign',
        ].map((permission_name) => ({ role_id: role.id, permission_name, scope: 'organization' })),
      )
      .execute();
    const owner = await db
      .insertInto('staff')
      .values({
        organization_id: organizationId,
        first_name: 'Floor',
        last_name: 'Owner',
        pin_hash: await argon2.hash('2468'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ownerId = owner.id;
    await db
      .insertInto('staff_roles')
      .values({ staff_id: ownerId, role_id: role.id, location_id: null })
      .execute();
    for (const [locationId, name] of [
      [locationA, 'Downtown terminal'],
      [locationB, 'Airport terminal'],
    ] as const) {
      const terminalId = crypto.randomUUID();
      const credential = terminalCredential(locationId, terminalId);
      await db
        .insertInto('terminals')
        .values({
          id: terminalId,
          location_id: locationId,
          name,
          credential_hash: credentialHash(credential),
        })
        .execute();
      const unlock = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/pin-unlock',
        headers: { 'x-terminal-credential': credential },
        payload: { staff_id: ownerId, pin: '2468' },
      });
      expect(unlock.statusCode).toBe(201);
      if (locationId === locationA) sessionA = unlock.json().token;
      else sessionB = unlock.json().token;
    }
  });
  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('creates an area, table, and section then assigns the table', async () => {
    const area = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationA}/areas`,
      headers: auth(sessionA),
      payload: { name: 'Patio' },
    });
    expect(area.statusCode).toBe(201);
    areaA = area.json().id;
    const table = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationA}/tables`,
      headers: auth(sessionA),
      payload: {
        area_id: areaA,
        name: 'P-4',
        min_capacity: 2,
        max_capacity: 4,
        pos_x: 10,
        pos_y: 20,
      },
    });
    expect(table.statusCode).toBe(201);
    tableA = table.json().id;
    const section = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationA}/sections`,
      headers: auth(sessionA),
      payload: { name: 'North' },
    });
    expect(section.statusCode).toBe(201);
    const assigned = await app.inject({
      method: 'PUT',
      url: `/api/v1/sections/${section.json().id}/tables`,
      headers: auth(sessionA),
      payload: { table_ids: [tableA] },
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().table_ids).toEqual([tableA]);
  });

  it('moves a table with optimistic concurrency', async () => {
    const current = await db
      .selectFrom('tables')
      .select('version')
      .where('id', '=', tableA)
      .executeTakeFirstOrThrow();
    const moved = await app.inject({
      method: 'PUT',
      url: `/api/v1/tables/${tableA}`,
      headers: { ...auth(sessionA), 'if-match': String(current.version) },
      payload: { max_capacity: 6, pos_x: 99, pos_y: -10 },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({
      max_capacity: 6,
      pos_x: 99,
      pos_y: -10,
      version: current.version + 1,
    });
  });

  it('supports the administrative out-of-service reactivation lifecycle', async () => {
    let version = (
      await db
        .selectFrom('tables')
        .select('version')
        .where('id', '=', tableA)
        .executeTakeFirstOrThrow()
    ).version;
    const out = await app.inject({
      method: 'POST',
      url: `/api/v1/tables/${tableA}/mark-out-of-service`,
      headers: { ...auth(sessionA), 'if-match': String(version) },
      payload: {},
    });
    expect(out.statusCode).toBe(200);
    version = out.json().version;
    const cleaning = await app.inject({
      method: 'POST',
      url: `/api/v1/tables/${tableA}/mark-needs-cleaning`,
      headers: { ...auth(sessionA), 'if-match': String(version) },
      payload: {},
    });
    expect(cleaning.statusCode).toBe(200);
    version = cleaning.json().version;
    const available = await app.inject({
      method: 'POST',
      url: `/api/v1/tables/${tableA}/mark-available`,
      headers: { ...auth(sessionA), 'if-match': String(version) },
      payload: {},
    });
    expect(available.statusCode).toBe(200);
    expect(available.json().status).toBe('AVAILABLE');
  });

  it('rejects an illegal status transition with a clear error', async () => {
    const version = (
      await db
        .selectFrom('tables')
        .select('version')
        .where('id', '=', tableA)
        .executeTakeFirstOrThrow()
    ).version;
    const invalid = await app.inject({
      method: 'POST',
      url: `/api/v1/tables/${tableA}/mark-available`,
      headers: { ...auth(sessionA), 'if-match': String(version) },
      payload: {},
    });
    expect(invalid.statusCode).toBe(409);
    expect(invalid.json().error.code).toBe('ILLEGAL_TABLE_STATUS_TRANSITION');
  });

  it('RLS prevents a location A transaction from seeing location B floor data', async () => {
    const areaB = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationB}/areas`,
      headers: auth(sessionB),
      payload: { name: 'Airport Hall' },
    });
    expect(areaB.statusCode).toBe(201);
    const tableB = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationB}/tables`,
      headers: auth(sessionB),
      payload: { area_id: areaB.json().id, name: 'A-1', max_capacity: 2 },
    });
    expect(tableB.statusCode).toBe(201);
    const sectionB = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${locationB}/sections`,
      headers: auth(sessionB),
      payload: { name: 'Airport section' },
    });
    expect(sectionB.statusCode).toBe(201);
    const hidden = await app.withLocationTransaction(locationA, async (trx) => ({
      areas: await trx
        .selectFrom('areas')
        .selectAll()
        .where('location_id', '=', locationB)
        .execute(),
      sections: await trx
        .selectFrom('sections')
        .selectAll()
        .where('location_id', '=', locationB)
        .execute(),
      tables: await trx
        .selectFrom('tables')
        .selectAll()
        .where('location_id', '=', locationB)
        .execute(),
    }));
    expect(hidden).toEqual({ areas: [], sections: [], tables: [] });
    const modified = await app.withLocationTransaction(locationA, async (trx) => ({
      area: await trx
        .updateTable('areas')
        .set({ name: 'Denied' })
        .where('id', '=', areaB.json().id)
        .returning('id')
        .executeTakeFirst(),
      table: await trx
        .updateTable('tables')
        .set({ name: 'Denied' })
        .where('id', '=', tableB.json().id)
        .returning('id')
        .executeTakeFirst(),
      section: await trx
        .updateTable('sections')
        .set({ name: 'Denied' })
        .where('id', '=', sectionB.json().id)
        .returning('id')
        .executeTakeFirst(),
    }));
    expect(modified).toEqual({ area: undefined, table: undefined, section: undefined });
    const denied = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${locationB}/tables`,
      headers: auth(sessionA),
    });
    expect(denied.statusCode).toBe(403);
  });
});
