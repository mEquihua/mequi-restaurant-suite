import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';

import Fastify from 'fastify';

import { identityModule } from '../identity/index.js';
import { createDatabase, installDatabase } from '../../shared/index.js';
import { menuModule } from './index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

function terminalCredential(locationId: string, terminalId: string): string {
  return `${locationId}.${terminalId}.${randomBytes(32).toString('base64url')}`;
}

function credentialHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describeIntegration('menu API against PostgreSQL', () => {
  const db = createDatabase({ databaseUrl });
  const app = Fastify({ logger: false });
  installDatabase(app, { databaseUrl });
  app.register(identityModule);
  app.register(menuModule);
  let organizationId = '';
  let locationA = '';
  let locationB = '';
  let ownerId = '';
  let sessionA = '';
  let sessionB = '';

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
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

    const organization = await db.insertInto('organizations').values({ name: 'Menu Integration Restaurant' }).returning('id').executeTakeFirstOrThrow();
    organizationId = organization.id;
    const locations = await db.insertInto('locations').values([{ organization_id: organizationId, name: 'Downtown' }, { organization_id: organizationId, name: 'Airport' }]).returning('id').execute();
    locationA = locations[0].id; locationB = locations[1].id;
    const role = await db.insertInto('roles').values({ organization_id: organizationId, name: 'Owner' }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('role_permissions').values(['menu.catalog.read', 'menu.products.write', 'menu.prices.update', 'menu.availability.update'].map((permission_name) => ({ role_id: role.id, permission_name, scope: 'organization' }))).execute();
    const owner = await db.insertInto('staff').values({ organization_id: organizationId, first_name: 'Menu', last_name: 'Owner', pin_hash: await argon2.hash('2468') }).returning('id').executeTakeFirstOrThrow();
    ownerId = owner.id;
    await db.insertInto('staff_roles').values({ staff_id: ownerId, role_id: role.id, location_id: null }).execute();
    for (const [locationId, name] of [[locationA, 'Downtown terminal'], [locationB, 'Airport terminal']] as const) {
      const terminalId = crypto.randomUUID(); const credential = terminalCredential(locationId, terminalId);
      await db.insertInto('terminals').values({ id: terminalId, location_id: locationId, name, credential_hash: credentialHash(credential) }).execute();
      const unlock = await app.inject({ method: 'POST', url: '/api/v1/auth/pin-unlock', headers: { 'x-terminal-credential': credential }, payload: { staff_id: ownerId, pin: '2468' } });
      expect(unlock.statusCode).toBe(201);
      if (locationId === locationA) sessionA = unlock.json().token; else sessionB = unlock.json().token;
    }
  });

  afterAll(async () => { await app.close(); await db.destroy(); });

  it('creates a category, product, modifier group, and combo', async () => {
    const category = await app.inject({ method: 'POST', url: '/api/v1/categories', headers: auth(sessionA), payload: { name: 'Burgers', display_order: 2 } });
    expect(category.statusCode).toBe(201);
    const side = await app.inject({ method: 'POST', url: '/api/v1/products', headers: auth(sessionA), payload: { name: 'Fries', base_price: 400 } });
    const product = await app.inject({ method: 'POST', url: '/api/v1/products', headers: auth(sessionA), payload: { category_id: category.json().id, name: 'Classic Burger', internal_name: 'BURGER CLASICA', notes: 'Kitchen: toast bun', allergens: ['gluten'], tags: ['signature'], base_price: 1250 } });
    expect(product.statusCode).toBe(201);
    expect(product.json().internal_name).toBe('BURGER CLASICA');
    expect(product.json().price).toBe(1250);
    const group = await app.inject({ method: 'POST', url: '/api/v1/modifier-groups', headers: auth(sessionA), payload: { name: 'Cook temperature', min_selections: 1, max_selections: 1 } });
    expect(group.statusCode).toBe(201);
    const modifier = await app.inject({ method: 'POST', url: `/api/v1/modifier-groups/${group.json().id}/modifiers`, headers: auth(sessionA), payload: { name: 'Medium', price_adjustment: 0 } });
    expect(modifier.statusCode).toBe(201);
    const attached = await app.inject({ method: 'POST', url: `/api/v1/products/${product.json().id}/modifier-groups`, headers: auth(sessionA), payload: { modifier_group_id: group.json().id } });
    expect(attached.statusCode).toBe(201);
    const combo = await app.inject({ method: 'POST', url: `/api/v1/products/${product.json().id}/combo-groups`, headers: auth(sessionA), payload: { name: 'Side', items: [{ product_id: side.json().id }] } });
    expect(combo.statusCode).toBe(201);
  });

  it('serves the location override rather than the base price', async () => {
    const product = await db.selectFrom('products').selectAll().where('name', '=', 'Classic Burger').executeTakeFirstOrThrow();
    const override = await app.inject({ method: 'PUT', url: `/api/v1/locations/${locationA}/price-overrides/${product.id}`, headers: { ...auth(sessionA), 'if-match': '0' }, payload: { override_price: 1450 } });
    expect(override.statusCode).toBe(200);
    const atA = await app.inject({ method: 'GET', url: '/api/v1/products', headers: auth(sessionA) });
    expect(atA.json().data.find((entry: { id: string }) => entry.id === product.id).price).toBe(1450);
    const atB = await app.inject({ method: 'GET', url: '/api/v1/products', headers: auth(sessionB) });
    expect(atB.json().data.find((entry: { id: string }) => entry.id === product.id).price).toBe(product.base_price);
  });

  it('records channel-scoped unavailability without affecting other channels or locations', async () => {
    const product = await db.selectFrom('products').select('id').where('name', '=', 'Classic Burger').executeTakeFirstOrThrow();
    const unavailable = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationA}/products/${product.id}/mark-unavailable`, headers: { ...auth(sessionA), 'if-match': '0' }, payload: { channel_scope: 'DELIVERY', service_type_scope: 'PICKUP' } });
    expect(unavailable.statusCode).toBe(200);
    const delivery = await app.inject({ method: 'GET', url: '/api/v1/products?channel=DELIVERY&service_type=PICKUP', headers: auth(sessionA) });
    expect(delivery.json().data.find((entry: { id: string }) => entry.id === product.id).availability).toEqual({ status: 'EXHAUSTED', available: false });
    const dineIn = await app.inject({ method: 'GET', url: '/api/v1/products?channel=DINE_IN&service_type=DINE_IN', headers: auth(sessionA) });
    expect(dineIn.json().data.find((entry: { id: string }) => entry.id === product.id).availability).toEqual({ status: 'AVAILABLE', available: true });
    const locationBProducts = await app.inject({ method: 'GET', url: '/api/v1/products?channel=DELIVERY&service_type=PICKUP', headers: auth(sessionB) });
    expect(locationBProducts.json().data.find((entry: { id: string }) => entry.id === product.id).availability).toEqual({ status: 'AVAILABLE', available: true });
  });

  it('returns current product state on an optimistic-concurrency conflict', async () => {
    const product = await db.selectFrom('products').select(['id', 'version']).where('name', '=', 'Classic Burger').executeTakeFirstOrThrow();
    const conflict = await app.inject({ method: 'PUT', url: `/api/v1/products/${product.id}`, headers: { ...auth(sessionA), 'if-match': String(product.version + 10) }, payload: { name: 'Stale Burger' } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.details.current_version).toBe(product.version);
    expect(conflict.json().error.details.current_state.id).toBe(product.id);
  });
});
