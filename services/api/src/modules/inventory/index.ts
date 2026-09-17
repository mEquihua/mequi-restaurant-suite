import type { FastifyPluginAsync } from 'fastify';
import { inventoryRoute, type InventoryRouteOptions } from './route.js';

export * from './route.js';

export const inventoryModule: FastifyPluginAsync<InventoryRouteOptions> = async (app, options) => {
  await app.register(inventoryRoute, options);
};
