import type { DatabaseTransaction } from '../../../shared/index.js';

export const findGuestOrder = (trx: DatabaseTransaction, visitId: string) =>
  trx.selectFrom('orders').selectAll().where('visit_id', '=', visitId).where('status', 'in', ['DRAFT', 'HELD', 'SENT']).orderBy('created_at').executeTakeFirst();

export const findGuestAccount = (trx: DatabaseTransaction, visitId: string) =>
  trx.selectFrom('accounts').selectAll().where('visit_id', '=', visitId).where('status', 'in', ['OPEN', 'PARTIALLY_PAID']).orderBy('created_at').executeTakeFirst();
