import { sql } from 'kysely';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  IdentityHttpError,
  requirePermission,
  withAuthenticatedSession,
  type AuthenticatedSession,
} from '../identity/index.js';

const uuid = { type: 'string', format: 'uuid' } as const;

function requireActorLocation(actor: AuthenticatedSession, requestedLocationId: string) {
  if (requestedLocationId !== actor.locationId)
    throw new IdentityHttpError(
      403,
      'LOCATION_SCOPE_DENIED',
      'The session is not scoped to the requested location.',
    );
}

function fail(reply: FastifyReply, request: FastifyRequest, error: IdentityHttpError) {
  return reply.status(error.statusCode).send({
    error: {
      status: error.statusCode,
      code: error.code,
      message: error.message,
      details: error.details,
      request_id: request.id,
    },
  });
}

function publicZone(zone: {
  id: string;
  name: string;
  fee: number;
  minimum_order_amount: number;
}) {
  return { id: zone.id, name: zone.name, fee: zone.fee, minimum_order_amount: zone.minimum_order_amount };
}

function adminZone(zone: {
  id: string;
  location_id: string;
  name: string;
  fee: number;
  minimum_order_amount: number;
  active: boolean;
  version: number;
}) {
  return {
    id: zone.id,
    location_id: zone.location_id,
    name: zone.name,
    fee: zone.fee,
    minimum_order_amount: zone.minimum_order_amount,
    active: zone.active,
    version: zone.version,
  };
}

export const deliveryZonesRoute: FastifyPluginAsync = async (app) => {
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
    request.log.error({ err: error }, 'delivery-zones request failed');
    return reply.status(500).send({
      error: {
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
        request_id: request.id,
      },
    });
  });

  app.get<{ Params: { loc_id: string } }>(
    '/api/v1/locations/:loc_id/delivery-zones',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['loc_id'],
          properties: { loc_id: uuid },
        },
      },
    },
    async (request) => {
      const { loc_id } = request.params;

      return app.withLocationTransaction(loc_id, async (trx) => {
        const location = await trx
          .selectFrom('locations')
          .select('id')
          .where('id', '=', loc_id)
          .executeTakeFirst();
        if (!location) throw new IdentityHttpError(404, 'NOT_FOUND', 'Location was not found.');

        const zones = await trx
          .selectFrom('delivery_zones')
          .select(['id', 'name', 'fee', 'minimum_order_amount'])
          .where('location_id', '=', loc_id)
          .where('active', '=', true)
          .execute();

        return { data: zones.map(publicZone) };
      });
    },
  );

  app.get<{ Params: { loc_id: string } }>(
    '/api/v1/locations/:loc_id/delivery-zones/admin',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['loc_id'],
          properties: { loc_id: uuid },
        },
      },
    },
    async (request) =>
      withAuthenticatedSession(app, request, new Date(), 15 * 60 * 1000, async (actor) => {
        requirePermission(actor, 'delivery.zones.read');
        requireActorLocation(actor, request.params.loc_id);

        const zones = await actor.trx
          .selectFrom('delivery_zones')
          .selectAll()
          .where('location_id', '=', actor.locationId)
          .execute();

        return { data: zones.map(adminZone) };
      }),
  );

  app.post<{
    Params: { loc_id: string };
    Body: { name: string; fee: number; minimum_order_amount?: number };
  }>(
    '/api/v1/locations/:loc_id/delivery-zones',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['loc_id'],
          properties: { loc_id: uuid },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'fee'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            fee: { type: 'integer', minimum: 0 },
            minimum_order_amount: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const zone = await withAuthenticatedSession(
        app,
        request,
        new Date(),
        15 * 60 * 1000,
        async (actor: AuthenticatedSession) => {
          requirePermission(actor, 'delivery.zones.write');
          requireActorLocation(actor, request.params.loc_id);

          const { name, fee, minimum_order_amount } = request.body;
          const created = await actor.trx
            .insertInto('delivery_zones')
            .values({
              location_id: actor.locationId,
              name,
              fee,
              minimum_order_amount: minimum_order_amount ?? 0,
              active: true,
              version: 1,
            })
            .returningAll()
            .executeTakeFirstOrThrow();

          return adminZone(created);
        },
      );
      reply.status(201);
      return zone;
    },
  );

  app.patch<{
    Params: { loc_id: string; zone_id: string };
    Body: {
      version: number;
      name?: string;
      fee?: number;
      minimum_order_amount?: number;
      active?: boolean;
    };
  }>(
    '/api/v1/locations/:loc_id/delivery-zones/:zone_id',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['loc_id', 'zone_id'],
          properties: { loc_id: uuid, zone_id: uuid },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['version'],
          properties: {
            version: { type: 'integer', minimum: 1 },
            name: { type: 'string', minLength: 1, maxLength: 200 },
            fee: { type: 'integer', minimum: 0 },
            minimum_order_amount: { type: 'integer', minimum: 0 },
            active: { type: 'boolean' },
          },
        },
      },
    },
    async (request) =>
      withAuthenticatedSession(app, request, new Date(), 15 * 60 * 1000, async (actor) => {
        requirePermission(actor, 'delivery.zones.write');
        requireActorLocation(actor, request.params.loc_id);

        const { zone_id } = request.params;
        const { version, name, fee, minimum_order_amount, active } = request.body;

        const existing = await actor.trx
          .selectFrom('delivery_zones')
          .selectAll()
          .where('id', '=', zone_id)
          .where('location_id', '=', actor.locationId)
          .executeTakeFirst();
        if (!existing) throw new IdentityHttpError(404, 'NOT_FOUND', 'Delivery zone was not found.');
        if (existing.version !== version)
          throw new IdentityHttpError(
            409,
            'OPTIMISTIC_CONCURRENCY_CONFLICT',
            'The delivery zone was modified since it was last read. Please refresh and try again.',
            { current_version: existing.version, current_state: adminZone(existing) },
          );

        const updated = await actor.trx
          .updateTable('delivery_zones')
          .set({
            name: name ?? existing.name,
            fee: fee ?? existing.fee,
            minimum_order_amount: minimum_order_amount ?? existing.minimum_order_amount,
            active: active ?? existing.active,
            version: sql<number>`version + 1`,
          })
          .where('id', '=', zone_id)
          .returningAll()
          .executeTakeFirstOrThrow();

        return adminZone(updated);
      }),
  );
};
