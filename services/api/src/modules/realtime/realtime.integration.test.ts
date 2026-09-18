import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import argon2 from 'argon2';
import Fastify from 'fastify';
import WebSocket, { type RawData } from 'ws';
import { Redis } from 'ioredis';
import { createDatabase, installDatabase } from '../../shared/index.js';
import { realtimeModule } from './index.js';

const hashSecret = (value: string) => createHash('sha256').update(value).digest('hex');

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.VALKEY_URL || process.env.REDIS_URL || 'redis://localhost:6379';
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration('realtime WebSocket gateway', () => {
  const db = createDatabase({ databaseUrl });
  const app = Fastify({ logger: false });
  installDatabase(app, { databaseUrl });
  app.register(realtimeModule);
  
  let locationA = '';
  let locationB = '';
  let sessionA = '';
  let sessionB = '';
  let guestSession = '';
  let guestVisit = '';
  let redis: Redis;
  beforeAll(async () => {
    // Standard suite global cleanup at the start
    for (const table of [
      'stock_adjustments',
      'ingredient_stock',
      'recipe_lines',
      'ingredients',
      'table_service_requests',
      'guest_sessions',
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
      'order_line_promotions',
      'order_lines',
      'orders',
      'accounts',
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
      'locations',
      'organizations'
    ] as const) {
      await db.deleteFrom(table).execute();
    }

    // Create an organization
    const org = await db.insertInto('organizations').values({ name: 'Realtime Org' }).returning('id').executeTakeFirstOrThrow();

    // Create locations
    const locA = await db.insertInto('locations')
      .values({ organization_id: org.id, name: 'Location A' })
      .returning('id').executeTakeFirstOrThrow();
    locationA = locA.id;

    const locB = await db.insertInto('locations')
      .values({ organization_id: org.id, name: 'Location B' })
      .returning('id').executeTakeFirstOrThrow();
    locationB = locB.id;

    const area = await db.insertInto('areas').values({ location_id: locationA, name: 'Dining' }).returning('id').executeTakeFirstOrThrow();
    const table = await db.insertInto('tables').values({ location_id: locationA, area_id: area.id, name: 'A1', max_capacity: 4, status: 'OCCUPIED' }).returning('id').executeTakeFirstOrThrow();
    const visit = await db.insertInto('visits').values({ location_id: locationA, table_id: table.id }).returning('id').executeTakeFirstOrThrow();
    guestVisit = visit.id;
    guestSession = `guest.${locationA}.${'g'.repeat(32)}`;
    await db.insertInto('guest_sessions').values({ location_id: locationA, visit_id: visit.id, table_id: table.id, token_hash: hashSecret(guestSession), expires_at: new Date(Date.now() + 60 * 60 * 1000) }).execute();

    // Create staff
    const staffId = await db.insertInto('staff')
      .values({ organization_id: org.id, first_name: 'Test', last_name: 'Worker', pin_hash: await argon2.hash('1234') })
      .returning('id').executeTakeFirstOrThrow();

    // Create terminals
    const termA = await db.insertInto('terminals')
      .values({ location_id: locationA, name: 'Term A', credential_hash: 'ignored' })
      .returning('id').executeTakeFirstOrThrow();
      
    const termB = await db.insertInto('terminals')
      .values({ location_id: locationB, name: 'Term B', credential_hash: 'ignored' })
      .returning('id').executeTakeFirstOrThrow();

    // Create sessions
    // Session A
    const secretA = 'a'.repeat(32);
    await db.insertInto('staff_sessions')
      .values({
        location_id: locationA,
        staff_id: staffId.id,
        terminal_id: termA.id,
        token_hash: hashSecret(`${locationA}.${secretA}`),
        expires_at: new Date(Date.now() + 1000 * 60 * 60)
      })
      .returning('id').executeTakeFirstOrThrow();
    sessionA = `${locationA}.${secretA}`;

    const secretB = 'b'.repeat(32);
    await db.insertInto('staff_sessions')
      .values({
        location_id: locationB,
        staff_id: staffId.id,
        terminal_id: termB.id,
        token_hash: hashSecret(`${locationB}.${secretB}`),
        expires_at: new Date(Date.now() + 1000 * 60 * 60)
      })
      .returning('id').executeTakeFirstOrThrow();
    sessionB = `${locationB}.${secretB}`;

    // Connect to Redis for publishing tests
    redis = new Redis(redisUrl);
    
    // Start fastify
    await app.listen({ port: 0 });
  });

  afterAll(async () => {
    if (redis) await redis.quit();
    await db.deleteFrom('table_service_requests').execute();
    await db.deleteFrom('guest_sessions').execute();
    await app.close();
    await db.destroy();
  });

  it('rejects unauthenticated connections', async () => {
    const address = app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/realtime`);
    
    return new Promise<void>((resolve, reject) => {
      ws.on('close', (code) => {
        expect(code).toBe(1008);
        resolve();
      });
      ws.on('error', reject);
    });
  });

  it('connects successfully with a valid session token', async () => {
    const address = app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/realtime`, {
      headers: { authorization: `Bearer ${sessionA}` }
    });

    return new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });
  });

  it('connects successfully via the Sec-WebSocket-Protocol token, as a real browser must (it cannot set Authorization on the handshake)', async () => {
    const address = app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/realtime`, ['Bearer', sessionA]);

    return new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        expect(ws.protocol).toBe('Bearer');
        ws.close();
        resolve();
      });
      ws.on('unexpected-response', (_req, res) => reject(new Error(`Unexpected response: ${res.statusCode}`)));
      ws.on('error', reject);
    });
  });

  it('accepts a guest subprotocol token and forwards only events for that guest visit', async () => {
    const address = app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/realtime`, ['Bearer', guestSession]);
    await new Promise<void>((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    const messages: Array<{ id: string }> = [];
    ws.on('message', (data: RawData) => messages.push(JSON.parse(data.toString())));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await redis.publish(`location:${locationA}:events`, JSON.stringify({ id: 'guest-own', payload: { visit_id: guestVisit } }));
    await redis.publish(`location:${locationA}:events`, JSON.stringify({ id: 'guest-other', payload: { visit_id: crypto.randomUUID() } }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(messages.map((message) => message.id)).toEqual(['guest-own']);
    ws.close();
  });

  it('receives messages for its location and isolates cross-location events', async () => {
    const address = app.server.address() as AddressInfo;
    const wsA = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/realtime`, {
      headers: { authorization: `Bearer ${sessionA}` }
    });
    const wsB = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/realtime`, {
      headers: { Authorization: `Bearer ${sessionB}` },
    });

    await new Promise(r => wsA.on('open', r));
    await new Promise(r => wsB.on('open', r));

    // Wait for the server to finish the async session validation and add us to clientMap
    await new Promise(r => setTimeout(r, 100));

    // Send a message to Location A
    const messageA = { id: 'evt_1', aggregate_type: 'order', aggregate_id: 'ord_1', event_type: 'OrderCreated', payload: {}, schema_version: 1, created_at: new Date().toISOString() };
    const messageB = { id: 'evt_2', aggregate_type: 'order', aggregate_id: 'ord_2', event_type: 'OrderCreated', payload: {}, schema_version: 1, created_at: new Date().toISOString() };

    const msgsForA: Array<{ id: string }> = [];
    wsA.on('message', (data: RawData) => {
      msgsForA.push(JSON.parse(data.toString()));
    });

    const msgsForB: Array<{ id: string }> = [];
    wsB.on('message', (data: RawData) => {
      msgsForB.push(JSON.parse(data.toString()));
    });

    // Wait a brief moment to ensure subscriptions are active.
    // The Redis PSUBSCRIBE happens on route load, but it's good to be safe.
    await new Promise(r => setTimeout(r, 100));

    // Publish manually to Redis
    await redis.publish(`location:${locationA}:events`, JSON.stringify(messageA));
    await redis.publish(`location:${locationB}:events`, JSON.stringify(messageB));

    // Wait for delivery
    await new Promise(r => setTimeout(r, 200));

    expect(msgsForA).toHaveLength(1);
    expect(msgsForA[0].id).toBe('evt_1');

    expect(msgsForB).toHaveLength(1);
    expect(msgsForB[0].id).toBe('evt_2');

    wsA.close();
    wsB.close();
  });
});
