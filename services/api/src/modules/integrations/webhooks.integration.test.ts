import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
import argon2 from 'argon2';
import Fastify from 'fastify';

import { identityModule } from '../identity/index.js';
import { createDatabase, installDatabase } from '../../shared/index.js';
import { integrationsModule } from './index.js';

const databaseUrl = process.env.DATABASE_URL;
const db = createDatabase({ databaseUrl });
const describeIntegration = databaseUrl ? describe : describe.skip;

function terminalCredential(locationId: string, terminalId: string) {
  return `${locationId}.${terminalId}.${randomBytes(32).toString('base64url')}`;
}
function credentialHash(credential: string) {
  return createHash('sha256').update(credential).digest('hex');
}

describeIntegration('webhooks module', () => {
  const app = Fastify();
  installDatabase(app, { databaseUrl });
  app.register(identityModule, {});
  app.register(integrationsModule, {});

  let organizationId: string;
  let locationId: string;
  let staffSession: string;

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
      'order_line_promotions',
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
      'promotions',
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
      'scheduled_order_settings',
      'webhook_subscriptions',
      'locations',
      'organizations',
    ])
      await db.deleteFrom(table as never).execute();

    const org = await db
      .insertInto('organizations')
      .values({ name: 'Webhooks Org' })
      .returning('id')
      .executeTakeFirstOrThrow();
    organizationId = org.id;

    const loc = await db
      .insertInto('locations')
      .values({ organization_id: organizationId, name: 'Main' })
      .returning('id')
      .executeTakeFirstOrThrow();
    locationId = loc.id;

    const termId = crypto.randomUUID();
    const cred = terminalCredential(locationId, termId);
    await db
      .insertInto('terminals')
      .values({
        id: termId,
        location_id: locationId,
        name: 'Test Term',
        credential_hash: credentialHash(cred),
      })
      .execute();

    const role = await db
      .insertInto('roles')
      .values({ organization_id: organizationId, name: 'Admin' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('role_permissions')
      .values([
        { role_id: role.id, permission_name: 'integrations.webhooks.write', scope: 'organization' },
        { role_id: role.id, permission_name: 'integrations.webhooks.read', scope: 'organization' },
      ])
      .execute();

    const pin_hash = await argon2.hash('1234');
    const staff = await db
      .insertInto('staff')
      .values({ organization_id: organizationId, first_name: 'Admin', last_name: 'User', pin_hash })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('staff_roles')
      .values({ staff_id: staff.id, role_id: role.id, location_id: null })
      .execute();

    const unlock = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/pin-unlock',
      headers: { 'X-Terminal-Credential': cred },
      payload: { staff_id: staff.id, pin: '1234' },
    });
    staffSession = unlock.json().token;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('can create, read, update, and rotate a webhook', async () => {
    // Create
    const createRes = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/webhooks`,
      headers: { authorization: `Bearer ${staffSession}` },
      payload: { url: 'https://example.com/hook', event_types: ['account.paid'], is_active: true },
    });
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.payload);
    expect(created.subscription.url).toBe('https://example.com/hook');
    expect(created.subscription.event_types).toEqual(['account.paid']);
    expect(created.secret.startsWith('whsec_')).toBe(true);

    const subId = created.subscription.id;
    let version = created.subscription.version;

    // Read
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/webhooks`,
      headers: { authorization: `Bearer ${staffSession}` },
    });
    expect(listRes.statusCode).toBe(200);
    const list = JSON.parse(listRes.payload);
    expect(list.data).toHaveLength(1);
    expect(list.data[0].id).toBe(subId);

    // Update
    const updateRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${organizationId}/webhooks/${subId}`,
      headers: { authorization: `Bearer ${staffSession}`, 'if-match': `"${version}"` },
      payload: {
        url: 'https://example.com/hook2',
        event_types: ['payment.received'],
        is_active: false,
      },
    });
    expect(updateRes.statusCode).toBe(200);
    const updated = JSON.parse(updateRes.payload);
    expect(updated.url).toBe('https://example.com/hook2');
    expect(updated.is_active).toBe(false);
    expect(updated.version).toBe(version + 1);
    version = updated.version;

    // Rotate
    const rotateRes = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/webhooks/${subId}/rotate-secret`,
      headers: { authorization: `Bearer ${staffSession}`, 'if-match': `"${version}"` },
    });
    expect(rotateRes.statusCode).toBe(200);
    const rotated = JSON.parse(rotateRes.payload);
    expect(rotated.secret).not.toBe(created.secret);
    expect(rotated.subscription.version).toBe(version + 1);
  });
});
