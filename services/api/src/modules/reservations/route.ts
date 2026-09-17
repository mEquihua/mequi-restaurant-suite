import { createHash, randomBytes } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';

import {
  IdentityHttpError,
  requirePermission,
  withAuthenticatedSession,
} from '../identity/index.js';
import { CustomerSessionHttpError, withCustomerSession } from '../customers/index.js';
import type { DatabaseTransaction } from '../../shared/index.js';

interface ReservationSettingsRow {
  accepts_reservations: boolean;
  operating_hours: Array<{ day_of_week: number; open_time: string; close_time: string }>;
  estimated_visit_duration_minutes: number;
  minimum_lead_time_minutes: number;
  maximum_party_size: number;
  auto_confirm: boolean;
  version: number;
}

interface ReservationRequestBody {
  party_size: number;
  reservation_time: string;
  customer_name: string;
  customer_email?: string | null;
  customer_phone?: string | null;
  special_requests?: string | null;
}

interface ReservationUpdateBody {
  party_size?: number;
  reservation_time?: string;
  customer_name?: string;
  customer_email?: string | null;
  customer_phone?: string | null;
  special_requests?: string | null;
}

interface SeatBody {
  table_id: string;
}

type SettingsBody = ReservationSettingsRow;

const uuid = { type: 'string', format: 'uuid' } as const;
const ifMatch = {
  type: 'object',
  additionalProperties: true,
  required: ['if-match'],
  properties: { 'if-match': { type: 'string', pattern: '^"?[1-9][0-9]*"?$' } },
} as const;

function fail(reply: FastifyReply, request: FastifyRequest, error: IdentityHttpError | CustomerSessionHttpError) {
  for (const [name, value] of Object.entries((error as IdentityHttpError).headers ?? {})) reply.header(name, value as string);
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

const expected = (value: string | undefined) => {
  if (!value)
    throw new IdentityHttpError(428, 'PRECONDITION_REQUIRED', 'If-Match is required for this update.');
  const n = Number(value.replaceAll('"', ''));
  if (!Number.isInteger(n) || n < 1)
    throw new IdentityHttpError(400, 'INVALID_IF_MATCH', 'If-Match must contain a positive integer version.');
  return n;
};

const conflict = (row: { version: number }, state: unknown) =>
  new IdentityHttpError(
    409,
    'OPTIMISTIC_CONCURRENCY_CONFLICT',
    'Resource modified since last read.',
    { current_version: row.version, current_state: state },
  );

function createGuestToken(): string {
  return randomBytes(32).toString('base64url');
}

function hashGuestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export const reservationsModule: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof IdentityHttpError || error instanceof CustomerSessionHttpError) return fail(reply, request, error);
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
    request.log.error({ err: error }, 'reservations request failed');
    return reply.status(500).send({
      error: {
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
        request_id: request.id,
      },
    });
  });

  const getSettings = async (trx: DatabaseTransaction, loc_id: string): Promise<ReservationSettingsRow> => {
    const settings = await trx
      .selectFrom('reservation_settings')
      .selectAll()
      .where('location_id', '=', loc_id)
      .executeTakeFirst();
    if (!settings) {
      return {
        accepts_reservations: false,
        operating_hours: [],
        estimated_visit_duration_minutes: 90,
        minimum_lead_time_minutes: 60,
        maximum_party_size: 8,
        auto_confirm: false,
        version: 1,
      };
    }
    return settings as unknown as ReservationSettingsRow;
  };

  const validateRequest = (settings: ReservationSettingsRow, body: ReservationRequestBody, now: Date) => {
    if (!settings.accepts_reservations) {
      throw new IdentityHttpError(400, 'RESERVATIONS_NOT_ACCEPTED', 'Location does not accept reservations.');
    }
    if (body.party_size > settings.maximum_party_size) {
      throw new IdentityHttpError(400, 'PARTY_SIZE_TOO_LARGE', 'Party size exceeds the maximum allowed.');
    }
    const reqTime = new Date(body.reservation_time);
    const leadTimeMinutes = (reqTime.getTime() - now.getTime()) / 60000;
    if (leadTimeMinutes < settings.minimum_lead_time_minutes) {
      throw new IdentityHttpError(400, 'LEAD_TIME_TOO_SHORT', 'Reservation lead time is too short.');
    }
    
    const dayOfWeek = reqTime.getDay() || 7; // 1-7 ISO
    const hoursStr = reqTime.getHours().toString().padStart(2, '0') + ':' + reqTime.getMinutes().toString().padStart(2, '0');
    
    const dayHours = (settings.operating_hours || []).find((h) => h.day_of_week === dayOfWeek);
    if (!dayHours || hoursStr < dayHours.open_time || hoursStr > dayHours.close_time) {
      throw new IdentityHttpError(400, 'OUTSIDE_OPERATING_HOURS', 'Reservation time is outside operating hours.');
    }
  };

  app.post<{ Params: { loc_id: string }; Body: ReservationRequestBody }>('/api/v1/locations/:loc_id/reservations/request', {
    schema: {
      params: { type: 'object', properties: { loc_id: uuid }, required: ['loc_id'] },
      body: {
        type: 'object',
        required: ['party_size', 'reservation_time', 'customer_name'],
        properties: {
          party_size: { type: 'integer', minimum: 1 },
          reservation_time: { type: 'string', format: 'date-time' },
          customer_name: { type: 'string', minLength: 1 },
          customer_email: { type: 'string', nullable: true },
          customer_phone: { type: 'string', nullable: true },
          special_requests: { type: 'string', nullable: true },
        }
      }
    }
  }, async (request, reply) => {
    const { loc_id } = request.params;
    let customerId: string | null = null;
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer customer.')) {
      await withCustomerSession(app, request, new Date(), async (session) => {
        customerId = session.customerId;
      });
    }

    const result = await app.withLocationTransaction(loc_id, async (trx) => {
      const settings = await getSettings(trx, loc_id);
      validateRequest(settings, request.body, new Date());

      const status = settings.auto_confirm ? 'CONFIRMED' : 'REQUESTED';
      let guestTokenHash: string | null = null;
      let guestToken: string | null = null;

      if (!customerId) {
        guestToken = createGuestToken();
        guestTokenHash = hashGuestToken(guestToken);
      }

      const reservation = await trx.insertInto('reservations').values({
        location_id: loc_id,
        customer_id: customerId,
        party_size: request.body.party_size,
        reservation_time: new Date(request.body.reservation_time),
        status,
        customer_name: request.body.customer_name,
        customer_email: request.body.customer_email ?? null,
        customer_phone: request.body.customer_phone ?? null,
        special_requests: request.body.special_requests ?? null,
        guest_token_hash: guestTokenHash,
      }).returning('id').executeTakeFirstOrThrow();

      return { reservation_id: reservation.id, guest_token: guestToken };
    });

    return reply.status(201).send(result);
  });

  app.get<{ Params: { loc_id: string; id: string }; Querystring: { guest_token?: string } }>('/api/v1/locations/:loc_id/reservations/:id', {
    schema: {
      params: { type: 'object', properties: { loc_id: uuid, id: uuid }, required: ['loc_id', 'id'] },
      querystring: { type: 'object', properties: { guest_token: { type: 'string' } } }
    }
  }, async (request) => {
    const { loc_id, id } = request.params;
    
    // Staff tokens have no distinguishing prefix (wire format is
    // `${locationId}.${secret}`), unlike customer (`customer.${orgId}.${secret}`)
    // and guest (`guest.${locationId}.${secret}`) tokens. So branch on the
    // customer prefix first, and treat anything else that is present as an
    // attempted staff session — a genuine auth failure there propagates as a
    // real 401/403 instead of silently falling through to the guest path.
    let isStaff = false;
    let authCustomerId: string | null = null;
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer customer.')) {
      await withCustomerSession(app, request, new Date(), async (session) => {
        authCustomerId = session.customerId;
      });
    } else if (authHeader) {
      await withAuthenticatedSession(app, request, new Date(), 15 * 60 * 1000, async (actor) => {
        requirePermission(actor, 'reservations.reservations.read');
        isStaff = true;
      });
    }

    return app.withLocationTransaction(loc_id, async (trx) => {
      const reservation = await trx.selectFrom('reservations').selectAll().where('id', '=', id).where('location_id', '=', loc_id).executeTakeFirst();
      if (!reservation) throw new IdentityHttpError(404, 'NOT_FOUND', 'Reservation not found.');

      if (!isStaff) {
        if (reservation.customer_id) {
          if (reservation.customer_id !== authCustomerId) {
            throw new IdentityHttpError(403, 'FORBIDDEN', 'Access denied.');
          }
        } else {
          const presentedHash = request.query.guest_token ? hashGuestToken(request.query.guest_token) : null;
          if (!presentedHash || presentedHash !== reservation.guest_token_hash) {
            throw new IdentityHttpError(403, 'FORBIDDEN', 'Access denied.');
          }
        }
      }

      return reservation;
    });
  });

  app.post<{ Params: { loc_id: string; id: string }; Querystring: { guest_token?: string }; Body: { guest_token?: string } | undefined }>('/api/v1/locations/:loc_id/reservations/:id/cancel', {
    schema: {
      params: { type: 'object', properties: { loc_id: uuid, id: uuid }, required: ['loc_id', 'id'] },
      querystring: { type: 'object', properties: { guest_token: { type: 'string' } } },
      // No `body` schema: a staff/customer cancel legitimately sends no body
      // at all (see apps/staff/src/host/HostMode.tsx's updateStatus, which
      // omits the request body entirely for actions with no payload) —
      // Fastify's AJV validation rejects a `type: object` body schema when no
      // body is present ("body must be object"), so this is intentionally
      // left unvalidated and read defensively below instead.
      headers: ifMatch
    }
  }, async (request, reply) => {
    const { loc_id, id } = request.params;
    const v = expected(request.headers['if-match'] as string | undefined);
    
    let isStaff = false;
    let staffId: string | null = null;
    let authCustomerId: string | null = null;

    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer customer.')) {
      await withCustomerSession(app, request, new Date(), async (session) => {
        authCustomerId = session.customerId;
      });
    } else if (authHeader) {
      await withAuthenticatedSession(app, request, new Date(), 15 * 60 * 1000, async (actor) => {
        requirePermission(actor, 'reservations.reservations.cancel');
        isStaff = true;
        staffId = actor.staffId;
      });
    }

    const updated = await app.withLocationTransaction(loc_id, async (trx) => {
      const reservation = await trx.selectFrom('reservations').selectAll().where('id', '=', id).where('location_id', '=', loc_id).executeTakeFirst();
      if (!reservation) throw new IdentityHttpError(404, 'NOT_FOUND', 'Reservation not found.');
      if (reservation.version !== v) throw conflict(reservation, reservation);

      if (!isStaff) {
        if (reservation.customer_id) {
          if (reservation.customer_id !== authCustomerId) {
            throw new IdentityHttpError(403, 'FORBIDDEN', 'Access denied.');
          }
        } else {
          const passedToken = (request.query as { guest_token?: string })?.guest_token
            ?? (request.body as { guest_token?: string } | undefined)?.guest_token;
          const presentedHash = passedToken ? hashGuestToken(passedToken) : null;
          if (!presentedHash || presentedHash !== reservation.guest_token_hash) {
            throw new IdentityHttpError(403, 'FORBIDDEN', 'Access denied.');
          }
        }
      }

      if (!['REQUESTED', 'CONFIRMED'].includes(reservation.status)) {
        throw new IdentityHttpError(409, 'ILLEGAL_RESERVATION_STATUS_TRANSITION', 'Cannot cancel from current status.');
      }

      const res = await trx.updateTable('reservations')
        .set({ status: 'CANCELLED', cancelled_by_staff_id: staffId, version: sql<number>`version + 1` })
        .where('id', '=', id).where('version', '=', v)
        .returningAll().executeTakeFirst();
      if (!res) throw conflict(reservation, reservation);
      return res;
    });

    return reply.status(200).send(updated);
  });

  app.get('/api/v1/customers/me/reservations', {}, async (request) => {
    return withCustomerSession(app, request, new Date(), async ({ organizationId, customerId }) => {
      // `reservations` has location-scoped RLS (app.current_location_id), but a
      // customer session only sets app.current_organization_id (it may span
      // several locations in the org). A plain query here under the customer's
      // own transaction would silently match zero rows regardless of what
      // exists, since the RESTRICTIVE policy's location_id comparison is never
      // satisfied. Resolve the organization's locations first, then query each
      // one's own reservations for this customer and merge — the same
      // technique already used for cross-location report aggregation.
      const locations = await app.db
        .selectFrom('locations')
        .select('id')
        .where('organization_id', '=', organizationId)
        .execute();
      const perLocation = await Promise.all(
        locations.map((loc) =>
          app.withLocationTransaction(loc.id, (trx) =>
            trx
              .selectFrom('reservations')
              .selectAll()
              .where('customer_id', '=', customerId)
              .execute(),
          ),
        ),
      );
      const reservations = perLocation
        .flat()
        .sort((a, b) => b.reservation_time.getTime() - a.reservation_time.getTime());
      return { data: reservations };
    });
  });

  app.get<{ Params: { loc_id: string } }>('/api/v1/locations/:loc_id/reservations', {
    schema: {
      params: { type: 'object', properties: { loc_id: uuid }, required: ['loc_id'] }
    }
  }, async (request) => {
    const { loc_id } = request.params;
    return withAuthenticatedSession(app, request, new Date(), 15 * 60 * 1000, async (actor) => {
      requirePermission(actor, 'reservations.reservations.read');
      return app.withLocationTransaction(loc_id, async (trx) => {
        const reservations = await trx.selectFrom('reservations')
          .selectAll()
          .where('location_id', '=', loc_id)
          .orderBy('reservation_time', 'asc')
          .execute();
        return { data: reservations };
      });
    });
  });

  app.post<{ Params: { loc_id: string }; Body: ReservationRequestBody }>('/api/v1/locations/:loc_id/reservations', {
    schema: {
      params: { type: 'object', properties: { loc_id: uuid }, required: ['loc_id'] },
      body: {
        type: 'object',
        required: ['party_size', 'reservation_time', 'customer_name'],
        properties: {
          party_size: { type: 'integer', minimum: 1 },
          reservation_time: { type: 'string', format: 'date-time' },
          customer_name: { type: 'string', minLength: 1 },
          customer_email: { type: 'string', nullable: true },
          customer_phone: { type: 'string', nullable: true },
          special_requests: { type: 'string', nullable: true },
        }
      }
    }
  }, async (request, reply) => {
    const { loc_id } = request.params;
    return withAuthenticatedSession(app, request, new Date(), 15 * 60 * 1000, async (actor) => {
      requirePermission(actor, 'reservations.reservations.write');
      const res = await app.withLocationTransaction(loc_id, async (trx) => {
        return trx.insertInto('reservations').values({
          location_id: loc_id,
          party_size: request.body.party_size,
          reservation_time: new Date(request.body.reservation_time),
          status: 'CONFIRMED',
          customer_name: request.body.customer_name,
          customer_email: request.body.customer_email ?? null,
          customer_phone: request.body.customer_phone ?? null,
          special_requests: request.body.special_requests ?? null,
          confirmed_by_staff_id: actor.staffId,
        }).returningAll().executeTakeFirstOrThrow();
      });
      return reply.status(201).send(res);
    });
  });

  app.put<{ Params: { loc_id: string; id: string }; Body: ReservationUpdateBody }>('/api/v1/locations/:loc_id/reservations/:id', {
    schema: {
      params: { type: 'object', properties: { loc_id: uuid, id: uuid }, required: ['loc_id', 'id'] },
      headers: ifMatch,
      body: {
        type: 'object',
        properties: {
          party_size: { type: 'integer', minimum: 1 },
          reservation_time: { type: 'string', format: 'date-time' },
          customer_name: { type: 'string', minLength: 1 },
          customer_email: { type: 'string', nullable: true },
          customer_phone: { type: 'string', nullable: true },
          special_requests: { type: 'string', nullable: true },
        }
      }
    }
  }, async (request, reply) => {
    const { loc_id, id } = request.params;
    const v = expected(request.headers['if-match'] as string | undefined);
    return withAuthenticatedSession(app, request, new Date(), 15 * 60 * 1000, async (actor) => {
      requirePermission(actor, 'reservations.reservations.write');
      const res = await app.withLocationTransaction(loc_id, async (trx) => {
        const reservation = await trx.selectFrom('reservations').selectAll().where('id', '=', id).where('location_id', '=', loc_id).executeTakeFirst();
        if (!reservation) throw new IdentityHttpError(404, 'NOT_FOUND', 'Reservation not found.');
        if (reservation.version !== v) throw conflict(reservation, reservation);

        const updated = await trx.updateTable('reservations')
          .set({
            party_size: request.body.party_size ?? reservation.party_size,
            reservation_time: request.body.reservation_time ? new Date(request.body.reservation_time) : reservation.reservation_time,
            customer_name: request.body.customer_name ?? reservation.customer_name,
            customer_email: request.body.customer_email !== undefined ? request.body.customer_email : reservation.customer_email,
            customer_phone: request.body.customer_phone !== undefined ? request.body.customer_phone : reservation.customer_phone,
            special_requests: request.body.special_requests !== undefined ? request.body.special_requests : reservation.special_requests,
            version: sql<number>`version + 1`,
          })
          .where('id', '=', id).where('version', '=', v)
          .returningAll().executeTakeFirst();
        if (!updated) throw conflict(reservation, reservation);
        return updated;
      });
      return reply.status(200).send(res);
    });
  });

  const transitionStatus = async (loc_id: string, id: string, expectedV: number, targetStatus: string, fromStatuses: string[], staffId: string) => {
    return app.withLocationTransaction(loc_id, async (trx) => {
      const reservation = await trx.selectFrom('reservations').selectAll().where('id', '=', id).where('location_id', '=', loc_id).executeTakeFirst();
      if (!reservation) throw new IdentityHttpError(404, 'NOT_FOUND', 'Reservation not found.');
      if (reservation.version !== expectedV) throw conflict(reservation, reservation);
      if (!fromStatuses.includes(reservation.status)) {
        throw new IdentityHttpError(409, 'ILLEGAL_RESERVATION_STATUS_TRANSITION', `Cannot transition reservation from ${reservation.status} to ${targetStatus}.`);
      }
      const setClause: { status: string; version: ReturnType<typeof sql<number>>; confirmed_by_staff_id?: string } = { status: targetStatus, version: sql<number>`version + 1` };
      if (targetStatus === 'CONFIRMED') setClause.confirmed_by_staff_id = staffId;
      
      const updated = await trx.updateTable('reservations').set(setClause).where('id', '=', id).where('version', '=', expectedV).returningAll().executeTakeFirst();
      if (!updated) throw conflict(reservation, reservation);
      return updated;
    });
  };

  app.post<{ Params: { loc_id: string; id: string } }>('/api/v1/locations/:loc_id/reservations/:id/confirm', {
    schema: { params: { type: 'object', properties: { loc_id: uuid, id: uuid }, required: ['loc_id', 'id'] }, headers: ifMatch }
  }, async (request, reply) => {
    const { loc_id, id } = request.params;
    const v = expected(request.headers['if-match'] as string | undefined);
    return withAuthenticatedSession(app, request, new Date(), 15 * 60 * 1000, async (actor) => {
      requirePermission(actor, 'reservations.reservations.update_status');
      const res = await transitionStatus(loc_id, id, v, 'CONFIRMED', ['REQUESTED'], actor.staffId);
      return reply.status(200).send(res);
    });
  });

  app.post<{ Params: { loc_id: string; id: string } }>('/api/v1/locations/:loc_id/reservations/:id/arrive', {
    schema: { params: { type: 'object', properties: { loc_id: uuid, id: uuid }, required: ['loc_id', 'id'] }, headers: ifMatch }
  }, async (request, reply) => {
    const { loc_id, id } = request.params;
    const v = expected(request.headers['if-match'] as string | undefined);
    return withAuthenticatedSession(app, request, new Date(), 15 * 60 * 1000, async (actor) => {
      requirePermission(actor, 'reservations.reservations.update_status');
      const res = await transitionStatus(loc_id, id, v, 'ARRIVED', ['CONFIRMED'], actor.staffId);
      return reply.status(200).send(res);
    });
  });

  app.post<{ Params: { loc_id: string; id: string } }>('/api/v1/locations/:loc_id/reservations/:id/no-show', {
    schema: { params: { type: 'object', properties: { loc_id: uuid, id: uuid }, required: ['loc_id', 'id'] }, headers: ifMatch }
  }, async (request, reply) => {
    const { loc_id, id } = request.params;
    const v = expected(request.headers['if-match'] as string | undefined);
    return withAuthenticatedSession(app, request, new Date(), 15 * 60 * 1000, async (actor) => {
      requirePermission(actor, 'reservations.reservations.update_status');
      const res = await transitionStatus(loc_id, id, v, 'NO_SHOW', ['CONFIRMED', 'ARRIVED'], actor.staffId);
      return reply.status(200).send(res);
    });
  });

  app.post<{ Params: { loc_id: string; id: string }; Body: SeatBody }>('/api/v1/locations/:loc_id/reservations/:id/seat', {
    schema: {
      params: { type: 'object', properties: { loc_id: uuid, id: uuid }, required: ['loc_id', 'id'] },
      headers: ifMatch,
      body: { type: 'object', properties: { table_id: uuid }, required: ['table_id'] }
    }
  }, async (request, reply) => {
    const { loc_id, id } = request.params;
    const v = expected(request.headers['if-match'] as string | undefined);
    return withAuthenticatedSession(app, request, new Date(), 15 * 60 * 1000, async (actor) => {
      requirePermission(actor, 'reservations.reservations.seat');
      const res = await app.withLocationTransaction(loc_id, async (trx) => {
        const reservation = await trx.selectFrom('reservations').selectAll().where('id', '=', id).where('location_id', '=', loc_id).executeTakeFirst();
        if (!reservation) throw new IdentityHttpError(404, 'NOT_FOUND', 'Reservation not found.');
        if (reservation.version !== v) throw conflict(reservation, reservation);
        if (reservation.status !== 'ARRIVED') {
          throw new IdentityHttpError(409, 'ILLEGAL_RESERVATION_STATUS_TRANSITION', `Cannot transition reservation from ${reservation.status} to SEATED.`);
        }

        const table = await trx.selectFrom('tables').selectAll().where('id', '=', request.body.table_id).where('location_id', '=', loc_id).executeTakeFirst();
        if (!table) throw new IdentityHttpError(400, 'INVALID_TABLE', 'Table does not belong to this location.');
        if (table.status !== 'AVAILABLE') throw new IdentityHttpError(409, 'TABLE_NOT_AVAILABLE', 'Table is not available.');
        
        const updatedTable = await trx.updateTable('tables').set({ status: 'OCCUPIED', version: sql<number>`version + 1` }).where('id', '=', request.body.table_id).where('version', '=', table.version).executeTakeFirst();
        if (!updatedTable) throw conflict(table, table);

        const visit = await trx.insertInto('visits').values({
          location_id: loc_id,
          table_id: request.body.table_id,
          staff_id: actor.staffId,
          guest_count: reservation.party_size,
        }).returningAll().executeTakeFirstOrThrow();

        const updated = await trx.updateTable('reservations')
          .set({ status: 'SEATED', visit_id: visit.id, version: sql<number>`version + 1` })
          .where('id', '=', id).where('version', '=', v)
          .returningAll().executeTakeFirst();
        if (!updated) throw conflict(reservation, reservation);
        
        return updated;
      });
      return reply.status(200).send(res);
    });
  });

  app.get<{ Params: { loc_id: string } }>('/api/v1/locations/:loc_id/reservation-settings', {
    schema: {
      params: { type: 'object', properties: { loc_id: uuid }, required: ['loc_id'] }
    }
  }, async (request) => {
    const { loc_id } = request.params;
    return withAuthenticatedSession(app, request, new Date(), 15 * 60 * 1000, async (actor) => {
      requirePermission(actor, 'reservations.settings.read');
      return app.withLocationTransaction(loc_id, async (trx) => {
        return getSettings(trx, loc_id);
      });
    });
  });

  app.put<{ Params: { loc_id: string }; Body: SettingsBody }>('/api/v1/locations/:loc_id/reservation-settings', {
    schema: {
      params: { type: 'object', properties: { loc_id: uuid }, required: ['loc_id'] },
      body: {
        type: 'object',
        properties: {
          accepts_reservations: { type: 'boolean' },
          operating_hours: { type: 'array', items: { type: 'object', properties: { day_of_week: { type: 'integer' }, open_time: { type: 'string' }, close_time: { type: 'string' } } } },
          estimated_visit_duration_minutes: { type: 'integer' },
          minimum_lead_time_minutes: { type: 'integer' },
          maximum_party_size: { type: 'integer' },
          auto_confirm: { type: 'boolean' },
          version: { type: 'integer' }
        },
        required: ['accepts_reservations', 'operating_hours', 'estimated_visit_duration_minutes', 'minimum_lead_time_minutes', 'maximum_party_size', 'auto_confirm', 'version']
      }
    }
  }, async (request, reply) => {
    const { loc_id } = request.params;
    return withAuthenticatedSession(app, request, new Date(), 15 * 60 * 1000, async (actor) => {
      requirePermission(actor, 'reservations.settings.write');
      const res = await app.withLocationTransaction(loc_id, async (trx) => {
        const body = request.body;
        const current = await trx.selectFrom('reservation_settings').selectAll().where('location_id', '=', loc_id).executeTakeFirst();
        if (current) {
          if (current.version !== body.version) throw conflict(current, current);
          const updated = await trx.updateTable('reservation_settings').set({
            accepts_reservations: body.accepts_reservations,
            // pg's default parameter serialization sends a plain JS array as a
            // Postgres ARRAY literal, not JSON, which a jsonb column rejects
            // ("invalid input syntax for type json") — confirmed against a
            // real Postgres 17 instance. Plain objects are auto-stringified by
            // pg and work either way, but arrays must be stringified explicitly.
            operating_hours: JSON.stringify(body.operating_hours),
            estimated_visit_duration_minutes: body.estimated_visit_duration_minutes,
            minimum_lead_time_minutes: body.minimum_lead_time_minutes,
            maximum_party_size: body.maximum_party_size,
            auto_confirm: body.auto_confirm,
            version: sql<number>`version + 1`,
          }).where('location_id', '=', loc_id).where('version', '=', body.version).returningAll().executeTakeFirst();
          if (!updated) throw conflict(current, current);
          return updated;
        } else {
          return trx.insertInto('reservation_settings').values({
            location_id: loc_id,
            accepts_reservations: body.accepts_reservations,
            operating_hours: JSON.stringify(body.operating_hours),
            estimated_visit_duration_minutes: body.estimated_visit_duration_minutes,
            minimum_lead_time_minutes: body.minimum_lead_time_minutes,
            maximum_party_size: body.maximum_party_size,
            auto_confirm: body.auto_confirm,
          }).returningAll().executeTakeFirstOrThrow();
        }
      });
      return reply.status(200).send(res);
    });
  });
};
