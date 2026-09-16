import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseTransaction } from '../../shared/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CustomerSessionHttpError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

export interface CustomerSession {
  trx: DatabaseTransaction;
  sessionId: string;
  organizationId: string;
  customerId: string;
  expiresAt: Date;
}

export function createCustomerSessionToken(organizationId: string): string {
  return `customer.${organizationId}.${randomBytes(32).toString('base64url')}`;
}

export function parseCustomerSessionToken(value: string | undefined): { organizationId: string; token: string } | undefined {
  if (!value) return undefined;
  const [kind, organizationId, secret, ...rest] = value.split('.');
  if (kind !== 'customer' || !organizationId || !secret || rest.length > 0 || !UUID.test(organizationId) || secret.length < 32) return undefined;
  return { organizationId, token: value };
}

export function hashCustomerSecret(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function bearerToken(request: FastifyRequest): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith('Bearer ') ? value.slice('Bearer '.length) : undefined;
}

export async function withCustomerSession<T>(app: FastifyInstance, request: FastifyRequest, now: Date, work: (session: CustomerSession) => Promise<T>): Promise<T> {
  const parsed = parseCustomerSessionToken(bearerToken(request));
  if (!parsed) throw new CustomerSessionHttpError(401, 'UNAUTHENTICATED', 'A valid customer session token is required.');
  
  return app.withOrganizationTransaction(parsed.organizationId, async (trx) => {
    const row = await trx
      .selectFrom('customer_sessions as cs')
      .select(['cs.id', 'cs.organization_id', 'cs.customer_id', 'cs.expires_at'])
      .where('cs.token_hash', '=', hashCustomerSecret(parsed.token))
      .where('cs.revoked_at', 'is', null)
      .where('cs.expires_at', '>', now)
      .executeTakeFirst();
      
    if (!row) throw new CustomerSessionHttpError(401, 'UNAUTHENTICATED', 'The customer session is invalid, expired, or revoked.');
    
    return work({ trx, sessionId: row.id, organizationId: row.organization_id, customerId: row.customer_id, expiresAt: row.expires_at });
  });
}
