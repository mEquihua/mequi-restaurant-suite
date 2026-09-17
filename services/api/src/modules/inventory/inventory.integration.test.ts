import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import Fastify from 'fastify';

import { identityModule } from '../identity/index.js';
import { createDatabase, installDatabase } from '../../shared/index.js';
import { inventoryModule } from './index.js';
import { menuModule } from '../menu/index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;
const credentialHash = (value: string) => createHash('sha256').update(value).digest('hex');
const terminalCredential = (locationId: string, terminalId: string) => `${locationId}.${terminalId}.${randomBytes(32).toString('base64url')}`;

describeIntegration('Inventory API against PostgreSQL', () => {
  const db = createDatabase({ databaseUrl });
  const app = Fastify({ logger: false });
  installDatabase(app, { databaseUrl });
  app.register(identityModule);
  app.register(menuModule);
  app.register(inventoryModule);
  
  let organizationId = ''; let locationId = ''; let ownerId = ''; let session = '';
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    for (const table of [
      'stock_adjustments',
      'ingredient_stock',
      'recipe_lines',
      'cash_drawer_movements',
      'cash_drawer_sessions',
      'module_activations',
      'command_idempotency',
      'audit_events',
      'reservations',
      'reservation_settings',
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
      'ingredients',
      'terminal_pin_attempts',
      'staff_sessions',
      'staff_roles',
      'role_permissions',
      'terminals',
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
    const organization = await db.insertInto('organizations').values({ name: 'Inventory Integration' }).returning('id').executeTakeFirstOrThrow(); organizationId = organization.id;
    const location = await db.insertInto('locations').values({ organization_id: organizationId, name: 'Main Location' }).returning('id').executeTakeFirstOrThrow(); locationId = location.id;
    const role = await db.insertInto('roles').values({ organization_id: organizationId, name: 'Owner' }).returning('id').executeTakeFirstOrThrow();
    
    await db.insertInto('role_permissions').values([
      'inventory.ingredients.read',
      'inventory.ingredients.write',
      'inventory.recipes.read',
      'inventory.recipes.write',
      'inventory.stock.read',
      'inventory.stock.adjust',
      'menu.products.write'
    ].map((permission_name) => ({ role_id: role.id, permission_name, scope: 'organization' }))).execute();
    
    const owner = await db.insertInto('staff').values({ organization_id: organizationId, first_name: 'Inventory', last_name: 'Admin', pin_hash: await argon2.hash('2468') }).returning('id').executeTakeFirstOrThrow(); ownerId = owner.id;
    await db.insertInto('staff_roles').values({ staff_id: ownerId, role_id: role.id, location_id: null }).execute();
    
    const terminalId = crypto.randomUUID(); const credential = terminalCredential(locationId, terminalId);
    await db.insertInto('terminals').values({ id: terminalId, location_id: locationId, name: 'Term1', credential_hash: credentialHash(credential) }).execute();
    
    const unlock = await app.inject({ method: 'POST', url: '/api/v1/auth/pin-unlock', headers: { 'x-terminal-credential': credential }, payload: { staff_id: ownerId, pin: '2468' } }); 
    session = unlock.json().token;
  });

  afterAll(async () => { await app.close(); await db.destroy(); });

  let ingredient1Id = '';
  let product1Id = '';

  it('crud ingredients', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/ingredients', headers: auth(session), payload: { name: 'Tomato', unit_of_measure: 'kg' } });
    expect(res.statusCode).toBe(201);
    ingredient1Id = res.json().id;

    const list = await app.inject({ method: 'GET', url: '/api/v1/ingredients', headers: auth(session) });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.length).toBe(1);

    const update = await app.inject({ method: 'PUT', url: `/api/v1/ingredients/${ingredient1Id}`, headers: auth(session), payload: { name: 'Fresh Tomato', unit_of_measure: 'kg' } });
    expect(update.statusCode).toBe(200);
    expect(update.json().name).toBe('Fresh Tomato');
  });

  it('crud recipes', async () => {
    // create a product
    const prodRes = await app.inject({ method: 'POST', url: '/api/v1/products', headers: auth(session), payload: { name: 'Salad', base_price: 1000 } });
    product1Id = prodRes.json().id;

    // test constraint
    const badRecipe = await app.inject({ method: 'POST', url: '/api/v1/recipes', headers: auth(session), payload: { product_id: product1Id, modifier_id: crypto.randomUUID(), ingredient_id: ingredient1Id, quantity_per_unit: "0.5" } });
    expect(badRecipe.statusCode).toBe(400);

    const noTargetRecipe = await app.inject({ method: 'POST', url: '/api/v1/recipes', headers: auth(session), payload: { ingredient_id: ingredient1Id, quantity_per_unit: "0.5" } });
    expect(noTargetRecipe.statusCode).toBe(400);

    // success
    const res = await app.inject({ method: 'POST', url: '/api/v1/recipes', headers: auth(session), payload: { product_id: product1Id, ingredient_id: ingredient1Id, quantity_per_unit: "0.5" } });
    expect(res.statusCode).toBe(201);
    
    const list = await app.inject({ method: 'GET', url: `/api/v1/recipes?product_id=${product1Id}`, headers: auth(session) });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.length).toBe(1);
    
    const delRes = await app.inject({ method: 'DELETE', url: `/api/v1/recipes/${res.json().id}`, headers: auth(session) });
    expect(delRes.statusCode).toBe(204);
  });

  it('stock adjustments with concurrency', async () => {
    const list = await app.inject({ method: 'GET', url: `/api/v1/locations/${locationId}/inventory`, headers: auth(session) });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.length).toBe(1);

    // First-ever adjustment for this ingredient: no ingredient_stock row exists yet,
    // so no If-Match is required or sent (matches the module-center convention:
    // If-Match is only required once a row actually exists to conflict with).
    const createRes = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationId}/inventory/${ingredient1Id}/adjust`, headers: auth(session), payload: { new_quantity: 10, reason: 'found 10 kg' } });
    expect(createRes.statusCode).toBe(200);
    expect(createRes.json().stock.quantity_on_hand).toBe('10.0000');
    expect(createRes.json().stock.version).toBe(1);

    // A stale If-Match against the now-existing row is rejected with a real 409.
    const staleRes = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationId}/inventory/${ingredient1Id}/adjust`, headers: { ...auth(session), 'If-Match': '999' }, payload: { new_quantity: 5, reason: 'recount' } });
    expect(staleRes.statusCode).toBe(409);
    expect(staleRes.json().error.code).toBe('OPTIMISTIC_CONCURRENCY_CONFLICT');
    expect(staleRes.json().error.details.current_version).toBe(1);

    // The correct current version succeeds.
    const updateRes = await app.inject({ method: 'POST', url: `/api/v1/locations/${locationId}/inventory/${ingredient1Id}/adjust`, headers: { ...auth(session), 'If-Match': '1' }, payload: { new_quantity: 7, reason: 'recount' } });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().stock.quantity_on_hand).toBe('7.0000');
    expect(updateRes.json().stock.version).toBe(2);
  });

});
