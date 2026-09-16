import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { Kysely, PostgresDialect, type Generated } from 'kysely';
import pg from 'pg';
import { OutboxDispatcher, type Database } from './dispatcher.js';

const dbUrl = process.env.DATABASE_URL;
const redisUrl = process.env.VALKEY_URL || process.env.REDIS_URL || 'redis://localhost:6379';
const describeIntegration = dbUrl ? describe : describe.skip;

interface TestDatabase extends Database {
  organizations: { id: Generated<string>; name: string };
  locations: { id: Generated<string>; organization_id: string; name: string };
}

describeIntegration('Worker OutboxDispatcher', () => {
  let dispatcher: OutboxDispatcher;
  let redis: Redis;
  let db: Kysely<TestDatabase>;
  let pool: pg.Pool;
  let locationId: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: dbUrl });
    db = new Kysely<TestDatabase>({ dialect: new PostgresDialect({ pool }) });
    redis = new Redis(redisUrl);

    // Create dispatcher
    dispatcher = new OutboxDispatcher({
      dbUrl: dbUrl!,
      redisUrl,
      batchSize: 50,
      pollIntervalMs: 100
    });

    // Clear only this test's own table; outbox_events.location_id has a real FK
    // to locations(id), so reuse or create a location rather than fabricating a
    // random UUID (a prior version of this test used a fake location_id, which
    // can only have "worked" by accident if another suite happened to leave a
    // matching row — fixed to be correct and independent of run order).
    await db.deleteFrom('outbox_events').execute();
    const existing = await db.selectFrom('locations').select('id').executeTakeFirst();
    if (existing) {
      locationId = existing.id;
    } else {
      const org = await db.insertInto('organizations').values({ name: 'Dispatcher Test Org' }).returning('id').executeTakeFirstOrThrow();
      const location = await db.insertInto('locations').values({ organization_id: org.id, name: 'Dispatcher Test Location' }).returning('id').executeTakeFirstOrThrow();
      locationId = location.id;
    }
  });

  afterAll(async () => {
    await dispatcher.stop();
    await db.destroy();
    redis.disconnect();
  });

  it('claims pending outbox events and publishes to valkey', async () => {
    // We will listen to Valkey for the publish
    const subscriber = new Redis(redisUrl);
    const messages: Array<{ channel: string; payload: { id: string } }> = [];

    await subscriber.psubscribe('location:*:events');
    subscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
      messages.push({ channel, payload: JSON.parse(message) });
    });

    // Wait for subscription
    await new Promise(r => setTimeout(r, 100));

    // Insert an outbox event against a real, existing location (see beforeAll).
    // aggregate_id is a UUID column; a non-UUID placeholder like "ord_1" fails
    // with a real Postgres type error, the same class of mistake as the fake
    // location_id fixed above.
    const evt = await db.insertInto('outbox_events')
      .values({
        location_id: locationId,
        aggregate_type: 'order',
        aggregate_id: '00000000-0000-0000-0000-0000000000aa',
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
    expect(messages[0].channel).toBe(`location:${locationId}:events`);
    expect(messages[0].payload.id).toBe(evt.id);
    
    await subscriber.quit();
  });
});
