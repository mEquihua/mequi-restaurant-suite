import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { DatabaseTransaction } from '../../shared/index.js';
import { hashGuestSecret, parseGuestSessionToken } from './security.js';

export class GuestSessionHttpError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

export interface GuestSession {
  trx: DatabaseTransaction;
  sessionId: string;
  locationId: string;
  visitId: string;
  tableId: string | null;
  organizationId: string;
  expiresAt: Date;
}

function bearerToken(request: FastifyRequest): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith('Bearer ') ? value.slice('Bearer '.length) : undefined;
}

/** Dedicated guest guard. A staff-shaped token is rejected before any database lookup. */
export async function withGuestSession<T>(app: FastifyInstance, request: FastifyRequest, now: Date, work: (session: GuestSession) => Promise<T>): Promise<T> {
  const parsed = parseGuestSessionToken(bearerToken(request));
  if (!parsed) throw new GuestSessionHttpError(401, 'UNAUTHENTICATED', 'A valid guest session token is required.');
  return app.withLocationTransaction(parsed.locationId, async (trx) => {
    const row = await trx
      .selectFrom('guest_sessions as gs')
      .innerJoin('locations as l', 'l.id', 'gs.location_id')
      .select(['gs.id', 'gs.location_id', 'gs.visit_id', 'gs.table_id', 'gs.expires_at', 'l.organization_id'])
      .where('gs.token_hash', '=', hashGuestSecret(parsed.token))
      .where('gs.revoked_at', 'is', null)
      .where('gs.expires_at', '>', now)
      .executeTakeFirst();
    if (!row) throw new GuestSessionHttpError(401, 'UNAUTHENTICATED', 'The guest session is invalid, expired, or revoked.');
    return work({ trx, sessionId: row.id, locationId: row.location_id, visitId: row.visit_id, tableId: row.table_id, organizationId: row.organization_id, expiresAt: row.expires_at });
  });
}
