import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import crypto from 'node:crypto';

export interface WebhookSubscription {
  id: string;
  organization_id: string;
  url: string;
  event_types: string[];
  secret: string;
  is_active: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface LocationTable {
  id: string;
  organization_id: string;
}

export interface OutboxEventTable {
  id: string;
  location_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  schema_version: number;
  created_at: Date;
  updated_at: Date;
  dispatched_at: Date | null;
  webhook_dispatched_at: Date | null;
}

export interface Database {
  outbox_events: OutboxEventTable;
  webhook_subscriptions: WebhookSubscription;
  locations: LocationTable;
}

export interface DispatcherOptions {
  dbUrl: string;
  pollIntervalMs?: number;
  batchSize?: number;
}

export class WebhookDispatcher {
  private db: Kysely<Database>;
  private isProcessing: boolean = false;
  private pollIntervalMs: number;
  private batchSize: number;
  private timer: NodeJS.Timeout | null = null;
  private stopped: boolean = false;
  private pool: pg.Pool;

  constructor(options: DispatcherOptions) {
    this.pool = new pg.Pool({ connectionString: options.dbUrl });
    this.db = new Kysely<Database>({ dialect: new PostgresDialect({ pool: this.pool }) });
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.batchSize = options.batchSize ?? 50;
  }

  public start() {
    this.stopped = false;
    this.scheduleNext(0);
  }

  public async stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.isProcessing) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await this.db.destroy();
  }

  private scheduleNext(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.processLoop();
    }, delay);
  }

  private async processLoop() {
    if (this.stopped) return;
    this.isProcessing = true;
    try {
      const processedCount = await this.processBatch();
      this.isProcessing = false;
      this.scheduleNext(processedCount === this.batchSize ? 0 : this.pollIntervalMs);
    } catch (err) {
      console.error('Webhook worker loop error:', err);
      this.isProcessing = false;
      this.scheduleNext(this.pollIntervalMs);
    }
  }

  public async processBatch(): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE application_worker_role`.execute(trx);

      const rows = await trx
        .selectFrom('outbox_events')
        .selectAll()
        .where('webhook_dispatched_at', 'is', null)
        .orderBy('created_at', 'asc')
        .limit(this.batchSize)
        .forUpdate()
        .skipLocked()
        .execute();

      if (rows.length === 0) return 0;

      // Group by location to resolve org and find subscriptions efficiently
      const locationIds = [...new Set(rows.map((r) => r.location_id))];

      const locations = await trx
        .selectFrom('locations')
        .select(['id', 'organization_id'])
        .where('id', 'in', locationIds)
        .execute();

      const orgIds = [...new Set(locations.map((l) => l.organization_id))];

      const subscriptions = await trx
        .selectFrom('webhook_subscriptions')
        .selectAll()
        .where('organization_id', 'in', orgIds)
        .where('is_active', '=', true)
        .execute();

      const locToOrg = new Map(locations.map((l) => [l.id, l.organization_id]));
      const orgToSubs = new Map<string, typeof subscriptions>();
      for (const sub of subscriptions) {
        const arr = orgToSubs.get(sub.organization_id) || [];
        arr.push(sub);
        orgToSubs.set(sub.organization_id, arr);
      }

      // Deliver events
      for (const row of rows) {
        const orgId = locToOrg.get(row.location_id);
        if (orgId) {
          const subs = orgToSubs.get(orgId) || [];
          for (const sub of subs) {
            if (sub.event_types.includes(row.event_type)) {
              await this.deliverEvent(sub, row);
            }
          }
        }
      }

      // Mark all as dispatched
      const ids = rows.map((r) => r.id);
      await trx
        .updateTable('outbox_events')
        .set({ webhook_dispatched_at: sql`now()` })
        .where('id', 'in', ids)
        .execute();

      return rows.length;
    });
  }

  private async deliverEvent(sub: WebhookSubscription, row: OutboxEventTable) {
    const payloadWrapper = {
      event_id: row.id,
      event_type: row.event_type,
      occurred_at: row.created_at.toISOString(),
      payload: row.payload,
    };
    const bodyStr = JSON.stringify(payloadWrapper);
    const signature = crypto.createHmac('sha256', sub.secret).update(bodyStr).digest('hex');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      await fetch(sub.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': `sha256=${signature}`,
        },
        body: bodyStr,
        signal: controller.signal,
      });
    } catch (e) {
      // Fire-and-forget: log and ignore
      console.error(`Webhook delivery failed for event ${row.id} to ${sub.url}`, e);
    } finally {
      clearTimeout(timeout);
    }
  }
}
