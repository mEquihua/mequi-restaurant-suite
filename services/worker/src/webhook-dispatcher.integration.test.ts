import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Kysely, PostgresDialect, type Generated } from 'kysely';
import pg from 'pg';
import { WebhookDispatcher } from './webhook-dispatcher.js';

const dbUrl = process.env.DATABASE_URL;
const describeIntegration = dbUrl ? describe : describe.skip;

interface TestDatabase {
  organizations: { id: Generated<string>; name: string };
  locations: { id: Generated<string>; organization_id: string; name: string };
  webhook_subscriptions: {
    id: Generated<string>;
    organization_id: string;
    url: string;
    event_types: string[];
    secret: string;
  };
  outbox_events: {
    id: Generated<string>;
    location_id: string;
    aggregate_type: string;
    aggregate_id: string;
    event_type: string;
    payload: unknown;
    schema_version: number;
    webhook_dispatched_at: Date | null;
  };
}

describeIntegration('WebhookDispatcher', () => {
  let dispatcher: WebhookDispatcher;
  let db: Kysely<TestDatabase>;
  let pool: pg.Pool;
  let organizationId: string;
  let locationId: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: dbUrl });
    db = new Kysely<TestDatabase>({ dialect: new PostgresDialect({ pool }) });

    dispatcher = new WebhookDispatcher({
      dbUrl: dbUrl!,
      batchSize: 50,
      pollIntervalMs: 100,
    });

    await db.deleteFrom('outbox_events').execute();
    await db.deleteFrom('webhook_subscriptions').execute();
    await db.deleteFrom('locations').execute();
    await db.deleteFrom('organizations').execute();

    const org = await db
      .insertInto('organizations')
      .values({ name: 'WH Worker Test' })
      .returning('id')
      .executeTakeFirstOrThrow();
    organizationId = org.id;

    const loc = await db
      .insertInto('locations')
      .values({ organization_id: organizationId, name: 'Main' })
      .returning('id')
      .executeTakeFirstOrThrow();
    locationId = loc.id;
  });

  afterAll(async () => {
    await dispatcher.stop();
    await db.destroy();
  });

  it('processes a batch and sends HTTP requests', async () => {
    // 1. Create a subscription
    await db
      .insertInto('webhook_subscriptions')
      .values({
        organization_id: organizationId,
        url: 'https://example.com/webhook',
        event_types: ['account.paid'],
        secret: 'test_secret',
      })
      .execute();

    // 2. Insert an event
    const event = await db
      .insertInto('outbox_events')
      .values({
        location_id: locationId,
        aggregate_type: 'account',
        aggregate_id: crypto.randomUUID(),
        event_type: 'account.paid',
        payload: { total: 100 } as never,
        schema_version: 1,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // 3. Mock fetch globally
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock;

    // 4. Process batch
    const processed = await dispatcher.processBatch();
    expect(processed).toBe(1);

    // 5. Verify fetch was called with correct payload and signature
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('https://example.com/webhook');
    expect(call[1].method).toBe('POST');

    const body = JSON.parse(call[1].body);
    expect(body.event_type).toBe('account.paid');
    expect(body.payload.total).toBe(100);

    const sig = call[1].headers['X-Webhook-Signature'];
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);

    // 6. Verify event is marked as dispatched
    const row = await db
      .selectFrom('outbox_events')
      .selectAll()
      .where('id', '=', event.id)
      .executeTakeFirst();
    expect(row?.webhook_dispatched_at).not.toBeNull();
  });
});
