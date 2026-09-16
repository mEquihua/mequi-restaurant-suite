import { sql } from 'kysely';

import { createDatabase } from '../../shared/index.js';
import { SYSTEM_ROLE_TEMPLATES } from './security.js';

const organizationId = process.env.ORGANIZATION_ID;
if (!organizationId) throw new Error('ORGANIZATION_ID is required to seed identity role templates.');

const db = createDatabase();
try {
  await db.transaction().execute(async (trx) => {
    await sql`SET LOCAL ROLE application_runtime_role`.execute(trx);
    for (const template of SYSTEM_ROLE_TEMPLATES) {
      let role = await trx.selectFrom('roles').select('id').where('organization_id', '=', organizationId).where('name', '=', template.name).executeTakeFirst();
      if (role) {
        await trx.updateTable('roles').set({ description: template.description, is_system_template: true }).where('id', '=', role.id).execute();
      } else {
        role = await trx
          .insertInto('roles')
          .values({ organization_id: organizationId, name: template.name, description: template.description, is_system_template: true })
          .returning('id')
          .executeTakeFirstOrThrow();
      }
      await trx.deleteFrom('role_permissions').where('role_id', '=', role.id).execute();
      await trx.insertInto('role_permissions').values(template.permissions.map((permission_name) => ({ role_id: role.id, permission_name, scope: 'organization' }))).execute();
    }
  });
} finally {
  await db.destroy();
}
