import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';

import {
  IdentityHttpError,
  requirePermission,
  withAuthenticatedSession,
} from '../identity/index.js';
import { withGuestSession, GuestSessionHttpError } from '../guest-sessions/index.js';
import { withCustomerSession, CustomerSessionHttpError } from '../customers/index.js';
import type { DatabaseTransaction } from '../../shared/index.js';

const uuidSchema = { type: 'string', format: 'uuid' } as const;
const ifMatchHeader = {
  type: 'object',
  additionalProperties: true,
  properties: { 'if-match': { type: 'string', pattern: '^"?[1-9][0-9]*"?$' } },
} as const;

export interface LoyaltyRouteOptions {
  now?: () => Date;
  sessionIdleMs?: number;
}

function fail(reply: FastifyReply, request: FastifyRequest, error: IdentityHttpError | GuestSessionHttpError | CustomerSessionHttpError) {
  const headers = error instanceof IdentityHttpError ? error.headers : {};
  for (const [name, value] of Object.entries(headers ?? {})) reply.header(name, value);
  return reply.status(error.statusCode).send({
    error: {
      status: error.statusCode,
      code: error.code,
      message: error.message,
      request_id: request.id,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  });
}

function parseIfMatch(value: string | undefined): number {
  if (!value)
    throw new IdentityHttpError(
      428,
      'PRECONDITION_REQUIRED',
      'If-Match is required for this update.',
    );
  const parsed = Number(value.replaceAll('"', ''));
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new IdentityHttpError(
      400,
      'INVALID_IF_MATCH',
      'If-Match must contain a positive integer version.',
    );
  return parsed;
}

function conflict(row: { version: number }, state: unknown) {
  return new IdentityHttpError(
    409,
    'OPTIMISTIC_CONCURRENCY_CONFLICT',
    'Resource modified since last read.',
    { current_version: row.version, current_state: state },
  );
}

/**
 * `loyalty_accounts`/`loyalty_transactions`/`loyalty_redemptions`/`customers` all carry
 * organization-scoped RESTRICTIVE RLS, but staff and guest sessions only run inside a
 * location-scoped transaction (`app.current_location_id`) -- `app.current_organization_id`
 * is never set there, so every read against those tables silently returns nothing and every
 * write is rejected by the policy's WITH CHECK. `set_config` can be called more than once
 * within one transaction, so this sets the organization context on the SAME trx (preserving
 * atomicity with whatever location-scoped work happens in the same handler) rather than
 * opening a second, separately-committed transaction via withOrganizationTransaction.
 */
async function setOrganizationContext(trx: DatabaseTransaction, organizationId: string): Promise<void> {
  await sql`SELECT set_config('app.current_organization_id', ${organizationId}, true)`.execute(trx);
}

export const loyaltyRoute: FastifyPluginAsync<LoyaltyRouteOptions> = async (app, options) => {
  const now = options.now ?? (() => new Date());
  const sessionIdleMs = options.sessionIdleMs ?? 15 * 60 * 1000;

  const withStaffSession = <T>(
    request: FastifyRequest,
    work: Parameters<typeof withAuthenticatedSession<T>>[4],
  ) => withAuthenticatedSession(app, request, now(), sessionIdleMs, work);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof IdentityHttpError || error instanceof GuestSessionHttpError || error instanceof CustomerSessionHttpError) {
      return fail(reply, request, error);
    }
    if (
      typeof error === 'object' &&
      error !== null &&
      'validation' in error &&
      (error as { validation?: unknown }).validation
    )
      return reply.status(400).send({
        error: {
          status: 400,
          code: 'VALIDATION_ERROR',
          message: 'The request does not match the required schema.',
          request_id: request.id,
        },
      });
    request.log.error({ err: error }, 'loyalty request failed');
    return reply.status(500).send({
      error: {
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
        request_id: request.id,
      },
    });
  });

  app.get('/api/v1/loyalty-settings', async (request) =>
    withStaffSession(request, async (actor) => {
      requirePermission(actor, 'loyalty.settings.read');
      let settings = await actor.trx
        .selectFrom('loyalty_settings')
        .selectAll()
        .where('organization_id', '=', actor.organizationId)
        .executeTakeFirst();
      if (!settings) {
        settings = await actor.trx
          .insertInto('loyalty_settings')
          .values({ organization_id: actor.organizationId })
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      return settings;
    })
  );

  app.put('/api/v1/loyalty-settings', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['spend_amount_for_one_point'],
        properties: { spend_amount_for_one_point: { type: 'integer', minimum: 1 } },
      }
    }
  }, async (request) =>
    withStaffSession(request, async (actor) => {
      requirePermission(actor, 'loyalty.settings.write');
      const { spend_amount_for_one_point } = request.body as { spend_amount_for_one_point: number };
      const current = await actor.trx
        .selectFrom('loyalty_settings')
        .selectAll()
        .where('organization_id', '=', actor.organizationId)
        .executeTakeFirst();
      if (!current) {
        return actor.trx
          .insertInto('loyalty_settings')
          .values({ organization_id: actor.organizationId, spend_amount_for_one_point })
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      return actor.trx
        .updateTable('loyalty_settings')
        .set({ spend_amount_for_one_point, version: sql<number>`version + 1` })
        .where('organization_id', '=', actor.organizationId)
        .returningAll()
        .executeTakeFirstOrThrow();
    })
  );

  app.get('/api/v1/loyalty-rewards', async (request) =>
    withStaffSession(request, async (actor) => {
      requirePermission(actor, 'loyalty.rewards.read');
      return {
        data: await actor.trx
          .selectFrom('loyalty_rewards')
          .selectAll()
          .where('organization_id', '=', actor.organizationId)
          .execute()
      };
    })
  );

  app.post('/api/v1/loyalty-rewards', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'discount_type', 'discount_value'],
        properties: {
          name: { type: 'string', minLength: 1 },
          description: { type: ['string', 'null'] },
          cost_in_points: { type: ['integer', 'null'] },
          cost_in_visits: { type: ['integer', 'null'] },
          discount_type: { type: 'string', enum: ['PERCENTAGE', 'AMOUNT'] },
          discount_value: { type: 'integer', minimum: 1 },
        }
      }
    }
  }, async (request, reply) => {
    const res = await withStaffSession(request, async (actor) => {
      requirePermission(actor, 'loyalty.rewards.write');
      const body = request.body as {
        name: string, description?: string | null,
        cost_in_points?: number | null, cost_in_visits?: number | null,
        discount_type: 'PERCENTAGE' | 'AMOUNT', discount_value: number
      };
      if (body.cost_in_points == null && body.cost_in_visits == null) {
        throw new IdentityHttpError(400, 'VALIDATION_ERROR', 'Reward must cost points or visits.');
      }
      if (body.discount_type === 'PERCENTAGE' && body.discount_value > 100) {
        throw new IdentityHttpError(400, 'VALIDATION_ERROR', 'Percentage discount value cannot exceed 100.');
      }
      return actor.trx
        .insertInto('loyalty_rewards')
        .values({
          organization_id: actor.organizationId,
          name: body.name,
          description: body.description ?? null,
          cost_in_points: body.cost_in_points ?? null,
          cost_in_visits: body.cost_in_visits ?? null,
          discount_type: body.discount_type,
          discount_value: body.discount_value,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return reply.status(201).send(res);
  });

  app.put('/api/v1/loyalty-rewards/:id', {
    schema: {
      params: { type: 'object', properties: { id: uuidSchema }, required: ['id'] },
      headers: ifMatchHeader,
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1 },
          description: { type: ['string', 'null'] },
          cost_in_points: { type: ['integer', 'null'] },
          cost_in_visits: { type: ['integer', 'null'] },
          discount_type: { type: 'string', enum: ['PERCENTAGE', 'AMOUNT'] },
          discount_value: { type: 'integer', minimum: 1 },
          is_active: { type: 'boolean' }
        }
      }
    }
  }, async (request) =>
    withStaffSession(request, async (actor) => {
      requirePermission(actor, 'loyalty.rewards.write');
      const { id } = request.params as { id: string };
      const body = request.body as {
        name?: string, description?: string | null,
        cost_in_points?: number | null, cost_in_visits?: number | null,
        discount_type?: 'PERCENTAGE' | 'AMOUNT', discount_value?: number, is_active?: boolean
      };
      const expected = parseIfMatch(request.headers['if-match']);

      const current = await actor.trx.selectFrom('loyalty_rewards').selectAll().where('id', '=', id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
      if (!current) throw new IdentityHttpError(404, 'NOT_FOUND', 'Reward not found.');
      if (current.version !== expected) throw conflict(current, current);

      const updated = await actor.trx
        .updateTable('loyalty_rewards')
        .set({
          name: body.name ?? current.name,
          description: body.description !== undefined ? body.description : current.description,
          cost_in_points: body.cost_in_points !== undefined ? body.cost_in_points : current.cost_in_points,
          cost_in_visits: body.cost_in_visits !== undefined ? body.cost_in_visits : current.cost_in_visits,
          discount_type: body.discount_type ?? current.discount_type,
          discount_value: body.discount_value ?? current.discount_value,
          is_active: body.is_active ?? current.is_active,
          version: sql<number>`version + 1`
        })
        .where('id', '=', id)
        .where('version', '=', expected)
        .returningAll()
        .executeTakeFirst();
      
      if (!updated) throw conflict(current, current);
      return updated;
    })
  );

  app.get('/api/v1/loyalty-coupons', async (request) =>
    withStaffSession(request, async (actor) => {
      requirePermission(actor, 'loyalty.rewards.read');
      return {
        data: await actor.trx
          .selectFrom('loyalty_coupons')
          .selectAll()
          .where('organization_id', '=', actor.organizationId)
          .execute()
      };
    })
  );

  app.post('/api/v1/loyalty-coupons', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'discount_type', 'discount_value'],
        properties: {
          code: { type: 'string', minLength: 1 },
          discount_type: { type: 'string', enum: ['PERCENTAGE', 'AMOUNT'] },
          discount_value: { type: 'integer', minimum: 1 },
        }
      }
    }
  }, async (request, reply) => {
    const res = await withStaffSession(request, async (actor) => {
      requirePermission(actor, 'loyalty.rewards.write');
      const body = request.body as { code: string, discount_type: 'PERCENTAGE' | 'AMOUNT', discount_value: number };
      if (body.discount_type === 'PERCENTAGE' && body.discount_value > 100) {
        throw new IdentityHttpError(400, 'VALIDATION_ERROR', 'Percentage discount value cannot exceed 100.');
      }
      return actor.trx
        .insertInto('loyalty_coupons')
        .values({
          organization_id: actor.organizationId,
          code: body.code,
          discount_type: body.discount_type,
          discount_value: body.discount_value,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return reply.status(201).send(res);
  });

  app.put('/api/v1/loyalty-coupons/:id', {
    schema: {
      params: { type: 'object', properties: { id: uuidSchema }, required: ['id'] },
      headers: ifMatchHeader,
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          discount_type: { type: 'string', enum: ['PERCENTAGE', 'AMOUNT'] },
          discount_value: { type: 'integer', minimum: 1 },
          is_active: { type: 'boolean' }
        }
      }
    }
  }, async (request) =>
    withStaffSession(request, async (actor) => {
      requirePermission(actor, 'loyalty.rewards.write');
      const { id } = request.params as { id: string };
      const body = request.body as { discount_type?: 'PERCENTAGE' | 'AMOUNT', discount_value?: number, is_active?: boolean };
      const expected = parseIfMatch(request.headers['if-match']);

      const current = await actor.trx.selectFrom('loyalty_coupons').selectAll().where('id', '=', id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
      if (!current) throw new IdentityHttpError(404, 'NOT_FOUND', 'Coupon not found.');
      if (current.version !== expected) throw conflict(current, current);

      const updated = await actor.trx
        .updateTable('loyalty_coupons')
        .set({
          discount_type: body.discount_type ?? current.discount_type,
          discount_value: body.discount_value ?? current.discount_value,
          is_active: body.is_active ?? current.is_active,
          version: sql<number>`version + 1`
        })
        .where('id', '=', id)
        .where('version', '=', expected)
        .returningAll()
        .executeTakeFirst();

      if (!updated) throw conflict(current, current);
      return updated;
    })
  );

  app.get('/api/v1/customers/:customerId/loyalty', {
    schema: {
      params: { type: 'object', properties: { customerId: uuidSchema }, required: ['customerId'] }
    }
  }, async (request) =>
    withStaffSession(request, async (actor) => {
      requirePermission(actor, 'loyalty.accounts.read');
      await setOrganizationContext(actor.trx, actor.organizationId);
      const { customerId } = request.params as { customerId: string };
      let account = await actor.trx.selectFrom('loyalty_accounts').selectAll().where('customer_id', '=', customerId).where('organization_id', '=', actor.organizationId).executeTakeFirst();
      
      if (!account) {
        account = await actor.trx.insertInto('loyalty_accounts').values({
          organization_id: actor.organizationId,
          customer_id: customerId,
        }).returningAll().executeTakeFirstOrThrow();
      }

      const transactions = await actor.trx.selectFrom('loyalty_transactions').selectAll().where('loyalty_account_id', '=', account.id).orderBy('created_at', 'desc').execute();
      
      return { account, transactions };
    })
  );

  app.post('/api/v1/customers/:customerId/loyalty/adjust', {
    schema: {
      params: { type: 'object', properties: { customerId: uuidSchema }, required: ['customerId'] },
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['points_delta', 'reason'],
        properties: {
          points_delta: { type: 'integer' },
          reason: { type: 'string', minLength: 1 }
        }
      }
    }
  }, async (request) =>
    withStaffSession(request, async (actor) => {
      requirePermission(actor, 'loyalty.accounts.adjust');
      await setOrganizationContext(actor.trx, actor.organizationId);
      const { customerId } = request.params as { customerId: string };
      const { points_delta, reason } = request.body as { points_delta: number, reason: string };

      let account = await actor.trx.selectFrom('loyalty_accounts').selectAll().where('customer_id', '=', customerId).where('organization_id', '=', actor.organizationId).executeTakeFirst();
      if (!account) {
        account = await actor.trx.insertInto('loyalty_accounts').values({
          organization_id: actor.organizationId,
          customer_id: customerId,
        }).returningAll().executeTakeFirstOrThrow();
      }

      await actor.trx.updateTable('loyalty_accounts')
        .set({ points_balance: account.points_balance + points_delta, version: sql<number>`version + 1` })
        .where('id', '=', account.id)
        .execute();

      const transaction = await actor.trx.insertInto('loyalty_transactions')
        .values({
          organization_id: actor.organizationId,
          loyalty_account_id: account.id,
          transaction_type: 'ADJUSTMENT',
          points_delta,
          visit_count_delta: 0,
          reason
        })
        .returningAll()
        .executeTakeFirstOrThrow();
        
      return transaction;
    })
  );

  /**
   * Resolves a staff-or-guest caller for a specific visit and runs `work` INSIDE that
   * caller's own transaction callback. A `trx` handed back from withGuestSession/
   * withStaffSession after their callback returns is already a committed, dead
   * transaction (Kysely's transaction().execute() commits as soon as the callback
   * resolves) -- so `work` must be invoked from within the callback, not after it,
   * or every subsequent query throws "Transaction is already committed".
   */
  async function withVisitAuth<T>(
    request: FastifyRequest,
    locationId: string,
    visitId: string,
    work: (ctx: { trx: DatabaseTransaction; organizationId: string; staffId: string | null }) => Promise<T>,
  ): Promise<T> {
    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;

    // Staff tokens have no prefix at all (${locationId}.${secret}); customer and guest
    // tokens are prefixed with their kind. Branching on the real wire formats directly
    // (rather than importing each module's internal token parser) keeps this module
    // within the codebase's module-boundary convention -- other modules may only be
    // reached through their public index.ts, which doesn't export those parsers.
    if (token?.startsWith('guest.')) {
      return withGuestSession(app, request, now(), async (session) => {
        if (session.locationId !== locationId || session.visitId !== visitId) {
          throw new GuestSessionHttpError(403, 'GUEST_SCOPE_DENIED', 'Guest session does not match requested visit.');
        }
        await setOrganizationContext(session.trx, session.organizationId);
        return work({ trx: session.trx, organizationId: session.organizationId, staffId: null });
      });
    } else if (token) {
      return withStaffSession(request, async (actor) => {
        // Staff can do this on any visit in their location
        if (actor.locationId !== locationId) {
          throw new IdentityHttpError(403, 'LOCATION_SCOPE_DENIED', 'Session is not scoped to requested location.');
        }
        await setOrganizationContext(actor.trx, actor.organizationId);
        return work({ trx: actor.trx, organizationId: actor.organizationId, staffId: actor.staffId });
      });
    } else {
      throw new IdentityHttpError(401, 'UNAUTHENTICATED', 'Missing or invalid token.');
    }
  }

  app.post('/api/v1/locations/:locationId/visits/:visitId/attach-customer', {
    schema: {
      params: { type: 'object', properties: { locationId: uuidSchema, visitId: uuidSchema }, required: ['locationId', 'visitId'] },
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['phone'],
        properties: { phone: { type: 'string', minLength: 1 } }
      }
    }
  }, async (request, reply) => {
    const { locationId, visitId } = request.params as { locationId: string, visitId: string };
    const { phone } = request.body as { phone: string };

    const result = await withVisitAuth(request, locationId, visitId, async ({ trx, organizationId }) => {
      let customer = await trx.selectFrom('customers').selectAll().where('organization_id', '=', organizationId).where('phone', '=', phone).executeTakeFirst();

      if (!customer) {
        customer = await trx.insertInto('customers').values({
          organization_id: organizationId,
          email: `guest-${Date.now()}@example.com`, // Minimal skeleton requirement since email/password are NOT NULL
          password_hash: 'skeleton',
          name: 'Guest',
          phone
        }).returningAll().executeTakeFirstOrThrow();
      }

      const visit = await trx.selectFrom('visits').selectAll().where('id', '=', visitId).executeTakeFirst();
      if (!visit || visit.status !== 'OPEN') {
        throw new IdentityHttpError(409, 'VISIT_NOT_OPEN', 'Cannot attach to closed visit.');
      }

      await trx.updateTable('visits').set({ customer_id: customer.id, version: sql<number>`version + 1` }).where('id', '=', visitId).executeTakeFirstOrThrow();

      return { customer_id: customer.id };
    });

    return reply.status(200).send(result);
  });

  app.post('/api/v1/locations/:locationId/visits/:visitId/redeem-reward', {
    schema: {
      params: { type: 'object', properties: { locationId: uuidSchema, visitId: uuidSchema }, required: ['locationId', 'visitId'] },
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reward_id: { type: 'string', format: 'uuid' },
          order_line_id: { type: 'string', format: 'uuid' },
          coupon_code: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { locationId, visitId } = request.params as { locationId: string, visitId: string };
    const { reward_id, order_line_id, coupon_code } = request.body as { reward_id?: string, order_line_id?: string, coupon_code?: string };

    const result = await withVisitAuth(request, locationId, visitId, async ({ trx, organizationId, staffId }) => {
    const visit = await trx.selectFrom('visits').selectAll().where('id', '=', visitId).executeTakeFirst();
    if (!visit || visit.status !== 'OPEN') {
      throw new IdentityHttpError(409, 'VISIT_NOT_OPEN', 'Visit must be open.');
    }

    let loyalty_account_id: string | null = null;
    let discount_type: 'PERCENTAGE' | 'AMOUNT' | null = null;
    let discount_value: number | null = null;
    let reason: string | null = null;

    if (reward_id) {
      if (!visit.customer_id) {
        throw new IdentityHttpError(400, 'CUSTOMER_REQUIRED', 'A customer must be attached to the visit to redeem rewards.');
      }

      const reward = await trx.selectFrom('loyalty_rewards').selectAll().where('id', '=', reward_id).where('organization_id', '=', organizationId).where('is_active', '=', true).executeTakeFirst();
      if (!reward) throw new IdentityHttpError(404, 'NOT_FOUND', 'Reward not found or inactive.');

      let account = await trx.selectFrom('loyalty_accounts').selectAll().where('customer_id', '=', visit.customer_id).where('organization_id', '=', organizationId).executeTakeFirst();
      if (!account) {
        account = await trx.insertInto('loyalty_accounts').values({
          organization_id: organizationId,
          customer_id: visit.customer_id,
        }).returningAll().executeTakeFirstOrThrow();
      }

      if (reward.cost_in_points && account.points_balance < reward.cost_in_points) {
        throw new IdentityHttpError(409, 'INSUFFICIENT_FUNDS', 'Not enough points.');
      }
      if (reward.cost_in_visits && account.total_visits < reward.cost_in_visits) {
        throw new IdentityHttpError(409, 'INSUFFICIENT_FUNDS', 'Not enough visits.');
      }

      discount_type = reward.discount_type;
      discount_value = reward.discount_value;
      reason = `Reward: ${reward.name}`;
      loyalty_account_id = account.id;

      if (reward.cost_in_points) {
        await trx.updateTable('loyalty_accounts').set({ points_balance: account.points_balance - reward.cost_in_points, version: sql<number>`version + 1` }).where('id', '=', account.id).execute();
        await trx.insertInto('loyalty_transactions').values({
          organization_id: organizationId,
          loyalty_account_id: account.id,
          transaction_type: 'REDEMPTION',
          points_delta: -reward.cost_in_points,
          visit_count_delta: 0,
          reason,
          reference_visit_id: visitId
        }).execute();
      } else if (reward.cost_in_visits) {
        await trx.updateTable('loyalty_accounts').set({ total_visits: account.total_visits - reward.cost_in_visits, version: sql<number>`version + 1` }).where('id', '=', account.id).execute();
        await trx.insertInto('loyalty_transactions').values({
          organization_id: organizationId,
          loyalty_account_id: account.id,
          transaction_type: 'REDEMPTION',
          points_delta: 0,
          visit_count_delta: -reward.cost_in_visits,
          reason,
          reference_visit_id: visitId
        }).execute();
      }

      if (reward.discount_type === 'PERCENTAGE' && reward.discount_value === 100) {
        if (!order_line_id) throw new IdentityHttpError(400, 'VALIDATION_ERROR', 'order_line_id is required for a free item reward.');
      }
    } else if (coupon_code) {
      const coupon = await trx.selectFrom('loyalty_coupons').selectAll().where('code', '=', coupon_code).where('organization_id', '=', organizationId).where('is_active', '=', true).executeTakeFirst();
      if (!coupon) throw new IdentityHttpError(404, 'NOT_FOUND', 'Coupon not found or inactive.');

      discount_type = coupon.discount_type;
      discount_value = coupon.discount_value;
      reason = `Coupon: ${coupon.code}`;
    } else {
      throw new IdentityHttpError(400, 'VALIDATION_ERROR', 'Must provide reward_id or coupon_code.');
    }

    let targetSubtotal = 0;
    let targetAccount = null;

    if (order_line_id) {
      const line = await trx.selectFrom('order_lines').selectAll().where('id', '=', order_line_id).executeTakeFirst();
      if (!line) throw new IdentityHttpError(404, 'NOT_FOUND', 'Order line not found.');
      targetAccount = await trx.selectFrom('accounts').selectAll().where('id', '=', line.account_id).executeTakeFirstOrThrow();
      if (targetAccount.visit_id !== visitId) throw new IdentityHttpError(400, 'VALIDATION_ERROR', 'Order line does not belong to this visit.');
      targetSubtotal = line.unit_price * line.quantity;
    } else {
      const accounts = await trx.selectFrom('accounts').selectAll().where('visit_id', '=', visitId).where('status', 'in', ['OPEN', 'PARTIALLY_PAID']).execute();
      if (accounts.length === 0) throw new IdentityHttpError(409, 'ACCOUNT_NOT_OPEN', 'No open accounts found.');
      targetAccount = accounts[0];
      targetSubtotal = targetAccount.subtotal;
    }

    if (targetSubtotal < 1) throw new IdentityHttpError(409, 'DISCOUNT_TARGET_EMPTY', 'Target subtotal must be positive.');

    if (!discount_type || discount_value === null || !reason) throw new IdentityHttpError(500, 'INTERNAL_ERROR', 'Discount values missing');
    const computedAmount = discount_type === 'PERCENTAGE' ? Math.round(targetSubtotal * (discount_value / 100.0)) : discount_value;
    
    const newTotal = Math.max(0, targetAccount.total - computedAmount);
    
    await trx.updateTable('accounts').set({
      discount: targetAccount.discount + computedAmount,
      total: newTotal,
      version: sql<number>`version + 1`
    }).where('id', '=', targetAccount.id).execute();

    const discount = await trx.insertInto('account_discounts').values({
      location_id: locationId,
      account_id: targetAccount.id,
      order_line_id: order_line_id ?? null,
      discount_type,
      value: discount_value,
      computed_amount: computedAmount,
      reason,
      applied_by: staffId ?? null,
      is_override: false
    }).returningAll().executeTakeFirstOrThrow();

    await trx.insertInto('loyalty_redemptions').values({
      organization_id: organizationId,
      loyalty_account_id,
      reward_id: reward_id ?? null,
      coupon_id: coupon_code ? (await trx.selectFrom('loyalty_coupons').select('id').where('code', '=', coupon_code).executeTakeFirstOrThrow()).id : null,
      account_discount_id: discount.id
    }).execute();

      return { discount_id: discount.id };
    });

    return reply.status(200).send(result);
  });


  app.get('/api/v1/locations/:locationId/guest-sessions/current/loyalty', {
    schema: { params: { type: 'object', required: ['locationId'], properties: { locationId: { type: 'string', format: 'uuid' } } } }
  }, async (request, reply) => {
    return withGuestSession(app, request, now(), async (session) => {
      const visit = await session.trx.selectFrom('visits').selectAll().where('id', '=', session.visitId).executeTakeFirstOrThrow();
      await setOrganizationContext(session.trx, session.organizationId);

      const rewards = await session.trx.selectFrom('loyalty_rewards').selectAll().where('organization_id', '=', session.organizationId).where('is_active', '=', true).execute();

      if (!visit.customer_id) {
        return reply.send({ account: null, history: [], available_rewards: [] });
      }

      const account = await session.trx.selectFrom('loyalty_accounts').selectAll().where('customer_id', '=', visit.customer_id).where('organization_id', '=', session.organizationId).executeTakeFirst();
      if (!account) {
        return reply.send({ account: null, history: [], available_rewards: [] });
      }

      const history = await session.trx.selectFrom('loyalty_transactions').selectAll().where('loyalty_account_id', '=', account.id).orderBy('created_at', 'desc').execute();
      const available_rewards = rewards.filter(r => (r.cost_in_points != null && account.points_balance >= r.cost_in_points) || (r.cost_in_visits != null && account.total_visits >= r.cost_in_visits));
      return reply.send({ account, history, available_rewards });
    });
  });

  app.get('/api/v1/customers/me/loyalty', async (request) =>
    withCustomerSession(app, request, now(), async (session) => {
      let account = await session.trx.selectFrom('loyalty_accounts').selectAll().where('customer_id', '=', session.customerId).where('organization_id', '=', session.organizationId).executeTakeFirst();
      if (!account) {
        account = { id: '', organization_id: session.organizationId, customer_id: session.customerId, points_balance: 0, total_visits: 0, version: 1, created_at: now(), updated_at: now() };
      }

      const rewards = await session.trx.selectFrom('loyalty_rewards').selectAll().where('organization_id', '=', session.organizationId).where('is_active', '=', true).execute();
      const available_rewards = rewards.filter(r => (r.cost_in_points != null && account.points_balance >= r.cost_in_points) || (r.cost_in_visits != null && account.total_visits >= r.cost_in_visits));

      return {
        points_balance: account.points_balance,
        total_visits: account.total_visits,
        available_rewards
      };
    })
  );

  app.get('/api/v1/customers/me/loyalty/history', async (request) =>
    withCustomerSession(app, request, now(), async (session) => {
      const account = await session.trx.selectFrom('loyalty_accounts').selectAll().where('customer_id', '=', session.customerId).where('organization_id', '=', session.organizationId).executeTakeFirst();
      if (!account) return { data: [] };

      const transactions = await session.trx.selectFrom('loyalty_transactions').selectAll().where('loyalty_account_id', '=', account.id).orderBy('created_at', 'desc').execute();
      return { data: transactions };
    })
  );
};
