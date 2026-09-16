import type { DatabaseTransaction } from '../../../shared/index.js';

export const findVisit = (trx: DatabaseTransaction, locationId: string, id: string) =>
  trx
    .selectFrom('visits')
    .selectAll()
    .where('location_id', '=', locationId)
    .where('id', '=', id)
    .executeTakeFirst();
export const findOrder = (trx: DatabaseTransaction, locationId: string, id: string) =>
  trx
    .selectFrom('orders')
    .selectAll()
    .where('location_id', '=', locationId)
    .where('id', '=', id)
    .executeTakeFirst();
export const findLine = (trx: DatabaseTransaction, locationId: string, id: string) =>
  trx
    .selectFrom('order_lines')
    .selectAll()
    .where('location_id', '=', locationId)
    .where('id', '=', id)
    .executeTakeFirst();
export const findAccount = (trx: DatabaseTransaction, locationId: string, id: string) =>
  trx
    .selectFrom('accounts')
    .selectAll()
    .where('location_id', '=', locationId)
    .where('id', '=', id)
    .executeTakeFirst();
export const findPayment = (trx: DatabaseTransaction, locationId: string, id: string) =>
  trx
    .selectFrom('payments')
    .selectAll()
    .where('location_id', '=', locationId)
    .where('id', '=', id)
    .executeTakeFirst();
