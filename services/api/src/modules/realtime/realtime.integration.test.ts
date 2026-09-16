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
  let redis: Redis;
  beforeAll(async () => {
    // Standard suite global cleanup at the start
    for (const table of ['cash_drawer_movements', 'cash_drawer_sessions', 'module_activations', 'command_idempotency', 'audit_events', 'account_discounts', 'outbox_events', 'refunds', 'cancellations_and_voids', 'payments', 'order_line_modifiers', 'order_lines', 'orders', 'accounts', 'visits', 'table_sections', 'sections', 'tables', 'areas', 'availability_rules', 'location_price_overrides', 'product_combo_items', 'product_combo_groups', 'product_modifier_groups', 'modifiers', 'modifier_groups', 'product_variants', 'products', 'categories', 'terminal_pin_attempts', 'staff_sessions', 'staff_roles', 'role_permissions', 'terminals', 'staff', 'roles', 'locations', 'organizations'] as const) {
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
