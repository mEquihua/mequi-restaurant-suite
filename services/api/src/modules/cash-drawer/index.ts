import type { FastifyPluginAsync } from 'fastify';
import { cashDrawerRoute, type CashDrawerRouteOptions } from './route.js';

export const cashDrawerModule: FastifyPluginAsync<CashDrawerRouteOptions> = async (app, options) => {
  await app.register(cashDrawerRoute, options);
};

export type { CashDrawerRouteOptions } from './route.js';
