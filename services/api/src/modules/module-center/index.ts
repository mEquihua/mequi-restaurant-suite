import type { FastifyPluginAsync } from 'fastify';

import { moduleCenterRoute, type ModuleCenterRouteOptions } from './route.js';

/** Public Module Center boundary. Other modules may import only from this file. */
export const moduleCenterModule: FastifyPluginAsync<ModuleCenterRouteOptions> = async (app, options) => {
  await app.register(moduleCenterRoute, options);
};

export type { ModuleCenterRouteOptions } from './route.js';
export { canPauseModule, moduleStatuses, type ModuleStatus } from './status.js';
