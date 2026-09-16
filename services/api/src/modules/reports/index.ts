import type { FastifyPluginAsync } from 'fastify';
import { reportsRoute, type ReportsRouteOptions } from './route.js';

export const reportsModule: FastifyPluginAsync<ReportsRouteOptions> = async (app, options) => {
  await app.register(reportsRoute, options);
};
export type { ReportsRouteOptions } from './route.js';
export { averageTicket, toCsv } from './state.js';
