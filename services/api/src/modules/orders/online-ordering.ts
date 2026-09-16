import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { components } from '@restaurant-suite/contracts';
import { withCustomerSession } from '../customers/index.js';
import {
  IdentityHttpError,
  requirePermission,
  withAuthenticatedSession,
  type AuthenticatedSession,
} from '../identity/index.js';
import { addOrderLines } from './commands.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const ifMatchAsBody = {
  type: 'object',
  additionalProperties: false,
  required: ['version'],
  properties: { version: { type: 'integer', minimum: 1 } },
} as const;
const checkoutSchema = {
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['loc_id'],
    properties: { loc_id: uuid },
  },
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['items', 'fulfillment_type', 'customer_name', 'customer_email', 'customer_phone'],
    properties: {
      items: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['product_id', 'quantity'],
          properties: {
            product_id: uuid,
            quantity: { type: 'integer', minimum: 1 },
            notes: { type: 'string', nullable: true },
            modifiers: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['modifier_id', 'quantity'],
                properties: { modifier_id: uuid, quantity: { type: 'integer', minimum: 1 } },
              },
            },
          },
        },
      },
      fulfillment_type: { type: 'string', enum: ['PICKUP', 'DELIVERY'] },
      scheduled_for: { type: 'string', format: 'date-time', nullable: true },
      customer_name: { type: 'string', minLength: 1, maxLength: 200 },
      customer_email: { type: 'string', format: 'email', maxLength: 255 },
      customer_phone: { type: 'string', minLength: 1, maxLength: 40 },
      delivery_address: { type: 'object', additionalProperties: true, nullable: true },
    },
  },
} as const;

function fail(reply: FastifyReply, request: FastifyRequest, error: IdentityHttpError) {
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

function createGuestOrderToken(): string {
  return randomBytes(32).toString('base64url');
}
function hashGuestOrderToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export const onlineOrdersRoute: FastifyPluginAsync = async (app) => {
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
    request.log.error({ err: error }, 'online-ordering request failed');
    return reply.status(500).send({
      error: {
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
        request_id: request.id,
      },
    });
  });

  app.post<{
    Params: { loc_id: string };
    Body: components['schemas']['OnlineCheckoutRequest'];
  }>(
    '/api/v1/locations/:loc_id/online-orders/checkout',
    { schema: checkoutSchema },
    async (request, reply) => {
      const { loc_id } = request.params;
      const body = request.body;

      let authCustomer: { customerId: string; organizationId: string } | null = null;
      const authHeader = request.headers.authorization;
      if (authHeader?.startsWith('Bearer customer.')) {
        await withCustomerSession(app, request, new Date(), async (session) => {
          authCustomer = { customerId: session.customerId, organizationId: session.organizationId };
        });
      }

      const result = await app.withLocationTransaction(loc_id, async (trx) => {
        const location = await trx
          .selectFrom('locations')
          .select('organization_id')
          .where('id', '=', loc_id)
          .executeTakeFirst();
        if (!location) throw new IdentityHttpError(404, 'NOT_FOUND', 'Location was not found.');
        const organizationId = location.organization_id;

        if (authCustomer && authCustomer.organizationId !== organizationId)
          throw new IdentityHttpError(
            403,
            'FORBIDDEN',
            'The customer session belongs to a different organization.',
          );

        const visit = await trx
          .insertInto('visits')
          .values({ location_id: loc_id, customer_id: authCustomer?.customerId ?? null })
          .returning('id')
          .executeTakeFirstOrThrow();

        const order = await trx
          .insertInto('orders')
          .values({
            location_id: loc_id,
            visit_id: visit.id,
            order_type: body.fulfillment_type,
            status: 'DRAFT',
          })
          .returning(['id', 'version'])
          .executeTakeFirstOrThrow();

        const account = await trx
          .insertInto('accounts')
          .values({
            location_id: loc_id,
            visit_id: visit.id,
            name: body.customer_name ? `Online: ${body.customer_name}` : 'Guest Order',
            status: 'OPEN',
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        const lines = body.items.map((item: components['schemas']['CheckoutItem']) => ({
          account_id: account.id,
          product_id: item.product_id,
          quantity: item.quantity,
          modifier_ids: (item.modifiers ?? []).map(
            (modifier: components['schemas']['CheckoutModifier']) => modifier.modifier_id,
          ),
        }));

        const created = await addOrderLines(trx, {
          locationId: loc_id,
          organizationId,
          orderId: order.id,
          expectedVersion: order.version,
          lines,
        });

        // addOrderLines creates lines in DRAFT and bumps the order's version
        // once for the lines being added; advance both to HELD (idea.md's
        // "Received" state — registered but not yet sent to the kitchen) with
        // their own real version bump each, matching the optimistic-
        // concurrency invariant every other mutation in this codebase holds:
        // every row change increments that row's own version, unconditionally.
        const heldOrder = await trx
          .updateTable('orders')
          .set({ status: 'HELD', version: sql<number>`version + 1` })
          .where('id', '=', order.id)
          .where('version', '=', created.order.version)
          .returningAll()
          .executeTakeFirstOrThrow();
        for (const line of created.lines) {
          await trx
            .updateTable('order_lines')
            .set({ status: 'HELD', version: sql<number>`version + 1` })
            .where('id', '=', line.id)
            .where('version', '=', line.version)
            .execute();
        }

        let guestTokenHash: string | null = null;
        let guestToken: string | null = null;
        if (!authCustomer) {
          guestToken = createGuestOrderToken();
          guestTokenHash = hashGuestOrderToken(guestToken);
        }

        await trx
          .insertInto('order_fulfillments')
          .values({
            location_id: loc_id,
            order_id: order.id,
            fulfillment_type: body.fulfillment_type,
            status: 'PENDING',
            scheduled_for: body.scheduled_for ? new Date(body.scheduled_for) : null,
            customer_name: body.customer_name,
            customer_email: body.customer_email,
            customer_phone: body.customer_phone,
            delivery_address: body.delivery_address ?? null,
            guest_token_hash: guestTokenHash,
          })
          .execute();

        return { order_id: order.id, order_token: guestToken, orderVersion: heldOrder.version };
      });

      reply.status(201);
      return { order_id: result.order_id, order_token: result.order_token };
    },
  );

  app.get<{
    Params: { loc_id: string; order_id: string };
    Querystring: { order_token?: string };
  }>(
    '/api/v1/locations/:loc_id/online-orders/:order_id',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['loc_id', 'order_id'],
          properties: { loc_id: uuid, order_id: uuid },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { order_token: { type: 'string' } },
        },
      },
    },
    async (request) => {
      const { loc_id, order_id } = request.params;
      const { order_token } = request.query;

      let authCustomerId: string | null = null;
      const authHeader = request.headers.authorization;
      if (authHeader?.startsWith('Bearer customer.')) {
        await withCustomerSession(app, request, new Date(), async (session) => {
          authCustomerId = session.customerId;
        });
      }

      return app.withLocationTransaction(loc_id, async (trx) => {
        const order = await trx
          .selectFrom('orders')
          .selectAll()
          .where('location_id', '=', loc_id)
          .where('id', '=', order_id)
          .executeTakeFirst();
        if (!order) throw new IdentityHttpError(404, 'NOT_FOUND', 'Order was not found.');

        const visit = await trx
          .selectFrom('visits')
          .select('customer_id')
          .where('id', '=', order.visit_id)
          .executeTakeFirstOrThrow();

        const fulfillment = await trx
          .selectFrom('order_fulfillments')
          .selectAll()
          .where('order_id', '=', order.id)
          .executeTakeFirstOrThrow();

        if (visit.customer_id) {
          if (visit.customer_id !== authCustomerId)
            throw new IdentityHttpError(
              403,
              'FORBIDDEN',
              'This order belongs to another customer.',
            );
        } else {
          const presentedHash = order_token ? hashGuestOrderToken(order_token) : null;
          if (!presentedHash || presentedHash !== fulfillment.guest_token_hash)
            throw new IdentityHttpError(
              403,
              'FORBIDDEN',
              'A valid order_token is required for a guest order.',
            );
        }

        const linesRows = await trx
          .selectFrom('order_lines')
          .selectAll()
          .where('order_id', '=', order.id)
          .execute();
        const modifiersRows = linesRows.length
          ? await trx
              .selectFrom('order_line_modifiers')
              .selectAll()
              .where(
                'order_line_id',
                'in',
                linesRows.map((line) => line.id),
              )
              .execute()
          : [];

        const accounts = await trx
          .selectFrom('accounts')
          .select(['id', 'status'])
          .where('visit_id', '=', order.visit_id)
          .execute();
        const payments = accounts.length
          ? await trx
              .selectFrom('payments')
              .select(['account_id', 'amount'])
              .where(
                'account_id',
                'in',
                accounts.map((account) => account.id),
              )
              .execute()
          : [];

        let subtotal = 0;
        for (const line of linesRows) {
          if (line.status !== 'CANCELLED' && line.status !== 'VOIDED') {
            const mods = modifiersRows.filter((modifier) => modifier.order_line_id === line.id);
            subtotal +=
              (line.unit_price + mods.reduce((sum, modifier) => sum + modifier.unit_price, 0)) *
              line.quantity;
          }
        }

        return {
          order: {
            id: order.id,
            location_id: order.location_id,
            visit_id: order.visit_id,
            order_type: order.order_type,
            status: order.status,
            version: order.version,
            created_at: order.created_at.toISOString(),
            updated_at: order.updated_at.toISOString(),
            totals: {
              subtotal,
              total: subtotal,
              paid: payments.reduce((sum, payment) => sum + payment.amount, 0),
            },
          },
          lines: linesRows.map((line) => ({
            id: line.id,
            order_id: line.order_id,
            account_id: line.account_id,
            product_id: line.product_id,
            status: line.status,
            quantity: line.quantity,
            created_at: line.created_at.toISOString(),
            updated_at: line.updated_at.toISOString(),
            modifiers: modifiersRows
              .filter((modifier) => modifier.order_line_id === line.id)
              .map((modifier) => ({ id: modifier.id, modifier_id: modifier.modifier_id })),
          })),
          fulfillment: {
            status: fulfillment.status,
            fulfillment_type: fulfillment.fulfillment_type,
          },
        };
      });
    },
  );

  app.post<{ Params: { loc_id: string; order_id: string }; Body: { version: number } }>(
    '/api/v1/locations/:loc_id/orders/:order_id/fulfillment/dispatch',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['loc_id', 'order_id'],
          properties: { loc_id: uuid, order_id: uuid },
        },
        body: ifMatchAsBody,
      },
    },
    async (request) => {
      const { loc_id, order_id } = request.params;
      const { version } = request.body;

      return withAuthenticatedSession(
        app,
        request,
        new Date(),
        15 * 60 * 1000,
        async (actor: AuthenticatedSession) => {
          requirePermission(actor, 'orders.fulfillment.dispatch');

          return app.withLocationTransaction(loc_id, async (trx) => {
            const fulfillment = await trx
              .selectFrom('order_fulfillments')
              .selectAll()
              .where('order_id', '=', order_id)
              .executeTakeFirst();
            if (!fulfillment)
              throw new IdentityHttpError(404, 'NOT_FOUND', 'Fulfillment was not found.');
            if (fulfillment.fulfillment_type !== 'DELIVERY')
              throw new IdentityHttpError(
                409,
                'NOT_A_DELIVERY_ORDER',
                'Only delivery orders can be dispatched.',
              );
            if (fulfillment.status !== 'PENDING')
              throw new IdentityHttpError(
                409,
                'ILLEGAL_FULFILLMENT_TRANSITION',
                `Cannot dispatch from ${fulfillment.status}.`,
              );

            const lines = await trx
              .selectFrom('order_lines')
              .select('status')
              .where('order_id', '=', order_id)
              .execute();
            const allReady = lines.every((line) =>
              ['READY', 'FULFILLED', 'CANCELLED', 'VOIDED'].includes(line.status),
            );
            if (!allReady)
              throw new IdentityHttpError(
                409,
                'ORDER_NOT_READY',
                'Every line must be ready before dispatch.',
              );

            const updated = await trx
              .updateTable('order_fulfillments')
              .set({ status: 'OUT_FOR_DELIVERY', version: sql<number>`version + 1` })
              .where('order_id', '=', order_id)
              .where('version', '=', version)
              .returningAll()
              .executeTakeFirst();
            if (!updated)
              throw new IdentityHttpError(
                409,
                'OPTIMISTIC_CONCURRENCY_CONFLICT',
                'The fulfillment was modified since it was last read.',
                {
                  current_version: fulfillment.version,
                  current_state: fulfillment,
                },
              );
            return updated;
          });
        },
      );
    },
  );

  app.post<{ Params: { loc_id: string; order_id: string }; Body: { version: number } }>(
    '/api/v1/locations/:loc_id/orders/:order_id/fulfillment/deliver',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['loc_id', 'order_id'],
          properties: { loc_id: uuid, order_id: uuid },
        },
        body: ifMatchAsBody,
      },
    },
    async (request) => {
      const { loc_id, order_id } = request.params;
      const { version } = request.body;

      return withAuthenticatedSession(
        app,
        request,
        new Date(),
        15 * 60 * 1000,
        async (actor: AuthenticatedSession) => {
          requirePermission(actor, 'orders.fulfillment.deliver');

          return app.withLocationTransaction(loc_id, async (trx) => {
            const fulfillment = await trx
              .selectFrom('order_fulfillments')
              .selectAll()
              .where('order_id', '=', order_id)
              .executeTakeFirst();
            if (!fulfillment)
              throw new IdentityHttpError(404, 'NOT_FOUND', 'Fulfillment was not found.');
            if (fulfillment.fulfillment_type !== 'DELIVERY')
              throw new IdentityHttpError(
                409,
                'NOT_A_DELIVERY_ORDER',
                'Only delivery orders can be marked delivered.',
              );
            if (fulfillment.status !== 'OUT_FOR_DELIVERY')
              throw new IdentityHttpError(
                409,
                'ILLEGAL_FULFILLMENT_TRANSITION',
                `Cannot deliver from ${fulfillment.status}.`,
              );

            const updated = await trx
              .updateTable('order_fulfillments')
              .set({ status: 'DELIVERED', version: sql<number>`version + 1` })
              .where('order_id', '=', order_id)
              .where('version', '=', version)
              .returningAll()
              .executeTakeFirst();
            if (!updated)
              throw new IdentityHttpError(
                409,
                'OPTIMISTIC_CONCURRENCY_CONFLICT',
                'The fulfillment was modified since it was last read.',
                {
                  current_version: fulfillment.version,
                  current_state: fulfillment,
                },
              );
            return updated;
          });
        },
      );
    },
  );
};
