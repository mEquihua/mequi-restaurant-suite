import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';

import { addOrderLines } from '../orders/index.js';
import { GuestSessionHttpError, withGuestSession } from './authentication.js';
import { findGuestAccount, findGuestOrder } from './persistence/repository.js';
import { createGuestSessionToken, hashGuestSecret } from './security.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const requestTypes = ['CALL_WAITER', 'REQUEST_BILL', 'NEED_WATER', 'NEED_UTENSILS'] as const;
const mintAttempts = new Map<string, { startedAt: number; count: number }>();

export interface GuestSessionsRouteOptions {
  now?: () => Date;
  sessionDurationMs?: number;
}

function fail(reply: FastifyReply, request: FastifyRequest, error: GuestSessionHttpError) {
  return reply
    .status(error.statusCode)
    .send({
      error: {
        status: error.statusCode,
        code: error.code,
        message: error.message,
        request_id: request.id,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    });
}
function requireLocation(session: { locationId: string }, locationId: string) {
  if (session.locationId !== locationId)
    throw new GuestSessionHttpError(
      403,
      'LOCATION_SCOPE_DENIED',
      'The guest session is not scoped to this location.',
    );
}

/** Private HTTP implementation for the guest-sessions module. */
export const guestSessionsRoute: FastifyPluginAsync<GuestSessionsRouteOptions> = async (
  app,
  options,
) => {
  const now = options.now ?? (() => new Date());
  const sessionDurationMs = options.sessionDurationMs ?? 12 * 60 * 60 * 1000;
  const withGuest = <T>(request: FastifyRequest, work: Parameters<typeof withGuestSession<T>>[3]) =>
    withGuestSession(app, request, now(), work);
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof GuestSessionHttpError) return fail(reply, request, error);
    if (
      typeof error === 'object' &&
      error !== null &&
      'validation' in error &&
      (error as { validation?: unknown }).validation
    )
      return reply
        .status(400)
        .send({
          error: {
            status: 400,
            code: 'VALIDATION_ERROR',
            message: 'The request does not match the required schema.',
            request_id: request.id,
          },
        });
    request.log.error({ err: error }, 'guest-session request failed');
    return reply
      .status(500)
      .send({
        error: {
          status: 500,
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred.',
          request_id: request.id,
        },
      });
  });

  app.post(
    '/api/v1/locations/:locationId/tables/:tableId/guest-session',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId', 'tableId'],
          properties: { locationId: uuid, tableId: uuid },
        },
        body: { type: 'object', additionalProperties: false, maxProperties: 0 },
      },
    },
    async (request, reply) => {
      const { locationId, tableId } = request.params as { locationId: string; tableId: string };
      // Intentionally process-local for this initial API; it limits accidental/naive QR hammering, not distributed abuse.
      const rateKey = `${request.ip}:${tableId}`;
      const currentAttempt = mintAttempts.get(rateKey);
      const window =
        currentAttempt && currentAttempt.startedAt > Date.now() - 60_000
          ? currentAttempt
          : { startedAt: Date.now(), count: 0 };
      if (window.count >= 30)
        throw new GuestSessionHttpError(
          429,
          'RATE_LIMITED',
          'Please wait briefly before scanning again.',
        );
      mintAttempts.set(rateKey, { ...window, count: window.count + 1 });
      const minted = await app.withLocationTransaction(locationId, async (trx) => {
        const table = await trx
          .selectFrom('tables')
          .selectAll()
          .where('id', '=', tableId)
          .where('location_id', '=', locationId)
          .forUpdate()
          .executeTakeFirst();
        if (!table)
          throw new GuestSessionHttpError(404, 'TABLE_NOT_FOUND', 'The table was not found.');
        let visit = await trx
          .selectFrom('visits')
          .selectAll()
          .where('location_id', '=', locationId)
          .where('table_id', '=', tableId)
          .where('status', '=', 'OPEN')
          .orderBy('opened_at', 'desc')
          .executeTakeFirst();
        if (!visit) {
          if (table.status !== 'AVAILABLE')
            throw new GuestSessionHttpError(
              409,
              'TABLE_NOT_READY',
              'This table is not ready for self-service. Please ask a staff member for help.',
            );
          const tableUpdated = await trx
            .updateTable('tables')
            .set({ status: 'OCCUPIED', version: sql<number>`version + 1` })
            .where('id', '=', table.id)
            .where('version', '=', table.version)
            .executeTakeFirst();
          if (!tableUpdated)
            throw new GuestSessionHttpError(
              409,
              'TABLE_NOT_READY',
              'This table changed while opening the visit. Please ask a staff member for help.',
            );
          visit = await trx
            .insertInto('visits')
            .values({ location_id: locationId, table_id: tableId, staff_id: null })
            .returningAll()
            .executeTakeFirstOrThrow();
        }
        let account = await findGuestAccount(trx, visit.id);
        if (!account)
          account = await trx
            .insertInto('accounts')
            .values({ location_id: locationId, visit_id: visit.id })
            .returningAll()
            .executeTakeFirstOrThrow();
        let order = await findGuestOrder(trx, visit.id);
        if (!order)
          order = await trx
            .insertInto('orders')
            .values({ location_id: locationId, visit_id: visit.id, order_type: 'TABLE_SELF_ORDER' })
            .returningAll()
            .executeTakeFirstOrThrow();
        const token = createGuestSessionToken(locationId);
        const expiresAt = new Date(now().getTime() + sessionDurationMs);
        await trx
          .insertInto('guest_sessions')
          .values({
            location_id: locationId,
            visit_id: visit.id,
            table_id: tableId,
            token_hash: hashGuestSecret(token),
            device_info: request.headers['user-agent']?.slice(0, 500) ?? null,
            expires_at: expiresAt,
          })
          .execute();
        return {
          token,
          visit_id: visit.id,
          table_id: tableId,
          expires_at: expiresAt.toISOString(),
        };
      });
      return reply.status(201).send(minted);
    },
  );

  app.post(
    '/api/v1/locations/:locationId/counter-sessions',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId'],
          properties: { locationId: uuid },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { order_type: { type: 'string', enum: ['DINE_IN', 'TAKEOUT'] } },
        },
      },
    },
    async (request, reply) => {
      const { locationId } = request.params as { locationId: string };
      const body = request.body as { order_type?: 'DINE_IN' | 'TAKEOUT' } | null;
      const orderType = body?.order_type ?? 'TAKEOUT';

      const minted = await app.withLocationTransaction(locationId, async (trx) => {
        const visit = await trx
          .insertInto('visits')
          .values({ location_id: locationId, table_id: null, staff_id: null })
          .returningAll()
          .executeTakeFirstOrThrow();

        await trx
          .insertInto('accounts')
          .values({ location_id: locationId, visit_id: visit.id })
          .returningAll()
          .executeTakeFirstOrThrow();

        await trx
          .insertInto('orders')
          .values({ location_id: locationId, visit_id: visit.id, order_type: orderType })
          .returningAll()
          .executeTakeFirstOrThrow();

        const token = createGuestSessionToken(locationId);
        const expiresAt = new Date(now().getTime() + sessionDurationMs);

        await trx
          .insertInto('guest_sessions')
          .values({
            location_id: locationId,
            visit_id: visit.id,
            table_id: null,
            token_hash: hashGuestSecret(token),
            device_info: request.headers['user-agent']?.slice(0, 500) ?? null,
            expires_at: expiresAt,
          })
          .execute();

        return {
          token,
          visit_id: visit.id,
          table_id: null,
          expires_at: expiresAt.toISOString(),
        };
      });
      return reply.status(201).send(minted);
    },
  );

  app.get(
    '/api/v1/locations/:locationId/guest-sessions/current',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId'],
          properties: { locationId: uuid },
        },
      },
    },
    async (request) =>
      withGuest(request, async (session) => {
        const { locationId } = request.params as { locationId: string };
        requireLocation(session, locationId);
        const [table, activation] = await Promise.all([
          session.tableId
            ? session.trx
                .selectFrom('tables')
                .select(['id', 'name', 'status'])
                .where('id', '=', session.tableId)
                .executeTakeFirstOrThrow()
            : Promise.resolve(null),
          session.trx
            .selectFrom('module_activations')
            .select(['status', 'guest_payment_mode'])
            .where('location_id', '=', session.locationId)
            .where('module_key', '=', 'qr_ordering')
            .executeTakeFirst(),
        ]);
        return {
          visit_id: session.visitId,
          table,
          self_service: {
            enabled: activation?.status === 'ACTIVE',
            guest_payment_mode: activation?.guest_payment_mode ?? 'ORDER_ONLY',
          },
        };
      }),
  );

  app.get(
    '/api/v1/locations/:locationId/guest-sessions/current/order',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId'],
          properties: { locationId: uuid },
        },
      },
    },
    async (request) =>
      withGuest(request, async (session) => {
        const { locationId } = request.params as { locationId: string };
        requireLocation(session, locationId);
        const order = await session.trx
          .selectFrom('orders')
          .selectAll()
          .where('visit_id', '=', session.visitId)
          .orderBy('created_at')
          .executeTakeFirst();
        if (!order)
          throw new GuestSessionHttpError(
            404,
            'ORDER_NOT_FOUND',
            'No order exists for this visit.',
          );
        const [lines, account] = await Promise.all([
          session.trx
            .selectFrom('order_lines')
            .selectAll()
            .where('order_id', '=', order.id)
            .orderBy('created_at')
            .execute(),
          session.trx
            .selectFrom('accounts')
            .select(['subtotal', 'tax', 'discount', 'total', 'paid_amount', 'status'])
            .where('visit_id', '=', session.visitId)
            .orderBy('created_at')
            .executeTakeFirst(),
        ]);
        return {
          order: { id: order.id, status: order.status, version: order.version, lines },
          account: account ?? null,
        };
      }),
  );

  app.post(
    '/api/v1/locations/:locationId/guest-sessions/current/lines',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId'],
          properties: { locationId: uuid },
        },
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
                required: ['product_id', 'quantity'],
                properties: {
                  product_id: uuid,
                  variant_id: uuid,
                  modifier_ids: { type: 'array', uniqueItems: true, items: uuid },
                  quantity: { type: 'integer', minimum: 1 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await withGuest(request, async (session) => {
        const { locationId } = request.params as { locationId: string };
        requireLocation(session, locationId);
        const order = await findGuestOrder(session.trx, session.visitId);
        const account = await findGuestAccount(session.trx, session.visitId);
        if (!order || !account)
          throw new GuestSessionHttpError(
            409,
            'ORDER_NOT_MUTABLE',
            'The shared table order is not available.',
          );
        const body = request.body as {
          lines: Array<{
            product_id: string;
            variant_id?: string;
            modifier_ids?: string[];
            quantity: number;
          }>;
        };
        const result = await addOrderLines(session.trx, {
          locationId: session.locationId,
          organizationId: session.organizationId,
          orderId: order.id,
          expectedVersion: order.version,
          lines: body.lines.map((line) => ({ ...line, account_id: account.id })),
        });
        return result;
      });
      return reply.status(201).send(result);
    },
  );

  app.post(
    '/api/v1/locations/:locationId/guest-sessions/current/service-requests',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId'],
          properties: { locationId: uuid },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['request_type'],
          properties: { request_type: { type: 'string', enum: requestTypes } },
        },
      },
    },
    async (request, reply) => {
      const serviceRequest = await withGuest(request, async (session) => {
        const { locationId } = request.params as { locationId: string };
        requireLocation(session, locationId);
        if (!session.tableId) {
          throw new GuestSessionHttpError(400, 'TABLE_REQUIRED', 'A physical table is required to request service.');
        }
        const requestType = (request.body as { request_type: (typeof requestTypes)[number] })
          .request_type;
        const serviceRequest = await session.trx
          .insertInto('table_service_requests')
          .values({
            location_id: session.locationId,
            visit_id: session.visitId,
            table_id: session.tableId,
            request_type: requestType,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await session.trx
          .insertInto('outbox_events')
          .values({
            location_id: session.locationId,
            aggregate_type: 'table_service_request',
            aggregate_id: serviceRequest.id,
            event_type: 'table_service_request.created',
            payload: {
              visit_id: session.visitId,
              table_id: session.tableId,
              request_type: requestType,
            },
            schema_version: 1,
          })
          .execute();
        return serviceRequest;
      });
      return reply.status(201).send(serviceRequest);
    },
  );

  app.post(
    '/api/v1/locations/:locationId/guest-sessions/current/payments',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId'],
          properties: { locationId: uuid },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['provider_token'],
          properties: { provider_token: { type: 'string', minLength: 1, maxLength: 2048 } },
        },
      },
    },
    async (request) =>
      withGuest(request, async (session) => {
        const { locationId } = request.params as { locationId: string };
        requireLocation(session, locationId);
        const activation = await session.trx
          .selectFrom('module_activations')
          .select('guest_payment_mode')
          .where('location_id', '=', session.locationId)
          .where('module_key', '=', 'qr_ordering')
          .executeTakeFirst();
        if (activation?.guest_payment_mode !== 'ORDER_AND_PAY')
          throw new GuestSessionHttpError(
            409,
            'GUEST_PAYMENT_NOT_ENABLED',
            'Self-service payment is not enabled for this location.',
          );
        // Provider adapters are explicitly out of scope; fail closed rather than treating a browser token as proof of payment.
        throw new GuestSessionHttpError(
          501,
          'PAYMENT_PROVIDER_NOT_CONFIGURED',
          'No verified payment provider is configured for guest self-service.',
        );
      }),
  );

  app.get(
    '/api/v1/locations/:locationId/order-status-board',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId'],
          properties: { locationId: uuid },
        },
      },
    },
    async (request) => {
      const { locationId } = request.params as { locationId: string };
      return app.withLocationTransaction(locationId, async (trx) => ({
        data: await trx
          .selectFrom('orders as o')
          .innerJoin('order_lines as ol', 'ol.order_id', 'o.id')
          .select(['o.id as order_id', 'ol.status'])
          .where('o.location_id', '=', locationId)
          .where('o.order_type', 'in', ['PICKUP', 'TAKEOUT'])
          .where('ol.status', 'in', ['PREPARING', 'READY'])
          .orderBy('o.created_at')
          .execute(),
      }));
    },
  );
};
