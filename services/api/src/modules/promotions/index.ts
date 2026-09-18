import type { FastifyPluginAsync } from 'fastify';
import { promotionsRoute, type PromotionsRouteOptions } from './route.js';

export * from './route.js';
export * from './evaluator.js';

export const promotionsModule: FastifyPluginAsync<PromotionsRouteOptions> = async (app, options) => {
  await app.register(promotionsRoute, options);
};
