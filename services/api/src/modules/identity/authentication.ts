import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { DatabaseTransaction } from '../../shared/index.js';
import { effectivePermissions, effectiveRoles, updateLastSeen } from './persistence/repository.js';
import { hashSecret, parseSessionToken } from './security.js';

export class IdentityHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export interface AuthenticatedSession {
  trx: DatabaseTransaction;
  sessionId: string;
  staffId: string;
  organizationId: string;
  locationId: string;
  terminalId: string;
  staff: { id: string; firstName: string; lastName: string; active: boolean; version: number };
  roles: Array<{ id: string; name: string; description: string | null }>;
  permissions: string[];
}

function bearerToken(request: FastifyRequest): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith('Bearer ') ? value.slice('Bearer '.length) : undefined;
}

export async function withAuthenticatedSession<T>(
  app: FastifyInstance,
  request: FastifyRequest,
  now: Date,
  idleWindowMs: number,
  work: (session: AuthenticatedSession) => Promise<T>,
): Promise<T> {
  const parsed = parseSessionToken(bearerToken(request));
  if (!parsed) throw new IdentityHttpError(401, 'UNAUTHENTICATED', 'A valid session token is required.');

  return app.withLocationTransaction(parsed.locationId, async (trx) => {
    const row = await trx
      .selectFrom('staff_sessions as ss')
      .innerJoin('staff as s', 's.id', 'ss.staff_id')
      .innerJoin('terminals as t', 't.id', 'ss.terminal_id')
      .select([
        'ss.id as session_id',
        'ss.staff_id',
        'ss.location_id',
        'ss.terminal_id',
        's.organization_id',
        's.first_name',
        's.last_name',
        's.active',
        's.version',
      ])
      .where('ss.token_hash', '=', hashSecret(parsed.token))
      .where('ss.revoked_at', 'is', null)
      .where('ss.expires_at', '>', now)
      .where('s.active', '=', true)
      .where('t.is_active', '=', true)
      .executeTakeFirst();
    if (!row) throw new IdentityHttpError(401, 'UNAUTHENTICATED', 'The session is invalid, expired, or revoked.');

    const [roles, permissions] = await Promise.all([
      effectiveRoles(trx, row.staff_id, row.organization_id),
      effectivePermissions(trx, row.staff_id, row.organization_id),
    ]);
    const expiresAt = new Date(now.getTime() + idleWindowMs);
    await updateLastSeen(trx, row.session_id, expiresAt);
    return work({
      trx,
      sessionId: row.session_id,
      staffId: row.staff_id,
      organizationId: row.organization_id,
      locationId: row.location_id,
      terminalId: row.terminal_id,
      staff: { id: row.staff_id, firstName: row.first_name, lastName: row.last_name, active: row.active, version: row.version },
      roles,
      permissions,
    });
  });
}

export function requirePermission(session: AuthenticatedSession, permission: string): void {
  if (!session.permissions.includes(permission)) {
    throw new IdentityHttpError(403, 'FORBIDDEN', `Missing required permission: ${permission}.`);
  }
}
