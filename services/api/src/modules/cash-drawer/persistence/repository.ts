import type { DatabaseTransaction } from '../../../shared/index.js';
import { sql } from 'kysely';

export const findSession = (trx: DatabaseTransaction, locationId: string, id: string) =>
  trx
    .selectFrom('cash_drawer_sessions')
    .selectAll()
    .where('location_id', '=', locationId)
    .where('id', '=', id)
    .executeTakeFirst();

export const getOpenSessionForTerminal = (trx: DatabaseTransaction, locationId: string, terminalId: string) =>
  trx
    .selectFrom('cash_drawer_sessions')
    .selectAll()
    .where('location_id', '=', locationId)
    .where('terminal_id', '=', terminalId)
    .where('status', '=', 'OPEN')
    .executeTakeFirst();

export const sumCashPayments = async (
  trx: DatabaseTransaction,
  locationId: string,
  since: Date,
) => {
  const row = await trx
    .selectFrom('payments')
    .select(sql<number>`coalesce(sum(amount), 0)::integer`.as('total'))
    .where('location_id', '=', locationId)
    .where('method', '=', 'CASH')
    .where('created_at', '>=', since)
    .executeTakeFirstOrThrow();
  return row.total;
};

export const sumMovements = async (
  trx: DatabaseTransaction,
  locationId: string,
  sessionId: string,
  movementType: 'CASH_IN' | 'CASH_OUT',
) => {
  const row = await trx
    .selectFrom('cash_drawer_movements')
    .select(sql<number>`coalesce(sum(amount), 0)::integer`.as('total'))
    .where('location_id', '=', locationId)
    .where('drawer_session_id', '=', sessionId)
    .where('movement_type', '=', movementType)
    .executeTakeFirstOrThrow();
  return row.total;
};
