import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';

import {
  IdentityHttpError,
  requirePermission,
  withAuthenticatedSession,
} from '../identity/index.js';
import {
  findSession,
  getOpenSessionForTerminal,
  sumCashPayments,
  sumMovements,
} from './persistence/repository.js';
import { computeExpectedAmount, computeVariance } from './state.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const ifMatch = {
  type: 'object',
  additionalProperties: true,
  required: ['if-match'],
  properties: { 'if-match': { type: 'string', pattern: '^"?[1-9][0-9]*"?$' } },
} as const;

export interface CashDrawerRouteOptions {
  now?: () => Date;
  sessionIdleMs?: number;
}
type Actor = Parameters<typeof requirePermission>[0];

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

const fail = (reply: FastifyReply, request: FastifyRequest, error: IdentityHttpError) =>
  reply.status(error.statusCode).send({
    error: {
      status: error.statusCode,
      code: error.code,
      message: error.message,
      request_id: request.id,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  });

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

export const cashDrawerRoute: FastifyPluginAsync<CashDrawerRouteOptions> = async (app, options) => {
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
    request.log.error({ err: error }, 'cash drawer request failed');
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

  app.post(
    '/api/v1/locations/:locationId/terminals/:terminalId/cash-drawer/open',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId', 'terminalId'],
          properties: { locationId: uuid, terminalId: uuid },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['opening_float'],
          properties: {
            opening_float: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    async (request, reply) =>
      withSession(request, async (actor) => {
        requirePermission(actor, 'payments.cash.open_drawer');
        const locationId = scoped(request, actor);
        const { terminalId } = request.params as { locationId: string; terminalId: string };
        const { opening_float } = request.body as { opening_float: number };

        const existing = await getOpenSessionForTerminal(actor.trx, locationId, terminalId);
        if (existing) {
          throw new IdentityHttpError(
            409,
            'DRAWER_ALREADY_OPEN',
            'A cash drawer session is already open for this terminal.',
          );
        }

        const session = await actor.trx
          .insertInto('cash_drawer_sessions')
          .values({
            location_id: locationId,
            terminal_id: terminalId,
            opened_by: actor.staffId,
            opening_float,
            status: 'OPEN',
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        return reply.status(201).send(session);
      }),
  );

  app.post(
    '/api/v1/locations/:locationId/cash-drawer-sessions/:sessionId/movements',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId', 'sessionId'],
          properties: { locationId: uuid, sessionId: uuid },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['movement_type', 'amount', 'reason'],
          properties: {
            movement_type: { type: 'string', enum: ['CASH_IN', 'CASH_OUT'] },
            amount: { type: 'integer', minimum: 1 },
            reason: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) =>
      withSession(request, async (actor) => {
        requirePermission(actor, 'payments.cash.open_drawer');
        const locationId = scoped(request, actor);
        const { sessionId } = request.params as { locationId: string; sessionId: string };
        const body = request.body as { movement_type: 'CASH_IN' | 'CASH_OUT'; amount: number; reason: string };

        const session = await findSession(actor.trx, locationId, sessionId);
        if (!session) throw new IdentityHttpError(404, 'NOT_FOUND', 'Session not found.');
        if (session.status !== 'OPEN') {
          throw new IdentityHttpError(
            409,
            'DRAWER_NOT_OPEN',
            'Cannot record movements on a closed cash drawer session.',
          );
        }

        const movement = await actor.trx
          .insertInto('cash_drawer_movements')
          .values({
            location_id: locationId,
            drawer_session_id: sessionId,
            movement_type: body.movement_type,
            amount: body.amount,
            reason: body.reason,
            recorded_by: actor.staffId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        return reply.status(201).send(movement);
      }),
  );

  app.post(
    '/api/v1/locations/:locationId/cash-drawer-sessions/:sessionId/close',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId', 'sessionId'],
          properties: { locationId: uuid, sessionId: uuid },
        },
        headers: ifMatch,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['counted_amount'],
          properties: {
            counted_amount: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    async (request, reply) =>
      withSession(request, async (actor) => {
        requirePermission(actor, 'payments.cash.reconcile');
        const locationId = scoped(request, actor);
        const { sessionId } = request.params as { locationId: string; sessionId: string };
        const { counted_amount } = request.body as { counted_amount: number };

        const session = await findSession(actor.trx, locationId, sessionId);
        if (!session) throw new IdentityHttpError(404, 'NOT_FOUND', 'Session not found.');
        
        const v = expected(request.headers['if-match']);
        if (v !== session.version) throw conflict(session, session);

        if (session.status !== 'OPEN') {
          throw new IdentityHttpError(
            409,
            'DRAWER_NOT_OPEN',
            'The cash drawer session is already closed.',
          );
        }

        const cashPaymentsTotal = await sumCashPayments(actor.trx, locationId, session.opened_at);
        const cashInsTotal = await sumMovements(actor.trx, locationId, sessionId, 'CASH_IN');
        const cashOutsTotal = await sumMovements(actor.trx, locationId, sessionId, 'CASH_OUT');

        const expectedAmount = computeExpectedAmount(
          session.opening_float,
          cashPaymentsTotal,
          cashInsTotal,
          cashOutsTotal,
        );
        const variance = computeVariance(counted_amount, expectedAmount);

        const closedSession = await actor.trx
          .updateTable('cash_drawer_sessions')
          .set({
            status: 'CLOSED',
            closed_by: actor.staffId,
            closed_at: now(),
            counted_amount,
            expected_amount: expectedAmount,
            variance,
            version: sql<number>`version + 1`,
          })
          .where('id', '=', sessionId)
          .where('version', '=', v)
          .returningAll()
          .executeTakeFirstOrThrow();

        return reply.send(closedSession);
      }),
  );

  app.get(
    '/api/v1/locations/:locationId/cash-drawer-sessions',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId'],
          properties: { locationId: uuid },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            terminal_id: uuid,
            status: { type: 'string', enum: ['OPEN', 'CLOSED'] },
          },
        },
      },
    },
    async (request, reply) =>
      withSession(request, async (actor) => {
        requirePermission(actor, 'payments.cash.open_drawer');
        const locationId = scoped(request, actor);
        const query = request.query as { terminal_id?: string; status?: 'OPEN' | 'CLOSED' };

        let builder = actor.trx.selectFrom('cash_drawer_sessions').selectAll().where('location_id', '=', locationId);
        
        if (query.terminal_id) {
          builder = builder.where('terminal_id', '=', query.terminal_id);
        }
        if (query.status) {
          builder = builder.where('status', '=', query.status);
        }

        const sessions = await builder.orderBy('opened_at', 'desc').execute();
        return reply.send({ items: sessions });
      }),
  );

  app.get(
    '/api/v1/locations/:locationId/cash-drawer-sessions/:sessionId',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId', 'sessionId'],
          properties: { locationId: uuid, sessionId: uuid },
        },
      },
    },
    async (request, reply) =>
      withSession(request, async (actor) => {
        requirePermission(actor, 'payments.cash.open_drawer');
        const locationId = scoped(request, actor);
        const { sessionId } = request.params as { locationId: string; sessionId: string };

        const session = await findSession(actor.trx, locationId, sessionId);
        if (!session) throw new IdentityHttpError(404, 'NOT_FOUND', 'Session not found.');

        const movements = await actor.trx
          .selectFrom('cash_drawer_movements')
          .selectAll()
          .where('location_id', '=', locationId)
          .where('drawer_session_id', '=', sessionId)
          .orderBy('created_at', 'desc')
          .execute();

        return reply.send({ ...session, movements });
      }),
  );
};
