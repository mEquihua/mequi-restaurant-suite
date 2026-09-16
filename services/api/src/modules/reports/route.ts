import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { IdentityHttpError, requirePermission, withAuthenticatedSession } from '../identity/index.js';
import {
  discounts,
  ordersSummary,
  paymentsByMethod,
  refunds,
  salesByCategory,
  salesByDay,
  salesByEmployee,
  salesByHour,
  salesByProduct,
  tips,
  voidsAndCancellations,
  type ReportRange,
} from './persistence/repository.js';
import { averageTicket, toCsv } from './state.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const rangeQuery = {
  type: 'object', additionalProperties: false, required: ['from', 'to'],
  properties: {
    from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' },
    format: { type: 'string', enum: ['json', 'csv'] }, limit: { type: 'integer', minimum: 1, maximum: 500 }, offset: { type: 'integer', minimum: 0 },
  },
} as const;
const params = { type: 'object', additionalProperties: false, required: ['locationId'], properties: { locationId: uuid } } as const;
type Actor = Parameters<typeof requirePermission>[0];
type Query = { from: string; to: string; format?: 'json' | 'csv'; limit?: number; offset?: number };

export interface ReportsRouteOptions { now?: () => Date; sessionIdleMs?: number }

function fail(reply: FastifyReply, request: FastifyRequest, error: IdentityHttpError) {
  for (const [name, value] of Object.entries(error.headers ?? {})) reply.header(name, value);
  return reply.status(error.statusCode).send({ error: { status: error.statusCode, code: error.code, message: error.message, request_id: request.id, ...(error.details === undefined ? {} : { details: error.details }) } });
}

function parseRange(query: Query, locationId: string): ReportRange {
  const from = new Date(query.from); const to = new Date(query.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to)
    throw new IdentityHttpError(400, 'INVALID_REPORT_RANGE', '`from` and `to` must be ISO 8601 timestamps with from before to.');
  return { locationId, from, to };
}

/** Private HTTP implementation for location-scoped, read-only operational reports. */
export const reportsRoute: FastifyPluginAsync<ReportsRouteOptions> = async (app, options) => {
  const now = options.now ?? (() => new Date()); const idle = options.sessionIdleMs ?? 15 * 60 * 1000;
  const withSession = <T>(request: FastifyRequest, work: (actor: Actor) => Promise<T>) => withAuthenticatedSession(app, request, now(), idle, work);
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof IdentityHttpError) return fail(reply, request, error);
    if (typeof error === 'object' && error !== null && 'validation' in error && (error as { validation?: unknown }).validation)
      return reply.status(400).send({ error: { status: 400, code: 'VALIDATION_ERROR', message: 'The request does not match the required schema.', request_id: request.id } });
    request.log.error({ err: error }, 'reports request failed');
    return reply.status(500).send({ error: { status: 500, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', request_id: request.id } });
  });
  const respond = (reply: FastifyReply, query: Query, data: Array<Record<string, unknown>>) =>
    query.format === 'csv'
      ? reply.type('text/csv').header('content-disposition', 'attachment; filename="report.csv"').send(toCsv(data))
      : { data };
  const scoped = (actor: Actor, request: FastifyRequest) => {
    const locationId = (request.params as { locationId: string }).locationId;
    if (actor.locationId !== locationId) throw new IdentityHttpError(403, 'LOCATION_SCOPE_DENIED', 'The session is not scoped to the requested location.');
    return locationId;
  };
  const report = (permission: string, execute: (actor: Actor, range: ReportRange, query: Query) => Promise<Array<Record<string, unknown>>>) =>
    async (request: FastifyRequest, reply: FastifyReply) => withSession(request, async (actor) => {
      requirePermission(actor, permission); const query = request.query as Query; const range = parseRange(query, scoped(actor, request));
      return respond(reply, query, await execute(actor, range, query));
    });
  const schema = { schema: { params, querystring: rangeQuery } };
  app.get('/api/v1/locations/:locationId/reports/sales/by-day', schema, report('reports.sales.read', (actor, range) => salesByDay(actor.trx, range)));
  app.get('/api/v1/locations/:locationId/reports/sales/by-hour', schema, report('reports.sales.read', (actor, range) => salesByHour(actor.trx, range)));
  app.get('/api/v1/locations/:locationId/reports/sales/by-product', schema, report('reports.sales.read', (actor, range, query) => salesByProduct(actor.trx, range, query.limit ?? 100, query.offset ?? 0)));
  app.get('/api/v1/locations/:locationId/reports/sales/by-category', schema, report('reports.sales.read', (actor, range) => salesByCategory(actor.trx, range)));
  app.get('/api/v1/locations/:locationId/reports/sales/by-employee', schema, report('reports.sales.read', (actor, range) => salesByEmployee(actor.trx, range)));
  app.get('/api/v1/locations/:locationId/reports/orders/summary', schema, report('reports.sales.read', async (actor, range) => {
    const [summary] = await ordersSummary(actor.trx, range) as Array<{ order_count: number; total_sales: number }>;
    return [{ order_count: summary?.order_count ?? 0, average_ticket: averageTicket(summary?.total_sales ?? 0, summary?.order_count ?? 0) }];
  }));
  app.get('/api/v1/locations/:locationId/reports/payments/by-method', schema, report('reports.sales.read', (actor, range) => paymentsByMethod(actor.trx, range)));
  app.get('/api/v1/locations/:locationId/reports/discounts', schema, report('reports.sales.read', (actor, range) => discounts(actor.trx, range)));
  app.get('/api/v1/locations/:locationId/reports/voids-and-cancellations', schema, report('reports.audit.read', (actor, range) => voidsAndCancellations(actor.trx, range)));
  app.get('/api/v1/locations/:locationId/reports/refunds', schema, report('reports.audit.read', (actor, range) => refunds(actor.trx, range)));
  app.get('/api/v1/locations/:locationId/reports/tips', schema, report('reports.sales.read', (actor, range) => tips(actor.trx, range)));
};
