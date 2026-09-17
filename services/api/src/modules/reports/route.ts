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
  const orgRangeQuery = {
    type: 'object', additionalProperties: false, required: ['from', 'to'],
    properties: {
      from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' },
      format: { type: 'string', enum: ['json'] }, limit: { type: 'integer', minimum: 1, maximum: 500 }, offset: { type: 'integer', minimum: 0 },
      location_ids: { type: 'string' }, all: { type: 'boolean' }
    },
    oneOf: [
      { required: ['location_ids'] },
      { required: ['all'] }
    ]
  } as const;
  const orgParams = { type: 'object', additionalProperties: false, required: ['orgId'], properties: { orgId: uuid } } as const;
  type OrgQuery = { from: string; to: string; format?: 'json'; limit?: number; offset?: number; location_ids?: string; all?: boolean };

  const orgReport = (permission: string, execute: (trx: Parameters<typeof salesByDay>[0], range: ReportRange, query: OrgQuery) => Promise<Array<Record<string, unknown>>>) =>
    async (request: FastifyRequest, _reply: FastifyReply) => withSession(request, async (actor) => {
      requirePermission(actor, permission);
      const query = request.query as OrgQuery;
      const orgId = (request.params as { orgId: string }).orgId;
      if (orgId !== actor.organizationId) throw new IdentityHttpError(403, 'FORBIDDEN', 'Cannot access reports for a different organization.');
      if (query.all && query.location_ids) throw new IdentityHttpError(400, 'VALIDATION_ERROR', 'Cannot specify both all and location_ids');
      if (!query.all && !query.location_ids) throw new IdentityHttpError(400, 'VALIDATION_ERROR', 'Must specify either all or location_ids');

      const orgLocations = await actor.trx
        .selectFrom('locations')
        .select(['id', 'name'])
        .where('organization_id', '=', actor.organizationId)
        .execute();

      let validLocations = orgLocations;
      if (!query.all && query.location_ids) {
        const requested = new Set(query.location_ids.split(','));
        validLocations = orgLocations.filter(loc => requested.has(loc.id));
      }

      if (validLocations.length === 0) return { data: [] };

      const results = [];
      for (const loc of validLocations) {
        const range = parseRange(query, loc.id);
        const rows = await app.withLocationTransaction(loc.id, (trx) => execute(trx, range, query));
        results.push({ location_id: loc.id, location_name: loc.name, data: rows });
      }

      return { data: results };
    });

  const orgSchema = { schema: { params: orgParams, querystring: orgRangeQuery } };
  app.get('/api/v1/organizations/:orgId/reports/sales/by-day', orgSchema, orgReport('reports.sales.read', (trx, range) => salesByDay(trx, range)));
  app.get('/api/v1/organizations/:orgId/reports/sales/by-hour', orgSchema, orgReport('reports.sales.read', (trx, range) => salesByHour(trx, range)));
  app.get('/api/v1/organizations/:orgId/reports/sales/by-product', orgSchema, orgReport('reports.sales.read', (trx, range, query) => salesByProduct(trx, range, query.limit ?? 100, query.offset ?? 0)));
  app.get('/api/v1/organizations/:orgId/reports/sales/by-category', orgSchema, orgReport('reports.sales.read', (trx, range) => salesByCategory(trx, range)));
  app.get('/api/v1/organizations/:orgId/reports/sales/by-employee', orgSchema, orgReport('reports.sales.read', (trx, range) => salesByEmployee(trx, range)));
  app.get('/api/v1/organizations/:orgId/reports/orders/summary', orgSchema, orgReport('reports.sales.read', async (trx, range) => {
    const [summary] = await ordersSummary(trx, range) as Array<{ order_count: number; total_sales: number }>;
    return [{ order_count: summary?.order_count ?? 0, average_ticket: averageTicket(summary?.total_sales ?? 0, summary?.order_count ?? 0) }];
  }));
  app.get('/api/v1/organizations/:orgId/reports/payments/by-method', orgSchema, orgReport('reports.sales.read', (trx, range) => paymentsByMethod(trx, range)));
  app.get('/api/v1/organizations/:orgId/reports/discounts', orgSchema, orgReport('reports.sales.read', (trx, range) => discounts(trx, range)));
  app.get('/api/v1/organizations/:orgId/reports/voids-and-cancellations', orgSchema, orgReport('reports.audit.read', (trx, range) => voidsAndCancellations(trx, range)));
  app.get('/api/v1/organizations/:orgId/reports/refunds', orgSchema, orgReport('reports.audit.read', (trx, range) => refunds(trx, range)));
  app.get('/api/v1/organizations/:orgId/reports/tips', orgSchema, orgReport('reports.sales.read', (trx, range) => tips(trx, range)));
};
