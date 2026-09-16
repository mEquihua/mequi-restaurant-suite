import type { FastifyPluginAsync } from 'fastify';

import { floorRoute, type FloorRouteOptions } from './route.js';

/** Public floor module entry point. Other modules may import only from this file. */
export const floorModule: FastifyPluginAsync<FloorRouteOptions> = async (app, options) => {
  await app.register(floorRoute, options);
};

export type { FloorRouteOptions } from './route.js';
export { canTransitionTableStatus, tableStatuses, type TableStatus } from './status.js';
