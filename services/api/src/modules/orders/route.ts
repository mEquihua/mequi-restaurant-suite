import { createHash } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';

import {
  IdentityHttpError,
  requirePermission,
  withAuthenticatedSession,
  lockPinAttempt,
  recordFailedPinAttempt,
  resetPinAttempt,
  findStaff,
  verifyPin,
  fingerprintPresentedCredential,
  retryAfterSeconds,
  nextFailedPinAttempt,
  DUMMY_PIN_HASH,
} from '../identity/index.js';
import { addOrderLines } from './commands.js';
import {
  resolveAvailability as rawResolveAvailability,
  type AvailabilityRuleInput,
} from '../menu/index.js';
import {
  findAccount,
  findLine,
  findOrder,
  findPayment,
  findVisit,
} from './persistence/repository.js';
import {
  canTransitionLineStatus,
  computeDiscountAmount,
  lineAmount,
  splitEqually,
  type LineStatus,
} from './state.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const ifMatch = {
  type: 'object',
  additionalProperties: true,
  required: ['if-match'],
  properties: { 'if-match': { type: 'string', pattern: '^"?[1-9][0-9]*"?$' } },
} as const;
const idempotency = {
  type: 'object',
  additionalProperties: true,
  required: ['idempotency-key'],
  properties: { 'idempotency-key': { type: 'string', minLength: 1, maxLength: 255 } },
} as const;
const locationParams = {
  type: 'object',
  additionalProperties: false,
  required: ['locationId'],
  properties: { locationId: uuid },
} as const;
const addLinesSchema = {
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['locationId', 'orderId'],
    properties: { locationId: uuid, orderId: uuid },
  },
  headers: ifMatch,
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['lines'],
    properties: {
      lines: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['account_id', 'product_id', 'quantity'],
          properties: {
            account_id: uuid,
            product_id: uuid,
            variant_id: uuid,
            modifier_ids: { type: 'array', uniqueItems: true, items: uuid },
            seat_number: { type: ['integer', 'null'] },
            course_name: { type: ['string', 'null'], maxLength: 120 },
            quantity: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
  },
} as const;
export interface OrdersRouteOptions {
  now?: () => Date;
  sessionIdleMs?: number;
}
type Actor = Parameters<typeof requirePermission>[0];
type LineBody = {
  account_id: string;
  product_id: string;
  variant_id?: string;
  modifier_ids?: string[];
  seat_number?: number | null;
  course_name?: string | null;
  quantity: number;
};
const jsonHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const availabilityInput = (
  rules: Array<{
    status: string;
    channel_scope: string | null;
    service_type_scope: string | null;
    days_of_week: number[] | null;
    start_time: Date | null;
    end_time: Date | null;
  }>,
) => rules as AvailabilityRuleInput[];
const resolveAvailability = (
  rules: Array<{
    status: string;
    channel_scope: string | null;
    service_type_scope: string | null;
    days_of_week: number[] | null;
    start_time: Date | null;
    end_time: Date | null;
  }>,
  context: Parameters<typeof rawResolveAvailability>[1],
) => rawResolveAvailability(availabilityInput(rules), context);
const expected = (value: string | undefined) => {
  if (!value)
    throw new IdentityHttpError(
      428,
      'PRECONDITION_REQUIRED',
      'If-Match is required for this update.',
    );
  const n = Number(value.replaceAll('"', ''));
  if (!Number.isInteger(n) || n < 1)
    throw new IdentityHttpError(
      400,
      'INVALID_IF_MATCH',
      'If-Match must contain a positive integer version.',
    );
  return n;
};
const fail = (reply: FastifyReply, request: FastifyRequest, error: IdentityHttpError) => {
  for (const [name, value] of Object.entries(error.headers ?? {})) reply.header(name, value);
  return reply.status(error.statusCode).send({
    error: {
      status: error.statusCode,
      code: error.code,
      message: error.message,
      request_id: request.id,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  });
};
const conflict = (row: { version: number }, state: unknown) =>
  new IdentityHttpError(
    409,
    'OPTIMISTIC_CONCURRENCY_CONFLICT',
    'Resource modified since last read.',
    { current_version: row.version, current_state: state },
  );
const requireLocation = (actor: Actor, locationId: string) => {
  if (actor.locationId !== locationId)
    throw new IdentityHttpError(
      403,
      'LOCATION_SCOPE_DENIED',
      'The session is not scoped to the requested location.',
    );
};
const terminalLine = (status: string) => ['FULFILLED', 'VOIDED', 'CANCELLED'].includes(status);
// A 20% reduction is a routine hospitality adjustment; anything larger needs manager authorization.
const ROUTINE_DISCOUNT_MAX_PERCENT = 20;
type DiscountBody = {
  discount_type: 'PERCENTAGE' | 'AMOUNT';
  value: number;
  order_line_id?: string;
  reason: string;
  authorized_by?: string;
  authorized_by_pin?: string;
};

/** Private HTTP implementation for orders, visits, accounts, and payments. */
export const ordersRoute: FastifyPluginAsync<OrdersRouteOptions> = async (app, options) => {
  const now = options.now ?? (() => new Date());
  const idle = options.sessionIdleMs ?? 15 * 60 * 1000;
  const withSession = <T>(request: FastifyRequest, work: (actor: Actor) => Promise<T>) =>
    withAuthenticatedSession(app, request, now(), idle, work);
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof IdentityHttpError) return fail(reply, request, error);
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
    request.log.error({ err: error }, 'orders request failed');
    return reply.status(500).send({
      error: {
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
        request_id: request.id,
      },
    });
  });
  const scoped = (request: FastifyRequest, actor: Actor) => {
    const locationId = (request.params as { locationId: string }).locationId;
    requireLocation(actor, locationId);
    return locationId;
  };
  const outbox = async (actor: Actor, aggregateId: string, eventType: string, payload: unknown) => {
    const line = await actor.trx
      .selectFrom('order_lines as ol')
      .innerJoin('orders as o', 'o.id', 'ol.order_id')
      .select('o.visit_id')
      .where('ol.id', '=', aggregateId)
      .executeTakeFirst();
    return actor.trx
      .insertInto('outbox_events')
      .values({
        location_id: actor.locationId,
        aggregate_type: 'order_line',
        aggregate_id: aggregateId,
        event_type: eventType,
        payload: {
          ...(payload as Record<string, unknown>),
          ...(line ? { visit_id: line.visit_id } : {}),
        } as never,
        schema_version: 1,
      })
      .execute();
  };
  const audit = (
    actor: Actor,
    request: FastifyRequest,
    action: string,
    aggregateId: string,
    before: number,
    after: number,
    reason: string,
  ) =>
    actor.trx
      .insertInto('audit_events')
      .values({
        location_id: actor.locationId,
        actor_id: actor.staffId,
        terminal_id: actor.terminalId,
        action,
        aggregate_type: 'order_line',
        aggregate_id: aggregateId,
        before_version: before,
        after_version: after,
        reason,
        request_id: request.id,
      })
      .execute();
  async function updateAccountTotal(actor: Actor, accountId: string, delta: number) {
    const account = await findAccount(actor.trx, actor.locationId, accountId);
    if (!account)
      throw new IdentityHttpError(
        400,
        'INVALID_ACCOUNT',
        'Account was not found in this location.',
      );
    const total = account.total + delta;
    if (total < 0)
      throw new IdentityHttpError(
        409,
        'ACCOUNT_TOTAL_UNDERFLOW',
        'The account total cannot become negative.',
      );
    return actor.trx
      .updateTable('accounts')
      .set({ subtotal: account.subtotal + delta, total, version: sql<number>`version + 1` })
      .where('id', '=', accountId)
      .where('version', '=', account.version)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  async function idempotent(
    actor: Actor,
    command: string,
    key: string,
    payload: unknown,
    work: () => Promise<unknown>,
  ) {
    const hash = jsonHash(payload);
    const cached = await actor.trx
      .selectFrom('command_idempotency')
      .selectAll()
      .where('location_id', '=', actor.locationId)
      .where('command', '=', command)
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
    if (cached) {
      if (cached.payload_hash !== hash)
        throw new IdentityHttpError(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key was already used with a different payload.',
        );
      return cached.response;
    }
    const response = await work();
    await actor.trx
      .insertInto('command_idempotency')
      .values({
        location_id: actor.locationId,
        command,
        idempotency_key: key,
        payload_hash: hash,
        response: response as never,
      })
      .execute();
    return response;
  }

  async function enforceReauth(
    actor: Actor,
    authorizedBy: string | undefined,
    pin: string | undefined,
  ) {
    if (!authorizedBy)
      throw new IdentityHttpError(
        400,
        'MANAGER_AUTHORIZATION_REQUIRED',
        'authorized_by is required for an override.',
      );
    if (authorizedBy === actor.staffId) return;

    if (!pin)
      throw new IdentityHttpError(
        400,
        'VALIDATION_ERROR',
        'authorized_by_pin is required when authorizing as a different manager.',
      );

    const fingerprint = fingerprintPresentedCredential(authorizedBy);
    const outcome = await app.withLocationTransaction(actor.locationId, async (authTrx) => {
      const attempt = await lockPinAttempt(authTrx, actor.terminalId, fingerprint);
      const timestamp = now();
      const retryAfter = retryAfterSeconds(
        { failureCount: attempt.failure_count, nextAttemptAt: attempt.next_attempt_at },
        timestamp,
      );

      if (retryAfter !== undefined) {
        return { kind: 'backoff' as const, retryAfter };
      }

      const [staff, location] = await Promise.all([
        findStaff(authTrx, authorizedBy),
        authTrx
          .selectFrom('locations')
          .select(['organization_id'])
          .where('id', '=', actor.locationId)
          .executeTakeFirst(),
      ]);
      const pinMatches = await verifyPin(staff?.pin_hash ?? DUMMY_PIN_HASH, pin);
      if (
        !staff ||
        !location ||
        !staff.active ||
        staff.organization_id !== location.organization_id ||
        !pinMatches
      ) {
        const next = nextFailedPinAttempt(
          { failureCount: attempt.failure_count, nextAttemptAt: attempt.next_attempt_at },
          timestamp,
        );
        await recordFailedPinAttempt(
          authTrx,
          actor.terminalId,
          fingerprint,
          next.failureCount,
          next.nextAttemptAt!,
        );
        const seconds = retryAfterSeconds(next, timestamp)!;
        return { kind: 'invalid-pin' as const, retryAfter: seconds };
      }

      await resetPinAttempt(authTrx, actor.terminalId, fingerprint);
      return { kind: 'success' as const };
    });

    if (outcome.kind === 'backoff') {
      throw new IdentityHttpError(
        429,
        'PIN_BACKOFF_ACTIVE',
        'PIN verification is temporarily delayed for this terminal and credential.',
        { retry_after_seconds: outcome.retryAfter },
        { 'Retry-After': String(outcome.retryAfter) },
      );
    }
    if (outcome.kind === 'invalid-pin') {
      throw new IdentityHttpError(
        401,
        'AUTHORIZER_PIN_INVALID',
        'The authorizer PIN is invalid.',
        undefined,
        { 'Retry-After': String(outcome.retryAfter) },
      );
    }
  }

  async function lineTransition(
    actor: Actor,
    request: FastifyRequest,
    lineId: string,
    to: LineStatus,
    permission: string,
    override = false,
    reason?: string,
    authorizedBy?: string,
    authorizedByPin?: string,
  ) {
    requirePermission(actor, permission);
    const before = await findLine(actor.trx, actor.locationId, lineId);
    if (!before) throw new IdentityHttpError(404, 'NOT_FOUND', 'Order line was not found.');
    const version = expected(request.headers['if-match']);
    if (before.version !== version) throw conflict(before, before);
    if (!canTransitionLineStatus(before.status as LineStatus, to))
      throw new IdentityHttpError(
        409,
        'ILLEGAL_ORDER_LINE_STATUS_TRANSITION',
        `Cannot transition order line from ${before.status} to ${to}.`,
      );
    if (override) {
      await enforceReauth(actor, authorizedBy, authorizedByPin);
    }
    const updated = await actor.trx
      .updateTable('order_lines')
      .set({ status: to, version: sql<number>`version + 1` })
      .where('id', '=', lineId)
      .where('version', '=', version)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw conflict(before, before);
    if (to === 'VOIDED') {
      await actor.trx
        .insertInto('cancellations_and_voids')
        .values({
          location_id: actor.locationId,
          order_line_id: lineId,
          operation_type: 'VOID',
          amount: lineAmount(before),
          reason: reason ?? 'Void',
          authorized_by: authorizedBy ?? actor.staffId,
        })
        .execute();
      await updateAccountTotal(actor, before.account_id, -lineAmount(before));
    }
    await outbox(actor, lineId, `order_line.${to.toLowerCase()}`, {
      line_id: lineId,
      order_id: before.order_id,
      status: to,
    });
    if (override)
      await audit(
        actor,
        request,
        'orders.lines.void_override',
        lineId,
        before.version,
        updated.version,
        `${reason ?? 'Void override'}; authorized_by=${authorizedBy}`,
      );
    return updated;
  }

  async function applyDiscount(request: FastifyRequest, actor: Actor, override: boolean) {
    requirePermission(
      actor,
      override ? 'accounts.discounts.apply_override' : 'accounts.discounts.apply',
    );
    scoped(request, actor);
    const accountId = (request.params as { accountId: string }).accountId;
    const body = request.body as DiscountBody;
    const account = await findAccount(actor.trx, actor.locationId, accountId);
    if (!account) throw new IdentityHttpError(404, 'NOT_FOUND', 'Account was not found.');
    const version = expected(request.headers['if-match']);
    if (version !== account.version) throw conflict(account, account);
    if (!['OPEN', 'PARTIALLY_PAID'].includes(account.status))
      throw new IdentityHttpError(
        409,
        'ACCOUNT_NOT_OPEN',
        'Discounts require an open or partially paid account.',
      );
    if (override) {
      await enforceReauth(actor, body.authorized_by, body.authorized_by_pin);
    }

    let line = undefined;
    let targetSubtotal = account.subtotal;
    if (body.order_line_id) {
      line = await findLine(actor.trx, actor.locationId, body.order_line_id);
      if (!line || line.account_id !== account.id)
        throw new IdentityHttpError(
          400,
          'INVALID_ORDER_LINE_FOR_ACCOUNT',
          'order_line_id must belong to this account in this location.',
        );
      if (terminalLine(line.status))
        throw new IdentityHttpError(
          409,
          'ORDER_LINE_NOT_DISCOUNTABLE',
          'Discounts cannot be applied to a terminal order line.',
        );
      targetSubtotal = lineAmount(line);
    }
    if (targetSubtotal < 1)
      throw new IdentityHttpError(
        409,
        'DISCOUNT_TARGET_EMPTY',
        'A discount requires a positive target subtotal.',
      );
    let computedAmount: number;
    try {
      computedAmount = computeDiscountAmount({
        targetSubtotal,
        discountType: body.discount_type,
        value: body.value,
      });
    } catch (error) {
      throw new IdentityHttpError(
        400,
        'INVALID_DISCOUNT',
        error instanceof Error ? error.message : 'Invalid discount.',
      );
    }
    const requestedPercent =
      body.discount_type === 'PERCENTAGE' ? body.value : (body.value * 100) / targetSubtotal;
    if (!override && requestedPercent > ROUTINE_DISCOUNT_MAX_PERCENT)
      throw new IdentityHttpError(
        409,
        'DISCOUNT_OVERRIDE_REQUIRED',
        `Discounts above ${ROUTINE_DISCOUNT_MAX_PERCENT}% of the target subtotal require the override endpoint.`,
      );
    const total = account.total - computedAmount;
    if (total < 0)
      throw new IdentityHttpError(
        409,
        'ACCOUNT_TOTAL_UNDERFLOW',
        'The account total cannot become negative.',
      );
    const updated = await actor.trx
      .updateTable('accounts')
      .set({
        discount: account.discount + computedAmount,
        total,
        version: sql<number>`version + 1`,
      })
      .where('id', '=', accountId)
      .where('version', '=', version)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw conflict(account, account);
    const discount = await actor.trx
      .insertInto('account_discounts')
      .values({
        location_id: actor.locationId,
        account_id: account.id,
        order_line_id: line?.id ?? null,
        discount_type: body.discount_type,
        value: body.value,
        computed_amount: computedAmount,
        reason: body.reason,
        applied_by: actor.staffId,
        is_override: override,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    if (override)
      await audit(
        actor,
        request,
        'accounts.discounts.apply_override',
        account.id,
        account.version,
        updated.version,
        `${body.reason}; authorized_by=${body.authorized_by}`,
      );
    return { account: updated, discount };
  }

  app.post(
    '/api/v1/locations/:locationId/visits',
    {
      schema: {
        params: locationParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { table_id: uuid, guest_count: { type: 'integer', minimum: 1 } },
        },
      },
    },
    async (request, reply) => {
      const visit = await withSession(request, async (actor) => {
        requirePermission(actor, 'orders.visits.create');
        const locationId = scoped(request, actor);
        const body = request.body as { table_id?: string; guest_count?: number };
        if (body.table_id) {
          const table = await actor.trx
            .selectFrom('tables')
            .selectAll()
            .where('id', '=', body.table_id)
            .where('location_id', '=', locationId)
            .executeTakeFirst();
          if (!table)
            throw new IdentityHttpError(
              400,
              'INVALID_TABLE',
              'Table does not belong to this location.',
            );
          if (table.status !== 'AVAILABLE')
            throw new IdentityHttpError(409, 'TABLE_NOT_AVAILABLE', 'Table is not available.');
          const updatedTable = await actor.trx
            .updateTable('tables')
            .set({ status: 'OCCUPIED', version: sql<number>`version + 1` })
            .where('id', '=', body.table_id)
            .where('version', '=', table.version)
            .executeTakeFirst();
          if (!updatedTable) throw conflict(table, table);
        }
        return actor.trx
          .insertInto('visits')
          .values({
            location_id: locationId,
            table_id: body.table_id ?? null,
            staff_id: actor.staffId,
            guest_count: body.guest_count ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      });
      // Sent only after withSession's wrapped transaction has committed (see
      // withLocationTransaction), so a client that immediately re-reads table
      // state after this 201 always observes the OCCUPIED transition. Do not
      // call reply.send() from inside the transaction callback for this
      // handler, since that races the commit (confirmed by direct testing).
      return reply.status(201).send(visit);
    },
  );
  app.post(
    '/api/v1/locations/:locationId/visits/:visitId/orders',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId', 'visitId'],
          properties: { locationId: uuid, visitId: uuid },
        },
        headers: ifMatch,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['order_type'],
          properties: {
            order_type: {
              type: 'string',
              enum: ['DINE_IN', 'TAKEOUT', 'PICKUP', 'DELIVERY', 'TABLE_SELF_ORDER'],
            },
          },
        },
      },
    },
    async (request, reply) => {
      const order = await withSession(request, async (actor) => {
        requirePermission(actor, 'orders.orders.create');
        const locationId = scoped(request, actor);
        const visitId = (request.params as { visitId: string }).visitId;
        const visit = await findVisit(actor.trx, locationId, visitId);
        if (!visit) throw new IdentityHttpError(404, 'NOT_FOUND', 'Visit was not found.');
        if (visit.status !== 'OPEN')
          throw new IdentityHttpError(
            409,
            'VISIT_NOT_OPEN',
            'Orders can only be created for an open visit.',
          );
        const v = expected(request.headers['if-match']);
        if (v !== visit.version) throw conflict(visit, visit);
        const order = await actor.trx
          .insertInto('orders')
          .values({
            location_id: locationId,
            visit_id: visitId,
            order_type: (request.body as { order_type: string }).order_type,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await actor.trx
          .updateTable('visits')
          .set({ version: sql<number>`version + 1` })
          .where('id', '=', visitId)
          .where('version', '=', v)
          .executeTakeFirst();
        return order;
      });
      return reply.status(201).send(order);
    },
  );
  app.post(
    '/api/v1/locations/:locationId/visits/:visitId/accounts',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId', 'visitId'],
          properties: { locationId: uuid, visitId: uuid },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { name: { type: 'string', maxLength: 160 } },
        },
      },
    },
    async (request, reply) => {
      const account = await withSession(request, async (actor) => {
        requirePermission(actor, 'accounts.accounts.create');
        const locationId = scoped(request, actor);
        const visitId = (request.params as { visitId: string }).visitId;
        const visit = await findVisit(actor.trx, locationId, visitId);
        if (!visit || visit.status !== 'OPEN')
          throw new IdentityHttpError(404, 'NOT_FOUND', 'Open visit was not found.');
        return actor.trx
          .insertInto('accounts')
          .values({
            location_id: locationId,
            visit_id: visitId,
            name: (request.body as { name?: string }).name?.trim() ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      });
      return reply.status(201).send(account);
    },
  );
  app.post(
    '/api/v1/locations/:locationId/orders/:orderId/lines',
    { schema: addLinesSchema },
    async (request, reply) => {
      const result = await withSession(request, async (actor) => {
        requirePermission(actor, 'orders.lines.add');
        scoped(request, actor);
        const orderId = (request.params as { orderId: string }).orderId;
        const v = expected(request.headers['if-match']);
        const lines = (request.body as { lines: LineBody[] }).lines;
        const result = await addOrderLines(actor.trx, {
          locationId: actor.locationId,
          organizationId: actor.organizationId,
          orderId,
          expectedVersion: v,
          lines,
        });
        return result;
      });
      return reply.status(201).send(result);
    },
  );
  app.post(
    '/api/v1/locations/:locationId/order-lines/:lineId/hold',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId', 'lineId'],
          properties: { locationId: uuid, lineId: uuid },
        },
        headers: ifMatch,
        body: { type: 'object', additionalProperties: false },
      },
    },
    async (request) =>
      withSession(request, async (actor) => {
        scoped(request, actor);
        const lineId = (request.params as { lineId: string }).lineId;
        const updated = await lineTransition(actor, request, lineId, 'HELD', 'orders.lines.hold');
        const order = await findOrder(actor.trx, actor.locationId, updated.order_id);
        const lines = await actor.trx
          .selectFrom('order_lines')
          .select('status')
          .where('order_id', '=', updated.order_id)
          .execute();
        if (order && order.status === 'DRAFT' && lines.every((line) => line.status === 'HELD'))
          await actor.trx
            .updateTable('orders')
            .set({ status: 'HELD', version: sql<number>`version + 1` })
            .where('id', '=', order.id)
            .execute();
        return updated;
      }),
  );
  app.post(
    '/api/v1/locations/:locationId/orders/:orderId/send',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId', 'orderId'],
          properties: { locationId: uuid, orderId: uuid },
        },
        headers: { allOf: [ifMatch, idempotency] },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['line_ids'],
          properties: { line_ids: { type: 'array', minItems: 1, uniqueItems: true, items: uuid } },
        },
      },
    },
    async (request) =>
      withSession(request, async (actor) => {
        requirePermission(actor, 'orders.lines.send');
        scoped(request, actor);
        const orderId = (request.params as { orderId: string }).orderId;
        const body = request.body as { line_ids: string[] };
        const key = String(request.headers['idempotency-key']);
        return idempotent(actor, `orders.send:${orderId}`, key, body, async () => {
          const order = await findOrder(actor.trx, actor.locationId, orderId);
          if (!order) throw new IdentityHttpError(404, 'NOT_FOUND', 'Order was not found.');
          const v = expected(request.headers['if-match']);
          if (v !== order.version) throw conflict(order, order);
          const lines = await actor.trx
            .selectFrom('order_lines')
            .selectAll()
            .where('order_id', '=', orderId)
            .where('id', 'in', body.line_ids)
            .execute();
          if (
            lines.length !== body.line_ids.length ||
            lines.some((line) => !['DRAFT', 'HELD'].includes(line.status))
          )
            throw new IdentityHttpError(
              409,
              'ILLEGAL_ORDER_LINE_STATUS_TRANSITION',
              'Only draft or held lines can be sent.',
            );
          for (const line of lines) {
            const rules = await actor.trx
              .selectFrom('availability_rules')
              .selectAll()
              .where('location_id', '=', actor.locationId)
              .where('product_id', '=', line.product_id)
              .execute();
            if (
              !resolveAvailability(rules, {
                now: now(),
                channel: order.order_type,
                serviceType: order.order_type,
              }).available
            )
              throw new IdentityHttpError(
                409,
                'PRODUCT_UNAVAILABLE',
                'A selected product became unavailable before send.',
              );
            const sent = await actor.trx
              .updateTable('order_lines')
              .set({ status: 'SENT', version: sql<number>`version + 1` })
              .where('id', '=', line.id)
              .where('version', '=', line.version)
              .returningAll()
              .executeTakeFirst();
            if (!sent) throw conflict(line, line);

            const lineModifiers = await actor.trx
              .selectFrom('order_line_modifiers')
              .select('modifier_id')
              .where('order_line_id', '=', line.id)
              .execute();
            const modifierIds = lineModifiers.map(m => m.modifier_id);

            const recipeLines = await actor.trx
              .selectFrom('recipe_lines')
              .selectAll()
              .where((eb) => {
                const conditions = [
                  eb.and([
                    eb('product_id', '=', line.product_id),
                    eb('modifier_id', 'is', null),
                    line.variant_id 
                      ? eb.or([eb('variant_id', '=', line.variant_id), eb('variant_id', 'is', null)]) 
                      : eb('variant_id', 'is', null)
                  ])
                ];
                if (modifierIds.length > 0) {
                  conditions.push(eb('modifier_id', 'in', modifierIds));
                }
                return eb.or(conditions);
              })
              .execute();

            const consumptionByIngredient = new Map<string, number>();
            for (const r of recipeLines) {
              const qtyPerUnit = parseFloat(r.quantity_per_unit);
              const totalQty = qtyPerUnit * line.quantity;
              consumptionByIngredient.set(
                r.ingredient_id, 
                (consumptionByIngredient.get(r.ingredient_id) || 0) + totalQty
              );
            }

            for (const [ingredientId, consumedQty] of consumptionByIngredient.entries()) {
               await actor.trx
                 .updateTable('ingredient_stock')
                 .set({
                    quantity_on_hand: sql<string>`quantity_on_hand - ${consumedQty}`,
                    version: sql<number>`version + 1`
                 })
                 .where('ingredient_id', '=', ingredientId)
                 .where('location_id', '=', actor.locationId)
                 .execute();
            }
            await outbox(actor, line.id, 'order_line.sent', {
              line_id: line.id,
              order_id: orderId,
              status: 'SENT',
              round_line_ids: body.line_ids,
            });
          }
          const updatedOrder = await actor.trx
            .updateTable('orders')
            .set({ status: 'SENT', version: sql<number>`version + 1` })
            .where('id', '=', orderId)
            .where('version', '=', v)
            .returningAll()
            .executeTakeFirst();
          if (!updatedOrder) throw conflict(order, order);
          return { order: updatedOrder, line_ids: body.line_ids };
        });
      }),
  );
  for (const [suffix, to] of [
    ['mark-preparing', 'PREPARING'],
    ['mark-ready', 'READY'],
    ['mark-fulfilled', 'FULFILLED'],
  ] as const)
    app.post(
      `/api/v1/locations/:locationId/order-lines/:lineId/${suffix}`,
      {
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['locationId', 'lineId'],
            properties: { locationId: uuid, lineId: uuid },
          },
          headers: ifMatch,
          body: { type: 'object', additionalProperties: false },
        },
      },
      async (request) =>
        withSession(request, async (actor) => {
          scoped(request, actor);
          return lineTransition(
            actor,
            request,
            (request.params as { lineId: string }).lineId,
            to,
            'kitchen.tickets.update_status',
          );
        }),
    );
  app.post(
    '/api/v1/locations/:locationId/order-lines/:lineId/void',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId', 'lineId'],
          properties: { locationId: uuid, lineId: uuid },
        },
        headers: ifMatch,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['reason'],
          properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } },
        },
      },
    },
    async (request) =>
      withSession(request, async (actor) => {
        scoped(request, actor);
        const before = await findLine(
          actor.trx,
          actor.locationId,
          (request.params as { lineId: string }).lineId,
        );
        if (!before || !['DRAFT', 'HELD', 'SENT'].includes(before.status))
          throw new IdentityHttpError(
            409,
            'ROUTINE_VOID_NOT_ALLOWED',
            'Routine void is allowed only before preparation.',
          );
        return lineTransition(
          actor,
          request,
          before.id,
          'VOIDED',
          'orders.lines.void',
          false,
          (request.body as { reason: string }).reason,
        );
      }),
  );
  app.post(
    '/api/v1/locations/:locationId/order-lines/:lineId/void-override',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId', 'lineId'],
          properties: { locationId: uuid, lineId: uuid },
        },
        headers: ifMatch,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['reason', 'authorized_by'],
          properties: {
            reason: { type: 'string', minLength: 1, maxLength: 500 },
            authorized_by: uuid,
            authorized_by_pin: { type: 'string', minLength: 4, maxLength: 12 },
          },
        },
      },
    },
    async (request) =>
      withSession(request, async (actor) => {
        scoped(request, actor);
        const body = request.body as {
          reason: string;
          authorized_by: string;
          authorized_by_pin?: string;
        };
        const before = await findLine(
          actor.trx,
          actor.locationId,
          (request.params as { lineId: string }).lineId,
        );
        if (!before || !['PREPARING', 'READY', 'FULFILLED'].includes(before.status))
          throw new IdentityHttpError(
            409,
            'OVERRIDE_VOID_NOT_ALLOWED',
            'Override void is required only after preparation begins.',
          );
        return lineTransition(
          actor,
          request,
          before.id,
          'VOIDED',
          'orders.lines.void_override',
          true,
          body.reason,
          body.authorized_by,
          body.authorized_by_pin,
        );
      }),
  );
  async function cancelOrder(request: FastifyRequest, actor: Actor, override: boolean) {
    requirePermission(actor, override ? 'orders.orders.cancel_override' : 'orders.orders.cancel');
    scoped(request, actor);
    const orderId = (request.params as { orderId: string }).orderId;
    const order = await findOrder(actor.trx, actor.locationId, orderId);
    if (!order) throw new IdentityHttpError(404, 'NOT_FOUND', 'Order was not found.');
    const v = expected(request.headers['if-match']);
    if (v !== order.version) throw conflict(order, order);
    const body = request.body as {
      reason: string;
      authorized_by?: string;
      authorized_by_pin?: string;
    };
    const lines = await actor.trx
      .selectFrom('order_lines')
      .selectAll()
      .where('order_id', '=', orderId)
      .execute();
    if (
      !override &&
      lines.some((line) => ['SENT', 'PREPARING', 'READY', 'FULFILLED'].includes(line.status))
    )
      throw new IdentityHttpError(
        409,
        'ROUTINE_CANCEL_NOT_ALLOWED',
        'Routine cancellation is legal only before any line is sent.',
      );
    if (override) {
      await enforceReauth(actor, body.authorized_by, body.authorized_by_pin);
    }
    for (const line of lines.filter((line) => !terminalLine(line.status))) {
      const postPrep = ['PREPARING', 'READY', 'FULFILLED'].includes(line.status);
      const status = postPrep ? 'VOIDED' : 'CANCELLED';
      const changed = await actor.trx
        .updateTable('order_lines')
        .set({ status, version: sql<number>`version + 1` })
        .where('id', '=', line.id)
        .where('version', '=', line.version)
        .returningAll()
        .executeTakeFirstOrThrow();
      await actor.trx
        .insertInto('cancellations_and_voids')
        .values({
          location_id: actor.locationId,
          order_line_id: line.id,
          operation_type: postPrep ? 'VOID' : 'CANCEL',
          amount: lineAmount(line),
          reason: body.reason,
          authorized_by: body.authorized_by ?? actor.staffId,
        })
        .execute();
      await updateAccountTotal(actor, line.account_id, -lineAmount(line));
      if (['SENT', 'PREPARING', 'READY', 'FULFILLED'].includes(line.status))
        await outbox(actor, line.id, 'order_line.cancelled', {
          line_id: line.id,
          status,
          order_id: orderId,
        });
      void changed;
    }
    const updated = await actor.trx
      .updateTable('orders')
      .set({ status: 'CANCELLED', version: sql<number>`version + 1` })
      .where('id', '=', orderId)
      .where('version', '=', v)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw conflict(order, order);
    if (override)
      await audit(
        actor,
        request,
        'orders.orders.cancel_override',
        orderId,
        order.version,
        updated.version,
        `${body.reason}; authorized_by=${body.authorized_by}`,
      );
    return updated;
  }
  const cancelSchema = (override: boolean) => ({
    params: {
      type: 'object',
      additionalProperties: false,
      required: ['locationId', 'orderId'],
      properties: { locationId: uuid, orderId: uuid },
    },
    headers: ifMatch,
    body: {
      type: 'object',
      additionalProperties: false,
      required: override ? ['reason', 'authorized_by'] : ['reason'],
      properties: {
        reason: { type: 'string', minLength: 1, maxLength: 500 },
        authorized_by: uuid,
        authorized_by_pin: { type: 'string', minLength: 4, maxLength: 12 },
      },
    },
  });
  app.post(
    '/api/v1/locations/:locationId/orders/:orderId/cancel',
    { schema: cancelSchema(false) },
    async (request) => withSession(request, (actor) => cancelOrder(request, actor, false)),
  );
  app.post(
    '/api/v1/locations/:locationId/orders/:orderId/cancel-override',
    { schema: cancelSchema(true) },
    async (request) => withSession(request, (actor) => cancelOrder(request, actor, true)),
  );
  app.post(
    '/api/v1/locations/:locationId/orders/:orderId/transfer-lines',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId', 'orderId'],
          properties: { locationId: uuid, orderId: uuid },
        },
        headers: ifMatch,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['line_ids'],
          properties: {
            line_ids: { type: 'array', minItems: 1, uniqueItems: true, items: uuid },
            target_order_id: uuid,
            target_account_id: uuid,
          },
        },
      },
    },
    async (request) =>
      withSession(request, async (actor) => {
        requirePermission(actor, 'orders.visits.transfer');
        scoped(request, actor);
        const orderId = (request.params as { orderId: string }).orderId;
        const body = request.body as {
          line_ids: string[];
          target_order_id?: string;
          target_account_id?: string;
        };
        if (!body.target_order_id && !body.target_account_id)
          throw new IdentityHttpError(
            400,
            'VALIDATION_ERROR',
            'A target order or account is required.',
          );
        const order = await findOrder(actor.trx, actor.locationId, orderId);
        if (!order) throw new IdentityHttpError(404, 'NOT_FOUND', 'Order was not found.');
        const v = expected(request.headers['if-match']);
        if (v !== order.version) throw conflict(order, order);
        let targetOrder = undefined;
        if (body.target_order_id) {
          targetOrder = await findOrder(actor.trx, actor.locationId, body.target_order_id);
          if (!targetOrder || targetOrder.visit_id !== order.visit_id)
            throw new IdentityHttpError(
              400,
              'INVALID_TARGET_ORDER',
              'Target order must belong to the same visit.',
            );
        }
        let targetAccount = undefined;
        if (body.target_account_id) {
          targetAccount = await findAccount(actor.trx, actor.locationId, body.target_account_id);
          if (!targetAccount || targetAccount.visit_id !== order.visit_id)
            throw new IdentityHttpError(
              400,
              'INVALID_ACCOUNT_FOR_VISIT',
              'Target account must belong to the same visit.',
            );
        }
        const lines = await actor.trx
          .selectFrom('order_lines')
          .selectAll()
          .where('order_id', '=', orderId)
          .where('id', 'in', body.line_ids)
          .execute();
        if (
          lines.length !== body.line_ids.length ||
          lines.some((line) => terminalLine(line.status))
        )
          throw new IdentityHttpError(
            409,
            'LINE_TRANSFER_NOT_ALLOWED',
            'Only non-terminal lines may be transferred.',
          );
        for (const line of lines) {
          if (targetAccount && line.account_id !== targetAccount.id) {
            await updateAccountTotal(actor, line.account_id, -lineAmount(line));
            await updateAccountTotal(actor, targetAccount.id, lineAmount(line));
          }
          await actor.trx
            .updateTable('order_lines')
            .set({
              ...(targetOrder ? { order_id: targetOrder.id } : {}),
              ...(targetAccount ? { account_id: targetAccount.id } : {}),
              version: sql<number>`version + 1`,
            })
            .where('id', '=', line.id)
            .execute();
        }
        const updated = await actor.trx
          .updateTable('orders')
          .set({ version: sql<number>`version + 1` })
          .where('id', '=', orderId)
          .where('version', '=', v)
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw conflict(order, order);
        return { order: updated, line_ids: body.line_ids };
      }),
  );
  const discountSchema = (override: boolean) => ({
    params: {
      type: 'object',
      additionalProperties: false,
      required: ['locationId', 'accountId'],
      properties: { locationId: uuid, accountId: uuid },
    },
    headers: ifMatch,
    body: {
      type: 'object',
      additionalProperties: false,
      required: override
        ? ['discount_type', 'value', 'reason', 'authorized_by']
        : ['discount_type', 'value', 'reason'],
      properties: {
        discount_type: { type: 'string', enum: ['PERCENTAGE', 'AMOUNT'] },
        value: { type: 'integer', minimum: 1 },
        order_line_id: uuid,
        reason: { type: 'string', minLength: 1, maxLength: 500 },
        authorized_by: uuid,
        authorized_by_pin: { type: 'string', minLength: 4, maxLength: 12 },
      },
    },
  });
  app.post(
    '/api/v1/locations/:locationId/accounts/:accountId/discounts',
    { schema: discountSchema(false) },
    async (request, reply) => {
      const discount = await withSession(request, (actor) => applyDiscount(request, actor, false));
      return reply.status(201).send(discount);
    },
  );
  app.post(
    '/api/v1/locations/:locationId/accounts/:accountId/discounts/override',
    { schema: discountSchema(true) },
    async (request, reply) => {
      const discount = await withSession(request, (actor) => applyDiscount(request, actor, true));
      return reply.status(201).send(discount);
    },
  );
  app.post(
    '/api/v1/locations/:locationId/accounts/:accountId/split',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId', 'accountId'],
          properties: { locationId: uuid, accountId: uuid },
        },
        headers: ifMatch,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['method'],
          properties: {
            method: { type: 'string', enum: ['BY_SEAT', 'BY_ITEM', 'EQUALLY'] },
            order_line_ids: { type: 'array', minItems: 1, uniqueItems: true, items: uuid },
            count: { type: 'integer', minimum: 2 },
          },
        },
      },
    },
    async (request, reply) => {
      const split = await withSession(request, async (actor) => {
        requirePermission(actor, 'accounts.accounts.split');
        scoped(request, actor);
        const accountId = (request.params as { accountId: string }).accountId;
        const account = await findAccount(actor.trx, actor.locationId, accountId);
        if (!account) throw new IdentityHttpError(404, 'NOT_FOUND', 'Account was not found.');
        const v = expected(request.headers['if-match']);
        if (v !== account.version) throw conflict(account, account);
        if (!['OPEN', 'PARTIALLY_PAID'].includes(account.status))
          throw new IdentityHttpError(409, 'ACCOUNT_NOT_OPEN', 'Only open accounts can be split.');
        const body = request.body as {
          method: 'BY_SEAT' | 'BY_ITEM' | 'EQUALLY';
          order_line_ids?: string[];
          count?: number;
        };
        const lines = await actor.trx
          .selectFrom('order_lines')
          .selectAll()
          .where('account_id', '=', accountId)
          .execute();
        const siblings = [];
        if (body.method === 'BY_SEAT') {
          const seats = [
            ...new Set(
              lines.map((line) => line.seat_number).filter((seat): seat is number => seat !== null),
            ),
          ];
          for (const seat of seats) {
            const move = lines.filter((line) => line.seat_number === seat);
            const total = move.reduce((sum, line) => sum + lineAmount(line), 0);
            const sibling = await actor.trx
              .insertInto('accounts')
              .values({
                location_id: actor.locationId,
                visit_id: account.visit_id,
                name: `Seat ${seat}`,
                subtotal: total,
                total,
              })
              .returningAll()
              .executeTakeFirstOrThrow();
            await actor.trx
              .updateTable('order_lines')
              .set({ account_id: sibling.id, version: sql<number>`version + 1` })
              .where('account_id', '=', accountId)
              .where('seat_number', '=', seat)
              .execute();
            siblings.push(sibling);
          }
          const moved = siblings.reduce((sum, sibling) => sum + sibling.total, 0);
          await actor.trx
            .updateTable('accounts')
            .set({
              subtotal: account.subtotal - moved,
              total: account.total - moved,
              version: sql<number>`version + 1`,
            })
            .where('id', '=', accountId)
            .where('version', '=', v)
            .executeTakeFirstOrThrow();
        } else if (body.method === 'BY_ITEM') {
          const ids = body.order_line_ids ?? [];
          const move = lines.filter((line) => ids.includes(line.id));
          if (move.length !== ids.length)
            throw new IdentityHttpError(
              400,
              'INVALID_ORDER_LINES',
              'Every line must belong to the source account.',
            );
          const total = move.reduce((sum, line) => sum + lineAmount(line), 0);
          const sibling = await actor.trx
            .insertInto('accounts')
            .values({
              location_id: actor.locationId,
              visit_id: account.visit_id,
              subtotal: total,
              total,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await actor.trx
            .updateTable('order_lines')
            .set({ account_id: sibling.id, version: sql<number>`version + 1` })
            .where('id', 'in', ids)
            .execute();
          await actor.trx
            .updateTable('accounts')
            .set({
              subtotal: account.subtotal - total,
              total: account.total - total,
              version: sql<number>`version + 1`,
            })
            .where('id', '=', accountId)
            .where('version', '=', v)
            .executeTakeFirstOrThrow();
          siblings.push(sibling);
        } else {
          if (!body.count)
            throw new IdentityHttpError(
              400,
              'VALIDATION_ERROR',
              'count is required for an equal split.',
            );
          const amounts = splitEqually(account.total, body.count);
          for (const [index, amount] of amounts.entries())
            siblings.push(
              await actor.trx
                .insertInto('accounts')
                .values({
                  location_id: actor.locationId,
                  visit_id: account.visit_id,
                  name: `Split ${index + 1}`,
                  subtotal: amount,
                  total: amount,
                })
                .returningAll()
                .executeTakeFirstOrThrow(),
            );
          await actor.trx
            .updateTable('accounts')
            .set({ subtotal: 0, tax: 0, discount: 0, total: 0, version: sql<number>`version + 1` })
            .where('id', '=', accountId)
            .where('version', '=', v)
            .executeTakeFirstOrThrow();
        }
        return { source_account_id: accountId, accounts: siblings };
      });
      return reply.status(201).send(split);
    },
  );
  app.post(
    '/api/v1/locations/:locationId/accounts/:accountId/reopen',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId', 'accountId'],
          properties: { locationId: uuid, accountId: uuid },
        },
        headers: ifMatch,
        body: { type: 'object', additionalProperties: false },
      },
    },
    async (request) =>
      withSession(request, async (actor) => {
        requirePermission(actor, 'accounts.accounts.reopen');
        scoped(request, actor);
        const id = (request.params as { accountId: string }).accountId;
        const account = await findAccount(actor.trx, actor.locationId, id);
        if (!account) throw new IdentityHttpError(404, 'NOT_FOUND', 'Account was not found.');
        const v = expected(request.headers['if-match']);
        if (v !== account.version) throw conflict(account, account);
        if (!['PAID', 'CLOSED'].includes(account.status))
          throw new IdentityHttpError(
            409,
            'ILLEGAL_ACCOUNT_STATUS_TRANSITION',
            'Only paid or closed accounts can be reopened.',
          );
        const paid = await actor.trx
          .selectFrom('payments')
          .select(sql<number>`coalesce(sum(amount), 0)`.as('total'))
          .where('account_id', '=', id)
          .executeTakeFirstOrThrow();
        return actor.trx
          .updateTable('accounts')
          .set({ status: 'OPEN', paid_amount: paid.total, version: sql<number>`version + 1` })
          .where('id', '=', id)
          .where('version', '=', v)
          .returningAll()
          .executeTakeFirstOrThrow();
      }),
  );
  app.post(
    '/api/v1/locations/:locationId/accounts/:accountId/payments',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId', 'accountId'],
          properties: { locationId: uuid, accountId: uuid },
        },
        headers: { allOf: [ifMatch, idempotency] },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['method', 'amount'],
          properties: {
            method: { type: 'string', enum: ['CASH', 'CARD', 'TRANSFER', 'OTHER'] },
            amount: { type: 'integer', minimum: 1 },
            tip_amount: { type: 'integer', minimum: 0 },
            reference_code: { type: 'string', maxLength: 255 },
          },
        },
      },
    },
    async (request, reply) => {
      const response = await withSession(request, async (actor) => {
        requirePermission(actor, 'payments.payments.create');
        scoped(request, actor);
        const accountId = (request.params as { accountId: string }).accountId;
        const body = request.body as {
          method: string;
          amount: number;
          tip_amount?: number;
          reference_code?: string;
        };
        const key = String(request.headers['idempotency-key']);
        const response = await idempotent(
          actor,
          `accounts.payment:${accountId}`,
          key,
          body,
          async () => {
            const account = await findAccount(actor.trx, actor.locationId, accountId);
            if (!account) throw new IdentityHttpError(404, 'NOT_FOUND', 'Account was not found.');
            const v = expected(request.headers['if-match']);
            if (v !== account.version) throw conflict(account, account);
            if (!['OPEN', 'PARTIALLY_PAID'].includes(account.status))
              throw new IdentityHttpError(
                409,
                'ACCOUNT_NOT_OPEN',
                'Payments require an open account.',
              );
            const paid = account.paid_amount + body.amount;
            const status = paid >= account.total ? 'PAID' : 'PARTIALLY_PAID';
            const payment = await actor.trx
              .insertInto('payments')
              .values({
                location_id: actor.locationId,
                account_id: accountId,
                method: body.method,
                amount: body.amount,
                tip_amount: body.tip_amount ?? 0,
                status: 'COMPLETED',
                reference_code: body.reference_code ?? null,
                idempotency_key: key,
              })
              .returningAll()
              .executeTakeFirstOrThrow();
            const updated = await actor.trx
              .updateTable('accounts')
              .set({ paid_amount: paid, status, version: sql<number>`version + 1` })
              .where('id', '=', accountId)
              .where('version', '=', v)
              .returningAll()
              .executeTakeFirst();
            if (!updated) throw conflict(account, account);
            return { payment, account: updated };
          },
        );
        return response;
      });
      return reply.status(201).send(response);
    },
  );
  app.post(
    '/api/v1/locations/:locationId/payments/:paymentId/refund',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId', 'paymentId'],
          properties: { locationId: uuid, paymentId: uuid },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['reason'],
          properties: {
            reason: { type: 'string', minLength: 1, maxLength: 500 },
            amount: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const refund = await withSession(request, async (actor) => {
        requirePermission(actor, 'payments.refunds.create');
        scoped(request, actor);
        const payment = await findPayment(
          actor.trx,
          actor.locationId,
          (request.params as { paymentId: string }).paymentId,
        );
        if (!payment || payment.status !== 'COMPLETED')
          throw new IdentityHttpError(404, 'NOT_FOUND', 'Completed payment was not found.');
        const body = request.body as { reason: string; amount?: number };
        const already = await actor.trx
          .selectFrom('refunds')
          .select(sql<number>`coalesce(sum(amount), 0)`.as('total'))
          .where('payment_id', '=', payment.id)
          .executeTakeFirstOrThrow();
        const amount = body.amount ?? payment.amount - already.total;
        if (amount <= 0 || amount > payment.amount - already.total)
          throw new IdentityHttpError(
            409,
            'INVALID_REFUND_AMOUNT',
            'Refund amount exceeds the remaining payment amount.',
          );
        const refund = await actor.trx
          .insertInto('refunds')
          .values({
            location_id: actor.locationId,
            payment_id: payment.id,
            amount,
            reason: body.reason,
            authorized_by: actor.staffId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const account = await findAccount(actor.trx, actor.locationId, payment.account_id);
        if (account) {
          const paid = account.paid_amount - amount;
          await actor.trx
            .updateTable('accounts')
            .set({
              paid_amount: paid,
              status: paid === 0 ? 'REFUNDED' : paid >= account.total ? 'PAID' : 'PARTIALLY_PAID',
              version: sql<number>`version + 1`,
            })
            .where('id', '=', account.id)
            .execute();
        }
        await audit(
          actor,
          request,
          'payments.refunds.create',
          payment.id,
          payment.version,
          payment.version,
          body.reason,
        );
        return refund;
      });
      return reply.status(201).send(refund);
    },
  );
  app.post(
    '/api/v1/locations/:locationId/visits/:visitId/close',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId', 'visitId'],
          properties: { locationId: uuid, visitId: uuid },
        },
        headers: ifMatch,
        body: { type: 'object', additionalProperties: false },
      },
    },
    async (request) =>
      withSession(request, async (actor) => {
        requirePermission(actor, 'orders.visits.close');
        const locationId = scoped(request, actor);
        const visitId = (request.params as { visitId: string }).visitId;
        const visit = await findVisit(actor.trx, locationId, visitId);
        if (!visit) throw new IdentityHttpError(404, 'NOT_FOUND', 'Visit was not found.');
        const v = expected(request.headers['if-match']);
        if (v !== visit.version) throw conflict(visit, visit);
        const accounts = await actor.trx
          .selectFrom('accounts')
          .selectAll()
          .where('visit_id', '=', visitId)
          .execute();
        if (accounts.some((account) => !['PAID', 'CLOSED'].includes(account.status)))
          throw new IdentityHttpError(
            409,
            'VISIT_ACCOUNTS_UNSETTLED',
            'All accounts must be paid or closed.',
          );
        const lines = await actor.trx
          .selectFrom('order_lines as ol')
          .innerJoin('orders as o', 'o.id', 'ol.order_id')
          .select('ol.status')
          .where('o.visit_id', '=', visitId)
          .execute();
        if (lines.some((line) => !terminalLine(line.status)))
          throw new IdentityHttpError(
            409,
            'VISIT_ORDER_LINES_UNSETTLED',
            'All order lines must be terminal.',
          );
        await actor.trx
          .updateTable('accounts')
          .set({ status: 'CLOSED', version: sql<number>`version + 1` })
          .where('visit_id', '=', visitId)
          .where('status', '=', 'PAID')
          .execute();
        await actor.trx
          .updateTable('orders')
          .set({ status: 'COMPLETED', version: sql<number>`version + 1` })
          .where('visit_id', '=', visitId)
          .where('status', 'in', ['SENT', 'HELD', 'DRAFT'])
          .execute();
        const updated = await actor.trx
          .updateTable('visits')
          .set({ status: 'COMPLETED', closed_at: now(), version: sql<number>`version + 1` })
          .where('id', '=', visitId)
          .where('version', '=', v)
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw conflict(visit, visit);

        await actor.trx
          .updateTable('reservations')
          .set({ status: 'COMPLETED', version: sql<number>`version + 1` })
          .where('visit_id', '=', visitId)
          .execute();

        if (updated.customer_id) {
          // loyalty_accounts/loyalty_transactions carry organization-scoped RLS, but
          // actor.trx here only has app.current_location_id set (staff sessions run in
          // a location-scoped transaction) -- without this, the read below silently
          // returns nothing and the writes are rejected by the RESTRICTIVE policy's
          // WITH CHECK. set_config can be called again within the same transaction, so
          // this preserves atomicity with the visit-close/reservation-completion work
          // above rather than opening a second, separately-committed transaction.
          await sql`SELECT set_config('app.current_organization_id', ${actor.organizationId}, true)`.execute(actor.trx);
          const settings = await actor.trx.selectFrom('loyalty_settings').selectAll().where('organization_id', '=', actor.organizationId).executeTakeFirst();
          if (settings) {
            const sumAccounts = await actor.trx.selectFrom('accounts')
              .select(sql<number>`coalesce(sum(subtotal), 0)`.as('total_subtotal'))
              .where('visit_id', '=', visitId)
              .where('status', 'in', ['PAID', 'CLOSED'])
              .executeTakeFirst();
            const totalSubtotal = sumAccounts?.total_subtotal ?? 0;
            const pointsEarned = Math.floor(totalSubtotal / settings.spend_amount_for_one_point);
            if (pointsEarned > 0 || totalSubtotal > 0) {
              let account = await actor.trx.selectFrom('loyalty_accounts').selectAll().where('customer_id', '=', updated.customer_id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
              if (!account) {
                account = await actor.trx.insertInto('loyalty_accounts').values({
                  organization_id: actor.organizationId,
                  customer_id: updated.customer_id,
                }).returningAll().executeTakeFirstOrThrow();
              }
              await actor.trx.updateTable('loyalty_accounts')
                .set({ points_balance: account.points_balance + pointsEarned, total_visits: account.total_visits + 1, version: sql<number>`version + 1` })
                .where('id', '=', account.id)
                .execute();
              await actor.trx.insertInto('loyalty_transactions').values({
                organization_id: actor.organizationId,
                loyalty_account_id: account.id,
                transaction_type: 'ACCRUAL',
                points_delta: pointsEarned,
                visit_count_delta: 1,
                reason: 'Visit Accrual',
                reference_visit_id: visitId
              }).execute();
            }
          }
        }

        await actor.trx
          .updateTable('guest_sessions')
          .set({ revoked_at: now() })
          .where('visit_id', '=', visitId)
          .where('revoked_at', 'is', null)
          .execute();

        if (updated.table_id) {
          const table = await actor.trx
            .selectFrom('tables')
            .selectAll()
            .where('id', '=', updated.table_id)
            .executeTakeFirst();
          if (table && table.status === 'OCCUPIED') {
            const updatedTable = await actor.trx
              .updateTable('tables')
              .set({ status: 'NEEDS_CLEANING', version: sql<number>`version + 1` })
              .where('id', '=', updated.table_id)
              .where('version', '=', table.version)
              .executeTakeFirst();
            if (!updatedTable) throw conflict(table, table);
          }
        }
        return updated;
      }),
  );
  app.get(
    '/api/v1/locations/:locationId/visits',
    {
      schema: {
        params: locationParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['OPEN', 'COMPLETED', 'CANCELLED'] },
            table_id: uuid,
          },
        },
      },
    },
    async (request) =>
      withSession(request, async (actor) => {
        requirePermission(actor, 'orders.visits.read_all');
        const locationId = scoped(request, actor);
        let query = actor.trx
          .selectFrom('visits')
          .selectAll()
          .where('location_id', '=', locationId)
          .orderBy('created_at', 'desc');

        const { status, table_id } = request.query as { status?: string; table_id?: string };
        if (status) query = query.where('status', '=', status);
        if (table_id) query = query.where('table_id', '=', table_id);

        return { data: await query.execute() };
      }),
  );

  app.get(
    '/api/v1/locations/:locationId/visits/:visitId',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId', 'visitId'],
          properties: { locationId: uuid, visitId: uuid },
        },
      },
    },
    async (request) =>
      withSession(request, async (actor) => {
        requirePermission(actor, 'orders.visits.read_all');
        const locationId = scoped(request, actor);
        const visitId = (request.params as { visitId: string }).visitId;

        const visit = await findVisit(actor.trx, locationId, visitId);
        if (!visit) throw new IdentityHttpError(404, 'NOT_FOUND', 'Visit was not found.');

        const orders = await actor.trx
          .selectFrom('orders')
          .select(['id', 'status', 'version'])
          .where('visit_id', '=', visitId)
          .execute();

        const accounts = await actor.trx
          .selectFrom('accounts')
          .select(['id', 'status', 'total', 'version'])
          .where('visit_id', '=', visitId)
          .execute();

        return { ...visit, orders, accounts };
      }),
  );

  app.get(
    '/api/v1/locations/:locationId/orders/:orderId',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId', 'orderId'],
          properties: { locationId: uuid, orderId: uuid },
        },
      },
    },
    async (request) =>
      withSession(request, async (actor) => {
        requirePermission(actor, 'orders.visits.read_all');
        const locationId = scoped(request, actor);
        const orderId = (request.params as { orderId: string }).orderId;

        const order = await findOrder(actor.trx, locationId, orderId);
        if (!order) throw new IdentityHttpError(404, 'NOT_FOUND', 'Order was not found.');

        const lines = await actor.trx
          .selectFrom('order_lines')
          .selectAll()
          .where('order_id', '=', orderId)
          .execute();

        const modifierRows = lines.length
          ? await actor.trx
              .selectFrom('order_line_modifiers')
              .selectAll()
              .where(
                'order_line_id',
                'in',
                lines.map((l) => l.id),
              )
              .execute()
          : [];

        const linesWithModifiers = lines.map((line) => ({
          ...line,
          modifiers: modifierRows.filter((m) => m.order_line_id === line.id),
        }));

        return { ...order, order_lines: linesWithModifiers };
      }),
  );

  app.get(
    '/api/v1/locations/:locationId/accounts/:accountId',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId', 'accountId'],
          properties: { locationId: uuid, accountId: uuid },
        },
      },
    },
    async (request) =>
      withSession(request, async (actor) => {
        requirePermission(actor, 'orders.visits.read_all');
        const locationId = scoped(request, actor);
        const accountId = (request.params as { accountId: string }).accountId;

        const account = await findAccount(actor.trx, locationId, accountId);
        if (!account) throw new IdentityHttpError(404, 'NOT_FOUND', 'Account was not found.');

        const payments = await actor.trx
          .selectFrom('payments')
          .selectAll()
          .where('account_id', '=', accountId)
          .execute();

        const lines = await actor.trx
          .selectFrom('order_lines')
          .select('id')
          .where('account_id', '=', accountId)
          .execute();

        const voids = lines.length
          ? await actor.trx
              .selectFrom('cancellations_and_voids')
              .selectAll()
              .where(
                'order_line_id',
                'in',
                lines.map((l) => l.id),
              )
              .execute()
          : [];

        return { ...account, payments, cancellations_and_voids: voids };
      }),
  );

  app.get(
    '/api/v1/locations/:locationId/order-lines',
    {
      schema: {
        params: locationParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string' },
            exclude_future_scheduled: { type: 'boolean' }
          },
        },
      },
    },
    async (request) =>
      withSession(request, async (actor) => {
        requirePermission(actor, 'kitchen.tickets.read');
        const locationId = scoped(request, actor);
        const { status, exclude_future_scheduled } = request.query as { status?: string, exclude_future_scheduled?: boolean };

        let query = actor.trx
          .selectFrom('order_lines as ol')
          .innerJoin('orders as o', 'o.id', 'ol.order_id')
          .innerJoin('visits as v', 'v.id', 'o.visit_id')
          .selectAll('ol')
          .select(['o.visit_id', 'v.table_id', 'o.created_at as order_created_at'])
          .where('v.location_id', '=', locationId);

        if (exclude_future_scheduled) {
          query = query.leftJoin('order_fulfillments as of', 'of.order_id', 'ol.order_id')
            .where((eb) => eb.or([
              eb('of.scheduled_for', 'is', null),
              eb('of.scheduled_for', '<=', sql<Date>`NOW() + INTERVAL '60 minutes'`)
            ]));
        }

        if (status) {
          const statuses = status.split(',');
          query = query.where(
            'ol.status',
            'in',
            statuses as (
              | 'DRAFT'
              | 'HELD'
              | 'SENT'
              | 'PREPARING'
              | 'READY'
              | 'FULFILLED'
              | 'CANCELLED'
              | 'VOIDED'
            )[],
          );
        }

        const lines = await query.execute();

        const modifierRows = lines.length
          ? await actor.trx
              .selectFrom('order_line_modifiers')
              .selectAll()
              .where(
                'order_line_id',
                'in',
                lines.map((l) => l.id),
              )
              .execute()
          : [];

        const linesWithModifiers = lines.map((line) => ({
          ...line,
          modifiers: modifierRows.filter((m) => m.order_line_id === line.id),
        }));

        return { data: linesWithModifiers };
      }),
  );
};
