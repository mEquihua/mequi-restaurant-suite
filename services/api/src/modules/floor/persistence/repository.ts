import type { DatabaseTransaction } from '../../../shared/index.js';

export async function findLocationArea(trx: DatabaseTransaction, locationId: string, areaId: string) {
  return trx.selectFrom('areas').selectAll().where('id', '=', areaId).where('location_id', '=', locationId).executeTakeFirst();
}

export async function findLocationTable(trx: DatabaseTransaction, locationId: string, tableId: string) {
  return trx.selectFrom('tables').selectAll().where('id', '=', tableId).where('location_id', '=', locationId).executeTakeFirst();
}

export async function findLocationSection(trx: DatabaseTransaction, locationId: string, sectionId: string) {
  return trx.selectFrom('sections').selectAll().where('id', '=', sectionId).where('location_id', '=', locationId).executeTakeFirst();
}
