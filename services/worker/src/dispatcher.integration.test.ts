import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { OutboxDispatcher } from './dispatcher.js';

const dbUrl = process.env.DATABASE_URL;
const redisUrl = process.env.VALKEY_URL || process.env.REDIS_URL || 'redis://localhost:6379';
const describeIntegration = dbUrl ? describe : describe.skip;

describeIntegration('Worker OutboxDispatcher', () => {
  let dispatcher: OutboxDispatcher;
  let redis: Redis;
  let db: Kysely<any>;
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: dbUrl });
    db = new Kysely({ dialect: new PostgresDialect({ pool }) });
    redis = new Redis(redisUrl);
    
    // Create dispatcher
    dispatcher = new OutboxDispatcher({
      dbUrl: dbUrl!,
      redisUrl,
      batchSize: 50,
      pollIntervalMs: 100
    });
    
    // Clear outbox
    await db.deleteFrom('outbox_events').execute();
  });

  afterAll(async () => {
    await dispatcher.stop();
    await db.destroy();
    redis.disconnect();
  });

  it('claims pending outbox events and publishes to valkey', async () => {
    // We will listen to Valkey for the publish
    const subscriber = new Redis(redisUrl);
    const messages: any[] = [];
    
    await subscriber.psubscribe('location:*:events');
    subscriber.on('pmessage', (pattern, channel, message) => {
      messages.push({ channel, payload: JSON.parse(message) });
    });
    
    // Wait for subscription
    await new Promise(r => setTimeout(r, 100));

    // Insert an outbox event
    const locId = '99999999-9999-9999-9999-999999999999';
    const evt = await db.insertInto('outbox_events')
      .values({
        location_id: locId,
        aggregate_type: 'order',
        aggregate_id: 'ord_1',
        event_type: 'OrderCreated',
        payload: { some: 'data' },
        schema_version: 1
      })
      .returning('id')
      .executeTakeFirstOrThrow();
      
    // Call processBatch manually for testing
    const processed = await dispatcher.processBatch();
    expect(processed).toBe(1);
    
    // Check that dispatched_at is set
    const updated = await db.selectFrom('outbox_events')
      .select('dispatched_at')
      .where('id', '=', evt.id)
      .executeTakeFirstOrThrow();
      
    expect(updated.dispatched_at).not.toBeNull();
    
    // Wait for redis message delivery
    await new Promise(r => setTimeout(r, 100));
    
    expect(messages).toHaveLength(1);
    expect(messages[0].channel).toBe(`location:${locId}:events`);
    expect(messages[0].payload.id).toBe(evt.id);
    
    await subscriber.quit();
  });
});
