import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { sql, type RawBuilder } from 'kysely';

import { IdentityHttpError, requirePermission, withAuthenticatedSession } from '../identity/index.js';
import { findLocationArea, findLocationSection, findLocationTable } from './persistence/repository.js';
import { canTransitionTableStatus, type TableStatus } from './status.js';

const uuidSchema = { type: 'string', format: 'uuid' } as const;
const ifMatchHeader = { type: 'object', additionalProperties: true, required: ['if-match'], properties: { 'if-match': { type: 'string', pattern: '^"?[1-9][0-9]*"?$' } } } as const;

export interface FloorRouteOptions { now?: () => Date; sessionIdleMs?: number }
type TableBody = { area_id: string; name: string; min_capacity?: number; max_capacity: number; pos_x?: number; pos_y?: number };
type UpdateTableBody = Partial<TableBody>;

function fail(reply: FastifyReply, request: FastifyRequest, error: IdentityHttpError) {
  for (const [name, value] of Object.entries(error.headers ?? {})) reply.header(name, value);
  return reply.status(error.statusCode).send({ error: { status: error.statusCode, code: error.code, message: error.message, request_id: request.id, ...(error.details === undefined ? {} : { details: error.details }) } });
}

function parseIfMatch(value: string | undefined): number {
  if (!value) throw new IdentityHttpError(428, 'PRECONDITION_REQUIRED', 'If-Match is required for this update.');
  const parsed = Number(value.replaceAll('"', ''));
  if (!Number.isInteger(parsed) || parsed < 1) throw new IdentityHttpError(400, 'INVALID_IF_MATCH', 'If-Match must contain a positive integer version.');
  return parsed;
}

function capacityIsValid(min: number, max: number): boolean {
  return Number.isInteger(min) && Number.isInteger(max) && min >= 1 && max >= min;
}

function publicTable(row: { id: string; location_id: string; area_id: string; name: string; min_capacity: number; max_capacity: number; pos_x: number; pos_y: number; status: string; version: number }) {
  return { ...row };
}

/** Private HTTP implementation for the floor module. */
export const floorRoute: FastifyPluginAsync<FloorRouteOptions> = async (app, options) => {
  const now = options.now ?? (() => new Date());
  const sessionIdleMs = options.sessionIdleMs ?? 15 * 60 * 1000;
  const withSession = <T>(request: FastifyRequest, work: Parameters<typeof withAuthenticatedSession<T>>[4]) => withAuthenticatedSession(app, request, now(), sessionIdleMs, work);

  async function requireActorLocation(actor: { locationId: string }, locationId: string) {
    if (locationId !== actor.locationId) throw new IdentityHttpError(403, 'LOCATION_SCOPE_DENIED', 'The session is not scoped to the requested location.');
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof IdentityHttpError) return fail(reply, request, error);
    if (typeof error === 'object' && error !== null && 'validation' in error && (error as { validation?: unknown }).validation) return reply.status(400).send({ error: { status: 400, code: 'VALIDATION_ERROR', message: 'The request does not match the required schema.', request_id: request.id } });
    request.log.error({ err: error }, 'floor request failed');
    return reply.status(500).send({ error: { status: 500, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', request_id: request.id } });
  });

  app.get('/api/v1/locations/:locationId/areas', { schema: { params: { type: 'object', additionalProperties: false, required: ['locationId'], properties: { locationId: uuidSchema } } } }, async (request) => withSession(request, async (actor) => {
    requirePermission(actor, 'floor.layout.read'); const { locationId } = request.params as { locationId: string }; await requireActorLocation(actor, locationId);
    return { data: await actor.trx.selectFrom('areas').selectAll().where('location_id', '=', locationId).orderBy('name').execute() };
  }));
  app.post('/api/v1/locations/:locationId/areas', { schema: { params: { type: 'object', additionalProperties: false, required: ['locationId'], properties: { locationId: uuidSchema } }, body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 160 } } } } }, async (request, reply) => withSession(request, async (actor) => {
    requirePermission(actor, 'floor.layout.write'); const { locationId } = request.params as { locationId: string }; const body = request.body as { name: string }; await requireActorLocation(actor, locationId);
    return reply.status(201).send(await actor.trx.insertInto('areas').values({ location_id: locationId, name: body.name.trim() }).returningAll().executeTakeFirstOrThrow());
  }));

  app.get('/api/v1/locations/:locationId/tables', { schema: { params: { type: 'object', additionalProperties: false, required: ['locationId'], properties: { locationId: uuidSchema } } } }, async (request) => withSession(request, async (actor) => {
    requirePermission(actor, 'floor.layout.read'); const { locationId } = request.params as { locationId: string }; await requireActorLocation(actor, locationId);
    return { data: (await actor.trx.selectFrom('tables').selectAll().where('location_id', '=', locationId).orderBy('name').execute()).map(publicTable) };
  }));
  app.post('/api/v1/locations/:locationId/tables', { schema: { params: { type: 'object', additionalProperties: false, required: ['locationId'], properties: { locationId: uuidSchema } }, body: { type: 'object', additionalProperties: false, required: ['area_id', 'name', 'max_capacity'], properties: { area_id: uuidSchema, name: { type: 'string', minLength: 1, maxLength: 160 }, min_capacity: { type: 'integer', minimum: 1 }, max_capacity: { type: 'integer', minimum: 1 }, pos_x: { type: 'integer' }, pos_y: { type: 'integer' } } } } }, async (request, reply) => withSession(request, async (actor) => {
    requirePermission(actor, 'floor.layout.write'); const { locationId } = request.params as { locationId: string }; const body = request.body as TableBody; await requireActorLocation(actor, locationId);
    const min = body.min_capacity ?? 1; if (!capacityIsValid(min, body.max_capacity)) throw new IdentityHttpError(400, 'VALIDATION_ERROR', 'min_capacity must be at least 1 and cannot exceed max_capacity.');
    if (!await findLocationArea(actor.trx, locationId, body.area_id)) throw new IdentityHttpError(400, 'INVALID_AREA', 'Area does not belong to this location.');
    const table = await actor.trx.insertInto('tables').values({ location_id: locationId, area_id: body.area_id, name: body.name.trim(), min_capacity: min, max_capacity: body.max_capacity, pos_x: body.pos_x ?? 0, pos_y: body.pos_y ?? 0 }).returningAll().executeTakeFirstOrThrow();
    return reply.status(201).send(publicTable(table));
  }));

  app.put('/api/v1/tables/:id', { schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuidSchema } }, headers: ifMatchHeader, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { area_id: uuidSchema, name: { type: 'string', minLength: 1, maxLength: 160 }, min_capacity: { type: 'integer', minimum: 1 }, max_capacity: { type: 'integer', minimum: 1 }, pos_x: { type: 'integer' }, pos_y: { type: 'integer' } } } } }, async (request, reply) => withSession(request, async (actor) => {
    requirePermission(actor, 'floor.layout.write'); const id = (request.params as { id: string }).id; const body = request.body as UpdateTableBody; const expected = parseIfMatch(request.headers['if-match']);
    const current = await findLocationTable(actor.trx, actor.locationId, id); if (!current) throw new IdentityHttpError(404, 'NOT_FOUND', 'Table was not found.');
    if (body.area_id && !await findLocationArea(actor.trx, actor.locationId, body.area_id)) throw new IdentityHttpError(400, 'INVALID_AREA', 'Area does not belong to this location.');
    const min = body.min_capacity ?? current.min_capacity; const max = body.max_capacity ?? current.max_capacity;
    if (!capacityIsValid(min, max)) throw new IdentityHttpError(400, 'VALIDATION_ERROR', 'min_capacity must be at least 1 and cannot exceed max_capacity.');
    const patch: Record<string, unknown> & { version: RawBuilder<number> } = { version: sql<number>`version + 1` };
    for (const field of ['area_id', 'name', 'min_capacity', 'max_capacity', 'pos_x', 'pos_y'] as const) if (body[field] !== undefined) patch[field] = field === 'name' ? String(body[field]).trim() : body[field];
    const updated = await actor.trx.updateTable('tables').set(patch as never).where('id', '=', id).where('location_id', '=', actor.locationId).where('version', '=', expected).returningAll().executeTakeFirst();
    if (!updated) throw new IdentityHttpError(409, 'OPTIMISTIC_CONCURRENCY_CONFLICT', 'The resource has been modified since it was last read. Please refresh and try again.', { current_version: current.version, current_state: publicTable(current) });
    return reply.send(publicTable(updated));
  }));

  async function changeStatus(request: FastifyRequest, reply: FastifyReply, target: TableStatus) {
    const id = (request.params as { id: string }).id; const expected = parseIfMatch(request.headers['if-match']);
    return withSession(request, async (actor) => {
      requirePermission(actor, 'floor.tables.update_status'); const current = await findLocationTable(actor.trx, actor.locationId, id); if (!current) throw new IdentityHttpError(404, 'NOT_FOUND', 'Table was not found.');
      if (!canTransitionTableStatus(current.status as TableStatus, target)) throw new IdentityHttpError(409, 'ILLEGAL_TABLE_STATUS_TRANSITION', `Cannot transition a table from ${current.status} to ${target}.`);
      const updated = await actor.trx.updateTable('tables').set({ status: target, version: sql<number>`version + 1` }).where('id', '=', id).where('location_id', '=', actor.locationId).where('version', '=', expected).returningAll().executeTakeFirst();
      if (!updated) throw new IdentityHttpError(409, 'OPTIMISTIC_CONCURRENCY_CONFLICT', 'The resource has been modified since it was last read. Please refresh and try again.', { current_version: current.version, current_state: publicTable(current) });
      return reply.send(publicTable(updated));
    });
  }
  const statusSchema = { schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuidSchema } }, headers: ifMatchHeader, body: { type: 'object', additionalProperties: false, maxProperties: 0 } } };
  app.post('/api/v1/tables/:id/mark-needs-cleaning', statusSchema, async (request, reply) => changeStatus(request, reply, 'NEEDS_CLEANING'));
  app.post('/api/v1/tables/:id/mark-available', statusSchema, async (request, reply) => changeStatus(request, reply, 'AVAILABLE'));
  app.post('/api/v1/tables/:id/mark-out-of-service', statusSchema, async (request, reply) => changeStatus(request, reply, 'OUT_OF_ORDER'));

  app.get('/api/v1/locations/:locationId/sections', { schema: { params: { type: 'object', additionalProperties: false, required: ['locationId'], properties: { locationId: uuidSchema } } } }, async (request) => withSession(request, async (actor) => {
    requirePermission(actor, 'floor.layout.read'); const { locationId } = request.params as { locationId: string }; await requireActorLocation(actor, locationId);
    return { data: await actor.trx.selectFrom('sections').selectAll().where('location_id', '=', locationId).orderBy('name').execute() };
  }));
  app.post('/api/v1/locations/:locationId/sections', { schema: { params: { type: 'object', additionalProperties: false, required: ['locationId'], properties: { locationId: uuidSchema } }, body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 160 } } } } }, async (request, reply) => withSession(request, async (actor) => {
    requirePermission(actor, 'floor.layout.write'); const { locationId } = request.params as { locationId: string }; const body = request.body as { name: string }; await requireActorLocation(actor, locationId);
    return reply.status(201).send(await actor.trx.insertInto('sections').values({ location_id: locationId, name: body.name.trim() }).returningAll().executeTakeFirstOrThrow());
  }));
  app.put('/api/v1/sections/:id/tables', { schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuidSchema } }, body: { type: 'object', additionalProperties: false, required: ['table_ids'], properties: { table_ids: { type: 'array', uniqueItems: true, items: uuidSchema } } } } }, async (request, reply) => withSession(request, async (actor) => {
    requirePermission(actor, 'floor.sections.assign'); const id = (request.params as { id: string }).id; const { table_ids } = request.body as { table_ids: string[] };
    const section = await findLocationSection(actor.trx, actor.locationId, id); if (!section) throw new IdentityHttpError(404, 'NOT_FOUND', 'Section was not found.');
    const rows = table_ids.length ? await actor.trx.selectFrom('tables').select('id').where('location_id', '=', actor.locationId).where('id', 'in', table_ids).execute() : [];
    if (rows.length !== table_ids.length) throw new IdentityHttpError(400, 'INVALID_TABLE', 'Every table must belong to this location.');
    await actor.trx.deleteFrom('table_sections').where('section_id', '=', id).execute();
    if (table_ids.length) await actor.trx.insertInto('table_sections').values(table_ids.map((table_id) => ({ table_id, section_id: id }))).execute();
    return reply.send({ section_id: id, table_ids });
  }));
};
