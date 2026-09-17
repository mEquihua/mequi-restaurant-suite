import type { FastifyPluginAsync } from 'fastify';
import { loyaltyRoute, type LoyaltyRouteOptions } from './route.js';

export * from './route.js';

export const loyaltyModule: FastifyPluginAsync<LoyaltyRouteOptions> = async (app, options) => {
  await app.register(loyaltyRoute, options);
};
