import type { DatabaseTransaction } from '../../../shared/index.js';

export async function findOrganizationProduct(trx: DatabaseTransaction, organizationId: string, productId: string) {
  return trx.selectFrom('products').selectAll().where('id', '=', productId).where('organization_id', '=', organizationId).executeTakeFirst();
}

export async function findOrganizationCategory(trx: DatabaseTransaction, organizationId: string, categoryId: string) {
  return trx.selectFrom('categories').selectAll().where('id', '=', categoryId).where('organization_id', '=', organizationId).executeTakeFirst();
}

export async function findOrganizationModifierGroup(trx: DatabaseTransaction, organizationId: string, modifierGroupId: string) {
  return trx.selectFrom('modifier_groups').selectAll().where('id', '=', modifierGroupId).where('organization_id', '=', organizationId).executeTakeFirst();
}

export async function assertLocationInOrganization(trx: DatabaseTransaction, organizationId: string, locationId: string) {
  return trx.selectFrom('locations').select('id').where('id', '=', locationId).where('organization_id', '=', organizationId).executeTakeFirst();
}
