import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  IdentityHttpError,
  requirePermission,
  withAuthenticatedSession,
} from '../identity/index.js';

const uuidSchema = { type: 'string', format: 'uuid' } as const;
const ifMatchHeader = {
  type: 'object',
  additionalProperties: true,
  properties: { 'if-match': { type: 'string', pattern: '^"?[1-9][0-9]*"?$' } },
} as const;

type PromoBody = {
  name: string;
  description?: string;
  discount_type: 'PERCENTAGE' | 'AMOUNT';
  discount_value: number;
  category_id?: string;
  product_id?: string;
  is_active: boolean;
  starts_at?: string;
  ends_at?: string;
  days_of_week?: number[];
  start_time?: string;
  end_time?: string;
};

export interface PromotionsRouteOptions {
  now?: () => Date;
  sessionIdleMs?: number;
}

function fail(reply: FastifyReply, request: FastifyRequest, error: IdentityHttpError) {
  const headers = error.headers;
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

export const promotionsRoute: FastifyPluginAsync<PromotionsRouteOptions> = async (app, options) => {
  const now = options.now ?? (() => new Date());
  const sessionIdleMs = options.sessionIdleMs ?? 15 * 60 * 1000;

  const withStaffSession = <T>(
    request: FastifyRequest,
    work: Parameters<typeof withAuthenticatedSession<T>>[4],
  ) => withAuthenticatedSession(app, request, now(), sessionIdleMs, work);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof IdentityHttpError) {
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
    request.log.error({ err: error }, 'promotions request failed');
    return reply.status(500).send({
      error: {
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
        request_id: request.id,
      },
    });
  });

  app.get('/api/v1/promotions', async (request) =>
    withStaffSession(request, async (actor) => {
      requirePermission(actor, 'promotions.promotions.read');
      return {
        data: await actor.trx
          .selectFrom('promotions')
          .selectAll()
          .where('organization_id', '=', actor.organizationId)
          .execute(),
      };
    })
  );

  app.post(
    '/api/v1/promotions',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'discount_type', 'discount_value', 'is_active'],
          properties: {
            name: { type: 'string', minLength: 1 },
            description: { type: 'string' },
            discount_type: { type: 'string', enum: ['PERCENTAGE', 'AMOUNT'] },
            discount_value: { type: 'integer', minimum: 1 },
            category_id: { ...uuidSchema, nullable: true },
            product_id: { ...uuidSchema, nullable: true },
            is_active: { type: 'boolean' },
            starts_at: { type: 'string', format: 'date-time', nullable: true },
            ends_at: { type: 'string', format: 'date-time', nullable: true },
            days_of_week: {
              type: 'array',
              items: { type: 'integer', minimum: 1, maximum: 7 },
              nullable: true,
            },
            start_time: { type: 'string', pattern: '^([0-1]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$', nullable: true },
            end_time: { type: 'string', pattern: '^([0-1]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$', nullable: true },
          },
        },
      },
    },
    async (request, reply) =>
      withStaffSession(request, async (actor) => {
        requirePermission(actor, 'promotions.promotions.write');
        const body = request.body as PromoBody;

        if (body.discount_type === 'PERCENTAGE' && body.discount_value > 100) {
          throw new IdentityHttpError(400, 'INVALID_DISCOUNT', 'Percentage discounts cannot exceed 100.');
        }
        if (body.category_id && body.product_id) {
          throw new IdentityHttpError(400, 'INVALID_TARGET', 'Cannot specify both category_id and product_id.');
        }

        const created = await actor.trx
          .insertInto('promotions')
          .values({
            organization_id: actor.organizationId,
            name: body.name,
            description: body.description ?? null,
            discount_type: body.discount_type,
            discount_value: body.discount_value,
            category_id: body.category_id ?? null,
            product_id: body.product_id ?? null,
            is_active: body.is_active,
            starts_at: body.starts_at ? new Date(body.starts_at) : null,
            ends_at: body.ends_at ? new Date(body.ends_at) : null,
            days_of_week: body.days_of_week ?? null,
            start_time: body.start_time ?? null,
            end_time: body.end_time ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return reply.status(201).send(created);
      })
  );

  app.get(
    '/api/v1/promotions/:id',
    { schema: { params: { type: 'object', properties: { id: uuidSchema }, required: ['id'] } } },
    async (request) =>
      withStaffSession(request, async (actor) => {
        requirePermission(actor, 'promotions.promotions.read');
        const { id } = request.params as { id: string };
        const promotion = await actor.trx
          .selectFrom('promotions')
          .selectAll()
          .where('organization_id', '=', actor.organizationId)
          .where('id', '=', id)
          .executeTakeFirst();
        if (!promotion) throw new IdentityHttpError(404, 'NOT_FOUND', 'Promotion not found.');
        return promotion;
      })
  );

  app.put(
    '/api/v1/promotions/:id',
    {
      schema: {
        headers: ifMatchHeader,
        params: { type: 'object', properties: { id: uuidSchema }, required: ['id'] },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'discount_type', 'discount_value', 'is_active'],
          properties: {
            name: { type: 'string', minLength: 1 },
            description: { type: 'string', nullable: true },
            discount_type: { type: 'string', enum: ['PERCENTAGE', 'AMOUNT'] },
            discount_value: { type: 'integer', minimum: 1 },
            category_id: { ...uuidSchema, nullable: true },
            product_id: { ...uuidSchema, nullable: true },
            is_active: { type: 'boolean' },
            starts_at: { type: 'string', format: 'date-time', nullable: true },
            ends_at: { type: 'string', format: 'date-time', nullable: true },
            days_of_week: {
              type: 'array',
              items: { type: 'integer', minimum: 1, maximum: 7 },
              nullable: true,
            },
            start_time: { type: 'string', pattern: '^([0-1]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$', nullable: true },
            end_time: { type: 'string', pattern: '^([0-1]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$', nullable: true },
          },
        },
      },
    },
    async (request) =>
      withStaffSession(request, async (actor) => {
        requirePermission(actor, 'promotions.promotions.write');
        const { id } = request.params as { id: string };
        const expectedVersion = parseIfMatch(request.headers['if-match']);
        const body = request.body as PromoBody;

        if (body.discount_type === 'PERCENTAGE' && body.discount_value > 100) {
          throw new IdentityHttpError(400, 'INVALID_DISCOUNT', 'Percentage discounts cannot exceed 100.');
        }
        if (body.category_id && body.product_id) {
          throw new IdentityHttpError(400, 'INVALID_TARGET', 'Cannot specify both category_id and product_id.');
        }

        const current = await actor.trx
          .selectFrom('promotions')
          .selectAll()
          .where('organization_id', '=', actor.organizationId)
          .where('id', '=', id)
          .executeTakeFirst();
        if (!current) throw new IdentityHttpError(404, 'NOT_FOUND', 'Promotion not found.');
        if (current.version !== expectedVersion) throw conflict(current, current);

        const updated = await actor.trx
          .updateTable('promotions')
          .set({
            name: body.name,
            description: body.description ?? null,
            discount_type: body.discount_type,
            discount_value: body.discount_value,
            category_id: body.category_id ?? null,
            product_id: body.product_id ?? null,
            is_active: body.is_active,
            starts_at: body.starts_at ? new Date(body.starts_at) : null,
            ends_at: body.ends_at ? new Date(body.ends_at) : null,
            days_of_week: body.days_of_week ?? null,
            start_time: body.start_time ?? null,
            end_time: body.end_time ?? null,
            version: current.version + 1,
          })
          .where('id', '=', id)
          .where('version', '=', expectedVersion)
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw conflict(current, current);
        return updated;
      })
  );
};
