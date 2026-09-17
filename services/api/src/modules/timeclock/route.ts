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

export interface TimeclockRouteOptions {
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

export const timeclockRoute: FastifyPluginAsync<TimeclockRouteOptions> = async (app, options) => {
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
    request.log.error({ err: error }, 'timeclock request failed');
    return reply.status(500).send({
      error: {
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
        request_id: request.id,
      },
    });
  });

  app.get('/api/v1/staff/me/shifts', async (request) =>
    withStaffSession(request, async (actor) => {
      // No special permission is required beyond a valid staff session.
      const shifts = await actor.trx
        .selectFrom('timeclock_shifts')
        .selectAll()
        .where('staff_id', '=', actor.staffId)
        .where('location_id', '=', actor.locationId)
        .orderBy('created_at', 'desc')
        .limit(100)
        .execute();
      return { data: shifts };
    })
  );

  app.post('/api/v1/locations/:loc_id/shifts/clock-in', {
    schema: {
      params: { type: 'object', properties: { loc_id: uuidSchema }, required: ['loc_id'] }
    }
  }, async (request, reply) => {
    const res = await withStaffSession(request, async (actor) => {
      const { loc_id } = request.params as { loc_id: string };
      if (actor.locationId !== loc_id) {
        throw new IdentityHttpError(403, 'LOCATION_SCOPE_DENIED', 'Session is not scoped to requested location.');
      }
      requirePermission(actor, 'timeclock.shifts.clock');

      const existingOpen = await actor.trx
        .selectFrom('timeclock_shifts')
        .selectAll()
        .where('staff_id', '=', actor.staffId)
        .where('location_id', '=', loc_id)
        .where('status', '=', 'OPEN')
        .executeTakeFirst();
      
      if (existingOpen) {
        throw new IdentityHttpError(409, 'ALREADY_CLOCKED_IN', 'Staff member already has an open shift at this location.');
      }

      return actor.trx
        .insertInto('timeclock_shifts')
        .values({
          location_id: loc_id,
          staff_id: actor.staffId,
          status: 'OPEN',
          clocked_in_at: now(),
          clocked_in_by_staff_id: actor.staffId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return reply.status(201).send(res);
  });

  app.post('/api/v1/locations/:loc_id/shifts/:id/clock-out', {
    schema: {
      params: { type: 'object', properties: { loc_id: uuidSchema, id: uuidSchema }, required: ['loc_id', 'id'] },
      headers: ifMatchHeader
    }
  }, async (request, reply) => {
    const res = await withStaffSession(request, async (actor) => {
      const { loc_id, id } = request.params as { loc_id: string, id: string };
      if (actor.locationId !== loc_id) {
        throw new IdentityHttpError(403, 'LOCATION_SCOPE_DENIED', 'Session is not scoped to requested location.');
      }
      
      const expected = parseIfMatch(request.headers['if-match']);

      const current = await actor.trx
        .selectFrom('timeclock_shifts')
        .selectAll()
        .where('id', '=', id)
        .where('location_id', '=', loc_id)
        .executeTakeFirst();

      if (!current) throw new IdentityHttpError(404, 'NOT_FOUND', 'Shift not found.');
      if (current.version !== expected) throw conflict(current, current);
      if (current.status === 'CLOSED') throw new IdentityHttpError(409, 'ALREADY_CLOSED', 'Shift is already closed.');

      // Conditional self-vs-other permission check on clock-out must correctly read actor.staffId
      // and compare it against the target shift's staff_id BEFORE deciding which permission to require.
      if (current.staff_id === actor.staffId) {
        requirePermission(actor, 'timeclock.shifts.clock');
      } else {
        requirePermission(actor, 'timeclock.shifts.write');
      }

      const updated = await actor.trx
        .updateTable('timeclock_shifts')
        .set({
          status: 'CLOSED',
          clocked_out_at: now(),
          clocked_out_by_staff_id: actor.staffId,
          version: sql<number>`version + 1`
        })
        .where('id', '=', id)
        .where('version', '=', expected)
        .returningAll()
        .executeTakeFirst();

      if (!updated) throw conflict(current, current);
      return updated;
    });
    return reply.status(200).send(res);
  });

  app.get('/api/v1/locations/:loc_id/shifts', {
    schema: {
      params: { type: 'object', properties: { loc_id: uuidSchema }, required: ['loc_id'] },
      querystring: {
        type: 'object',
        properties: {
          staff_id: { type: 'string', format: 'uuid' },
          start_date: { type: 'string', format: 'date-time' },
          end_date: { type: 'string', format: 'date-time' }
        }
      }
    }
  }, async (request) =>
    withStaffSession(request, async (actor) => {
      const { loc_id } = request.params as { loc_id: string };
      if (actor.locationId !== loc_id) {
        throw new IdentityHttpError(403, 'LOCATION_SCOPE_DENIED', 'Session is not scoped to requested location.');
      }
      requirePermission(actor, 'timeclock.shifts.read');

      const { staff_id, start_date, end_date } = request.query as { staff_id?: string, start_date?: string, end_date?: string };
      
      let query = actor.trx
        .selectFrom('timeclock_shifts')
        .selectAll()
        .where('location_id', '=', loc_id)
        .orderBy('created_at', 'desc')
        .limit(200);
      
      if (staff_id) {
        query = query.where('staff_id', '=', staff_id);
      }
      if (start_date) {
        query = query.where('clocked_in_at', '>=', new Date(start_date));
      }
      if (end_date) {
        query = query.where('clocked_in_at', '<=', new Date(end_date));
      }

      const shifts = await query.execute();
      return { data: shifts };
    })
  );

  app.post('/api/v1/locations/:loc_id/shifts', {
    schema: {
      params: { type: 'object', properties: { loc_id: uuidSchema }, required: ['loc_id'] },
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['staff_id', 'status', 'clocked_in_at'],
        properties: {
          staff_id: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['OPEN', 'CLOSED'] },
          clocked_in_at: { type: 'string', format: 'date-time' },
          clocked_out_at: { type: ['string', 'null'], format: 'date-time' }
        }
      }
    }
  }, async (request, reply) => {
    const res = await withStaffSession(request, async (actor) => {
      const { loc_id } = request.params as { loc_id: string };
      if (actor.locationId !== loc_id) {
        throw new IdentityHttpError(403, 'LOCATION_SCOPE_DENIED', 'Session is not scoped to requested location.');
      }
      requirePermission(actor, 'timeclock.shifts.write');

      const body = request.body as { staff_id: string, status: 'OPEN' | 'CLOSED', clocked_in_at: string, clocked_out_at?: string | null };

      return actor.trx
        .insertInto('timeclock_shifts')
        .values({
          location_id: loc_id,
          staff_id: body.staff_id,
          status: body.status,
          clocked_in_at: new Date(body.clocked_in_at),
          clocked_out_at: body.clocked_out_at ? new Date(body.clocked_out_at) : null,
          clocked_in_by_staff_id: actor.staffId,
          clocked_out_by_staff_id: (body.status === 'CLOSED' && body.clocked_out_at) ? actor.staffId : null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return reply.status(201).send(res);
  });

  app.put('/api/v1/locations/:loc_id/shifts/:id', {
    schema: {
      params: { type: 'object', properties: { loc_id: uuidSchema, id: uuidSchema }, required: ['loc_id', 'id'] },
      headers: ifMatchHeader,
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['OPEN', 'CLOSED'] },
          clocked_in_at: { type: 'string', format: 'date-time' },
          clocked_out_at: { type: ['string', 'null'], format: 'date-time' }
        }
      }
    }
  }, async (request) => {
    return withStaffSession(request, async (actor) => {
      const { loc_id, id } = request.params as { loc_id: string, id: string };
      if (actor.locationId !== loc_id) {
        throw new IdentityHttpError(403, 'LOCATION_SCOPE_DENIED', 'Session is not scoped to requested location.');
      }
      requirePermission(actor, 'timeclock.shifts.write');

      const expected = parseIfMatch(request.headers['if-match']);
      const body = request.body as { status?: 'OPEN' | 'CLOSED', clocked_in_at?: string, clocked_out_at?: string | null };

      const current = await actor.trx
        .selectFrom('timeclock_shifts')
        .selectAll()
        .where('id', '=', id)
        .where('location_id', '=', loc_id)
        .executeTakeFirst();

      if (!current) throw new IdentityHttpError(404, 'NOT_FOUND', 'Shift not found.');
      if (current.version !== expected) throw conflict(current, current);

      const status = body.status ?? current.status;
      const clocked_in_at = body.clocked_in_at ? new Date(body.clocked_in_at) : current.clocked_in_at;
      const clocked_out_at = body.clocked_out_at !== undefined ? (body.clocked_out_at ? new Date(body.clocked_out_at) : null) : current.clocked_out_at;

      const updated = await actor.trx
        .updateTable('timeclock_shifts')
        .set({
          status,
          clocked_in_at,
          clocked_out_at,
          version: sql<number>`version + 1`
        })
        .where('id', '=', id)
        .where('version', '=', expected)
        .returningAll()
        .executeTakeFirst();
      
      if (!updated) throw conflict(current, current);
      return updated;
    });
  });
};
