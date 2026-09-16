import { sql, type Selectable } from 'kysely';

import type {
  DatabaseTransaction,
  RoleTable,
  StaffTable,
  TerminalPinAttemptTable,
  TerminalTable,
} from '../../../shared/index.js';

export type StaffRecord = Selectable<StaffTable>;
export type TerminalRecord = Selectable<TerminalTable>;

export async function findTerminal(trx: DatabaseTransaction, terminalId: string): Promise<TerminalRecord | undefined> {
  return trx.selectFrom('terminals').selectAll().where('id', '=', terminalId).executeTakeFirst();
}

export async function findStaff(trx: DatabaseTransaction, staffId: string): Promise<StaffRecord | undefined> {
  return trx.selectFrom('staff').selectAll().where('id', '=', staffId).executeTakeFirst();
}

export async function effectivePermissions(trx: DatabaseTransaction, staffId: string, organizationId: string): Promise<string[]> {
  const rows = await trx
    .selectFrom('staff_roles as sr')
    .innerJoin('roles as r', 'r.id', 'sr.role_id')
    .innerJoin('role_permissions as rp', 'rp.role_id', 'r.id')
    .select('rp.permission_name')
    .where('sr.staff_id', '=', staffId)
    .where('r.organization_id', '=', organizationId)
    .distinct()
    .execute();
  return rows.map((row) => row.permission_name);
}

export async function effectiveRoles(trx: DatabaseTransaction, staffId: string, organizationId: string): Promise<Pick<Selectable<RoleTable>, 'id' | 'name' | 'description'>[]> {
  return trx
    .selectFrom('staff_roles as sr')
    .innerJoin('roles as r', 'r.id', 'sr.role_id')
    .select(['r.id', 'r.name', 'r.description'])
    .where('sr.staff_id', '=', staffId)
    .where('r.organization_id', '=', organizationId)
    .distinct()
    .execute();
}

export async function lockPinAttempt(
  trx: DatabaseTransaction,
  terminalId: string,
  credentialFingerprint: string,
): Promise<Selectable<TerminalPinAttemptTable>> {
  await trx
    .insertInto('terminal_pin_attempts')
    .values({ terminal_id: terminalId, credential_fingerprint: credentialFingerprint })
    .onConflict((oc) => oc.columns(['terminal_id', 'credential_fingerprint']).doNothing())
    .execute();
  const attempt = await trx
    .selectFrom('terminal_pin_attempts')
    .selectAll()
    .where('terminal_id', '=', terminalId)
    .where('credential_fingerprint', '=', credentialFingerprint)
    .forUpdate()
    .executeTakeFirst();
  if (!attempt) throw new Error('PIN attempt state was not created');
  return attempt;
}

export async function resetPinAttempt(trx: DatabaseTransaction, terminalId: string, credentialFingerprint: string): Promise<void> {
  await trx
    .updateTable('terminal_pin_attempts')
    .set({ failure_count: 0, next_attempt_at: null })
    .where('terminal_id', '=', terminalId)
    .where('credential_fingerprint', '=', credentialFingerprint)
    .execute();
}

export async function recordFailedPinAttempt(
  trx: DatabaseTransaction,
  terminalId: string,
  credentialFingerprint: string,
  failureCount: number,
  nextAttemptAt: Date,
): Promise<void> {
  await trx
    .updateTable('terminal_pin_attempts')
    .set({ failure_count: failureCount, next_attempt_at: nextAttemptAt })
    .where('terminal_id', '=', terminalId)
    .where('credential_fingerprint', '=', credentialFingerprint)
    .execute();
}

export async function updateLastSeen(trx: DatabaseTransaction, sessionId: string, expiresAt: Date): Promise<void> {
  await trx
    .updateTable('staff_sessions')
    .set({ last_seen_at: sql`NOW()`, expires_at: expiresAt })
    .where('id', '=', sessionId)
    .execute();
}
