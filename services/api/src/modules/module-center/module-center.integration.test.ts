import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import Fastify from 'fastify';

import { identityModule } from '../identity/index.js';
import { createDatabase, installDatabase } from '../../shared/index.js';
import { moduleCenterModule } from './index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;
const credentialHash = (value: string) => createHash('sha256').update(value).digest('hex');
const terminalCredential = (locationId: string, terminalId: string) => `${locationId}.${terminalId}.${randomBytes(32).toString('base64url')}`;

describeIntegration('Module Center API against PostgreSQL', () => {
  const db = createDatabase({ databaseUrl });
  const app = Fastify({ logger: false });
  installDatabase(app, { databaseUrl });
  app.register(identityModule); app.register(moduleCenterModule);
  let organizationId = ''; let locationA = ''; let locationB = ''; let ownerId = ''; let sessionA = ''; let sessionB = ''; let version = 0;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    for (const table of ['stock_adjustments', 'ingredient_stock', 'recipe_lines', 'ingredients', 'cash_drawer_movements', 'cash_drawer_sessions', 'module_activations', 'command_idempotency', 'audit_events', 'account_discounts', 'outbox_events', 'refunds', 'cancellations_and_voids', 'payments', 'order_fulfillments', 'order_line_modifiers', 'order_lines', 'orders', 'accounts', 'reservations', 'reservation_settings', 'visits', 'table_sections', 'sections', 'tables', 'areas', 'availability_rules', 'location_price_overrides', 'product_combo_items', 'product_combo_groups', 'product_modifier_groups', 'modifiers', 'modifier_groups', 'product_variants', 'products', 'categories', 'terminal_pin_attempts', 'staff_sessions', 'staff_roles', 'role_permissions', 'terminals', 'staff', 'roles', 'customer_sessions', 'customers', 'delivery_zones', 'locations', 'organizations'] as const) {
      await db.deleteFrom(table).execute();
    }
    const organization = await db.insertInto('organizations').values({ name: 'Module Center Integration Restaurant' }).returning('id').executeTakeFirstOrThrow(); organizationId = organization.id;
    const locations = await db.insertInto('locations').values([{ organization_id: organizationId, name: 'Downtown' }, { organization_id: organizationId, name: 'Airport' }]).returning('id').execute(); [locationA, locationB] = locations.map((location) => location.id);
    const role = await db.insertInto('roles').values({ organization_id: organizationId, name: 'Owner' }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('role_permissions').values(['module_center.modules.read', 'module_center.modules.write'].map((permission_name) => ({ role_id: role.id, permission_name, scope: 'organization' }))).execute();
    const owner = await db.insertInto('staff').values({ organization_id: organizationId, first_name: 'Module', last_name: 'Owner', pin_hash: await argon2.hash('2468') }).returning('id').executeTakeFirstOrThrow(); ownerId = owner.id;
    await db.insertInto('staff_roles').values({ staff_id: ownerId, role_id: role.id, location_id: null }).execute();
    for (const locationId of [locationA, locationB]) {
      const terminalId = crypto.randomUUID(); const credential = terminalCredential(locationId, terminalId);
      await db.insertInto('terminals').values({ id: terminalId, location_id: locationId, name: 'Module terminal', credential_hash: credentialHash(credential) }).execute();
      const unlock = await app.inject({ method: 'POST', url: '/api/v1/auth/pin-unlock', headers: { 'x-terminal-credential': credential }, payload: { staff_id: ownerId, pin: '2468' } }); expect(unlock.statusCode).toBe(201);
      if (locationId === locationA) sessionA = unlock.json().token; else sessionB = unlock.json().token;
    }
  });
  afterAll(async () => { await app.close(); await db.destroy(); });

  it('lists the seeded catalog and defaults a location without rows to disabled', async () => {
    const definitions = await app.inject({ method: 'GET', url: '/api/v1/module-definitions', headers: auth(sessionA) }); expect(definitions.statusCode).toBe(200); expect(definitions.json().data.map((item: { key: string }) => item.key)).toContain('kiosk');
    const modules = await app.inject({ method: 'GET', url: `/api/v1/locations/${locationA}/modules`, headers: auth(sessionA) }); expect(modules.statusCode).toBe(200);
    expect(modules.json().data).toHaveLength(definitions.json().data.length); expect(modules.json().data.every((item: { status: string; version: number }) => item.status === 'DISABLED' && item.version === 0)).toBe(true);
  });

  it('activates, pauses, and deactivates while retaining the activation row', async () => {
    const activated = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationA}/modules/pos/activate`, headers: auth(sessionA), payload: {} }); expect(activated.statusCode).toBe(200); expect(activated.json()).toMatchObject({ status: 'ACTIVE', version: 1 }); version = activated.json().version;
    const paused = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationA}/modules/pos/pause`, headers: { ...auth(sessionA), 'if-match': String(version) }, payload: {} }); expect(paused.statusCode).toBe(200); expect(paused.json().status).toBe('PAUSED'); version = paused.json().version;
    const disabled = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationA}/modules/pos/deactivate`, headers: { ...auth(sessionA), 'if-match': String(version) }, payload: {} }); expect(disabled.statusCode).toBe(200); expect(disabled.json()).toMatchObject({ status: 'DISABLED', version: version + 1 });
    expect(await db.selectFrom('module_activations').selectAll().where('location_id', '=', locationA).where('module_key', '=', 'pos').executeTakeFirst()).toBeTruthy();
  });

  it('commits the activation before the HTTP response returns, with no read-after-write delay needed', async () => {
    // Regression test for a response-before-commit race: reply.send() called
    // from inside the transaction callback could complete before the
    // wrapping transaction actually reached COMMIT, so a client reading the
    // row via a separate connection immediately after a success response
    // could see stale, pre-transaction data. Deliberately reads via `db`
    // (a separate connection from the app's own pool) with zero delay.
    const activated = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationB}/modules/loyalty/activate`, headers: auth(sessionB), payload: {} });
    expect(activated.statusCode).toBe(200);
    const row = await db.selectFrom('module_activations').selectAll().where('location_id', '=', locationB).where('module_key', '=', 'loyalty').executeTakeFirst();
    expect(row?.status).toBe('ACTIVE');
  });

  it('rejects pause from disabled', async () => {
    const current = await db.selectFrom('module_activations').select('version').where('location_id', '=', locationA).where('module_key', '=', 'pos').executeTakeFirstOrThrow();
    const invalid = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationA}/modules/pos/pause`, headers: { ...auth(sessionA), 'if-match': String(current.version) }, payload: {} }); expect(invalid.statusCode).toBe(409); expect(invalid.json().error.code).toBe('ILLEGAL_MODULE_STATUS_TRANSITION');
  });

  it('isolates module activations across locations through RLS and HTTP scope', async () => {
    const activeB = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationB}/modules/kiosk/activate`, headers: auth(sessionB), payload: {} }); expect(activeB.statusCode).toBe(200);
    const hidden = await app.withLocationTransaction(locationA, async (trx) => trx.selectFrom('module_activations').selectAll().where('location_id', '=', locationB).execute()); expect(hidden).toEqual([]);
    const modified = await app.withLocationTransaction(locationA, async (trx) => trx.updateTable('module_activations').set({ status: 'PAUSED' }).where('location_id', '=', locationB).where('module_key', '=', 'kiosk').returning('module_key').executeTakeFirst()); expect(modified).toBeUndefined();
    const denied = await app.inject({ method: 'GET', url: `/api/v1/locations/${locationB}/modules`, headers: auth(sessionA) }); expect(denied.statusCode).toBe(403);
  });
});
