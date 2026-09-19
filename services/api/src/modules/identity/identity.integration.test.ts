import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import Fastify from 'fastify';

import { identityModule } from './index.js';
import { createDatabase, installDatabase } from '../../shared/index.js';
import { createTerminalCredential, hashPin, hashSecret } from './security.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration('identity API against PostgreSQL', () => {
  const db = createDatabase({ databaseUrl });
  const app = Fastify({ logger: false });
  installDatabase(app, { databaseUrl });
  app.register(identityModule);
  let locationA = '';
  let locationB = '';
  let ownerId = '';
  let ownerTerminalCredential = '';
  let ownerSession = '';

  beforeAll(async () => {
    await db.deleteFrom('stock_adjustments').execute();
    await db.deleteFrom('ingredient_stock').execute();
    await db.deleteFrom('recipe_lines').execute();
    await db.deleteFrom('ingredients').execute();
    await db.deleteFrom('cash_drawer_movements').execute();
    await db.deleteFrom('cash_drawer_sessions').execute();
    await db.deleteFrom('command_idempotency').execute();
    await db.deleteFrom('audit_events').execute();
    await db.deleteFrom('loyalty_transactions').execute();
    await db.deleteFrom('loyalty_redemptions').execute();
    await db.deleteFrom('loyalty_accounts').execute();
    await db.deleteFrom('loyalty_rewards').execute();
    await db.deleteFrom('loyalty_coupons').execute();
    await db.deleteFrom('loyalty_settings').execute();
    await db.deleteFrom('account_discounts').execute();
    await db.deleteFrom('outbox_events').execute();
    await db.deleteFrom('refunds').execute();
    await db.deleteFrom('cancellations_and_voids').execute();
    await db.deleteFrom('payments').execute();
    await db.deleteFrom('order_line_modifiers').execute(); await db.deleteFrom('order_fulfillments').execute();
    await db.deleteFrom('order_line_promotions').execute(); await db.deleteFrom('order_lines').execute();
    await db.deleteFrom('orders').execute();
    await db.deleteFrom('accounts').execute();
    await db.deleteFrom('reservations').execute();
    await db.deleteFrom('reservation_settings').execute();
    await db.deleteFrom('guest_sessions').execute();
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
    await db.deleteFrom('promotions').execute(); await db.deleteFrom('products').execute();
    await db.deleteFrom('categories').execute();
    await db.deleteFrom('terminal_pin_attempts').execute();
    await db.deleteFrom('staff_sessions').execute();
    await db.deleteFrom('staff_roles').execute();
    await db.deleteFrom('role_permissions').execute();
    await db.deleteFrom('terminals').execute();
    await db.deleteFrom('timeclock_shifts').execute();
    await db.deleteFrom('staff').execute();
    await db.deleteFrom('roles').execute();
    await db.deleteFrom('customer_sessions').execute();    await db.deleteFrom('customers').execute();    await db.deleteFrom('delivery_zones').execute();    await db.deleteFrom('scheduled_order_settings').execute();    await db.deleteFrom('locations').execute();
    await db.deleteFrom('webhook_subscriptions').execute();
    await db.deleteFrom('organizations').execute();

    const organization = await db
      .insertInto('organizations')
      .values({ name: 'Integration Restaurant' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const [firstLocation, secondLocation] = await db
      .insertInto('locations')
      .values([
        { organization_id: organization.id, name: 'Downtown' },
        { organization_id: organization.id, name: 'Airport' },
      ])
      .returning('id')
      .execute();
    locationA = firstLocation.id;
    locationB = secondLocation.id;
    const ownerRole = await db
      .insertInto('roles')
      .values({ organization_id: organization.id, name: 'Owner' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('role_permissions')
      .values(
        [
          'iam.terminals.enroll',
          'iam.terminals.read',
          'iam.staff.read',
          'iam.staff.create',
          'iam.staff.update',
          'iam.roles.read',
          'iam.roles.update',
        ].map((permission_name) => ({
          role_id: ownerRole.id,
          permission_name,
          scope: 'organization',
        })),
      )
      .execute();
    const owner = await db
      .insertInto('staff')
      .values({
        organization_id: organization.id,
        first_name: 'Ada',
        last_name: 'Owner',
        pin_hash: await hashPin('2468'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ownerId = owner.id;
    await db
      .insertInto('staff_roles')
      .values({ staff_id: owner.id, role_id: ownerRole.id, location_id: null })
      .execute();
    const terminalId = crypto.randomUUID();
    ownerTerminalCredential = createTerminalCredential(locationA, terminalId);
    await db
      .insertInto('terminals')
      .values({
        id: terminalId,
        location_id: locationA,
        name: 'Owner terminal',
        credential_hash: hashSecret(ownerTerminalCredential),
      })
      .execute();
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('enrolls a terminal and unlocks a staff session with a terminal credential', async () => {
    const unlock = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/pin-unlock',
      headers: { 'x-terminal-credential': ownerTerminalCredential },
      payload: { staff_id: ownerId, pin: '2468' },
    });
    expect(unlock.statusCode).toBe(201);
    ownerSession = unlock.json().token;

    const enrolled = await app.inject({
      method: 'POST',
      url: '/api/v1/terminals/enroll',
      headers: { authorization: `Bearer ${ownerSession}` },
      payload: { location_id: locationA, name: 'POS 1' },
    });
    expect(enrolled.statusCode).toBe(201);
    expect(enrolled.json().terminal_credential).toEqual(expect.any(String));
    const enrolledUnlock = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/pin-unlock',
      headers: { 'x-terminal-credential': enrolled.json().terminal_credential },
      payload: { staff_id: ownerId, pin: '2468' },
    });
    expect(enrolledUnlock.statusCode).toBe(201);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${ownerSession}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().staff.id).toBe(ownerId);
    expect(me.json().app_target).toBeNull();
    expect(me.json().profile_config).toBeNull();
  });

  it('resolves terminal profiles and validates profile assignment', async () => {
    const terminalId = ownerTerminalCredential.split('.')[1]!;
    const organization = await db
      .selectFrom('organizations')
      .select('id')
      .executeTakeFirstOrThrow();
    const [category] = await db
      .insertInto('categories')
      .values({ organization_id: organization.id, name: 'Grill' })
      .returning('id')
      .execute();
    const nonExistentCategoryId = crypto.randomUUID();
    const [areaA, areaB] = await db
      .insertInto('areas')
      .values([
        { location_id: locationA, name: 'Dining room A' },
        { location_id: locationB, name: 'Dining room B' },
      ])
      .returning('id')
      .execute();
    const [tableA, tableB] = await db
      .insertInto('tables')
      .values([
        { location_id: locationA, area_id: areaA.id, name: 'A1', max_capacity: 4 },
        { location_id: locationB, area_id: areaB.id, name: 'B1', max_capacity: 4 },
      ])
      .returning('id')
      .execute();

    const lookup = await app.inject({
      method: 'GET',
      url: '/api/v1/terminals/me',
      headers: { 'x-terminal-credential': ownerTerminalCredential },
    });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toMatchObject({ terminal_id: terminalId, location_id: locationA, app_target: null, profile_config: null });

    let version = 1;
    async function update(app_target: string | null, profile_config: unknown, expected = version) {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/terminals/${terminalId}/profile`,
        headers: { authorization: `Bearer ${ownerSession}`, 'if-match': String(expected) },
        payload: { app_target, profile_config },
      });
      if (response.statusCode === 200) version = response.json().version;
      return response;
    }

    expect((await update('KITCHEN', { scope: 'ALL' })).statusCode).toBe(200);
    expect((await update('KITCHEN', { scope: 'CATEGORY', category_ids: [category.id] })).statusCode).toBe(200);
    expect((await update('SELF_SERVICE', { mode: 'KIOSK' })).statusCode).toBe(200);
    expect((await update('SELF_SERVICE', { mode: 'TABLE', table_id: tableA.id })).statusCode).toBe(200);
    expect((await update('SELF_SERVICE', { mode: 'ORDER_STATUS' })).statusCode).toBe(200);
    expect((await update('STAFF', { mode: 'HOST' })).statusCode).toBe(200);
    expect((await update(null, null)).statusCode).toBe(200);

    const configured = await update('KITCHEN', { scope: 'CATEGORY', category_ids: [category.id] });
    expect(configured.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${ownerSession}` } });
    expect(me.json()).toMatchObject({ app_target: 'KITCHEN', profile_config: { scope: 'CATEGORY', category_ids: [category.id] } });

    const invalidCategory = await update('KITCHEN', { scope: 'CATEGORY', category_ids: [nonExistentCategoryId] });
    expect(invalidCategory.statusCode).toBe(400);
    expect(invalidCategory.json().error.code).toBe('INVALID_CATEGORY');
    const invalidTable = await update('SELF_SERVICE', { mode: 'TABLE', table_id: tableB.id });
    expect(invalidTable.statusCode).toBe(400);
    expect(invalidTable.json().error.code).toBe('INVALID_TABLE');
    const malformed = await update('KITCHEN', { scope: 'ALL', category_ids: [category.id] });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('VALIDATION_ERROR');

    const missingMatch = await app.inject({
      method: 'PUT',
      url: `/api/v1/terminals/${terminalId}/profile`,
      headers: { authorization: `Bearer ${ownerSession}` },
      payload: { app_target: null, profile_config: null },
    });
    expect(missingMatch.statusCode).toBe(428);
    const invalidMatch = await app.inject({
      method: 'PUT',
      url: `/api/v1/terminals/${terminalId}/profile`,
      headers: { authorization: `Bearer ${ownerSession}`, 'if-match': 'zero' },
      payload: { app_target: null, profile_config: null },
    });
    expect(invalidMatch.statusCode).toBe(400);
    expect(invalidMatch.json().error.code).toBe('INVALID_IF_MATCH');
    const stale = await update(null, null, 1);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('OPTIMISTIC_CONCURRENCY_CONFLICT');
    expect(stale.json().error.details.current_state.id).toBe(terminalId);

    for (const headers of [
      {},
      { 'x-terminal-credential': 'invalid' },
      { 'x-terminal-credential': createTerminalCredential(locationA, crypto.randomUUID()) },
      { 'x-terminal-credential': createTerminalCredential(locationB, terminalId) },
    ]) {
      const response = await app.inject({ method: 'GET', url: '/api/v1/terminals/me', headers });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('TERMINAL_UNAUTHENTICATED');
    }
    const mismatchedSecret = await app.inject({
      method: 'GET',
      url: '/api/v1/terminals/me',
      headers: { 'x-terminal-credential': createTerminalCredential(locationA, terminalId) },
    });
    expect(mismatchedSecret.statusCode).toBe(401);
    const inactiveId = crypto.randomUUID();
    const inactiveCredential = createTerminalCredential(locationA, inactiveId);
    await db.insertInto('terminals').values({ id: inactiveId, location_id: locationA, name: 'Inactive', is_active: false, credential_hash: hashSecret(inactiveCredential) }).execute();
    const inactive = await app.inject({ method: 'GET', url: '/api/v1/terminals/me', headers: { 'x-terminal-credential': inactiveCredential } });
    expect(inactive.statusCode).toBe(401);

    const readRole = await db.insertInto('roles').values({ organization_id: organization.id, name: 'Terminal reader' }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('role_permissions').values({ role_id: readRole.id, permission_name: 'iam.terminals.read', scope: 'location' }).execute();
    const reader = await db.insertInto('staff').values({ organization_id: organization.id, first_name: 'Read', last_name: 'Only', pin_hash: await hashPin('1357') }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('staff_roles').values({ staff_id: reader.id, role_id: readRole.id, location_id: locationA }).execute();
    const readerTerminalId = crypto.randomUUID();
    const readerCredential = createTerminalCredential(locationA, readerTerminalId);
    await db.insertInto('terminals').values({ id: readerTerminalId, location_id: locationA, name: 'Reader', credential_hash: hashSecret(readerCredential) }).execute();
    const unlock = await app.inject({ method: 'POST', url: '/api/v1/auth/pin-unlock', headers: { 'x-terminal-credential': readerCredential }, payload: { staff_id: reader.id, pin: '1357' } });
    expect(unlock.statusCode).toBe(201);
    const forbidden = await app.inject({
      method: 'PUT',
      url: `/api/v1/terminals/${terminalId}/profile`,
      headers: { authorization: `Bearer ${unlock.json().token}`, 'if-match': String(version) },
      payload: { app_target: null, profile_config: null },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('backs off failed PINs per terminal and presented credential', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/pin-unlock',
      headers: { 'x-terminal-credential': ownerTerminalCredential },
      payload: { staff_id: ownerId, pin: '0000' },
    });
    expect(first.statusCode).toBe(401);
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/pin-unlock',
      headers: { 'x-terminal-credential': ownerTerminalCredential },
      payload: { staff_id: ownerId, pin: '0000' },
    });
    expect(second.statusCode).toBe(429);
    expect(second.headers['retry-after']).toBe('1');
  });

  it('returns the current representation on an optimistic-concurrency conflict', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/staff',
      headers: { authorization: `Bearer ${ownerSession}` },
      payload: { first_name: 'Grace', last_name: 'Hopper', pin: '1234', role_ids: [] },
    });
    expect(created.statusCode).toBe(400);
    const role = await db
      .selectFrom('roles')
      .select('id')
      .where('name', '=', 'Owner')
      .executeTakeFirstOrThrow();
    const validCreated = await app.inject({
      method: 'POST',
      url: '/api/v1/staff',
      headers: { authorization: `Bearer ${ownerSession}` },
      payload: { first_name: 'Grace', last_name: 'Hopper', pin: '1234', role_ids: [role.id] },
    });
    expect(validCreated.statusCode).toBe(201);
    const conflict = await app.inject({
      method: 'PUT',
      url: `/api/v1/staff/${validCreated.json().id}`,
      headers: { authorization: `Bearer ${ownerSession}`, 'if-match': '99' },
      payload: { first_name: 'Grace' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.details.current_state.id).toBe(validCreated.json().id);
  });

  it('uses RLS to prevent a location A session from seeing location B terminals or staff', async () => {
    const organization = await db
      .selectFrom('organizations')
      .select('id')
      .executeTakeFirstOrThrow();
    const role = await db
      .selectFrom('roles')
      .select('id')
      .where('name', '=', 'Owner')
      .executeTakeFirstOrThrow();
    const staff = await db
      .insertInto('staff')
      .values({
        organization_id: organization.id,
        first_name: 'Bea',
        last_name: 'Airport',
        pin_hash: await hashPin('1357'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('staff_roles')
      .values({ staff_id: staff.id, role_id: role.id, location_id: locationB })
      .execute();
    const terminalId = crypto.randomUUID();
    const terminalCredential = createTerminalCredential(locationB, terminalId);
    await db
      .insertInto('terminals')
      .values({
        id: terminalId,
        location_id: locationB,
        name: 'Airport terminal',
        credential_hash: hashSecret(terminalCredential),
      })
      .execute();

    const terminals = await app.inject({
      method: 'GET',
      url: '/api/v1/terminals',
      headers: { authorization: `Bearer ${ownerSession}` },
    });
    expect(terminals.statusCode).toBe(200);
    expect(
      terminals
        .json()
        .data.some((terminal: { location_id: string }) => terminal.location_id === locationB),
    ).toBe(false);
    const staffList = await app.inject({
      method: 'GET',
      url: '/api/v1/staff',
      headers: { authorization: `Bearer ${ownerSession}` },
    });
    expect(staffList.statusCode).toBe(200);
    expect(staffList.json().data.some((entry: { id: string }) => entry.id === staff.id)).toBe(
      false,
    );
  });

  it('commits a new role before the HTTP response returns, with no read-after-write delay needed', async () => {
    // Regression test for a response-before-commit race: reply.send() called
    // from inside the transaction callback could complete before the
    // wrapping transaction actually reached COMMIT, so a client reading the
    // row via a separate connection immediately after a success response
    // could see it missing. Deliberately reads via `db` (a separate
    // connection from the app's own pool) with zero delay.
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      headers: { authorization: `Bearer ${ownerSession}` },
      payload: { name: 'Host' },
    });
    expect(created.statusCode).toBe(201);
    const row = await db.selectFrom('roles').selectAll().where('id', '=', created.json().id).executeTakeFirst();
    expect(row).toBeTruthy();
    expect(row?.name).toBe('Host');
  });

  it('creates a custom role', async () => {
    const noAuth = await app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      payload: { name: 'Manager' },
    });
    expect(noAuth.statusCode).toBe(401);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      headers: { authorization: `Bearer ${ownerSession}` },
      payload: { name: 'Manager', description: 'Store manager' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().name).toBe('Manager');
    expect(created.json().is_system_template).toBe(false);
    expect(created.json().permissions).toEqual([]);
  });

  it('reassigns staff roles', async () => {
    const role = await app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      headers: { authorization: `Bearer ${ownerSession}` },
      payload: { name: 'Cashier' },
    });
    const roleId = role.json().id;

    const invalidRole = await app.inject({
      method: 'PUT',
      url: `/api/v1/staff/${ownerId}`,
      headers: { authorization: `Bearer ${ownerSession}`, 'if-match': '1' },
      payload: { role_ids: [crypto.randomUUID()] },
    });
    expect(invalidRole.statusCode).toBe(400);

    const reassigned = await app.inject({
      method: 'PUT',
      url: `/api/v1/staff/${ownerId}`,
      headers: { authorization: `Bearer ${ownerSession}`, 'if-match': '1' },
      payload: { role_ids: [roleId] },
    });
    expect(reassigned.statusCode).toBe(200);
  });

  it('enrolls a terminal for a DIFFERENT location in the SAME organization', async () => {
    const enrolled = await app.inject({
      method: 'POST',
      url: '/api/v1/terminals/enroll',
      headers: { authorization: `Bearer ${ownerSession}` },
      payload: { location_id: locationB, name: 'POS 2' },
    });
    expect(enrolled.statusCode).toBe(201);
  });

  it('fails to enroll a terminal for a location that does not belong to the caller\'s organization', async () => {
    // This codebase enforces a hard single-organization-per-install constraint
    // (organizations.unq_is_single_org), so a genuinely separate organization
    // row cannot exist alongside this test's own. A location id that simply
    // doesn't exist exercises the exact same query path in the handler
    // (`WHERE id = body.location_id AND organization_id = actor.organizationId`
    // — no match either way) without violating that constraint.
    const enrolled = await app.inject({
      method: 'POST',
      url: '/api/v1/terminals/enroll',
      headers: { authorization: `Bearer ${ownerSession}` },
      payload: { location_id: crypto.randomUUID(), name: 'POS 3' },
    });
    expect(enrolled.statusCode).toBe(404);
  });
});
