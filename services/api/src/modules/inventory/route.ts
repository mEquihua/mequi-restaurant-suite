import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';

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

export interface InventoryRouteOptions {
  now?: () => Date;
  sessionIdleMs?: number;
}

function fail(reply: FastifyReply, request: FastifyRequest, error: IdentityHttpError) {
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

export const inventoryRoute: FastifyPluginAsync<InventoryRouteOptions> = async (app, options) => {
  const now = options.now ?? (() => new Date());
  const sessionIdleMs = options.sessionIdleMs ?? 15 * 60 * 1000;
  const withSession = <T>(
    request: FastifyRequest,
    work: Parameters<typeof withAuthenticatedSession<T>>[4],
  ) => withAuthenticatedSession(app, request, now(), sessionIdleMs, work);

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
    request.log.error({ err: error }, 'inventory request failed');
    return reply.status(500).send({
      error: {
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
        request_id: request.id,
      },
    });
  });

  app.get(
    '/api/v1/ingredients',
    { schema: {} },
    async (request) =>
      withSession(request, async (actor) => {
        requirePermission(actor, 'inventory.ingredients.read');
        const ingredients = await actor.trx
          .selectFrom('ingredients')
          .selectAll()
          .where('organization_id', '=', actor.organizationId)
          .orderBy('name')
          .execute();
        return { data: ingredients };
      }),
  );

  app.post(
    '/api/v1/ingredients',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'unit_of_measure'],
          properties: {
            name: { type: 'string', minLength: 1 },
            unit_of_measure: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await withSession(request, async (actor) => {
        requirePermission(actor, 'inventory.ingredients.write');
        const body = request.body as { name: string; unit_of_measure: string };
        const ingredient = await actor.trx
          .insertInto('ingredients')
          .values({
            organization_id: actor.organizationId,
            name: body.name.trim(),
            unit_of_measure: body.unit_of_measure.trim(),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return ingredient;
      });
      return reply.status(201).send(result);
    },
  );

  app.put(
    '/api/v1/ingredients/:id',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: uuidSchema },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: { type: 'string', minLength: 1 },
            unit_of_measure: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await withSession(request, async (actor) => {
        requirePermission(actor, 'inventory.ingredients.write');
        const id = (request.params as { id: string }).id;
        const body = request.body as { name?: string; unit_of_measure?: string };
        const patch: Record<string, unknown> = {};
        if (body.name !== undefined) patch.name = body.name.trim();
        if (body.unit_of_measure !== undefined) patch.unit_of_measure = body.unit_of_measure.trim();

        const updated = await actor.trx
          .updateTable('ingredients')
          .set(patch as never)
          .where('id', '=', id)
          .where('organization_id', '=', actor.organizationId)
          .returningAll()
          .executeTakeFirst();
        
        if (!updated) {
          throw new IdentityHttpError(404, 'NOT_FOUND', 'Ingredient was not found.');
        }
        return updated;
      });
      return reply.send(result);
    },
  );

  app.get(
    '/api/v1/recipes',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            product_id: uuidSchema,
          },
        },
      },
    },
    async (request) =>
      withSession(request, async (actor) => {
        requirePermission(actor, 'inventory.recipes.read');
        const query = request.query as { product_id?: string };
        let q = actor.trx
          .selectFrom('recipe_lines')
          .selectAll()
          .where('organization_id', '=', actor.organizationId);
        
        if (query.product_id) {
          q = q.where('product_id', '=', query.product_id);
        }
        const lines = await q.execute();
        return { data: lines };
      }),
  );

  app.post(
    '/api/v1/recipes',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['ingredient_id', 'quantity_per_unit'],
          properties: {
            product_id: { anyOf: [uuidSchema, { type: 'null' }] },
            variant_id: { anyOf: [uuidSchema, { type: 'null' }] },
            modifier_id: { anyOf: [uuidSchema, { type: 'null' }] },
            ingredient_id: uuidSchema,
            quantity_per_unit: { type: 'number' },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await withSession(request, async (actor) => {
        requirePermission(actor, 'inventory.recipes.write');
        const body = request.body as {
          product_id?: string | null;
          variant_id?: string | null;
          modifier_id?: string | null;
          ingredient_id: string;
          quantity_per_unit: string | number;
        };

        const hasProduct = body.product_id != null;
        const hasModifier = body.modifier_id != null;

        if (hasProduct === hasModifier) {
             throw new IdentityHttpError(
                 400,
                 'VALIDATION_ERROR',
                 'Exactly one of product_id or modifier_id must be provided.'
             );
        }

        const qty = String(body.quantity_per_unit);
        if (isNaN(parseFloat(qty))) {
             throw new IdentityHttpError(400, 'VALIDATION_ERROR', 'quantity_per_unit must be a number.');
        }

        const line = await actor.trx
          .insertInto('recipe_lines')
          .values({
            organization_id: actor.organizationId,
            product_id: body.product_id ?? null,
            variant_id: body.variant_id ?? null,
            modifier_id: body.modifier_id ?? null,
            ingredient_id: body.ingredient_id,
            quantity_per_unit: qty,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return line;
      });
      return reply.status(201).send(result);
    },
  );

  app.delete(
    '/api/v1/recipes/:id',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: uuidSchema },
        },
      },
    },
    async (request, reply) => {
      await withSession(request, async (actor) => {
        requirePermission(actor, 'inventory.recipes.write');
        const id = (request.params as { id: string }).id;
        const deleted = await actor.trx
          .deleteFrom('recipe_lines')
          .where('id', '=', id)
          .where('organization_id', '=', actor.organizationId)
          .executeTakeFirst();
        
        if (Number(deleted.numDeletedRows) === 0) {
          throw new IdentityHttpError(404, 'NOT_FOUND', 'Recipe line was not found.');
        }
      });
      return reply.status(204).send();
    },
  );

  app.get(
    '/api/v1/locations/:locationId/inventory',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId'],
          properties: { locationId: uuidSchema },
        },
      },
    },
    async (request) =>
      withSession(request, async (actor) => {
        requirePermission(actor, 'inventory.stock.read');
        const locationId = (request.params as { locationId: string }).locationId;
        if (actor.locationId !== locationId)
          throw new IdentityHttpError(403, 'LOCATION_SCOPE_DENIED', 'Wrong location scope.');
        
        const results = await actor.trx
          .selectFrom('ingredients as i')
          .leftJoin('ingredient_stock as s', join => 
              join.onRef('s.ingredient_id', '=', 'i.id')
                  .on('s.location_id', '=', locationId)
          )
          .selectAll('i')
          .select([
             's.quantity_on_hand',
             's.low_stock_threshold',
             's.version',
             's.id as stock_id'
          ])
          .where('i.organization_id', '=', actor.organizationId)
          .execute();
          
        return { data: results };
      }),
  );

  app.get(
    '/api/v1/locations/:locationId/inventory/low-stock',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId'],
          properties: { locationId: uuidSchema },
        },
      },
    },
    async (request) =>
      withSession(request, async (actor) => {
        requirePermission(actor, 'inventory.stock.read');
        const locationId = (request.params as { locationId: string }).locationId;
        if (actor.locationId !== locationId)
          throw new IdentityHttpError(403, 'LOCATION_SCOPE_DENIED', 'Wrong location scope.');
        
        const results = await actor.trx
          .selectFrom('ingredients as i')
          .innerJoin('ingredient_stock as s', 's.ingredient_id', 'i.id')
          .selectAll('i')
          .select([
             's.quantity_on_hand',
             's.low_stock_threshold',
             's.version',
             's.id as stock_id'
          ])
          .where('i.organization_id', '=', actor.organizationId)
          .where('s.location_id', '=', locationId)
          .where(eb => eb('s.low_stock_threshold', 'is not', null))
          .whereRef('s.quantity_on_hand', '<=', 's.low_stock_threshold')
          .execute();
          
        return { data: results };
      }),
  );

  app.post(
    '/api/v1/locations/:locationId/inventory/:ingredientId/adjust',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['locationId', 'ingredientId'],
          properties: { locationId: uuidSchema, ingredientId: uuidSchema },
        },
        headers: ifMatchHeader,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['new_quantity', 'reason'],
          properties: {
             new_quantity: { type: 'number' },
             reason: { type: 'string', minLength: 1 }
          },
        },
      },
    },
    async (request, reply) => {
      const result = await withSession(request, async (actor) => {
        requirePermission(actor, 'inventory.stock.adjust');
        const locationId = (request.params as { locationId: string }).locationId;
        const ingredientId = (request.params as { ingredientId: string }).ingredientId;
        if (actor.locationId !== locationId)
          throw new IdentityHttpError(403, 'LOCATION_SCOPE_DENIED', 'Wrong location scope.');

        const body = request.body as { new_quantity: string | number; reason: string };
        const newQtyStr = String(body.new_quantity);
        const newQty = parseFloat(newQtyStr);
        if (isNaN(newQty)) {
             throw new IdentityHttpError(400, 'VALIDATION_ERROR', 'new_quantity must be a number.');
        }

        const ingredient = await actor.trx
            .selectFrom('ingredients')
            .select('id')
            .where('id', '=', ingredientId)
            .where('organization_id', '=', actor.organizationId)
            .executeTakeFirst();
        if (!ingredient) throw new IdentityHttpError(404, 'NOT_FOUND', 'Ingredient was not found.');

        const currentStock = await actor.trx
            .selectFrom('ingredient_stock')
            .selectAll()
            .where('ingredient_id', '=', ingredientId)
            .where('location_id', '=', locationId)
            .executeTakeFirst();

        // Matching the module-center convention: If-Match is only required and
        // validated once a row exists. A first-ever adjustment for an
        // ingredient with no tracked stock yet just creates it at the schema
        // default version (1) — there is nothing to conflict with.
        let updated;
        if (!currentStock) {
           updated = await actor.trx
             .insertInto('ingredient_stock')
             .values({
                 location_id: locationId,
                 ingredient_id: ingredientId,
                 quantity_on_hand: newQtyStr,
             })
             .returningAll()
             .executeTakeFirstOrThrow();
        } else {
           const expectedVersion = parseIfMatch(request.headers['if-match']);
           updated = await actor.trx
             .updateTable('ingredient_stock')
             .set({
                 quantity_on_hand: newQtyStr,
                 version: sql<number>`version + 1`
             })
             .where('id', '=', currentStock.id)
             .where('version', '=', expectedVersion)
             .returningAll()
             .executeTakeFirst();
           if (!updated)
             throw new IdentityHttpError(
                 409,
                 'OPTIMISTIC_CONCURRENCY_CONFLICT',
                 'The resource has been modified since it was last read. Please refresh and try again.',
                 { current_version: currentStock.version, current_state: currentStock }
             );
        }

        const currentQty = currentStock ? parseFloat(currentStock.quantity_on_hand) : 0;
        const delta = newQty - currentQty;

        const adjustment = await actor.trx
            .insertInto('stock_adjustments')
            .values({
                location_id: locationId,
                ingredient_id: ingredientId,
                staff_id: actor.staffId,
                quantity_delta: String(delta),
                reason: body.reason
            })
            .returningAll()
            .executeTakeFirstOrThrow();

        return { stock: updated, adjustment };
      });
      return reply.send(result);
    },
  );
};
