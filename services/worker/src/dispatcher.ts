import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Redis } from 'ioredis';

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
}

export interface Database {
  outbox_events: OutboxEventTable;
}

export interface DispatcherOptions {
  dbUrl: string;
  redisUrl: string;
  pollIntervalMs?: number;
  batchSize?: number;
}

export class OutboxDispatcher {
  private db: Kysely<Database>;
  private redis: Redis;
  private isProcessing: boolean = false;
  private pollIntervalMs: number;
  private batchSize: number;
  private timer: NodeJS.Timeout | null = null;
  private stopped: boolean = false;
  private pool: pg.Pool;

  constructor(options: DispatcherOptions) {
    this.pool = new pg.Pool({ connectionString: options.dbUrl });
    this.db = new Kysely<Database>({ dialect: new PostgresDialect({ pool: this.pool }) });
    this.redis = new Redis(options.redisUrl);
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.batchSize = options.batchSize ?? 50;
    
    // We document the choice of application_migration_role:
    // The worker must read outbox_events across every location. Since RLS is
    // enforced on location_id for the runtime role, we use the migration role
    // which has BYPASSRLS, effectively giving this worker global access.
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
    
    // Wait for any in-flight batch to finish
    while (this.isProcessing) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    await this.db.destroy();
    await this.redis.quit();
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
      console.error('Worker loop error:', err);
      this.isProcessing = false;
      this.scheduleNext(this.pollIntervalMs);
    }
  }

  public async processBatch(): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE application_migration_role`.execute(trx);
      
      const rows = await trx.selectFrom('outbox_events')
        .selectAll()
        .where('dispatched_at', 'is', null)
        .orderBy('created_at', 'asc')
        .limit(this.batchSize)
        .forUpdate()
        .skipLocked()
        .execute();
        
      if (rows.length === 0) return 0;
      
      for (const row of rows) {
        // Channel convention: location:{location_id}:events
        const channel = `location:${row.location_id}:events`;
        const message = JSON.stringify({
          id: row.id,
          aggregate_type: row.aggregate_type,
          aggregate_id: row.aggregate_id,
          event_type: row.event_type,
          payload: row.payload,
          schema_version: row.schema_version,
          created_at: row.created_at,
        });
        
        await this.redis.publish(channel, message);
      }
      
      const ids = rows.map(r => r.id);
      
      await trx.updateTable('outbox_events')
        .set({ dispatched_at: sql`now()` })
        .where('id', 'in', ids)
        .execute();
        
      return rows.length;
    });
  }
}
